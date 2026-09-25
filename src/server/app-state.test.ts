import { describe, expect, it } from "vitest";
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
import { openTestDatabase, type Db } from "./db";
import { songKey } from "./song-key";

const NOW = 1_700_000_000_000;
const KEY = songKey("Radiohead", "Everything in Its Right Place");
const OTHER_KEY = songKey("Other Artist", "Other Track");

interface IdRow extends Record<string, unknown> {
  id: number;
}

interface QueueShape extends Record<string, unknown> {
  song_key: string;
  artist: string;
  track: string;
  artwork_url: string | null;
  joined_at: number;
}

function tempDb(): Promise<Db> {
  return openTestDatabase();
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

async function seedUser(db: Db, seed: UserSeed): Promise<{ userId: number; sessionId: string }> {
  const inserted = await db.one<IdRow>(
    `INSERT INTO users (
       lastfm_username, lastfm_session_key, avatar_url, profile_url, created_at, last_heartbeat_at
     ) VALUES ($1, 'session-key', $2, $3, $4, $5)
     RETURNING id`,
    [
      seed.username,
      seed.avatarUrl === undefined ? null : seed.avatarUrl,
      seed.profileUrl === undefined ? null : seed.profileUrl,
      NOW,
      seed.heartbeatAt === undefined ? NOW : seed.heartbeatAt,
    ],
  );
  const userId = Number(inserted?.id);
  const sessionId = `session-${seed.username}`;
  await db.exec("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [
    sessionId,
    userId,
    NOW + 1_000_000_000,
  ]);
  if (seed.cache !== null) {
    const cache = seed.cache ?? {};
    const artist = cache.artist === undefined ? "Radiohead" : cache.artist;
    const track = cache.track === undefined ? "Everything in Its Right Place" : cache.track;
    const key =
      cache.songKey === undefined ? (artist && track ? songKey(artist, track) : null) : cache.songKey;
    await db.exec(
      `INSERT INTO now_playing (
         user_id, artist, track, album, artwork_url, is_now_playing, song_key,
         recent_artists, fetched_at, attempted_at, error
       ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10)`,
      [
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
      ],
    );
  }
  return { userId, sessionId };
}

function queueRow(db: Db, userId: number) {
  return db.one<QueueShape>(
    "SELECT song_key, artist, track, artwork_url, joined_at FROM queue WHERE user_id = $1",
    [userId],
  );
}

async function insertQueue(
  db: Db,
  userId: number,
  joinedAt: number,
  song = KEY,
  artist = "Radiohead",
  track = "Everything in Its Right Place",
  artwork: string | null = "https://art/default",
): Promise<void> {
  await db.exec(
    `INSERT INTO queue (user_id, song_key, artist, track, artwork_url, joined_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, song, artist, track, artwork, joinedAt],
  );
}

describe("leave, rematch, and a third listener", () => {
  it("sends both people home, blocks that pair, and matches the earlier waiter with someone new", async () => {
    const db = await tempDb();
    const low = await seedUser(db, {
      username: "low",
      avatarUrl: "https://img/low",
      profileUrl: "https://www.last.fm/user/low",
      cache: { recentArtists: ["Low Recent"] },
    });
    const high = await seedUser(db, {
      username: "high",
      avatarUrl: "https://img/high",
      profileUrl: "https://www.last.fm/user/high",
      cache: { recentArtists: ["High Recent"] },
    });

    expect(await joinQueue(db, high.userId, NOW)).toBe("waiting");
    expect(await joinQueue(db, low.userId, NOW + 1)).toBe("matched");
    expect(await joinQueue(db, high.userId, NOW + 1)).toBe("in_chat");
    expect(await queueRow(db, high.userId)).toBeUndefined();
    expect(await queueRow(db, low.userId)).toBeUndefined();

    expect(await leaveMatch(db, low.userId, NOW + 2)).toEqual({ ended: true });
    expect(await leaveMatch(db, high.userId, NOW + 3)).toEqual({ ended: false });
    expect(await readState(db, low.sessionId, NOW + 3, 0)).toMatchObject({ view: "home" });
    expect(await readState(db, high.sessionId, NOW + 3, 0)).toMatchObject({ view: "home" });
    expect(await db.one("SELECT status, ended_by, ended_at FROM matches")).toEqual({
      status: "ended",
      ended_by: low.userId,
      ended_at: NOW + 2,
    });
    expect(await db.query("SELECT user_lo, user_hi FROM pairs")).toEqual([
      { user_lo: low.userId, user_hi: high.userId },
    ]);

    expect(await joinQueue(db, high.userId, NOW + 10)).toBe("waiting");
    expect(await joinQueue(db, low.userId, NOW + 11)).toBe("waiting");
    expect(await db.query("SELECT status FROM matches WHERE status = 'active'")).toEqual([]);

    const third = await seedUser(db, {
      username: "third",
      avatarUrl: "https://img/third",
      profileUrl: "https://www.last.fm/user/third",
      cache: { recentArtists: ["Third Recent"] },
    });
    expect(await joinQueue(db, third.userId, NOW + 12)).toBe("matched");
    expect(await readState(db, third.sessionId, NOW + 12, 0)).toMatchObject({
      view: "chat",
      selfId: third.userId,
      partner: { username: "high" },
    });
    expect(await readState(db, high.sessionId, NOW + 12, 0)).toMatchObject({
      view: "chat",
      partner: { username: "third" },
    });
    expect(await readState(db, low.sessionId, NOW + 12, 0)).toMatchObject({ view: "waiting" });
    expect((await queueRow(db, low.userId))?.joined_at).toBe(NOW + 11);
    expect(
      await db.one("SELECT user_a_id, user_b_id, status FROM matches WHERE status = 'active'"),
    ).toEqual({
      user_a_id: high.userId,
      user_b_id: third.userId,
      status: "active",
    });
    expect(await db.query("SELECT user_lo, user_hi FROM pairs")).toEqual([
      { user_lo: low.userId, user_hi: high.userId },
    ]);
  });
});

describe("messages", () => {
  it("refuses empty and 501-character bodies, a message after leave, and an outsider", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, { username: "alpha" });
    const beta = await seedUser(db, { username: "beta" });
    const outsider = await seedUser(db, { username: "outsider" });
    await joinQueue(db, alpha.userId, NOW);
    await joinQueue(db, beta.userId, NOW + 1);

    expect(await sendMessage(db, alpha.userId, "   ", NOW + 2)).toEqual({ ok: false, error: "empty" });
    expect(await sendMessage(db, outsider.userId, "  ", NOW + 2)).toEqual({ ok: false, error: "empty" });
    expect(await sendMessage(db, alpha.userId, "a".repeat(501), NOW + 2)).toEqual({
      ok: false,
      error: "too_long",
    });
    expect(await sendMessage(db, alpha.userId, ` ${"b".repeat(501)} `, NOW + 2)).toEqual({
      ok: false,
      error: "too_long",
    });

    const accepted = await sendMessage(db, alpha.userId, "c".repeat(500), NOW + 3);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(await db.one("SELECT body FROM messages WHERE id = $1", [accepted.id])).toEqual({
      body: "c".repeat(500),
    });

    const trimmed = await sendMessage(db, beta.userId, "  hello  ", NOW + 4);
    expect(trimmed).toEqual({ ok: true, id: accepted.id + 1 });
    if (!trimmed.ok) return;
    expect(await db.one("SELECT body, sender_id, created_at FROM messages WHERE id = $1", [trimmed.id])).toEqual({
      body: "hello",
      sender_id: beta.userId,
      created_at: NOW + 4,
    });

    const state = await readState(db, alpha.sessionId, NOW + 4, 0);
    expect(state).toMatchObject({
      view: "chat",
      messages: [
        { id: accepted.id, senderId: alpha.userId, body: "c".repeat(500), createdAt: NOW + 3 },
        { id: trimmed.id, senderId: beta.userId, body: "hello", createdAt: NOW + 4 },
      ],
    });
    expect(await readState(db, alpha.sessionId, NOW + 4, accepted.id)).toMatchObject({
      view: "chat",
      messages: [{ id: trimmed.id, senderId: beta.userId, body: "hello", createdAt: NOW + 4 }],
    });

    expect(await leaveMatch(db, alpha.userId, NOW + 5)).toEqual({ ended: true });
    expect(await sendMessage(db, beta.userId, "after", NOW + 6)).toEqual({ ok: false, error: "no_match" });
    expect(await sendMessage(db, outsider.userId, "nope", NOW + 6)).toEqual({ ok: false, error: "no_match" });
    expect(await db.one("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 2 });
  });
});

describe("logout", () => {
  it("removes that session and queue row without ending the active match", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, { username: "alpha" });
    const beta = await seedUser(db, { username: "beta" });
    const waiting = await seedUser(db, { username: "waiting" });
    await joinQueue(db, alpha.userId, NOW);
    await joinQueue(db, beta.userId, NOW + 1);
    await insertQueue(db, alpha.userId, NOW + 2);
    await insertQueue(db, waiting.userId, NOW + 2, OTHER_KEY, "Other Artist", "Other Track", null);
    const otherSession = "alpha-other";
    await db.exec("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [
      otherSession,
      alpha.userId,
      NOW + 1_000_000_000,
    ]);

    await logout(db, alpha.sessionId);

    expect(await db.one("SELECT id FROM sessions WHERE id = $1", [alpha.sessionId])).toBeUndefined();
    expect(await queueRow(db, alpha.userId)).toBeUndefined();
    expect((await queueRow(db, waiting.userId))?.song_key).toBe(OTHER_KEY);
    expect(await db.one("SELECT status FROM matches")).toEqual({ status: "active" });
    expect(await readState(db, alpha.sessionId, NOW + 3, 0)).toEqual({ view: "signed_out", error: null });
    expect(await readState(db, otherSession, NOW + 3, 0)).toMatchObject({
      view: "chat",
      selfId: alpha.userId,
      partner: { username: "beta" },
    });
    expect(await readState(db, beta.sessionId, NOW + 3, 0)).toMatchObject({ view: "chat" });
  });
});

describe("joinQueue", () => {
  it("keeps joined_at when the same song is already queued and does not pair on that repeat", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, { username: "alpha" });
    const beta = await seedUser(db, { username: "beta" });
    expect(await joinQueue(db, alpha.userId, NOW)).toBe("waiting");
    await insertQueue(db, beta.userId, NOW + 1);

    expect(await joinQueue(db, alpha.userId, NOW + 5)).toBe("waiting");
    expect((await queueRow(db, alpha.userId))?.joined_at).toBe(NOW);
    expect(await db.query("SELECT id FROM matches")).toEqual([]);
    expect((await queueRow(db, beta.userId))?.joined_at).toBe(NOW + 1);
  });

  it("replaces the queue row when the cached song changes", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, {
      username: "alpha",
      cache: { artist: "Radiohead", track: "Everything in Its Right Place", artworkUrl: "https://art/first" },
    });
    expect(await joinQueue(db, alpha.userId, NOW)).toBe("waiting");
    await db.exec(
      `UPDATE now_playing
       SET artist = $1, track = $2, artwork_url = $3, song_key = $4, is_now_playing = 1, fetched_at = $5
       WHERE user_id = $6`,
      ["Other Artist", "Other Track", null, OTHER_KEY, NOW + 5, alpha.userId],
    );

    expect(await joinQueue(db, alpha.userId, NOW + 5)).toBe("waiting");
    expect(await queueRow(db, alpha.userId)).toEqual({
      song_key: OTHER_KEY,
      artist: "Other Artist",
      track: "Other Track",
      artwork_url: null,
      joined_at: NOW + 5,
    });
  });

  it("returns in_chat during an active match and does not insert a queue row", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, { username: "alpha" });
    const beta = await seedUser(db, { username: "beta" });
    await joinQueue(db, alpha.userId, NOW);
    await joinQueue(db, beta.userId, NOW + 1);
    await db.exec("DELETE FROM now_playing WHERE user_id = $1", [alpha.userId]);

    expect(await joinQueue(db, alpha.userId, NOW + 2)).toBe("in_chat");
    expect(await queueRow(db, alpha.userId)).toBeUndefined();
  });

  it("returns unavailable and does not write a queue row when the cache cannot be matched", async () => {
    const db = await tempDb();
    const missing = await seedUser(db, { username: "missing", cache: null });
    const stopped = await seedUser(db, {
      username: "stopped",
      cache: { isNowPlaying: 0, artist: "Old", track: "Song" },
    });
    const stale = await seedUser(db, {
      username: "stale",
      cache: { fetchedAt: NOW - NOW_PLAYING_TTL_MS },
    });
    const privateTracks = await seedUser(db, {
      username: "private",
      cache: {
        error: "private",
        isNowPlaying: 1,
        artist: "Secret",
        track: "Hidden",
        fetchedAt: NOW,
      },
    });
    const freshEdge = await seedUser(db, {
      username: "edge",
      cache: { fetchedAt: NOW - NOW_PLAYING_TTL_MS + 1 },
    });

    for (const user of [missing, stopped, stale, privateTracks]) {
      expect(await joinQueue(db, user.userId, NOW)).toBe("unavailable");
      expect(await queueRow(db, user.userId)).toBeUndefined();
    }
    expect(await joinQueue(db, freshEdge.userId, NOW)).toBe("waiting");
    expect((await queueRow(db, freshEdge.userId))?.joined_at).toBe(NOW);
  });

  it("stays unavailable when a queued cache goes stale and leaves the existing row alone", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, { username: "alpha" });
    expect(await joinQueue(db, alpha.userId, NOW)).toBe("waiting");
    await db.exec("UPDATE now_playing SET fetched_at = $1 WHERE user_id = $2", [
      NOW + 70_000 - NOW_PLAYING_TTL_MS,
      alpha.userId,
    ]);

    expect(await joinQueue(db, alpha.userId, NOW + 70_000)).toBe("unavailable");
    expect((await queueRow(db, alpha.userId))?.joined_at).toBe(NOW);
  });

  it("does not report matched when tryPair pairs two earlier waiters", async () => {
    const db = await tempDb();
    const early = await seedUser(db, { username: "early" });
    const middle = await seedUser(db, { username: "middle" });
    const late = await seedUser(db, { username: "late" });
    await insertQueue(db, early.userId, NOW);
    await insertQueue(db, middle.userId, NOW + 1);

    expect(await joinQueue(db, late.userId, NOW + 2)).toBe("waiting");
    expect((await queueRow(db, late.userId))?.joined_at).toBe(NOW + 2);
    expect(await db.one("SELECT user_a_id, user_b_id FROM matches")).toEqual({
      user_a_id: early.userId,
      user_b_id: middle.userId,
    });
  });
});

describe("cancelQueue", () => {
  it("deletes the caller's queue row and leaves them on home", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, { username: "alpha" });
    await joinQueue(db, alpha.userId, NOW);
    await cancelQueue(db, alpha.userId);
    await cancelQueue(db, alpha.userId);
    expect(await queueRow(db, alpha.userId)).toBeUndefined();
    expect(await readState(db, alpha.sessionId, NOW, 0)).toMatchObject({ view: "home", canMatch: true });
  });
});

describe("readState", () => {
  it("returns signed out for a missing, unknown, or expired session", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, { username: "alpha" });
    await db.exec("UPDATE sessions SET expires_at = $1 WHERE id = $2", [NOW, alpha.sessionId]);

    expect(await readState(db, null, NOW, 0)).toEqual({ view: "signed_out", error: null });
    expect(await readState(db, "missing", NOW, 0)).toEqual({ view: "signed_out", error: null });
    expect(await readState(db, alpha.sessionId, NOW, 0)).toEqual({ view: "signed_out", error: null });
    expect(await db.one("SELECT id FROM sessions WHERE id = $1", [alpha.sessionId])).toBeUndefined();
  });

  it("shows home for private, fresh, stale, idle, and empty caches", async () => {
    const db = await tempDb();
    const privateUser = await seedUser(db, {
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
    const privateFlag = await seedUser(db, {
      username: "private-flag",
      cache: {
        artist: "Secret",
        track: "Hidden",
        isNowPlaying: 1,
        error: "private",
        recentArtists: ["Kept"],
      },
    });
    const playing = await seedUser(db, {
      username: "playing",
      cache: {
        artist: "Radiohead",
        track: "Everything in Its Right Place",
        artworkUrl: "https://art/live",
        recentArtists: ["Radiohead", "Bjork"],
      },
    });
    const unreachable = await seedUser(db, {
      username: "unreachable",
      cache: { error: "unreachable", artworkUrl: null, recentArtists: ["Live"] },
    });
    const stale = await seedUser(db, {
      username: "stale-home",
      cache: { fetchedAt: NOW - NOW_PLAYING_TTL_MS, artworkUrl: "https://art/old" },
    });
    const idle = await seedUser(db, {
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
    const empty = await seedUser(db, { username: "empty", cache: null });

    expect(await readState(db, privateUser.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: null,
      recentArtists: ["One", "Two"],
      canMatch: false,
      notice: COPY.privateTracks,
    });
    expect(await readState(db, privateFlag.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: null,
      recentArtists: ["Kept"],
      canMatch: false,
      notice: COPY.privateTracks,
    });
    expect(await readState(db, playing.sessionId, NOW, 0)).toEqual({
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
    expect(await readState(db, unreachable.sessionId, NOW, 0)).toEqual({
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
    expect(await readState(db, stale.sessionId, NOW, 0)).toEqual({
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
    expect(await readState(db, idle.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: null,
      recentArtists: ["Zed"],
      canMatch: false,
      notice: null,
    });
    expect(await readState(db, empty.sessionId, NOW, 0)).toEqual({
      view: "home",
      nowPlaying: null,
      recentArtists: [],
      canMatch: false,
      notice: null,
    });
  });

  it("returns the queued song and a stale notice without using the live cache as the header", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, {
      username: "alpha",
      cache: { artist: "Live Artist", track: "Live Track", artworkUrl: "https://art/live", songKey: KEY },
    });
    await insertQueue(db, alpha.userId, NOW, KEY, "Queued Artist", "Queued Track", "https://art/queue");

    expect(await readState(db, alpha.sessionId, NOW, 0)).toEqual({
      view: "waiting",
      song: { artist: "Queued Artist", track: "Queued Track", artworkUrl: "https://art/queue" },
      notice: null,
    });

    await db.exec("UPDATE now_playing SET error = 'unreachable' WHERE user_id = $1", [alpha.userId]);
    expect(await readState(db, alpha.sessionId, NOW, 0)).toEqual({
      view: "waiting",
      song: { artist: "Queued Artist", track: "Queued Track", artworkUrl: "https://art/queue" },
      notice: COPY.stale,
    });

    await db.exec("UPDATE now_playing SET error = NULL, fetched_at = $1 WHERE user_id = $2", [
      NOW + 120_000 - NOW_PLAYING_TTL_MS,
      alpha.userId,
    ]);
    expect(await readState(db, alpha.sessionId, NOW + 120_000, 0)).toEqual({
      view: "waiting",
      song: { artist: "Queued Artist", track: "Queued Track", artworkUrl: "https://art/queue" },
      notice: COPY.stale,
    });
  });

  it("pairs a waiting caller while reading state", async () => {
    const db = await tempDb();
    const alpha = await seedUser(db, { username: "alpha", cache: { recentArtists: ["Alpha"] } });
    const beta = await seedUser(db, { username: "beta", cache: { recentArtists: ["Beta"] } });
    await insertQueue(db, alpha.userId, NOW);
    await insertQueue(db, beta.userId, NOW + 1);

    expect(await readState(db, beta.sessionId, NOW + 2, 0)).toMatchObject({
      view: "chat",
      selfId: beta.userId,
      partner: { username: "alpha", recentArtists: ["Alpha"] },
    });
    expect(await queueRow(db, alpha.userId)).toBeUndefined();
    expect(await queueRow(db, beta.userId)).toBeUndefined();
  });

  it("returns the frozen match song, snapshot, away flag, and messages after the cursor", async () => {
    const db = await tempDb();
    const early = await seedUser(db, {
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
    const later = await seedUser(db, {
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
    expect(await joinQueue(db, early.userId, NOW)).toBe("waiting");
    expect(await joinQueue(db, later.userId, NOW + 1)).toBe("matched");
    await db.exec(
      `UPDATE now_playing SET artist = 'Changed', track = 'Changed Track', artwork_url = 'https://art/new'
       WHERE user_id IN ($1, $2)`,
      [early.userId, later.userId],
    );
    const first = await sendMessage(db, early.userId, "first", NOW + 2);
    const second = await sendMessage(db, later.userId, "second", NOW + 3);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(await readState(db, later.sessionId, NOW + 3, 0)).toEqual({
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
    expect(await readState(db, early.sessionId, NOW + 3, first.id)).toMatchObject({
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
    await db.exec("UPDATE users SET last_heartbeat_at = $1 WHERE id = $2", [
      awayAt - (PRESENCE_MS + 1000),
      early.userId,
    ]);
    expect(await readState(db, later.sessionId, awayAt, second.id)).toMatchObject({
      view: "chat",
      partner: { away: true },
      messages: [],
    });
    await db.exec("UPDATE users SET last_heartbeat_at = $1 WHERE id = $2", [
      awayAt - PRESENCE_MS + 1,
      early.userId,
    ]);
    expect(await readState(db, later.sessionId, awayAt, second.id)).toMatchObject({
      partner: { away: false },
    });
    await db.exec("UPDATE users SET last_heartbeat_at = NULL WHERE id = $1", [early.userId]);
    expect(await readState(db, later.sessionId, awayAt, second.id)).toMatchObject({
      partner: { away: true },
    });
  });
});
