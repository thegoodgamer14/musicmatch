import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { NOW_PLAYING_TTL_MS, PRESENCE_MS } from "./constants";
import { openDatabase } from "./db";
import { tryPair } from "./matchmaker";
import { songKey } from "./song-key";

const NOW = 1_700_000_000_000;
const KEY = songKey("Radiohead", "Everything in Its Right Place");
const OTHER_KEY = songKey("Other Artist", "Other Track");

const dirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "musicmatch-"));
  dirs.push(dir);
  return join(dir, "app.db");
}

function open(path: string): Database.Database {
  const db = openDatabase(path);
  dbs.push(db);
  return db;
}

function tempDb(): Database.Database {
  return open(tempFile());
}

type Seed = {
  username: string;
  joinedAt: number;
  heartbeatAt?: number | null;
  nowPlayingKey?: string | null;
  queueKey?: string;
  fetchedAt?: number;
  isNowPlaying?: number;
  artist?: string;
  track?: string;
  artworkUrl?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  recentArtists?: string[];
};

function seedWaiting(db: Database.Database, seed: Seed): number {
  const queueKey = seed.queueKey ?? KEY;
  const artist = seed.artist ?? "Artist";
  const track = seed.track ?? "Track";
  const artworkUrl = seed.artworkUrl === undefined ? null : seed.artworkUrl;
  const inserted = db
    .prepare(
      `INSERT INTO users (
         lastfm_username, lastfm_session_key, avatar_url, profile_url, created_at, last_heartbeat_at
       ) VALUES (?, 'session', ?, ?, ?, ?)`,
    )
    .run(
      seed.username,
      seed.avatarUrl === undefined ? null : seed.avatarUrl,
      seed.profileUrl === undefined ? null : seed.profileUrl,
      NOW,
      seed.heartbeatAt === undefined ? NOW : seed.heartbeatAt,
    );
  const id = Number(inserted.lastInsertRowid);
  db.prepare(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    artist,
    track,
    artworkUrl,
    seed.isNowPlaying ?? 1,
    seed.nowPlayingKey === undefined ? queueKey : seed.nowPlayingKey,
    JSON.stringify(seed.recentArtists ?? []),
    seed.fetchedAt ?? NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO queue (user_id, song_key, artist, track, artwork_url, joined_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, queueKey, artist, track, artworkUrl, seed.joinedAt);
  return id;
}

type MatchRow = {
  id: number;
  song_key: string;
  artist: string;
  track: string;
  artwork_url: string | null;
  user_a_id: number;
  user_b_id: number;
  snapshot_a: string;
  snapshot_b: string;
  status: string;
  ended_by: number | null;
  created_at: number;
  ended_at: number | null;
};

function matchRows(db: Database.Database): MatchRow[] {
  return db.prepare("SELECT * FROM matches ORDER BY id").all() as MatchRow[];
}

function queuedIds(db: Database.Database): number[] {
  return (
    db.prepare("SELECT user_id FROM queue ORDER BY user_id").all() as { user_id: number }[]
  ).map((row) => row.user_id);
}

describe("tryPair", () => {
  it("pairs the longer wait ahead of someone who joined later", () => {
    const db = tempDb();
    const later = seedWaiting(db, {
      username: "later",
      joinedAt: 300,
      artist: "Later Artist",
      track: "Later Track",
      artworkUrl: "https://art/later",
    });
    const earliest = seedWaiting(db, {
      username: "dj/one",
      joinedAt: 100,
      artist: "Early Artist",
      track: "Early Track",
      artworkUrl: "https://art/early",
      avatarUrl: "https://img/early",
      recentArtists: ["Alpha", "Beta"],
    });
    const middle = seedWaiting(db, {
      username: "middle",
      joinedAt: 200,
      artist: "Middle Artist",
      track: "Middle Track",
      artworkUrl: "https://art/middle",
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/middle",
      recentArtists: ["Gamma"],
    });

    const id = tryPair(db, KEY, NOW);
    const rows = matchRows(db);

    expect(id).toBe(rows[0]?.id ?? null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      song_key: KEY,
      artist: "Early Artist",
      track: "Early Track",
      artwork_url: "https://art/early",
      user_a_id: earliest,
      user_b_id: middle,
      status: "active",
      ended_by: null,
      created_at: NOW,
      ended_at: null,
    });
    expect(JSON.parse(rows[0].snapshot_a)).toEqual({
      username: "dj/one",
      avatarUrl: "https://img/early",
      profileUrl: "https://www.last.fm/user/dj%2Fone",
      recentArtists: ["Alpha", "Beta"],
    });
    expect(JSON.parse(rows[0].snapshot_b)).toEqual({
      username: "middle",
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/middle",
      recentArtists: ["Gamma"],
    });
    expect(queuedIds(db)).toEqual([later]);
  });

  it("pairs the lower user id as user_a when joined_at is equal", () => {
    const db = tempDb();
    const low = seedWaiting(db, { username: "low", joinedAt: 50 });
    const mid = seedWaiting(db, { username: "mid", joinedAt: 50 });
    const high = seedWaiting(db, { username: "high", joinedAt: 50 });

    tryPair(db, KEY, NOW);

    expect(matchRows(db)[0]).toMatchObject({ user_a_id: low, user_b_id: mid });
    expect(queuedIds(db)).toEqual([high]);
  });

  it("skips a heartbeat older than 30 seconds and pairs the remaining two", () => {
    const db = tempDb();
    const stale = seedWaiting(db, {
      username: "stale-heart",
      joinedAt: 1,
      heartbeatAt: NOW - PRESENCE_MS,
    });
    const second = seedWaiting(db, { username: "second", joinedAt: 2 });
    const third = seedWaiting(db, { username: "third", joinedAt: 3 });

    tryPair(db, KEY, NOW);

    expect(matchRows(db)[0]).toMatchObject({ user_a_id: second, user_b_id: third });
    expect(queuedIds(db)).toEqual([stale]);
  });

  it("skips a mismatched now-playing key and a fetch older than 60 seconds", () => {
    const db = tempDb();
    const wrongSong = seedWaiting(db, {
      username: "wrong-song",
      joinedAt: 1,
      nowPlayingKey: OTHER_KEY,
    });
    const staleFetch = seedWaiting(db, {
      username: "stale-fetch",
      joinedAt: 2,
      fetchedAt: NOW - NOW_PLAYING_TTL_MS,
    });
    const first = seedWaiting(db, { username: "ok-a", joinedAt: 3 });
    const second = seedWaiting(db, { username: "ok-b", joinedAt: 4 });

    tryPair(db, KEY, NOW);

    expect(matchRows(db)[0]).toMatchObject({ user_a_id: first, user_b_id: second });
    expect(queuedIds(db)).toEqual([wrongSong, staleFetch]);
  });

  it("keeps a recorded pair queued and matches the third user with the longer waiter", () => {
    const db = tempDb();
    const longer = seedWaiting(db, { username: "longer", joinedAt: 10 });
    const shorter = seedWaiting(db, { username: "shorter", joinedAt: 20 });
    const third = seedWaiting(db, { username: "third", joinedAt: 30 });
    const lo = Math.min(longer, shorter);
    const hi = Math.max(longer, shorter);
    db.prepare("INSERT INTO pairs (user_lo, user_hi) VALUES (?, ?)").run(lo, hi);

    tryPair(db, KEY, NOW);

    expect(matchRows(db)[0]).toMatchObject({ user_a_id: longer, user_b_id: third });
    expect(queuedIds(db)).toEqual([shorter]);
    expect(db.prepare("SELECT user_lo, user_hi FROM pairs").all()).toEqual([
      { user_lo: lo, user_hi: hi },
    ]);
  });

  it("creates one match when tryPair is called twice", () => {
    const db = tempDb();
    seedWaiting(db, { username: "a", joinedAt: 1 });
    seedWaiting(db, { username: "b", joinedAt: 2 });

    const first = tryPair(db, KEY, NOW);
    const second = tryPair(db, KEY, NOW);

    expect(first).toEqual(expect.any(Number));
    expect(second).toBeNull();
    expect(matchRows(db)).toHaveLength(1);
    expect(queuedIds(db)).toEqual([]);
  });

  it("lets only one of two connections create a match", () => {
    const path = tempFile();
    const first = open(path);
    seedWaiting(first, { username: "a", joinedAt: 1 });
    seedWaiting(first, { username: "b", joinedAt: 2 });
    const second = open(path);

    const results = [tryPair(first, KEY, NOW), tryPair(second, KEY, NOW)];

    expect(results.filter((id) => id !== null)).toHaveLength(1);
    expect(matchRows(first)).toHaveLength(1);
    expect(matchRows(second)).toHaveLength(1);
  });

  it("does not put a user who already has an active match into a second one", () => {
    const db = tempDb();
    const busy = seedWaiting(db, { username: "busy", joinedAt: 1 });
    const left = seedWaiting(db, { username: "left", joinedAt: 2 });
    const right = seedWaiting(db, { username: "right", joinedAt: 3 });
    const outsider = db
      .prepare(
        "INSERT INTO users (lastfm_username, lastfm_session_key, created_at) VALUES ('outsider', 'k', ?)",
      )
      .run(NOW);
    const existing = db
      .prepare(
        `INSERT INTO matches (
           song_key, artist, track, artwork_url, user_a_id, user_b_id,
           snapshot_a, snapshot_b, status, created_at
         ) VALUES ('other', 'Z', 'Song', NULL, ?, ?, '{}', '{}', 'active', ?)`,
      )
      .run(Number(outsider.lastInsertRowid), busy, NOW - 10);

    const id = tryPair(db, KEY, NOW);
    const rows = matchRows(db);

    expect(id).not.toBe(Number(existing.lastInsertRowid));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ user_a_id: left, user_b_id: right, status: "active" });
    const busyMatches = db
      .prepare(
        `SELECT id FROM matches WHERE status = 'active' AND (user_a_id = ? OR user_b_id = ?)`,
      )
      .all(busy, busy);
    expect(busyMatches).toEqual([{ id: Number(existing.lastInsertRowid) }]);
    expect(queuedIds(db)).toEqual([busy]);
  });
});
