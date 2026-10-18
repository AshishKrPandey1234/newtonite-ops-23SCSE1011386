import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './security.js';

export function openDatabase(path = process.env.DATABASE_PATH ?? './data/opsflow.sqlite') {
  const filename = path === ':memory:' ? path : resolve(path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });

  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'done')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
      created_by TEXT NOT NULL REFERENCES users(id),
      assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
    );
    CREATE INDEX IF NOT EXISTS work_items_status_updated_idx ON work_items(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS work_items_assignee_idx ON work_items(assignee_id);
  `);

  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!existing) {
      const { salt, hash } = hashPassword(password);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO users (id, email, display_name, role, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, 'admin', ?, ?, ?)`)
        .run(randomUUID(), email, email.split('@')[0], salt, hash, now);
    }
  }
  return db;
}
