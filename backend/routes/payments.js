const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { authenticate } = require('../middleware/auth');

const BUYERS_PREMIUM_RATE = 0.10; // 10%

// ── Lazy-load Stripe ─────────────────────────────────────
let stripe;
function getStripe() {
  if (!stripe && process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

// POST /api/payments/create-intent — Create payment intent
router.post('/create-intent', authenticate, async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id required' });

    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(order_id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(400).json({ error: 'Order already processed' });

    const Stripe = getStripe();
    if (!Stripe) {
      // Demo mode — return fake intent
      return res.json({
        client_secret: 'pi_demo_secret_' + Date.now(),
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_demo',
        amount: order.total,
        demo_mode: true
      });
    }

    // Create or retrieve Stripe customer
    let customerId = req.user.stripe_customer_id;
    if (!customerId) {
      const customer = await Stripe.customers.create({
        email: req.user.email,
        name: `${req.user.first_name} ${req.user.last_name}`,
        phone: req.user.phone || undefined,
        metadata: { user_id: req.user.id }
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(customerId, req.user.id);
    }

    const intent = await Stripe.paymentIntents.create({
      amount: Math.round(order.total * 100), // cents
      currency: 'usd',
      customer: customerId,
      metadata: {
        order_id: order.id,
        user_id: req.user.id,
        listing_id: order.listing_id || ''
      },
      receipt_email: req.user.email,
      description: `Leo's Auctions — Order ${order.id.substring(0, 8).toUpperCase()}`
    });

    db.prepare('UPDATE orders SET stripe_payment_intent_id=? WHERE id=?').run(intent.id, order.id);
    res.json({
      client_secret: intent.client_secret,
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY,
      amount: order.total
    });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: err.message || 'Payment setup failed' });
  }
});

// POST /api/payments/confirm — Confirm payment (after Stripe success)
router.post('/confirm', authenticate, async (req, res) => {
  try {
    const { order_id, payment_intent_id, payment_method_last4 } = req.body;
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(order_id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const Stripe = getStripe();
    if (Stripe && payment_intent_id) {
      const intent = await Stripe.paymentIntents.retrieve(payment_intent_id);
      if (intent.status !== 'succeeded') {
        return res.status(400).json({ error: 'Payment not completed' });
      }
    }

    db.prepare(`UPDATE orders SET status='paid', stripe_charge_id=?, payment_method_last4=?, updated_at=datetime('now') WHERE id=?`)
      .run(payment_intent_id || null, payment_method_last4 || null, order.id);

    // Mark listing as sold
    if (order.listing_id) {
      db.prepare(`UPDATE listings SET status='sold', updated_at=datetime('now') WHERE id=?`).run(order.listing_id);
    }

    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,new_value)
      VALUES (?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'ORDER_PAID', 'order', order.id, `$${order.total}`);

    res.json({ message: 'Payment confirmed', order_id: order.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// POST /api/payments/checkout — Create order from winning bid / buy-now
router.post('/checkout', authenticate, async (req, res) => {
  try {
    const { listing_id, order_type = 'buynow' } = req.body;
    const db = getDb();

    const listing = db.prepare('SELECT * FROM listings WHERE id=?').get(listing_id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    let subtotal;
    if (order_type === 'buynow') {
      if (!listing.buy_now_price) return res.status(400).json({ error: 'No Buy Now price set' });
      subtotal = listing.buy_now_price;
    } else {
      // Auction win
      const winBid = db.prepare('SELECT * FROM bids WHERE listing_id=? AND user_id=? AND is_winning=1').get(listing_id, req.user.id);
      if (!winBid) return res.status(400).json({ error: 'You are not the winner of this auction' });
      subtotal = winBid.amount;
    }

    const buyersPremium = Math.round(subtotal * BUYERS_PREMIUM_RATE * 100) / 100;
    const total = Math.round((subtotal + buyersPremium) * 100) / 100;

    const orderId = uuidv4();
    db.prepare(`
      INSERT INTO orders (id, user_id, listing_id, order_type, subtotal, buyers_premium, total, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(orderId, req.user.id, listing_id, order_type, subtotal, buyersPremium, total);

    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    res.status(201).json({ order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// GET /api/payments/orders — My orders
router.get('/orders', authenticate, (req, res) => {
  try {
    const db = getDb();
    const orders = db.prepare(`
      SELECT o.*, l.title as listing_title,
        (SELECT url FROM listing_images WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) as listing_image
      FROM orders o
      LEFT JOIN listings l ON o.listing_id = l.id
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
    `).all(req.user.id);
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// POST /api/payments/orders/:id/pickup — Book pickup slot
router.post('/orders/:id/pickup', authenticate, (req, res) => {
  try {
    const { slot_id } = req.body;
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'paid') return res.status(400).json({ error: 'Order must be paid before booking pickup' });

    const slot = db.prepare('SELECT * FROM pickup_slots WHERE id=? AND is_active=1').get(slot_id);
    if (!slot) return res.status(404).json({ error: 'Pickup slot not found' });
    if (slot.booked_count >= slot.max_capacity) return res.status(400).json({ error: 'This time slot is full' });

    db.prepare(`UPDATE orders SET pickup_slot=?, status='ready_pickup', updated_at=datetime('now') WHERE id=?`).run(`${slot.date} ${slot.time_slot}`, order.id);
    db.prepare('UPDATE pickup_slots SET booked_count=booked_count+1 WHERE id=?').run(slot_id);

    res.json({ message: `Pickup scheduled for ${slot.date} ${slot.time_slot}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to book pickup' });
  }
});

// Stripe Webhook (raw body required)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const Stripe = getStripe();
  if (!Stripe) return res.json({ received: true });

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = Stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = getDb();
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const order = db.prepare('SELECT * FROM orders WHERE stripe_payment_intent_id=?').get(intent.id);
    if (order && order.status === 'pending') {
      db.prepare(`UPDATE orders SET status='paid', updated_at=datetime('now') WHERE id=?`).run(order.id);
      if (order.listing_id) db.prepare(`UPDATE listings SET status='sold' WHERE id=?`).run(order.listing_id);
    }
  }
  res.json({ received: true });
});

module.exports = router;
