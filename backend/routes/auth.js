const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { generateToken, authenticate } = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, first_name, last_name, phone, address } = req.body;
    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json({ error: 'Email, password, first name, and last name are required' });
    }
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    if (!address) return res.status(400).json({ error: 'Address is required' });
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const password_hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, first_name, last_name, phone, address, role, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'customer', 1)
    `).run(id, email.toLowerCase(), password_hash, first_name.trim(), last_name.trim(), phone || null, address || null);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    const token = generateToken(user);

    // Log audit
    db.prepare(`INSERT INTO audit_log (id, user_id, user_email, user_role, action, entity_type, entity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), id, email, 'customer', 'USER_REGISTERED', 'user', id);

    res.status(201).json({
      token,
      user: sanitizeUser(user),
      message: 'Account created successfully'
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    db.prepare(`INSERT INTO audit_log (id, user_id, user_email, user_role, action, entity_type, entity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), user.id, user.email, user.role, 'USER_LOGIN', 'user', user.id);

    const token = generateToken(user);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

// PUT /api/auth/profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { first_name, last_name, phone } = req.body;
    const db = getDb();
    db.prepare(`UPDATE users SET first_name=?, last_name=?, phone=?, updated_at=datetime('now') WHERE id=?`)
      .run(first_name, last_name, phone || null, req.user.id);
    const updated = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    res.json({ user: sanitizeUser(updated), message: 'Profile updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// PUT /api/auth/password
router.put('/password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    db.prepare(`UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?`).run(hash, req.user.id);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// ── Admin: create staff accounts ────────────────────────
router.post('/create-staff', authenticate, async (req, res) => {
  try {
    if (!['owner', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only owners and managers can create staff accounts' });
    }
    const { email, password, first_name, last_name, phone, role } = req.body;
    if (!email || !password || !first_name || !last_name || !role) {
      return res.status(400).json({ error: 'All fields required' });
    }
    // Managers can only create employees; owners can create managers and employees
    if (req.user.role === 'manager' && role !== 'employee') {
      return res.status(403).json({ error: 'Managers can only create employee accounts' });
    }
    if (!['employee','manager'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Use employee or manager.' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    db.prepare(`INSERT INTO users (id,email,password_hash,first_name,last_name,phone,role,is_verified,created_by)
      VALUES (?,?,?,?,?,?,?,1,?)`).run(id, email.toLowerCase(), hash, first_name, last_name, phone||null, role, req.user.id);

    db.prepare(`INSERT INTO audit_log (id,user_id,user_email,user_role,action,entity_type,entity_id,new_value)
      VALUES (?,?,?,?,?,?,?,?)`).run(uuidv4(), req.user.id, req.user.email, req.user.role, 'STAFF_CREATED', 'user', id, `role:${role}`);

    const newUser = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    res.status(201).json({ user: sanitizeUser(newUser), message: `${role} account created` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create staff account' });
  }
});

function sanitizeUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

module.exports = router;
