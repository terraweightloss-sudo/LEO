const jwt = require('jsonwebtoken');
const { getDb } = require('../db/connection');

const JWT_SECRET = process.env.JWT_SECRET || 'leos-auctions-dev-secret-change-in-production';

// ── Verify JWT token ─────────────────────────────────────
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found or inactive' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Optional auth (attaches user if token present) ───────
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    req.user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(decoded.id);
  } catch (_) {}
  next();
}

// ── Role guards ──────────────────────────────────────────
const ROLE_LEVELS = { customer: 0, employee: 1, manager: 2, owner: 3 };

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Required: ${roles.join(' or ')}` });
    }
    next();
  };
}

function requireMinRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (ROLE_LEVELS[req.user.role] < ROLE_LEVELS[minRole]) {
      return res.status(403).json({ error: `Access denied. Minimum role required: ${minRole}` });
    }
    next();
  };
}

// ── Audit logger middleware ──────────────────────────────
function auditLog(action, entityType, getEntityId, getChanges) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      if (res.statusCode < 300 && req.user) {
        try {
          const db = getDb();
          const { v4: uuidv4 } = require('uuid');
          const entityId = typeof getEntityId === 'function' ? getEntityId(req, data) : getEntityId;
          const changes = typeof getChanges === 'function' ? getChanges(req, data) : null;
          db.prepare(`
            INSERT INTO audit_log (id, user_id, user_email, user_role, action, entity_type, entity_id, field_changed, old_value, new_value, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            uuidv4(),
            req.user.id,
            req.user.email,
            req.user.role,
            action,
            entityType,
            entityId || null,
            changes?.field || null,
            changes?.old != null ? String(changes.old) : null,
            changes?.new != null ? String(changes.new) : null,
            req.ip,
            req.headers['user-agent']?.substring(0, 200) || null
          );
        } catch (err) {
          console.error('Audit log error:', err.message);
        }
      }
      return originalJson(data);
    };
    next();
  };
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = { authenticate, optionalAuth, requireRole, requireMinRole, auditLog, generateToken, JWT_SECRET };
