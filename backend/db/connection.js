const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'leos_auctions.db');

let db;
function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

module.exports = { getDb };
