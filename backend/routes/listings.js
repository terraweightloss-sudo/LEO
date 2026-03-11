const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/connection');
const { authenticate, optionalAuth, requireMinRole } = require('../middleware/auth');

// ── Image upload setup (Cloudinary or local) ─────────────
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Lazily initialize Cloudinary if configured
let cloudinary;
function getCloudinary() {
  if (!cloudinary && process.env.CLOUDINARY_CLOUD_NAME && process.env.USE_CLOUDINARY === 'true') {
    cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key:    process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }
  return cloudinary;
}

// Use memory storage so we can optionally pipe to Cloudinary
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg','.jpeg','.png','.webp','.gif'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only image files allowed (JPG, PNG, WebP, GIF)'));
  }
});

// Helper: upload file to Cloudinary if configured, else return local URL
async function resolveImageUrl(localFilename, localPath) {
  const cld = getCloudinary();
  if (cld) {
    try {
      const result = await cld.uploader.upload(localPath, {
        folder: 'leos-auctions',
        transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
      });
      // Remove local file after uploading to Cloudinary
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      return { url: result.secure_url, filename: result.public_id, isCloudinary: true };
    } catch (err) {
      console.error('Cloudinary upload failed, falling back to local:', err.message);
    }
  }
  return { url: `/uploads/${localFilename}`, filename: localFilename, isCloudinary: false };
}

// ── Helper: log price change ─────────────────────────────
function logPriceChange(db, userId, userEmail, userRole, listingId, field, oldVal, newVal) {
  db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,field_changed,old_value,new_value)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    uuidv4(), userId, userEmail, userRole, 'LISTING_PRICE_CHANGED', 'listing', listingId, field,
    oldVal != null ? String(oldVal) : null,
    newVal != null ? String(newVal) : null
  );
}

// ══════════════════════════════════════════════════════════
// GET /api/listings  — public listing feed
// ══════════════════════════════════════════════════════════
router.get('/', optionalAuth, (req, res) => {
  try {
    const db = getDb();
    const { category, condition, status = 'active', sort = 'ending', search, page = 1, limit = 24 } = req.query;
    let where = ['l.status = ?'];
    let params = [status];

    if (category) { where.push('c.slug = ?'); params.push(category); }
    if (condition) { where.push('l.condition = ?'); params.push(condition); }
    if (search) { where.push('(l.title LIKE ? OR l.description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

    const sortMap = {
      ending: 'l.ends_at ASC',
      'price-low': 'l.current_bid ASC',
      'price-high': 'l.current_bid DESC',
      bids: 'l.bid_count DESC',
      new: 'l.created_at DESC'
    };
    const orderBy = sortMap[sort] || 'l.ends_at ASC';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const sql = `
      SELECT l.*, c.name as category_name, c.slug as category_slug, c.icon as category_icon,
        (SELECT url FROM listing_images WHERE listing_id = l.id AND is_primary = 1 LIMIT 1) as primary_image,
        (SELECT url FROM listing_images WHERE listing_id = l.id ORDER BY sort_order LIMIT 1) as first_image,
        u.first_name || ' ' || u.last_name as created_by_name
      FROM listings l
      LEFT JOIN categories c ON l.category_id = c.id
      LEFT JOIN users u ON l.created_by = u.id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;
    const listings = db.prepare(sql).all(...params, parseInt(limit), offset);
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM listings l LEFT JOIN categories c ON l.category_id=c.id WHERE ${where.join(' AND ')}`).get(...params).cnt;

    // Add images array to each listing
    listings.forEach(l => {
      l.images = db.prepare('SELECT * FROM listing_images WHERE listing_id = ? ORDER BY sort_order').all(l.id);
      if (req.user) l.is_saved = !!db.prepare('SELECT 1 FROM saved_listings WHERE user_id=? AND listing_id=?').get(req.user.id, l.id);
    });

    res.json({ listings, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// GET /api/listings/:id
router.get('/:id', optionalAuth, (req, res) => {
  try {
    const db = getDb();
    const listing = db.prepare(`
      SELECT l.*, c.name as category_name, c.slug as category_slug, c.icon as category_icon,
        u.first_name || ' ' || u.last_name as created_by_name
      FROM listings l
      LEFT JOIN categories c ON l.category_id = c.id
      LEFT JOIN users u ON l.created_by = u.id
      WHERE l.id = ?
    `).get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    listing.images = db.prepare('SELECT * FROM listing_images WHERE listing_id = ? ORDER BY sort_order').all(listing.id);
    listing.bids = db.prepare(`
      SELECT b.*, u.first_name || ' ' || substr(u.last_name,1,1) || '***' as bidder_name
      FROM bids b JOIN users u ON b.user_id = u.id
      WHERE b.listing_id = ? ORDER BY b.amount DESC LIMIT 20
    `).all(listing.id);

    if (req.user) {
      listing.is_saved = !!db.prepare('SELECT 1 FROM saved_listings WHERE user_id=? AND listing_id=?').get(req.user.id, listing.id);
      listing.my_bid = db.prepare('SELECT MAX(amount) as amount FROM bids WHERE listing_id=? AND user_id=?').get(listing.id, req.user.id)?.amount;
    }
    res.json({ listing });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch listing' });
  }
});

// ══════════════════════════════════════════════════════════
// POST /api/listings — Create listing (employee+)
// ══════════════════════════════════════════════════════════
router.post('/', authenticate, requireMinRole('employee'), (req, res) => {
  try {
    const db = getDb();
    const {
      title, description, category_id, condition, retail_price,
      starting_bid, buy_now_price, reserve_price, ends_at,
      pickup_date, sku, weight_lbs, dimensions, notes, status
    } = req.body;

    if (!title || !category_id || !condition) {
      return res.status(400).json({ error: 'Title, category, and condition are required' });
    }
    const conditionLabels = { new: 'New Sealed', likenew: 'Like New', good: 'Good', fair: 'Fair' };

    // Employees cannot set buy_now_price, reserve_price, or activate listings
    const canSetPricing = ['manager', 'owner'].includes(req.user.role);
    const finalBuyNow = canSetPricing ? (buy_now_price || null) : null;
    const finalReserve = canSetPricing ? (reserve_price || null) : null;
    const finalStatus = canSetPricing ? (status || 'draft') : 'draft';

    const id = uuidv4();
    db.prepare(`
      INSERT INTO listings (id, title, description, category_id, condition, condition_label,
        retail_price, starting_bid, current_bid, buy_now_price, reserve_price,
        status, ends_at, pickup_date, sku, weight_lbs, dimensions, notes, created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, title, description || '', category_id, condition,
      conditionLabels[condition] || condition,
      parseFloat(retail_price) || 0,
      parseFloat(starting_bid) || 1,
      parseFloat(starting_bid) || 1,
      finalBuyNow ? parseFloat(finalBuyNow) : null,
      finalReserve ? parseFloat(finalReserve) : null,
      finalStatus, ends_at || null, pickup_date || null,
      sku || null, weight_lbs ? parseFloat(weight_lbs) : null,
      dimensions || null, notes || null, req.user.id, req.user.id);

    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,new_value)
      VALUES (?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'LISTING_CREATED', 'listing', id, title);

    const listing = db.prepare('SELECT * FROM listings WHERE id=?').get(id);
    res.status(201).json({ listing, message: 'Listing created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create listing' });
  }
});

// ══════════════════════════════════════════════════════════
// PUT /api/listings/:id — Update listing
// Employees: title, description, condition, notes
// Managers+: all fields including pricing
// ══════════════════════════════════════════════════════════
router.put('/:id', authenticate, requireMinRole('employee'), (req, res) => {
  try {
    const db = getDb();
    const listing = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const isManager = ['manager', 'owner'].includes(req.user.role);
    const updates = {};
    const pricingFields = ['retail_price', 'starting_bid', 'buy_now_price', 'reserve_price', 'status', 'ends_at'];
    const allowedFields = ['title', 'description', 'category_id', 'condition', 'notes', 'sku', 'weight_lbs', 'dimensions', 'pickup_date'];
    if (isManager) allowedFields.push(...pricingFields);

    allowedFields.forEach(f => {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    });

    if (updates.condition) updates.condition_label = { new:'New Sealed',likenew:'Like New',good:'Good',fair:'Fair' }[updates.condition] || updates.condition;

    // Log price changes specifically
    if (isManager) {
      ['retail_price','starting_bid','buy_now_price'].forEach(field => {
        if (updates[field] !== undefined && updates[field] != listing[field]) {
          logPriceChange(db, req.user.id, req.user.email, req.user.role, listing.id, field, listing[field], updates[field]);
        }
      });
      if (updates.status && updates.status !== listing.status) {
        db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,field_changed,old_value,new_value)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'LISTING_STATUS_CHANGED', 'listing', listing.id, 'status', listing.status, updates.status);
      }
    } else {
      // Log general edit by employee
      db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id)
        VALUES (?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'LISTING_EDITED', 'listing', listing.id);
    }

    if (Object.keys(updates).length) {
      const setClauses = Object.keys(updates).map(k => `${k}=?`).join(',');
      db.prepare(`UPDATE listings SET ${setClauses}, updated_by=?, updated_at=datetime('now') WHERE id=?`)
        .run(...Object.values(updates), req.user.id, listing.id);
    }

    const updated = db.prepare('SELECT * FROM listings WHERE id=?').get(listing.id);
    updated.images = db.prepare('SELECT * FROM listing_images WHERE listing_id=? ORDER BY sort_order').all(listing.id);
    res.json({ listing: updated, message: 'Listing updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update listing' });
  }
});

// ══════════════════════════════════════════════════════════
// POST /api/listings/:id/images — Upload images
// ══════════════════════════════════════════════════════════
router.post('/:id/images', authenticate, requireMinRole('employee'), upload.array('images', 10), async (req, res) => {
  try {
    const db = getDb();
    const listing = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    // Managers can replace images; employees can only add
    const canReplace = ['manager', 'owner'].includes(req.user.role);
    if (req.body.replace_all === 'true' && canReplace) {
      const existing = db.prepare('SELECT filename FROM listing_images WHERE listing_id=?').all(listing.id);
      existing.forEach(img => {
        const fp = path.join(uploadDir, img.filename);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });
      db.prepare('DELETE FROM listing_images WHERE listing_id=?').run(listing.id);
      db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id)
        VALUES (?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'LISTING_IMAGES_REPLACED', 'listing', listing.id);
    }

    const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM listing_images WHERE listing_id=?').get(listing.id).cnt;
    const insertImg = db.prepare(`INSERT INTO listing_images (id,listing_id,filename,url,sort_order,is_primary,uploaded_by) VALUES (?,?,?,?,?,?,?)`);
    const images = [];

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const imgId = uuidv4();
      const isPrimary = (existingCount + i === 0) ? 1 : 0;
      // Upload to Cloudinary or use local URL
      const { url, filename } = await resolveImageUrl(file.filename, path.join(uploadDir, file.filename));
      insertImg.run(imgId, listing.id, filename, url, existingCount + i, isPrimary, req.user.id);
      images.push({ id: imgId, url, filename, is_primary: isPrimary });
    }

    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,new_value)
      VALUES (?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'IMAGES_UPLOADED', 'listing', listing.id, `${req.files.length} images`);

    res.json({ images, message: `${req.files.length} image(s) uploaded` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

// DELETE /api/listings/:id/images/:imageId — Managers only
router.delete('/:id/images/:imageId', authenticate, requireMinRole('manager'), (req, res) => {
  try {
    const db = getDb();
    const img = db.prepare('SELECT * FROM listing_images WHERE id=? AND listing_id=?').get(req.params.imageId, req.params.id);
    if (!img) return res.status(404).json({ error: 'Image not found' });

    const fp = path.join(uploadDir, img.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    db.prepare('DELETE FROM listing_images WHERE id=?').run(img.id);

    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id)
      VALUES (?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'IMAGE_DELETED', 'listing', req.params.id);

    res.json({ message: 'Image deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// DELETE /api/listings/:id — Managers only
router.delete('/:id', authenticate, requireMinRole('manager'), (req, res) => {
  try {
    const db = getDb();
    const listing = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    db.prepare(`UPDATE listings SET status='cancelled', updated_by=?, updated_at=datetime('now') WHERE id=?`).run(req.user.id, listing.id);
    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,old_value)
      VALUES (?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'LISTING_CANCELLED', 'listing', listing.id, listing.title);

    res.json({ message: 'Listing cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel listing' });
  }
});

module.exports = router;
