import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import type { LastfmClient, LastfmTrack } from "./lastfm";
import { songKey } from "./song-key";
import {
  LASTFM_REFRESH_MS,
  NOW_PLAYING_TTL_MS,
  PRESENCE_MS,
  PROFILE_TTL_MS,
  SESSION_TTL_MS,
} from "./constants";
import { COPY } from "./copy";
import {
  createSession,
  deleteSession,
  readSession,
  recordHeartbeat,
  refreshIfDue,
  sessionCookie,
  upsertUser,
} from "./presence";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "musicmatch-"));
  dirs.push(dir);
  return openDatabase(join(dir, "app.db"));
}

function track(partial: Partial<LastfmTrack> & Pick<LastfmTrack, "artist" | "track">): LastfmTrack {
  return {
    album: null,
    artworkUrl: null,
    nowPlaying: false,
    ...partial,
  };
}

function fakeClient(options: {
  recent: () => Awaited<ReturnType<LastfmClient["getRecentTracks"]>>;
  info?: () => Awaited<ReturnType<LastfmClient["getInfo"]>>;
}) {
  const calls = { recent: 0, info: 0 };
  const seen: { username?: string; sessionKey?: string } = {};
  const client: LastfmClient = {
    async getToken() {
      return { ok: false, reason: "unreachable" };
    },
    async getSession() {
      return { ok: false, reason: "unreachable" };
    },
    async getRecentTracks(username, sessionKey) {
      calls.recent += 1;
      seen.username = username;
      seen.sessionKey = sessionKey;
      return options.recent();
    },
    async getInfo() {
      calls.info += 1;
      return options.info ? options.info() : { ok: false, reason: "unreachable" };
    },
  };
  return { client, calls, seen };
}

function insertQueue(
  db: ReturnType<typeof tempDb>,
  userId: number,
  artist: string,
  title: string,
) {
  db.prepare(
    "INSERT INTO queue (user_id, song_key, artist, track, artwork_url, joined_at) VALUES (?, ?, ?, ?, NULL, 1)",
  ).run(userId, songKey(artist, title), artist, title);
}

describe("constants and copy", () => {
  it("uses the presence windows and the exact user-facing strings", () => {
    expect(PRESENCE_MS).toBe(30_000);
    expect(LASTFM_REFRESH_MS).toBe(15_000);
    expect(NOW_PLAYING_TTL_MS).toBe(60_000);
    expect(PROFILE_TTL_MS).toBe(60 * 60 * 1000);
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(COPY).toEqual({
      denied: "Last.fm didn't approve access.",
      rejected: "Last.fm didn't accept this session. Sign in again.",
      privateTracks: "Make your recent tracks public on Last.fm to be matched.",
      stale: "Last.fm may be out of date.",
      nothingPlaying: "Nothing is playing right now.",
      away: "Away",
      emptyMessage: "Write a message first.",
      tooLong: "Messages can be at most 500 characters.",
    });
  });
});

describe("sessions", () => {
  it("extends expires_at to now + SESSION_TTL_MS and sets last_heartbeat_at", () => {
    const db = tempDb();
    const start = 1_000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now: start,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    const sessionId = createSession(db, userId, start);
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
    const created = db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(sessionId) as {
      expires_at: number;
    };
    expect(created.expires_at).toBe(start + SESSION_TTL_MS);

    const now = start + 5_000;
    recordHeartbeat(db, sessionId, now);
    const session = db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(sessionId) as {
      expires_at: number;
    };
    const user = db.prepare("SELECT last_heartbeat_at FROM users WHERE id = ?").get(userId) as {
      last_heartbeat_at: number;
    };
    expect(session.expires_at).toBe(now + SESSION_TTL_MS);
    expect(user.last_heartbeat_at).toBe(now);

    recordHeartbeat(db, "missing-session", now + 1);
    const unchanged = db.prepare("SELECT last_heartbeat_at FROM users WHERE id = ?").get(userId) as {
      last_heartbeat_at: number;
    };
    expect(unchanged.last_heartbeat_at).toBe(now);
  });

  it("reads an expired session as null and deletes the row", () => {
    const db = tempDb();
    const now = 50_000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    const sessionId = createSession(db, userId, now);
    const expires = now + SESSION_TTL_MS;
    expect(readSession(db, sessionId, expires - 1)).toEqual({ userId });
    expect(readSession(db, sessionId, expires)).toBeNull();
    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId)).toBeUndefined();
    expect(readSession(db, "missing", now)).toBeNull();
  });

  it("deletes only the named session", () => {
    const db = tempDb();
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now: 1,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    const keep = createSession(db, userId, 1);
    const drop = createSession(db, userId, 1);
    deleteSession(db, drop);
    expect(readSession(db, drop, 1)).toBeNull();
    expect(readSession(db, keep, 1)).toEqual({ userId });
  });

  it("omits Secure on http and sets Secure, HttpOnly, and SameSite=Lax on https", () => {
    const httpCookie = sessionCookie("abc", "http://localhost:3000");
    const httpsCookie = sessionCookie("abc", "https://music.example");
    expect(httpCookie).toBe(
      "musicmatch_session=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000",
    );
    expect(httpCookie).not.toContain("Secure");
    expect(httpsCookie).toBe(
      "musicmatch_session=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure",
    );
    expect(httpsCookie).toContain("HttpOnly");
    expect(httpsCookie).toContain("SameSite=Lax");
  });

  it("updates the session key when the Last.fm username already exists", () => {
    const db = tempDb();
    const first = upsertUser(db, {
      username: "ada",
      sessionKey: "old-key",
      now: 1,
      avatarUrl: "https://img.example/old.jpg",
      profileUrl: "https://www.last.fm/user/ada",
    });
    const second = upsertUser(db, {
      username: "ada",
      sessionKey: "new-key",
      now: 2,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/Ada",
    });
    expect(second).toBe(first);
    const row = db
      .prepare(
        "SELECT lastfm_session_key, avatar_url, profile_url, profile_fetched_at, created_at FROM users WHERE id = ?",
      )
      .get(first) as {
      lastfm_session_key: string;
      avatar_url: string | null;
      profile_url: string;
      profile_fetched_at: number;
      created_at: number;
    };
    expect(row).toEqual({
      lastfm_session_key: "new-key",
      avatar_url: null,
      profile_url: "https://www.last.fm/user/Ada",
      profile_fetched_at: 2,
      created_at: 1,
    });
  });
});

describe("refreshIfDue", () => {
  const playing = [
    track({
      artist: "The Beatles",
      track: "Yesterday",
      album: "Help!",
      artworkUrl: "https://img.example/beatles.jpg",
      nowPlaying: true,
    }),
    track({ artist: "the   beatles", track: "Hey Jude" }),
    track({ artist: "Radiohead", track: "Karma Police" }),
    track({ artist: "Pink Floyd", track: "Wish You Were Here" }),
    track({ artist: "Led Zeppelin", track: "Kashmir" }),
    track({ artist: "Queen", track: "Bohemian Rhapsody" }),
    track({ artist: "David Bowie", track: "Heroes" }),
  ];

  it("stores the now-playing track and five recent artists, then skips a call 10 seconds later", async () => {
    const db = tempDb();
    const now = 2_000_000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    const { client, calls, seen } = fakeClient({
      recent: () => ({ ok: true, tracks: playing }),
    });

    await refreshIfDue(db, userId, client, now);
    await refreshIfDue(db, userId, client, now + 10_000);

    expect(calls.recent).toBe(1);
    expect(calls.info).toBe(0);
    expect(seen).toEqual({ username: "ada", sessionKey: "lastfm-key" });
    const row = db.prepare("SELECT * FROM now_playing WHERE user_id = ?").get(userId) as {
      artist: string;
      track: string;
      album: string;
      artwork_url: string;
      is_now_playing: number;
      song_key: string;
      recent_artists: string;
      fetched_at: number;
      attempted_at: number;
      error: string | null;
    };
    expect(row).toMatchObject({
      artist: "The Beatles",
      track: "Yesterday",
      album: "Help!",
      artwork_url: "https://img.example/beatles.jpg",
      is_now_playing: 1,
      song_key: songKey("The Beatles", "Yesterday"),
      recent_artists: JSON.stringify([
        "The Beatles",
        "Radiohead",
        "Pink Floyd",
        "Led Zeppelin",
        "Queen",
      ]),
      fetched_at: now,
      attempted_at: now,
      error: null,
    });
  });

  it("deletes the queue row when the song changes and keeps it when the song matches", async () => {
    const db = tempDb();
    const now = 3_000_000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    insertQueue(db, userId, "Journey", "Don't Stop");
    const changed = fakeClient({
      recent: () => ({
        ok: true,
        tracks: [track({ artist: "Journey", track: "Separate Ways", nowPlaying: true })],
      }),
    });
    await refreshIfDue(db, userId, changed.client, now);
    expect(
      db.prepare("SELECT user_id FROM queue WHERE user_id = ?").get(userId),
    ).toBeUndefined();
    expect(
      (db.prepare("SELECT song_key FROM now_playing WHERE user_id = ?").get(userId) as {
        song_key: string;
      }).song_key,
    ).toBe(songKey("Journey", "Separate Ways"));

    insertQueue(db, userId, "Journey", "Separate Ways");
    const same = fakeClient({
      recent: () => ({
        ok: true,
        tracks: [track({ artist: "Journey", track: "Separate Ways", nowPlaying: true })],
      }),
    });
    await refreshIfDue(db, userId, same.client, now + LASTFM_REFRESH_MS);
    expect(same.calls.recent).toBe(1);
    expect(db.prepare("SELECT song_key FROM queue WHERE user_id = ?").get(userId)).toEqual({
      song_key: songKey("Journey", "Separate Ways"),
    });
  });

  it("deletes the queue row when nothing is now playing", async () => {
    const db = tempDb();
    const now = 4_000_000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    insertQueue(db, userId, "Journey", "Don't Stop");
    const { client } = fakeClient({
      recent: () => ({
        ok: true,
        tracks: [track({ artist: "Journey", track: "Don't Stop" })],
      }),
    });
    await refreshIfDue(db, userId, client, now);
    expect(db.prepare("SELECT user_id FROM queue WHERE user_id = ?").get(userId)).toBeUndefined();
    const row = db
      .prepare("SELECT is_now_playing, song_key, recent_artists, error FROM now_playing WHERE user_id = ?")
      .get(userId) as {
      is_now_playing: number;
      song_key: string | null;
      recent_artists: string;
      error: string | null;
    };
    expect(row).toEqual({
      is_now_playing: 0,
      song_key: null,
      recent_artists: JSON.stringify(["Journey"]),
      error: null,
    });
  });

  it("deletes the queue row and sets error to private", async () => {
    const db = tempDb();
    const now = 5_000_000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    insertQueue(db, userId, "Journey", "Don't Stop");
    const { client } = fakeClient({
      recent: () => ({ ok: false, reason: "private" }),
    });
    await refreshIfDue(db, userId, client, now);
    expect(db.prepare("SELECT user_id FROM queue WHERE user_id = ?").get(userId)).toBeUndefined();
    const row = db
      .prepare("SELECT is_now_playing, error, fetched_at, attempted_at FROM now_playing WHERE user_id = ?")
      .get(userId) as {
      is_now_playing: number;
      error: string;
      fetched_at: number;
      attempted_at: number;
    };
    expect(row).toEqual({
      is_now_playing: 0,
      error: "private",
      fetched_at: now,
      attempted_at: now,
    });
  });

  it("keeps a cache fetched 10 seconds ago and sets error to unreachable without moving fetched_at", async () => {
    const db = tempDb();
    const now = 6_000_000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: "https://img.example/ada.jpg",
      profileUrl: "https://www.last.fm/user/ada",
    });
    const fetchedAt = now - 10_000;
    db.prepare(
      `INSERT INTO now_playing (
        user_id, artist, track, album, artwork_url, is_now_playing, song_key,
        recent_artists, fetched_at, attempted_at, error
      ) VALUES (?, 'Journey', 'Don''t Stop', 'Escape', 'https://img.example/j.jpg', 1, ?, '["Journey"]', ?, ?, NULL)`,
    ).run(userId, songKey("Journey", "Don't Stop"), fetchedAt, now - LASTFM_REFRESH_MS - 1);
    const { client, calls } = fakeClient({
      recent: () => ({ ok: false, reason: "unreachable" }),
    });
    await refreshIfDue(db, userId, client, now);
    expect(calls.recent).toBe(1);
    const row = db.prepare("SELECT * FROM now_playing WHERE user_id = ?").get(userId) as {
      artist: string;
      track: string;
      album: string;
      artwork_url: string;
      is_now_playing: number;
      song_key: string;
      recent_artists: string;
      fetched_at: number;
      attempted_at: number;
      error: string;
    };
    expect(row).toMatchObject({
      artist: "Journey",
      track: "Don't Stop",
      album: "Escape",
      artwork_url: "https://img.example/j.jpg",
      is_now_playing: 1,
      song_key: songKey("Journey", "Don't Stop"),
      recent_artists: '["Journey"]',
      fetched_at: fetchedAt,
      attempted_at: now,
      error: "unreachable",
    });
    const user = db
      .prepare("SELECT avatar_url, profile_url, profile_fetched_at FROM users WHERE id = ?")
      .get(userId);
    expect(user).toEqual({
      avatar_url: "https://img.example/ada.jpg",
      profile_url: "https://www.last.fm/user/ada",
      profile_fetched_at: now,
    });
  });

  it("deletes the user's session when recent tracks are rejected", async () => {
    const db = tempDb();
    const now = 7_000_000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    db.prepare("UPDATE users SET profile_fetched_at = NULL WHERE id = ?").run(userId);
    const sessionId = createSession(db, userId, now);
    const other = createSession(db, userId, now);
    const { client, calls } = fakeClient({
      recent: () => ({ ok: false, reason: "rejected" }),
      info: () => ({
        ok: true,
        avatarUrl: "https://img.example/should-not-apply.jpg",
        profileUrl: "https://www.last.fm/user/nope",
      }),
    });
    await refreshIfDue(db, userId, client, now);
    expect(calls.recent).toBe(1);
    expect(calls.info).toBe(0);
    expect(readSession(db, sessionId, now)).toBeNull();
    expect(readSession(db, other, now)).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(userId),
    ).toEqual({ count: 0 });
    expect(
      (db.prepare("SELECT error FROM now_playing WHERE user_id = ?").get(userId) as { error: string })
        .error,
    ).toBe("rejected");
  });

  it("does not request profile info when profile_fetched_at is 30 minutes old", async () => {
    const db = tempDb();
    const now = 8_000_000;
    const fetchedAt = now - 30 * 60 * 1000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now: fetchedAt,
      avatarUrl: "https://img.example/ada.jpg",
      profileUrl: "https://www.last.fm/user/ada",
    });
    const { client, calls } = fakeClient({
      recent: () => ({ ok: true, tracks: playing }),
      info: () => ({
        ok: true,
        avatarUrl: "https://img.example/new.jpg",
        profileUrl: "https://www.last.fm/user/new",
      }),
    });
    await refreshIfDue(db, userId, client, now);
    expect(calls.recent).toBe(1);
    expect(calls.info).toBe(0);
    expect(
      db.prepare("SELECT avatar_url, profile_url, profile_fetched_at FROM users WHERE id = ?").get(userId),
    ).toEqual({
      avatar_url: "https://img.example/ada.jpg",
      profile_url: "https://www.last.fm/user/ada",
      profile_fetched_at: fetchedAt,
    });
  });

  it("refreshes profile info when it is older than an hour and drops sessions if that info is rejected", async () => {
    const db = tempDb();
    const now = 9_000_000;
    const userId = upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now: now - PROFILE_TTL_MS - 1,
      avatarUrl: "https://img.example/old.jpg",
      profileUrl: "https://www.last.fm/user/ada",
    });
    const updated = fakeClient({
      recent: () => ({ ok: true, tracks: [] }),
      info: () => ({
        ok: true,
        avatarUrl: "https://img.example/new.jpg",
        profileUrl: "https://www.last.fm/user/Ada",
      }),
    });
    await refreshIfDue(db, userId, updated.client, now);
    expect(updated.calls.info).toBe(1);
    expect(
      db.prepare("SELECT avatar_url, profile_url, profile_fetched_at FROM users WHERE id = ?").get(userId),
    ).toEqual({
      avatar_url: "https://img.example/new.jpg",
      profile_url: "https://www.last.fm/user/Ada",
      profile_fetched_at: now,
    });

    const rejectedNow = now + LASTFM_REFRESH_MS;
    db.prepare("UPDATE users SET profile_fetched_at = ? WHERE id = ?").run(
      rejectedNow - PROFILE_TTL_MS - 1,
      userId,
    );
    const sessionId = createSession(db, userId, rejectedNow);
    const rejected = fakeClient({
      recent: () => ({ ok: true, tracks: [] }),
      info: () => ({ ok: false, reason: "rejected" }),
    });
    await refreshIfDue(db, userId, rejected.client, rejectedNow);
    expect(readSession(db, sessionId, rejectedNow)).toBeNull();
    expect(
      db.prepare("SELECT avatar_url, profile_url FROM users WHERE id = ?").get(userId),
    ).toEqual({
      avatar_url: "https://img.example/new.jpg",
      profile_url: "https://www.last.fm/user/Ada",
    });
  });
});
