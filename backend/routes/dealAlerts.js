const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { authenticate, optionalAuth } = require('../middleware/auth');

// POST /api/deal-alerts — Subscribe
router.post('/', optionalAuth, (req, res) => {
  try {
    const { email, category_id, keyword, max_price, condition_filter, notify_sms } = req.body;
    if (!email && !req.user) return res.status(400).json({ error: 'Email required' });

    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO deal_alerts (id, user_id, email, category_id, keyword, max_price, condition_filter, notify_email, notify_sms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id,
      req.user?.id || null,
      req.user?.email || email,
      category_id || null,
      keyword || null,
      max_price ? parseFloat(max_price) : null,
      condition_filter || null,
      notify_sms ? 1 : 0
    );

    res.status(201).json({ message: 'You\'re subscribed! We\'ll alert you when matching deals drop.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// GET /api/deal-alerts/my — My subscriptions
router.get('/my', authenticate, (req, res) => {
  try {
    const db = getDb();
    const alerts = db.prepare(`
      SELECT da.*, c.name as category_name, c.icon as category_icon
      FROM deal_alerts da LEFT JOIN categories c ON da.category_id=c.id
      WHERE da.user_id=? OR da.email=?
      ORDER BY da.created_at DESC
    `).all(req.user.id, req.user.email);
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// DELETE /api/deal-alerts/:id — Unsubscribe
router.delete('/:id', authenticate, (req, res) => {
  try {
    const db = getDb();
    db.prepare(`UPDATE deal_alerts SET is_active=0 WHERE id=? AND (user_id=? OR email=?)`).run(req.params.id, req.user.id, req.user.email);
    res.json({ message: 'Unsubscribed from deal alert' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

module.exports = router;
