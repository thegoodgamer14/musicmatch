import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  lastfm_username TEXT NOT NULL UNIQUE,
  lastfm_session_key TEXT NOT NULL,
  avatar_url TEXT,
  profile_url TEXT,
  profile_fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS now_playing (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  artist TEXT,
  track TEXT,
  album TEXT,
  artwork_url TEXT,
  is_now_playing INTEGER NOT NULL,
  song_key TEXT,
  recent_artists TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  attempted_at INTEGER NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS queue (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  song_key TEXT NOT NULL,
  artist TEXT NOT NULL,
  track TEXT NOT NULL,
  artwork_url TEXT,
  joined_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  song_key TEXT NOT NULL,
  artist TEXT NOT NULL,
  track TEXT NOT NULL,
  artwork_url TEXT,
  user_a_id INTEGER NOT NULL,
  user_b_id INTEGER NOT NULL,
  snapshot_a TEXT NOT NULL,
  snapshot_b TEXT NOT NULL,
  status TEXT NOT NULL,
  ended_by INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  sender_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairs (
  user_lo INTEGER NOT NULL,
  user_hi INTEGER NOT NULL,
  PRIMARY KEY (user_lo, user_hi)
);
`;

export function migrate(db: Database.Database): void {
  db.exec(SCHEMA);
}

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  migrate(db);
  return db;
}

let singleton: Database.Database | null = null;

export function getDb(): Database.Database {
  if (singleton) return singleton;
  const path = process.env.DATABASE_PATH || "data/musicmatch.db";
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  singleton = openDatabase(path);
  return singleton;
}
