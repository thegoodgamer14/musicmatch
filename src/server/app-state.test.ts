import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  cancelQueue,
  joinQueue,
  leaveMatch,
  logout,
  readState,
  sendMessage,
} from "./app-state";
import { NOW_PLAYING_TTL_MS, PRESENCE_MS } from "./constants";
import { COPY } from "./copy";
import { openDatabase } from "./db";
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

function tempDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "musicmatch-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "app.db"));
  dbs.push(db);
  return db;
}

type CacheSeed = {
  artist?: string | null;
  track?: string | null;
  artworkUrl?: string | null;
  isNowPlaying?: number;
  songKey?: string | null;
  fetchedAt?: number;
  error?: string | null;
  recentArtists?: string[];
};

type UserSeed = {
  username: string;
  heartbeatAt?: number | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  cache?: CacheSeed | null;
};

function seedUser(db: Database.Database, seed: UserSeed): { userId: number; sessionId: string } {
  const inserted = db
    .prepare(
      `INSERT INTO users (
         lastfm_username, lastfm_session_key, avatar_url, profile_url, created_at, last_heartbeat_at
       ) VALUES (?, 'session-key', ?, ?, ?, ?)`,
    )
    .run(
      seed.username,
      seed.avatarUrl === undefined ? null : seed.avatarUrl,
      seed.profileUrl === undefined ? null : seed.profileUrl,
      NOW,
      seed.heartbeatAt === undefined ? NOW : seed.heartbeatAt,
    );
  const userId = Number(inserted.lastInsertRowid);
  const sessionId = `session-${seed.username}`;
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    sessionId,
    userId,
    NOW + 1_000_000_000,
  );
  if (seed.cache !== null) {
    const cache = seed.cache ?? {};
    const artist = cache.artist === undefined ? "Radiohead" : cache.artist;
    const track = cache.track === undefined ? "Everything in Its Right Place" : cache.track;
    const key =
      cache.songKey === undefined ? (artist && track ? songKey(artist, track) : null) : cache.songKey;
    db.prepare(
      `INSERT INTO now_playing (
         user_id, artist, track, album, artwork_url, is_now_playing, song_key,
         recent_artists, fetched_at, attempted_at, error
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      artist,
      track,
      cache.artworkUrl === undefined ? "https://art/default" : cache.artworkUrl,
      cache.isNowPlaying ?? 1,
      key,
      JSON.stringify(cache.recentArtists ?? ["Radiohead"]),
      cache.fetchedAt ?? NOW,
      NOW,
      cache.error === undefined ? null : cache.error,
    );
  }
  return { userId, sessionId };
}

function queueRow(db: Database.Database, userId: number) {
  return db.prepare("SELECT song_key, artist, track, artwork_url, joined_at FROM queue WHERE user_id = ?").get(
    userId,
  ) as
    | {
        song_key: string;
        artist: string;
        track: string;
        artwork_url: string | null;
        joined_at: number;
      }
    | undefined;
}

function insertQueue(
  db: Database.Database,
  userId: number,
  joinedAt: number,
  song = KEY,
  artist = "Radiohead",
  track = "Everything in Its Right Place",
  artwork: string | null = "https://art/default",
): void {
  db.prepare(
    `INSERT INTO queue (user_id, song_key, artist, track, artwork_url, joined_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, song, artist, track, artwork, joinedAt);
}

describe("leave, rematch, and a third listener", () => {
  it("sends both people home, blocks that pair, and matches the earlier waiter with someone new", () => {
    const db = tempDb();
    const low = seedUser(db, {
      username: "low",
      avatarUrl: "https://img/low",
      profileUrl: "https://www.last.fm/user/low",
      cache: { recentArtists: ["Low Recent"] },
    });
    const high = seedUser(db, {
      username: "high",
      avatarUrl: "https://img/high",
      profileUrl: "https://www.last.fm/user/high",
      cache: { recentArtists: ["High Recent"] },
    });

    expect(joinQueue(db, high.userId, NOW)).toBe("waiting");
    expect(joinQueue(db, low.userId, NOW + 1)).toBe("matched");
    expect(joinQueue(db, high.userId, NOW + 1)).toBe("in_chat");
    expect(queueRow(db, high.userId)).toBeUndefined();
    expect(queueRow(db, low.userId)).toBeUndefined();

    expect(leaveMatch(db, low.userId, NOW + 2)).toEqual({ ended: true });
    expect(leaveMatch(db, high.userId, NOW + 3)).toEqual({ ended: false });
    expect(readState(db, low.sessionId, NOW + 3, 0)).toMatchObject({ view: "home" });
    expect(readState(db, high.sessionId, NOW + 3, 0)).toMatchObject({ view: "home" });
    expect(db.prepare("SELECT status, ended_by, ended_at FROM matches").get()).toEqual({
      status: "ended",
      ended_by: low.userId,
      ended_at: NOW + 2,
    });
    expect(db.prepare("SELECT user_lo, user_hi FROM pairs").all()).toEqual([
      { user_lo: low.userId, user_hi: high.userId },
    ]);

    expect(joinQueue(db, high.userId, NOW + 10)).toBe("waiting");
    expect(joinQueue(db, low.userId, NOW + 11)).toBe("waiting");
    expect(db.prepare("SELECT status FROM matches WHERE status = 'active'").all()).toEqual([]);

    const third = seedUser(db, {
      username: "third",
      avatarUrl: "https://img/third",
      profileUrl: "https://www.last.fm/user/third",
      cache: { recentArtists: ["Third Recent"] },
    });
    expect(joinQueue(db, third.userId, NOW + 12)).toBe("matched");
    expect(readState(db, third.sessionId, NOW + 12, 0)).toMatchObject({
      view: "chat",
      selfId: third.userId,
      partner: { username: "high" },
    });
    expect(readState(db, high.sessionId, NOW + 12, 0)).toMatchObject({
      view: "chat",
      partner: { username: "third" },
    });
    expect(readState(db, low.sessionId, NOW + 12, 0)).toMatchObject({ view: "waiting" });
    expect(queueRow(db, low.userId)?.joined_at).toBe(NOW + 11);
    expect(db.prepare("SELECT user_a_id, user_b_id, status FROM matches WHERE status = 'active'").get()).toEqual({
      user_a_id: high.userId,
      user_b_id: third.userId,
      status: "active",
    });
    expect(db.prepare("SELECT user_lo, user_hi FROM pairs").all()).toEqual([
      { user_lo: low.userId, user_hi: high.userId },
    ]);
  });
});

describe("messages", () => {
  it("refuses empty and 501-character bodies, a message after leave, and an outsider", () => {
    const db = tempDb();
    const alpha = seedUser(db, { username: "alpha" });
    const beta = seedUser(db, { username: "beta" });
    const outsider = seedUser(db, { username: "outsider" });
    joinQueue(db, alpha.userId, NOW);
    joinQueue(db, beta.userId, NOW + 1);

    expect(sendMessage(db, alpha.userId, "   ", NOW + 2)).toEqual({ ok: false, error: "empty" });
    expect(sendMessage(db, outsider.userId, "  ", NOW + 2)).toEqual({ ok: false, error: "empty" });
    expect(sendMessage(db, alpha.userId, "a".repeat(501), NOW + 2)).toEqual({
      ok: false,
      error: "too_long",
    });
    expect(sendMessage(db, alpha.userId, ` ${"b".repeat(501)} `, NOW + 2)).toEqual({
      ok: false,
      error: "too_long",
    });

    const accepted = sendMessage(db, alpha.userId, "c".repeat(500), NOW + 3);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(
      db.prepare("SELECT body FROM messages WHERE id = ?").get(accepted.id),
    ).toEqual({ body: "c".repeat(500) });

    const trimmed = sendMessage(db, beta.userId, "  hello  ", NOW + 4);
    expect(trimmed).toEqual({ ok: true, id: accepted.id + 1 });
    if (!trimmed.ok) return;
    expect(db.prepare("SELECT body, sender_id, created_at FROM messages WHERE id = ?").get(trimmed.id)).toEqual({
      body: "hello",
      sender_id: beta.userId,
      created_at: NOW + 4,
    });

    const state = readState(db, alpha.sessionId, NOW + 4, 0);
    expect(state).toMatchObject({
      view: "chat",
      messages: [
        { id: accepted.id, senderId: alpha.userId, body: "c".repeat(500), createdAt: NOW + 3 },
        { id: trimmed.id, senderId: beta.userId, body: "hello", createdAt: NOW + 4 },
      ],
    });
    expect(readState(db, alpha.sessionId, NOW + 4, accepted.id)).toMatchObject({
      view: "chat",
      messages: [{ id: trimmed.id, senderId: beta.userId, body: "hello", createdAt: NOW + 4 }],
    });

    expect(leaveMatch(db, alpha.userId, NOW + 5)).toEqual({ ended: true });
    expect(sendMessage(db, beta.userId, "after", NOW + 6)).toEqual({ ok: false, error: "no_match" });
    expect(sendMessage(db, outsider.userId, "nope", NOW + 6)).toEqual({ ok: false, error: "no_match" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 2 });
  });
});

describe("logout", () => {
  it("removes that session and queue row without ending the active match", () => {
    const db = tempDb();
    const alpha = seedUser(db, { username: "alpha" });
    const beta = seedUser(db, { username: "beta" });
    const waiting = seedUser(db, { username: "waiting" });
    joinQueue(db, alpha.userId, NOW);
    joinQueue(db, beta.userId, NOW + 1);
    insertQueue(db, alpha.userId, NOW + 2);
    insertQueue(db, waiting.userId, NOW + 2, OTHER_KEY, "Other Artist", "Other Track", null);
    const otherSession = "alpha-other";
    db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
      otherSession,
      alpha.userId,
      NOW + 1_000_000_000,
    );

    logout(db, alpha.sessionId);

    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(alpha.sessionId)).toBeUndefined();
    expect(queueRow(db, alpha.userId)).toBeUndefined();
    expect(queueRow(db, waiting.userId)?.song_key).toBe(OTHER_KEY);
    expect(db.prepare("SELECT status FROM matches").get()).toEqual({ status: "active" });
    expect(readState(db, alpha.sessionId, NOW + 3, 0)).toEqual({ view: "signed_out", error: null });
    expect(readState(db, otherSession, NOW + 3, 0)).toMatchObject({
      view: "chat",
      selfId: alpha.userId,
      partner: { username: "beta" },
    });
    expect(readState(db, beta.sessionId, NOW + 3, 0)).toMatchObject({ view: "chat" });
  });
});

describe("joinQueue", () => {
  it("keeps joined_at when the same song is already queued and does not pair on that repeat", () => {
    const db = tempDb();
    const alpha = seedUser(db, { username: "alpha" });
    const beta = seedUser(db, { username: "beta" });
    expect(joinQueue(db, alpha.userId, NOW)).toBe("waiting");
    insertQueue(db, beta.userId, NOW + 1);

    expect(joinQueue(db, alpha.userId, NOW + 5)).toBe("waiting");
    expect(queueRow(db, alpha.userId)?.joined_at).toBe(NOW);
    expect(db.prepare("SELECT id FROM matches").all()).toEqual([]);
    expect(queueRow(db, beta.userId)?.joined_at).toBe(NOW + 1);
  });

  it("replaces the queue row when the cached song changes", () => {
    const db = tempDb();
    const alpha = seedUser(db, {
      username: "alpha",
      cache: { artist: "Radiohead", track: "Everything in Its Right Place", artworkUrl: "https://art/first" },
    });
    expect(joinQueue(db, alpha.userId, NOW)).toBe("waiting");
    db.prepare(
      `UPDATE now_playing
       SET artist = ?, track = ?, artwork_url = ?, song_key = ?, is_now_playing = 1, fetched_at = ?
       WHERE user_id = ?`,
    ).run("Other Artist", "Other Track", null, OTHER_KEY, NOW + 5, alpha.userId);

    expect(joinQueue(db, alpha.userId, NOW + 5)).toBe("waiting");
    expect(queueRow(db, alpha.userId)).toEqual({
      song_key: OTHER_KEY,
      artist: "Other Artist",
      track: "Other Track",
      artwork_url: null,
      joined_at: NOW + 5,
    });
  });

  it("returns in_chat during an active match and does not insert a queue row", () => {
    const db = tempDb();
    const alpha = seedUser(db, { username: "alpha" });
    const beta = seedUser(db, { username: "beta" });
    joinQueue(db, alpha.userId, NOW);
    joinQueue(db, beta.userId, NOW + 1);
    db.prepare("DELETE FROM now_playing WHERE user_id = ?").run(alpha.userId);

    expect(joinQueue(db, alpha.userId, NOW + 2)).toBe("in_chat");
    expect(queueRow(db, alpha.userId)).toBeUndefined();
  });

  it("returns unavailable and does not write a queue row when the cache cannot be matched", () => {
    const db = tempDb();
    const missing = seedUser(db, { username: "missing", cache: null });
    const stopped = seedUser(db, { username: "stopped", cache: { isNowPlaying: 0, artist: "Old", track: "Song" } });
    const stale = seedUser(db, {
      username: "stale",
      cache: { fetchedAt: NOW - NOW_PLAYING_TTL_MS },
    });
    const privateTracks = seedUser(db, {
      username: "private",
      cache: {
        error: "private",
        isNowPlaying: 1,
        artist: "Secret",
        track: "Hidden",
        fetchedAt: NOW,
      },
    });
    const freshEdge = seedUser(db, {
      username: "edge",
      cache: { fetchedAt: NOW - NOW_PLAYING_TTL_MS + 1 },
    });

    for (const user of [missing, stopped, stale, privateTracks]) {
      expect(joinQueue(db, user.userId, NOW)).toBe("unavailable");
      expect(queueRow(db, user.userId)).toBeUndefined();
    }
    expect(joinQueue(db, freshEdge.userId, NOW)).toBe("waiting");
    expect(queueRow(db, freshEdge.userId)?.joined_at).toBe(NOW);
  });

  it("stays unavailable when a queued cache goes stale and leaves the existing row alone", () => {
    const db = tempDb();
    const alpha = seedUser(db, { username: "alpha" });
    expect(joinQueue(db, alpha.userId, NOW)).toBe("waiting");
    db.prepare("UPDATE now_playing SET fetched_at = ? WHERE user_id = ?").run(
      NOW + 70_000 - NOW_PLAYING_TTL_MS,
      alpha.userId,
    );

    expect(joinQueue(db, alpha.userId, NOW + 70_000)).toBe("unavailable");
    expect(queueRow(db, alpha.userId)?.joined_at).toBe(NOW);
  });

  it("does not report matched when tryPair pairs two earlier waiters", () => {
    const db = tempDb();
    const early = seedUser(db, { username: "early" });
    const middle = seedUser(db, { username: "middle" });
    const late = seedUser(db, { username: "late" });
    insertQueue(db, early.userId, NOW);
    insertQueue(db, middle.userId, NOW + 1);

    expect(joinQueue(db, late.userId, NOW + 2)).toBe("waiting");
    expect(queueRow(db, late.userId)?.joined_at).toBe(NOW + 2);
    expect(db.prepare("SELECT user_a_id, user_b_id FROM matches").get()).toEqual({
      user_a_id: early.userId,
      user_b_id: middle.userId,
    });
  });
});

describe("cancelQueue", () => {
  it("deletes the caller's queue row and leaves them on home", () => {
    const db = tempDb();
    const alpha = seedUser(db, { username: "alpha" });
    joinQueue(db, alpha.userId, NOW);
    cancelQueue(db, alpha.userId);
    cancelQueue(db, alpha.userId);
    expect(queueRow(db, alpha.userId)).toBeUndefined();
    expect(readState(db, alpha.sessionId, NOW, 0)).toMatchObject({ view: "home", canMatch: true });
  });
});

describe("readState", () => {
  it("returns signed out for a missing, unknown, or expired session", () => {
    const db = tempDb();
    const alpha = seedUser(db, { username: "alpha" });
    db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(NOW, alpha.sessionId);

    expect(readState(db, null, NOW, 0)).toEqual({ view: "signed_out", error: null });
    expect(readState(db, "missing", NOW, 0)).toEqual({ view: "signed_out", error: null });
    expect(readState(db, alpha.sessionId, NOW, 0)).toEqual({ view: "signed_out", error: null });
    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(alpha.sessionId)).toBeUndefined();
  });

  it("shows home for private, fresh, stale, idle, and empty caches", () => {
    const db = tempDb();
    const privateUser = seedUser(db, {
      username: "private-user",
      cache: {
        artist: "Secret",
        track: "Hidden",
        artworkUrl: "https://art/secret",
        isNowPlaying: 0,
        error: "private",
        recentArtists: ["One", "Two"],
        fetchedAt: NOW,
      },
    });
    const privateFlag = seedUser(db, {
      username: "private-flag",
      cache: {
        artist: "Secret",
        track: "Hidden",
        isNowPlaying: 1,
        error: "private",
        recentArtists: ["Kept"],
      },
    });
    const playing = seedUser(db, {
      username: "playing",
      cache: {
        artist: "Radiohead",
        track: "Everything in Its Right Place",
        artworkUrl: "https://art/live",
        recentArtists: ["Radiohead", "Bjork"],
      },
    });
    const unreachable = seedUser(db, {
      username: "unreachable",
      cache: { error: "unreachable", artworkUrl: null, recentArtists: ["Live"] },
    });
    const stale = seedUser(db, {
      username: "stale-home",
      cache: { fetchedAt: NOW - NOW_PLAYING_TTL_MS, artworkUrl: "https://art/old" },
    });
    const idle = seedUser(db, {
      username: "idle",
      cache: {
        isNowPlaying: 0,
        artist: "Leftover",
        track: "Leftover Track",
        artworkUrl: "https://art/old",
        recentArtists: ["Zed"],
        fetchedAt: NOW,
        error: null,
      },
    });
    const empty = seedUser(db, { username: "empty", cache: null });

    expect(readState(db, privateUser.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: null,
      recentArtists: ["One", "Two"],
      canMatch: false,
      notice: COPY.privateTracks,
    });
    expect(readState(db, privateFlag.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: null,
      recentArtists: ["Kept"],
      canMatch: false,
      notice: COPY.privateTracks,
    });
    expect(readState(db, playing.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: {
        artist: "Radiohead",
        track: "Everything in Its Right Place",
        artworkUrl: "https://art/live",
      },
      recentArtists: ["Radiohead", "Bjork"],
      canMatch: true,
      notice: null,
    });
    expect(readState(db, unreachable.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: {
        artist: "Radiohead",
        track: "Everything in Its Right Place",
        artworkUrl: null,
      },
      recentArtists: ["Live"],
      canMatch: true,
      notice: COPY.stale,
    });
    expect(readState(db, stale.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: {
        artist: "Radiohead",
        track: "Everything in Its Right Place",
        artworkUrl: "https://art/old",
      },
      recentArtists: ["Radiohead"],
      canMatch: false,
      notice: COPY.stale,
    });
    expect(readState(db, idle.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: null,
      recentArtists: ["Zed"],
      canMatch: false,
      notice: null,
    });
    expect(readState(db, empty.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: null,
      recentArtists: [],
      canMatch: false,
      notice: null,
    });
  });

  it("returns the queued song and a stale notice without using the live cache as the header", () => {
    const db = tempDb();
    const alpha = seedUser(db, {
      username: "alpha",
      cache: { artist: "Live Artist", track: "Live Track", artworkUrl: "https://art/live", songKey: KEY },
    });
    insertQueue(db, alpha.userId, NOW, KEY, "Queued Artist", "Queued Track", "https://art/queue");

    expect(readState(db, alpha.sessionId, NOW, 0)).toEqual({
      view: "waiting",
      song: { artist: "Queued Artist", track: "Queued Track", artworkUrl: "https://art/queue" },
      notice: null,
    });

    db.prepare("UPDATE now_playing SET error = 'unreachable' WHERE user_id = ?").run(alpha.userId);
    expect(readState(db, alpha.sessionId, NOW, 0)).toEqual({
      view: "waiting",
      song: { artist: "Queued Artist", track: "Queued Track", artworkUrl: "https://art/queue" },
      notice: COPY.stale,
    });

    db.prepare("UPDATE now_playing SET error = NULL, fetched_at = ? WHERE user_id = ?").run(
      NOW + 120_000 - NOW_PLAYING_TTL_MS,
      alpha.userId,
    );
    expect(readState(db, alpha.sessionId, NOW + 120_000, 0)).toEqual({
      view: "waiting",
      song: { artist: "Queued Artist", track: "Queued Track", artworkUrl: "https://art/queue" },
      notice: COPY.stale,
    });
  });

  it("pairs a waiting caller while reading state", () => {
    const db = tempDb();
    const alpha = seedUser(db, { username: "alpha", cache: { recentArtists: ["Alpha"] } });
    const beta = seedUser(db, { username: "beta", cache: { recentArtists: ["Beta"] } });
    insertQueue(db, alpha.userId, NOW);
    insertQueue(db, beta.userId, NOW + 1);

    expect(readState(db, beta.sessionId, NOW + 2, 0)).toMatchObject({
      view: "chat",
      selfId: beta.userId,
      partner: { username: "alpha", recentArtists: ["Alpha"] },
    });
    expect(queueRow(db, alpha.userId)).toBeUndefined();
    expect(queueRow(db, beta.userId)).toBeUndefined();
  });

  it("returns the frozen match song, snapshot, away flag, and messages after the cursor", () => {
    const db = tempDb();
    const early = seedUser(db, {
      username: "dj/one",
      avatarUrl: "https://img/early",
      profileUrl: "https://www.last.fm/user/early",
      cache: {
        artist: "Early Artist",
        track: "Early Track",
        artworkUrl: "https://art/early",
        songKey: KEY,
        recentArtists: ["Alpha", "Beta"],
      },
    });
    const later = seedUser(db, {
      username: "later",
      avatarUrl: null,
      cache: {
        artist: "Later Artist",
        track: "Later Track",
        artworkUrl: null,
        songKey: KEY,
        recentArtists: ["Gamma"],
      },
    });
    expect(joinQueue(db, early.userId, NOW)).toBe("waiting");
    expect(joinQueue(db, later.userId, NOW + 1)).toBe("matched");
    db.prepare(
      `UPDATE now_playing SET artist = 'Changed', track = 'Changed Track', artwork_url = 'https://art/new'
       WHERE user_id IN (?, ?)`,
    ).run(early.userId, later.userId);
    const first = sendMessage(db, early.userId, "first", NOW + 2);
    const second = sendMessage(db, later.userId, "second", NOW + 3);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(readState(db, later.sessionId, NOW + 3, 0)).toEqual({
      view: "chat",
      selfId: later.userId,
      partner: {
        username: "dj/one",
        avatarUrl: "https://img/early",
        profileUrl: "https://www.last.fm/user/early",
        recentArtists: ["Alpha", "Beta"],
        away: false,
      },
      song: { artist: "Early Artist", track: "Early Track", artworkUrl: "https://art/early" },
      messages: [
        { id: first.id, senderId: early.userId, body: "first", createdAt: NOW + 2 },
        { id: second.id, senderId: later.userId, body: "second", createdAt: NOW + 3 },
      ],
    });
    expect(readState(db, early.sessionId, NOW + 3, first.id)).toMatchObject({
      view: "chat",
      selfId: early.userId,
      partner: {
        username: "later",
        avatarUrl: null,
        profileUrl: "https://www.last.fm/user/later",
        recentArtists: ["Gamma"],
        away: false,
      },
      song: { artist: "Early Artist", track: "Early Track", artworkUrl: "https://art/early" },
      messages: [{ id: second.id }],
    });

    const awayAt = NOW + 40_000;
    db.prepare("UPDATE users SET last_heartbeat_at = ? WHERE id = ?").run(
      awayAt - PRESENCE_MS,
      early.userId,
    );
    expect(readState(db, later.sessionId, awayAt, second.id)).toMatchObject({
      view: "chat",
      partner: { away: true },
      messages: [],
    });
    db.prepare("UPDATE users SET last_heartbeat_at = ? WHERE id = ?").run(
      awayAt - PRESENCE_MS + 1,
      early.userId,
    );
    expect(readState(db, later.sessionId, awayAt, second.id)).toMatchObject({
      partner: { away: false },
    });
    db.prepare("UPDATE users SET last_heartbeat_at = NULL WHERE id = ?").run(early.userId);
    expect(readState(db, later.sessionId, awayAt, second.id)).toMatchObject({
      partner: { away: true },
    });
  });
});
