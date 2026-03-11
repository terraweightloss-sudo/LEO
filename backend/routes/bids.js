const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { authenticate } = require('../middleware/auth');

// POST /api/bids — Place a bid
router.post('/', authenticate, (req, res) => {
  try {
    const { listing_id, amount, max_amount } = req.body;
    if (!listing_id || !amount) return res.status(400).json({ error: 'listing_id and amount required' });

    const db = getDb();
    const listing = db.prepare('SELECT * FROM listings WHERE id=? AND status=?').get(listing_id, 'active');
    if (!listing) return res.status(404).json({ error: 'Listing not found or not active' });

    // Check auction hasn't ended
    if (listing.ends_at && new Date(listing.ends_at) < new Date()) {
      db.prepare(`UPDATE listings SET status='ended' WHERE id=?`).run(listing_id);
      return res.status(400).json({ error: 'This auction has ended' });
    }

    const minBid = Math.max(listing.current_bid || 0, listing.starting_bid || 1) + 1;
    if (parseFloat(amount) < minBid) {
      return res.status(400).json({ error: `Minimum bid is $${minBid.toFixed(2)}` });
    }

    // Remove winning status from previous winner
    db.prepare('UPDATE bids SET is_winning=0 WHERE listing_id=?').run(listing_id);

    const bidId = uuidv4();
    db.prepare(`
      INSERT INTO bids (id, listing_id, user_id, amount, max_amount, is_winning)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(bidId, listing_id, req.user.id, parseFloat(amount), max_amount ? parseFloat(max_amount) : null);

    // Update listing current bid
    db.prepare(`UPDATE listings SET current_bid=?, bid_count=bid_count+1, updated_at=datetime('now') WHERE id=?`)
      .run(parseFloat(amount), listing_id);

    // Auto-extend if bid in last 2 minutes
    if (listing.ends_at) {
      const endsAt = new Date(listing.ends_at);
      const now = new Date();
      if ((endsAt - now) < 2 * 60 * 1000) {
        const newEnd = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
        db.prepare(`UPDATE listings SET ends_at=? WHERE id=?`).run(newEnd, listing_id);
      }
    }

    const bid = db.prepare('SELECT * FROM bids WHERE id=?').get(bidId);
    const updatedListing = db.prepare('SELECT * FROM listings WHERE id=?').get(listing_id);

    res.status(201).json({ bid, listing: updatedListing, message: `Bid of $${parseFloat(amount).toFixed(2)} placed!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to place bid' });
  }
});

// GET /api/bids/my — My bids
router.get('/my', authenticate, (req, res) => {
  try {
    const db = getDb();
    const bids = db.prepare(`
      SELECT b.*, l.title, l.ends_at, l.status as listing_status, l.current_bid,
        (SELECT url FROM listing_images WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) as image
      FROM bids b
      JOIN listings l ON b.listing_id = l.id
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC
    `).all(req.user.id);
    res.json({ bids });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bids' });
  }
});

module.exports = router;
