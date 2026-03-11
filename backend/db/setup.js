/**
 * Leo's Auctions - Database Setup
 * Run: node backend/db/setup.js
 */
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'leos_auctions.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('🗄️  Setting up Leo\'s Auctions database...');

db.exec(`
  -- ═══════════════════════════════════════
  -- USERS TABLE
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT,
    role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','employee','manager','owner')),
    is_verified INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    stripe_customer_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_login TEXT,
    created_by TEXT
  );

  -- ═══════════════════════════════════════
  -- CATEGORIES TABLE
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    icon TEXT DEFAULT '📦',
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );

  -- ═══════════════════════════════════════
  -- LISTINGS TABLE
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    category_id TEXT REFERENCES categories(id),
    condition TEXT NOT NULL CHECK(condition IN ('new','likenew','good','fair')),
    condition_label TEXT,
    retail_price REAL,
    starting_bid REAL DEFAULT 1,
    current_bid REAL DEFAULT 0,
    buy_now_price REAL,
    reserve_price REAL,
    bid_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','active','ended','sold','cancelled')),
    ends_at TEXT,
    pickup_date TEXT,
    sku TEXT,
    weight_lbs REAL,
    dimensions TEXT,
    notes TEXT,
    created_by TEXT REFERENCES users(id),
    updated_by TEXT REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══════════════════════════════════════
  -- LISTING IMAGES TABLE
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS listing_images (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    url TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_primary INTEGER DEFAULT 0,
    uploaded_by TEXT REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══════════════════════════════════════
  -- BIDS TABLE
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS bids (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    amount REAL NOT NULL,
    max_amount REAL,
    is_auto INTEGER DEFAULT 0,
    is_winning INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══════════════════════════════════════
  -- ORDERS TABLE
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    listing_id TEXT REFERENCES listings(id),
    order_type TEXT DEFAULT 'auction' CHECK(order_type IN ('auction','buynow')),
    subtotal REAL NOT NULL,
    buyers_premium REAL DEFAULT 0,
    tax REAL DEFAULT 0,
    total REAL NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','ready_pickup','picked_up','cancelled','refunded')),
    stripe_payment_intent_id TEXT,
    stripe_charge_id TEXT,
    payment_method_last4 TEXT,
    pickup_slot TEXT,
    picked_up_at TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══════════════════════════════════════
  -- DEAL ALERT SUBSCRIBERS (replaces Wish List)
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS deal_alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    email TEXT,
    category_id TEXT REFERENCES categories(id),
    keyword TEXT,
    max_price REAL,
    condition_filter TEXT,
    is_active INTEGER DEFAULT 1,
    notify_email INTEGER DEFAULT 1,
    notify_sms INTEGER DEFAULT 0,
    last_notified_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══════════════════════════════════════
  -- AUDIT LOG TABLE (Owner-only view)
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    user_email TEXT,
    user_role TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    field_changed TEXT,
    old_value TEXT,
    new_value TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══════════════════════════════════════
  -- PICKUP SLOTS TABLE
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS pickup_slots (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    max_capacity INTEGER DEFAULT 10,
    booked_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );

  -- ═══════════════════════════════════════
  -- SAVED LISTINGS (customer's saved items)
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS saved_listings (
    user_id TEXT REFERENCES users(id),
    listing_id TEXT REFERENCES listings(id),
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, listing_id)
  );

  -- INDEXES
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category_id);
  CREATE INDEX IF NOT EXISTS idx_listings_ends_at ON listings(ends_at);
  CREATE INDEX IF NOT EXISTS idx_bids_listing ON bids(listing_id);
  CREATE INDEX IF NOT EXISTS idx_bids_user ON bids(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_deal_alerts_user ON deal_alerts(user_id);
`);

// ── Seed categories ──────────────────────────────────────
const insertCat = db.prepare(`
  INSERT OR IGNORE INTO categories (id, name, slug, icon, sort_order)
  VALUES (?, ?, ?, ?, ?)
`);
const categories = [
  ['cat-electronics','Electronics','electronics','📺',1],
  ['cat-furniture','Furniture','furniture','🛋',2],
  ['cat-appliances','Appliances','appliances','🍳',3],
  ['cat-tools','Tools & Hardware','tools','🔧',4],
  ['cat-toys','Toys & Games','toys','🧸',5],
  ['cat-clothing','Clothing & Shoes','clothing','👟',6],
  ['cat-sports','Sports & Fitness','sports','🏋',7],
  ['cat-mystery','Mystery Lots','mystery','🎁',8],
];
categories.forEach(c => insertCat.run(...c));

// ── Seed default owner account ────────────────────────────
const { v4: uuidv4 } = require('uuid');
const ownerExists = db.prepare('SELECT id FROM users WHERE email = ?').get('owner@leosauctions.com');
if (!ownerExists) {
  const hash = bcrypt.hashSync('LeoOwner2026!', 12);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_verified)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(uuidv4(), 'owner@leosauctions.com', hash, 'Leo', 'Owner', 'owner');
  console.log('✅  Owner account created: owner@leosauctions.com / LeoOwner2026!');
}

// ── Seed demo manager ────────────────────────────────────
const managerExists = db.prepare('SELECT id FROM users WHERE email = ?').get('manager@leosauctions.com');
if (!managerExists) {
  const hash = bcrypt.hashSync('LeoManager2026!', 12);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_verified)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(uuidv4(), 'manager@leosauctions.com', hash, 'Demo', 'Manager', 'manager');
  console.log('✅  Manager account: manager@leosauctions.com / LeoManager2026!');
}

// ── Seed demo employee ───────────────────────────────────
const empExists = db.prepare('SELECT id FROM users WHERE email = ?').get('employee@leosauctions.com');
if (!empExists) {
  const hash = bcrypt.hashSync('LeoEmployee2026!', 12);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_verified)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(uuidv4(), 'employee@leosauctions.com', hash, 'Demo', 'Employee', 'employee');
  console.log('✅  Employee account: employee@leosauctions.com / LeoEmployee2026!');
}

// ── Seed pickup slots ────────────────────────────────────
const slotInsert = db.prepare(`INSERT OR IGNORE INTO pickup_slots (id,date,time_slot,max_capacity) VALUES (?,?,?,?)`);
const slots = [
  ['2026-03-15 09:00','2026-03-15','9:00 AM - 10:00 AM',8],
  ['2026-03-15 10:00','2026-03-15','10:00 AM - 11:00 AM',8],
  ['2026-03-15 11:00','2026-03-15','11:00 AM - 12:00 PM',8],
  ['2026-03-15 12:00','2026-03-15','12:00 PM - 1:00 PM',6],
  ['2026-03-15 13:00','2026-03-15','1:00 PM - 2:00 PM',8],
  ['2026-03-15 14:00','2026-03-15','2:00 PM - 3:00 PM',8],
  ['2026-03-15 15:00','2026-03-15','3:00 PM - 4:00 PM',6],
  ['2026-03-22 09:00','2026-03-22','9:00 AM - 10:00 AM',8],
  ['2026-03-22 10:00','2026-03-22','10:00 AM - 11:00 AM',8],
  ['2026-03-22 11:00','2026-03-22','11:00 AM - 12:00 PM',8],
];
slots.forEach(s => slotInsert.run(...s));

db.close();
console.log('✅  Database setup complete!');
console.log('📁  Database location:', DB_PATH);
console.log('\n🚀  Run: npm start');
