import { describe, expect, it } from "vitest";
import { openTestDatabase, type Db } from "./db";
import type { LastfmClient, LastfmTrack } from "./lastfm";
import { songKey } from "./song-key";
import {
  HEARTBEAT_MS,
  LASTFM_REFRESH_MS,
  NOW_PLAYING_TTL_MS,
  PRESENCE_MS,
  PROFILE_TTL_MS,
  SESSION_TTL_MS,
  STATE_POLL_MS,
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

interface ExpiresRow extends Record<string, unknown> {
  expires_at: number;
}

interface HeartbeatRow extends Record<string, unknown> {
  last_heartbeat_at: number;
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

interface UserProfileRow extends Record<string, unknown> {
  lastfm_session_key: string;
  avatar_url: string | null;
  profile_url: string;
  profile_fetched_at: number;
  created_at: number;
}

interface CountRow extends Record<string, unknown> {
  count: number;
}

function tempDb(): Promise<Db> {
  return openTestDatabase();
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

async function insertQueue(db: Db, userId: number, artist: string, title: string) {
  await db.exec(
    "INSERT INTO queue (user_id, song_key, artist, track, artwork_url, joined_at) VALUES ($1, $2, $3, $4, NULL, 1)",
    [userId, songKey(artist, title), artist, title],
  );
}

describe("constants and copy", () => {
  it("uses the presence windows and the exact user-facing strings", () => {
    expect(PRESENCE_MS).toBe(90_000);
    expect(STATE_POLL_MS).toBe(8000);
    expect(HEARTBEAT_MS).toBe(30000);
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
  it("extends expires_at to now + SESSION_TTL_MS and sets last_heartbeat_at", async () => {
    const db = await tempDb();
    const start = 1_000;
    const userId = await upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now: start,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    const sessionId = await createSession(db, userId, start);
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
    const created = await db.one<ExpiresRow>("SELECT expires_at FROM sessions WHERE id = $1", [sessionId]);
    expect(created?.expires_at).toBe(start + SESSION_TTL_MS);

    const now = start + 5_000;
    await recordHeartbeat(db, sessionId, now);
    const session = await db.one<ExpiresRow>("SELECT expires_at FROM sessions WHERE id = $1", [sessionId]);
    const user = await db.one<HeartbeatRow>("SELECT last_heartbeat_at FROM users WHERE id = $1", [userId]);
    expect(session?.expires_at).toBe(now + SESSION_TTL_MS);
    expect(user?.last_heartbeat_at).toBe(now);

    await recordHeartbeat(db, "missing-session", now + 1);
    const unchanged = await db.one<HeartbeatRow>("SELECT last_heartbeat_at FROM users WHERE id = $1", [
      userId,
    ]);
    expect(unchanged?.last_heartbeat_at).toBe(now);
  });

  it("reads an expired session as null and deletes the row", async () => {
    const db = await tempDb();
    const now = 50_000;
    const userId = await upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    const sessionId = await createSession(db, userId, now);
    const expires = now + SESSION_TTL_MS;
    expect(await readSession(db, sessionId, expires - 1)).toEqual({ userId });
    expect(await readSession(db, sessionId, expires)).toBeNull();
    expect(await db.one<IdRow>("SELECT id FROM sessions WHERE id = $1", [sessionId])).toBeUndefined();
    expect(await readSession(db, "missing", now)).toBeNull();
  });

  it("deletes only the named session", async () => {
    const db = await tempDb();
    const userId = await upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now: 1,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    const keep = await createSession(db, userId, 1);
    const drop = await createSession(db, userId, 1);
    await deleteSession(db, drop);
    expect(await readSession(db, drop, 1)).toBeNull();
    expect(await readSession(db, keep, 1)).toEqual({ userId });
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

  it("updates the session key when the Last.fm username already exists", async () => {
    const db = await tempDb();
    const first = await upsertUser(db, {
      username: "ada",
      sessionKey: "old-key",
      now: 1,
      avatarUrl: "https://img.example/old.jpg",
      profileUrl: "https://www.last.fm/user/ada",
    });
    const second = await upsertUser(db, {
      username: "ada",
      sessionKey: "new-key",
      now: 2,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/Ada",
    });
    expect(second).toBe(first);
    const row = await db.one<UserProfileRow>(
      "SELECT lastfm_session_key, avatar_url, profile_url, profile_fetched_at, created_at FROM users WHERE id = $1",
      [first],
    );
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
    const db = await tempDb();
    const now = 2_000_000;
    const userId = await upsertUser(db, {
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
    const row = await db.one<Record<string, unknown>>("SELECT * FROM now_playing WHERE user_id = $1", [
      userId,
    ]);
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
    const db = await tempDb();
    const now = 3_000_000;
    const userId = await upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    await insertQueue(db, userId, "Journey", "Don't Stop");
    const changed = fakeClient({
      recent: () => ({
        ok: true,
        tracks: [track({ artist: "Journey", track: "Separate Ways", nowPlaying: true })],
      }),
    });
    await refreshIfDue(db, userId, changed.client, now);
    expect(await db.one("SELECT user_id FROM queue WHERE user_id = $1", [userId])).toBeUndefined();
    expect(
      (
        await db.one<{ song_key: string } & Record<string, unknown>>(
          "SELECT song_key FROM now_playing WHERE user_id = $1",
          [userId],
        )
      )?.song_key,
    ).toBe(songKey("Journey", "Separate Ways"));

    await insertQueue(db, userId, "Journey", "Separate Ways");
    const same = fakeClient({
      recent: () => ({
        ok: true,
        tracks: [track({ artist: "Journey", track: "Separate Ways", nowPlaying: true })],
      }),
    });
    await refreshIfDue(db, userId, same.client, now + LASTFM_REFRESH_MS);
    expect(same.calls.recent).toBe(1);
    expect(await db.one("SELECT song_key FROM queue WHERE user_id = $1", [userId])).toEqual({
      song_key: songKey("Journey", "Separate Ways"),
    });
  });

  it("deletes the queue row when nothing is now playing", async () => {
    const db = await tempDb();
    const now = 4_000_000;
    const userId = await upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    await insertQueue(db, userId, "Journey", "Don't Stop");
    const { client } = fakeClient({
      recent: () => ({
        ok: true,
        tracks: [track({ artist: "Journey", track: "Don't Stop" })],
      }),
    });
    await refreshIfDue(db, userId, client, now);
    expect(await db.one("SELECT user_id FROM queue WHERE user_id = $1", [userId])).toBeUndefined();
    const row = await db.one(
      "SELECT is_now_playing, song_key, recent_artists, error FROM now_playing WHERE user_id = $1",
      [userId],
    );
    expect(row).toEqual({
      is_now_playing: 0,
      song_key: null,
      recent_artists: JSON.stringify(["Journey"]),
      error: null,
    });
  });

  it("deletes the queue row and sets error to private", async () => {
    const db = await tempDb();
    const now = 5_000_000;
    const userId = await upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    await insertQueue(db, userId, "Journey", "Don't Stop");
    const { client } = fakeClient({
      recent: () => ({ ok: false, reason: "private" }),
    });
    await refreshIfDue(db, userId, client, now);
    expect(await db.one("SELECT user_id FROM queue WHERE user_id = $1", [userId])).toBeUndefined();
    const row = await db.one(
      "SELECT is_now_playing, error, fetched_at, attempted_at FROM now_playing WHERE user_id = $1",
      [userId],
    );
    expect(row).toEqual({
      is_now_playing: 0,
      error: "private",
      fetched_at: now,
      attempted_at: now,
    });
  });

  it("keeps a cache fetched 10 seconds ago and sets error to unreachable without moving fetched_at", async () => {
    const db = await tempDb();
    const now = 6_000_000;
    const userId = await upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: "https://img.example/ada.jpg",
      profileUrl: "https://www.last.fm/user/ada",
    });
    const fetchedAt = now - 10_000;
    await db.exec(
      `INSERT INTO now_playing (
        user_id, artist, track, album, artwork_url, is_now_playing, song_key,
        recent_artists, fetched_at, attempted_at, error
      ) VALUES ($1, 'Journey', 'Don''t Stop', 'Escape', 'https://img.example/j.jpg', 1, $2, '["Journey"]', $3, $4, NULL)`,
      [userId, songKey("Journey", "Don't Stop"), fetchedAt, now - LASTFM_REFRESH_MS - 1],
    );
    const { client, calls } = fakeClient({
      recent: () => ({ ok: false, reason: "unreachable" }),
    });
    await refreshIfDue(db, userId, client, now);
    expect(calls.recent).toBe(1);
    const row = await db.one<Record<string, unknown>>("SELECT * FROM now_playing WHERE user_id = $1", [
      userId,
    ]);
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
    const user = await db.one(
      "SELECT avatar_url, profile_url, profile_fetched_at FROM users WHERE id = $1",
      [userId],
    );
    expect(user).toEqual({
      avatar_url: "https://img.example/ada.jpg",
      profile_url: "https://www.last.fm/user/ada",
      profile_fetched_at: now,
    });
  });

  it("deletes the user's session when recent tracks are rejected", async () => {
    const db = await tempDb();
    const now = 7_000_000;
    const userId = await upsertUser(db, {
      username: "ada",
      sessionKey: "lastfm-key",
      now,
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/ada",
    });
    await db.exec("UPDATE users SET profile_fetched_at = NULL WHERE id = $1", [userId]);
    const sessionId = await createSession(db, userId, now);
    const other = await createSession(db, userId, now);
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
    expect(await readSession(db, sessionId, now)).toBeNull();
    expect(await readSession(db, other, now)).toBeNull();
    expect(await db.one<CountRow>("SELECT COUNT(*) AS count FROM sessions WHERE user_id = $1", [userId])).toEqual({
      count: 0,
    });
    expect(
      (await db.one<{ error: string } & Record<string, unknown>>("SELECT error FROM now_playing WHERE user_id = $1", [
        userId,
      ]))?.error,
    ).toBe("rejected");
  });

  it("does not request profile info when profile_fetched_at is 30 minutes old", async () => {
    const db = await tempDb();
    const now = 8_000_000;
    const fetchedAt = now - 30 * 60 * 1000;
    const userId = await upsertUser(db, {
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
      await db.one("SELECT avatar_url, profile_url, profile_fetched_at FROM users WHERE id = $1", [userId]),
    ).toEqual({
      avatar_url: "https://img.example/ada.jpg",
      profile_url: "https://www.last.fm/user/ada",
      profile_fetched_at: fetchedAt,
    });
  });

  it("refreshes profile info when it is older than an hour and drops sessions if that info is rejected", async () => {
    const db = await tempDb();
    const now = 9_000_000;
    const userId = await upsertUser(db, {
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
      await db.one("SELECT avatar_url, profile_url, profile_fetched_at FROM users WHERE id = $1", [userId]),
    ).toEqual({
      avatar_url: "https://img.example/new.jpg",
      profile_url: "https://www.last.fm/user/Ada",
      profile_fetched_at: now,
    });

    const rejectedNow = now + LASTFM_REFRESH_MS;
    await db.exec("UPDATE users SET profile_fetched_at = $1 WHERE id = $2", [
      rejectedNow - PROFILE_TTL_MS - 1,
      userId,
    ]);
    const sessionId = await createSession(db, userId, rejectedNow);
    const rejected = fakeClient({
      recent: () => ({ ok: true, tracks: [] }),
      info: () => ({ ok: false, reason: "rejected" }),
    });
    await refreshIfDue(db, userId, rejected.client, rejectedNow);
    expect(await readSession(db, sessionId, rejectedNow)).toBeNull();
    expect(await db.one("SELECT avatar_url, profile_url FROM users WHERE id = $1", [userId])).toEqual({
      avatar_url: "https://img.example/new.jpg",
      profile_url: "https://www.last.fm/user/Ada",
    });
  });
});
