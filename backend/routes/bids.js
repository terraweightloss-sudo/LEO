const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { authenticate } = require('../middleware/auth');

// POST /api/bids — Place a bid with auto-bid and increment support
router.post('/', authenticate, (req, res) => {
  try {
    const { listing_id, amount, max_amount, increment } = req.body;
    if (!listing_id || !amount) return res.status(400).json({ error: 'listing_id and amount required' });

    const db = getDb();
    const listing = db.prepare('SELECT * FROM listings WHERE id=? AND status=?').get(listing_id, 'active');
    if (!listing) return res.status(404).json({ error: 'Listing not found or not active' });

    if (listing.ends_at && new Date(listing.ends_at) < new Date()) {
      db.prepare(`UPDATE listings SET status='ended' WHERE id=?`).run(listing_id);
      return res.status(400).json({ error: 'This auction has ended' });
    }

    const incr = Math.max(0.50, parseFloat(increment) || 1.00);
    const currentBid = parseFloat(listing.current_bid || listing.starting_bid || 0);
    const minBid = Math.round((currentBid + incr) * 100) / 100;
    const bidAmt = parseFloat(amount);
    const maxAmt = max_amount ? parseFloat(max_amount) : null;

    if (bidAmt < minBid) {
      return res.status(400).json({ error: `Minimum bid is $${minBid.toFixed(2)}` });
    }
    if (maxAmt && maxAmt < bidAmt) {
      return res.status(400).json({ error: 'Max bid must be at least equal to your starting bid' });
    }

    // Check if there's an existing auto-bidder we need to compete with
    const existingAutoBid = db.prepare(
      'SELECT * FROM bids WHERE listing_id=? AND max_amount IS NOT NULL AND is_winning=1 AND user_id!=? ORDER BY max_amount DESC LIMIT 1'
    ).get(listing_id, req.user.id);

    let finalBid = bidAmt;
    let winnerId = req.user.id;
    let winnerBid = bidAmt;

    if (existingAutoBid && maxAmt) {
      // Two auto-bidders competing
      if (parseFloat(existingAutoBid.max_amount) >= maxAmt) {
        // Existing bidder wins — raise their bid to just beat new max
        finalBid = Math.min(parseFloat(existingAutoBid.max_amount), maxAmt + incr);
        winnerId = existingAutoBid.user_id;
        winnerBid = finalBid;
      }
      // else new bidder wins at existing max + increment
    } else if (existingAutoBid && !maxAmt) {
      // New bidder has no max, existing auto-bidder raises to beat
      const raiseToAmt = Math.round((bidAmt + incr) * 100) / 100;
      if (parseFloat(existingAutoBid.max_amount) >= raiseToAmt) {
        finalBid = raiseToAmt;
        winnerId = existingAutoBid.user_id;
        winnerBid = raiseToAmt;
      }
    }

    // Clear previous winner
    db.prepare('UPDATE bids SET is_winning=0 WHERE listing_id=?').run(listing_id);

    const bidId = uuidv4();
    db.prepare(`INSERT INTO bids (id, listing_id, user_id, amount, max_amount, is_winning) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(bidId, listing_id, req.user.id, bidAmt, maxAmt || null, winnerId === req.user.id ? 1 : 0);

    if (winnerId !== req.user.id) {
      // Update existing auto-bidder's winning bid
      db.prepare('UPDATE bids SET amount=?, is_winning=1 WHERE listing_id=? AND user_id=? AND is_winning=0 ORDER BY created_at DESC LIMIT 1')
        .run(winnerBid, listing_id, winnerId);
    }

    db.prepare(`UPDATE listings SET current_bid=?, bid_count=bid_count+1, updated_at=datetime('now') WHERE id=?`)
      .run(finalBid, listing_id);

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

    const msg = winnerId === req.user.id
      ? `Bid of $${finalBid.toFixed(2)} placed! You're winning.`
      : `Bid placed but outbid by existing auto-bidder. Current: $${finalBid.toFixed(2)}`;

    res.status(201).json({ bid, listing: updatedListing, message: msg });
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
