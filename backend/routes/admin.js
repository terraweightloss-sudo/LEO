const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { authenticate, requireMinRole, requireRole } = require('../middleware/auth');

// All admin routes require at least employee role
router.use(authenticate);
router.use(requireMinRole('employee'));

// ══════════════════════════════════════════════════════════
// DASHBOARD STATS
// ══════════════════════════════════════════════════════════
router.get('/dashboard', (req, res) => {
  try {
    const db = getDb();
    const isManager = ['manager','owner'].includes(req.user.role);

    const stats = {
      active_listings: db.prepare("SELECT COUNT(*) as c FROM listings WHERE status='active'").get().c,
      draft_listings: db.prepare("SELECT COUNT(*) as c FROM listings WHERE status='draft'").get().c,
      ended_listings: db.prepare("SELECT COUNT(*) as c FROM listings WHERE status='ended'").get().c,
      total_bids_today: db.prepare("SELECT COUNT(*) as c FROM bids WHERE date(created_at)=date('now')").get().c,
    };

    if (isManager) {
      stats.pending_orders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending'").get().c;
      stats.paid_orders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='paid'").get().c;
      stats.revenue_today = db.prepare("SELECT COALESCE(SUM(total),0) as s FROM orders WHERE status='paid' AND date(updated_at)=date('now')").get().s;
      stats.revenue_week = db.prepare("SELECT COALESCE(SUM(total),0) as s FROM orders WHERE status='paid' AND updated_at >= datetime('now','-7 days')").get().s;
      stats.total_users = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='customer'").get().c;
      stats.deal_alert_subscribers = db.prepare("SELECT COUNT(*) as c FROM deal_alerts WHERE is_active=1").get().c;
    }

    const ending_soon = db.prepare(`
      SELECT l.*, c.icon as category_icon,
        (SELECT url FROM listing_images WHERE listing_id=l.id LIMIT 1) as image
      FROM listings l LEFT JOIN categories c ON l.category_id=c.id
      WHERE l.status='active' AND l.ends_at IS NOT NULL
      ORDER BY l.ends_at ASC LIMIT 5
    `).all();

    const recent_bids = db.prepare(`
      SELECT b.*, l.title, u.first_name||' '||u.last_name as user_name
      FROM bids b JOIN listings l ON b.listing_id=l.id JOIN users u ON b.user_id=u.id
      ORDER BY b.created_at DESC LIMIT 10
    `).all();

    res.json({ stats, ending_soon, recent_bids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ══════════════════════════════════════════════════════════
// ALL LISTINGS (staff view with full details)
// ══════════════════════════════════════════════════════════
router.get('/listings', (req, res) => {
  try {
    const db = getDb();
    const { status, category, search, page = 1, limit = 50 } = req.query;
    let where = ['1=1'];
    let params = [];
    if (status) { where.push('l.status=?'); params.push(status); }
    if (category) { where.push('c.slug=?'); params.push(category); }
    if (search) { where.push('(l.title LIKE ? OR l.sku LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

    const offset = (parseInt(page)-1) * parseInt(limit);
    const listings = db.prepare(`
      SELECT l.*, c.name as category_name, c.icon as category_icon,
        u1.first_name||' '||u1.last_name as created_by_name,
        u2.first_name||' '||u2.last_name as updated_by_name,
        (SELECT url FROM listing_images WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) as image
      FROM listings l
      LEFT JOIN categories c ON l.category_id=c.id
      LEFT JOIN users u1 ON l.created_by=u1.id
      LEFT JOIN users u2 ON l.updated_by=u2.id
      WHERE ${where.join(' AND ')}
      ORDER BY l.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const total = db.prepare(`SELECT COUNT(*) as c FROM listings l LEFT JOIN categories c ON l.category_id=c.id WHERE ${where.join(' AND ')}`).get(...params).c;
    res.json({ listings, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// ══════════════════════════════════════════════════════════
// ORDERS MANAGEMENT (manager+)
// ══════════════════════════════════════════════════════════
router.get('/orders', requireMinRole('manager'), (req, res) => {
  try {
    const db = getDb();
    const { status, page = 1, limit = 50 } = req.query;
    let where = ['1=1'];
    let params = [];
    if (status) { where.push('o.status=?'); params.push(status); }

    const offset = (parseInt(page)-1)*parseInt(limit);
    const orders = db.prepare(`
      SELECT o.*, u.first_name||' '||u.last_name as customer_name, u.email as customer_email, u.phone as customer_phone,
        l.title as listing_title
      FROM orders o JOIN users u ON o.user_id=u.id LEFT JOIN listings l ON o.listing_id=l.id
      WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const total = db.prepare(`SELECT COUNT(*) as c FROM orders o WHERE ${where.join(' AND ')}`).get(...params).c;
    res.json({ orders, total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.put('/orders/:id', requireMinRole('manager'), (req, res) => {
  try {
    const { status, notes, picked_up_at } = req.body;
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const updates = {};
    if (status) updates.status = status;
    if (notes) updates.notes = notes;
    if (picked_up_at) updates.picked_up_at = picked_up_at;

    if (Object.keys(updates).length) {
      const setClauses = Object.keys(updates).map(k=>`${k}=?`).join(',');
      db.prepare(`UPDATE orders SET ${setClauses}, updated_at=datetime('now') WHERE id=?`).run(...Object.values(updates), order.id);
    }

    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,field_changed,old_value,new_value)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'ORDER_UPDATED', 'order', order.id, 'status', order.status, status||order.status);

    res.json({ order: db.prepare('SELECT * FROM orders WHERE id=?').get(order.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// ══════════════════════════════════════════════════════════
// USERS MANAGEMENT (manager+)
// ══════════════════════════════════════════════════════════
router.get('/users', requireMinRole('manager'), (req, res) => {
  try {
    const db = getDb();
    const { role, search, page = 1, limit = 50 } = req.query;
    let where = ['1=1'];
    let params = [];
    if (role) { where.push('u.role=?'); params.push(role); }
    if (search) { where.push('(u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)'); params.push(`%${search}%`,`%${search}%`,`%${search}%`); }

    const offset = (parseInt(page)-1)*parseInt(limit);
    const users = db.prepare(`
      SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.role, u.is_active, u.is_verified,
        u.created_at, u.last_login,
        (SELECT COUNT(*) FROM bids WHERE user_id=u.id) as bid_count,
        (SELECT COUNT(*) FROM orders WHERE user_id=u.id) as order_count
      FROM users u WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const total = db.prepare(`SELECT COUNT(*) as c FROM users u WHERE ${where.join(' AND ')}`).get(...params).c;
    res.json({ users, total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.put('/users/:id/role', requireRole('owner'), (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['customer','employee','manager'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.prepare(`UPDATE users SET role=?, updated_at=datetime('now') WHERE id=?`).run(role, user.id);
    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,field_changed,old_value,new_value)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'USER_ROLE_CHANGED', 'user', user.id, 'role', user.role, role);

    res.json({ message: `User role updated to ${role}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

router.put('/users/:id/status', requireMinRole('manager'), (req, res) => {
  try {
    const { is_active } = req.body;
    const db = getDb();
    db.prepare(`UPDATE users SET is_active=?, updated_at=datetime('now') WHERE id=?`).run(is_active ? 1 : 0, req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,new_value)
      VALUES (?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, is_active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'user', req.params.id, u.email);
    res.json({ message: `User ${is_active ? 'activated' : 'deactivated'}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

// DELETE /admin/users/:id — Owner only, cannot delete owners
router.delete('/users/:id', requireRole('owner'), (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot delete owner accounts' });
    if (user.id === req.user.id) return res.status(403).json({ error: 'Cannot delete your own account' });
    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,old_value)
      VALUES (?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'USER_DELETED', 'user', user.id, user.email);
    db.prepare('DELETE FROM bids WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM deal_alerts WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM saved_listings WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM users WHERE id=?').run(user.id);
    res.json({ message: `User ${user.email} deleted` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ══════════════════════════════════════════════════════════
// AUDIT LOG (owner only)
// ══════════════════════════════════════════════════════════
router.get('/audit-log', requireRole('owner'), (req, res) => {
  try {
    const db = getDb();
    const { user_id, action, entity_type, date_from, date_to, page = 1, limit = 100 } = req.query;
    let where = ['1=1'];
    let params = [];
    if (user_id) { where.push('a.user_id=?'); params.push(user_id); }
    if (action) { where.push('a.action LIKE ?'); params.push(`%${action}%`); }
    if (entity_type) { where.push('a.entity_type=?'); params.push(entity_type); }
    if (date_from) { where.push('a.created_at >= ?'); params.push(date_from); }
    if (date_to) { where.push('a.created_at <= ?'); params.push(date_to); }

    const offset = (parseInt(page)-1)*parseInt(limit);
    const logs = db.prepare(`
      SELECT a.*, u.first_name||' '||u.last_name as full_name
      FROM audit_log a LEFT JOIN users u ON a.user_id=u.id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const total = db.prepare(`SELECT COUNT(*) as c FROM audit_log a WHERE ${where.join(' AND ')}`).get(...params).c;
    res.json({ logs, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ══════════════════════════════════════════════════════════
// DEAL ALERT SUBSCRIBERS (manager+)
// ══════════════════════════════════════════════════════════
router.get('/deal-alerts', requireMinRole('manager'), (req, res) => {
  try {
    const db = getDb();
    const alerts = db.prepare(`
      SELECT da.*, u.email as user_email, u.first_name, u.last_name, c.name as category_name
      FROM deal_alerts da
      LEFT JOIN users u ON da.user_id=u.id
      LEFT JOIN categories c ON da.category_id=c.id
      WHERE da.is_active=1
      ORDER BY da.created_at DESC
    `).all();
    res.json({ alerts, total: alerts.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch deal alerts' });
  }
});

// ══════════════════════════════════════════════════════════
// PICKUP SLOTS (manager+)
// ══════════════════════════════════════════════════════════
router.get('/pickup-slots', (req, res) => {
  try {
    const db = getDb();
    const slots = db.prepare(`
      SELECT ps.*, 
        (SELECT COUNT(*) FROM orders WHERE pickup_slot LIKE '%'||ps.time_slot||'%' AND status IN ('ready_pickup','picked_up')) as booked
      FROM pickup_slots ps WHERE ps.is_active=1 ORDER BY ps.date, ps.time_slot
    `).all();
    res.json({ slots });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

router.post('/pickup-slots', requireMinRole('manager'), (req, res) => {
  try {
    const { date, time_slot, max_capacity } = req.body;
    const db = getDb();
    const id = `${date} ${time_slot}`;
    db.prepare(`INSERT OR IGNORE INTO pickup_slots (id,date,time_slot,max_capacity) VALUES (?,?,?,?)`).run(id, date, time_slot, max_capacity || 8);
    res.status(201).json({ message: 'Pickup slot created' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create slot' });
  }
});

// CATEGORIES
router.get('/categories', (req, res) => {
  try {
    const db = getDb();
    const cats = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM listings WHERE category_id=c.id AND status='active') as active_count FROM categories c ORDER BY sort_order`).all();
    res.json({ categories: cats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

module.exports = router;
