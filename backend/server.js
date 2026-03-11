/**
 * Leo's Auctions — Main Server
 * Full-stack auction platform with role-based access control
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy (required for Railway/Netlify/Heroku) ────
app.set('trust proxy', 1);

// ── Security middleware ──────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // disabled for easy dev
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── Rate limiting ────────────────────────────────────────
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many requests, try again later' } }));
app.use('/api', rateLimit({ windowMs: 1 * 60 * 1000, max: 200 }));

// ── Body parsing (except for Stripe webhook) ────────────
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payments/webhook') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));

// ── Static files ─────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ── API Routes ────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/listings', require('./routes/listings'));
app.use('/api/bids', require('./routes/bids'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/deal-alerts', require('./routes/dealAlerts'));
app.use('/api/contact', require('./routes/contact'));

// Saved listings
const { authenticate, optionalAuth } = require('./middleware/auth');
const { getDb } = require('./db/connection');
const { v4: uuidv4 } = require('uuid');

app.post('/api/saved/:listingId', authenticate, (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT 1 FROM saved_listings WHERE user_id=? AND listing_id=?').get(req.user.id, req.params.listingId);
    if (existing) {
      db.prepare('DELETE FROM saved_listings WHERE user_id=? AND listing_id=?').run(req.user.id, req.params.listingId);
      res.json({ saved: false, message: 'Removed from saved' });
    } else {
      db.prepare('INSERT OR IGNORE INTO saved_listings (user_id, listing_id) VALUES (?,?)').run(req.user.id, req.params.listingId);
      res.json({ saved: true, message: 'Item saved' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle save' });
  }
});

app.get('/api/saved', authenticate, (req, res) => {
  try {
    const db = getDb();
    const saved = db.prepare(`
      SELECT l.*, c.icon as category_icon,
        (SELECT url FROM listing_images WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) as image
      FROM saved_listings sl JOIN listings l ON sl.listing_id=l.id LEFT JOIN categories c ON l.category_id=c.id
      WHERE sl.user_id=? ORDER BY sl.created_at DESC
    `).all(req.user.id);
    res.json({ saved });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch saved items' });
  }
});

app.get('/api/categories', (req, res) => {
  try {
    const db = getDb();
    const categories = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM listings WHERE category_id=c.id AND status='active') as count
      FROM categories c WHERE c.is_active=1 ORDER BY c.sort_order
    `).all();
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ── Serve frontend for all non-API routes ─────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Auction end processor (runs every minute) ────────────
function processEndedAuctions() {
  try {
    const db = getDb();
    const ended = db.prepare(`
      SELECT * FROM listings WHERE status='active' AND ends_at IS NOT NULL AND ends_at <= datetime('now')
    `).all();

    ended.forEach(listing => {
      const winner = db.prepare('SELECT * FROM bids WHERE listing_id=? AND is_winning=1').get(listing.id);
      db.prepare(`UPDATE listings SET status='ended', updated_at=datetime('now') WHERE id=?`).run(listing.id);

      if (winner) {
        // Auto-create order for winner
        const existing = db.prepare('SELECT id FROM orders WHERE listing_id=? AND user_id=? AND order_type=?').get(listing.id, winner.user_id, 'auction');
        if (!existing) {
          const premium = Math.round(winner.amount * 0.10 * 100) / 100;
          const total = winner.amount + premium;
          db.prepare(`INSERT INTO orders (id,user_id,listing_id,order_type,subtotal,buyers_premium,total,status) VALUES (?,?,?,?,?,?,?,?)`)
            .run(uuidv4(), winner.user_id, listing.id, 'auction', winner.amount, premium, total, 'pending');
        }
      }
      console.log(`✅ Auction ended: ${listing.title}`);
    });
  } catch (err) {
    console.error('Auction processor error:', err.message);
  }
}

setInterval(processEndedAuctions, 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n🐺  Leo's Auctions Server`);
  console.log(`🚀  Running at http://localhost:${PORT}`);
  console.log(`📊  Admin panel: http://localhost:${PORT}/admin`);
  console.log(`🔑  Default login: owner@leosauctions.com / LeoOwner2026!\n`);
});
