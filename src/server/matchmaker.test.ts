import { describe, expect, it } from "vitest";
import { NOW_PLAYING_TTL_MS, PRESENCE_MS } from "./constants";
import { openTestDatabase, type Db } from "./db";
import { tryPair } from "./matchmaker";
import { songKey } from "./song-key";

const NOW = 1_700_000_000_000;
const KEY = songKey("Radiohead", "Everything in Its Right Place");
const OTHER_KEY = songKey("Other Artist", "Other Track");

interface IdRow extends Record<string, unknown> {
  id: number;
}

interface MatchRow extends Record<string, unknown> {
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
}

interface UserIdRow extends Record<string, unknown> {
  user_id: number;
}

interface PairRow extends Record<string, unknown> {
  user_lo: number;
  user_hi: number;
}

function tempDb(): Promise<Db> {
  return openTestDatabase();
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

async function seedWaiting(db: Db, seed: Seed): Promise<number> {
  const queueKey = seed.queueKey ?? KEY;
  const artist = seed.artist ?? "Artist";
  const track = seed.track ?? "Track";
  const artworkUrl = seed.artworkUrl === undefined ? null : seed.artworkUrl;
  const inserted = await db.one<IdRow>(
    `INSERT INTO users (
       lastfm_username, lastfm_session_key, avatar_url, profile_url, created_at, last_heartbeat_at
     ) VALUES ($1, 'session', $2, $3, $4, $5)
     RETURNING id`,
    [
      seed.username,
      seed.avatarUrl === undefined ? null : seed.avatarUrl,
      seed.profileUrl === undefined ? null : seed.profileUrl,
      NOW,
      seed.heartbeatAt === undefined ? NOW : seed.heartbeatAt,
    ],
  );
  const id = Number(inserted?.id);
  await db.exec(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, NULL)`,
    [
      id,
      artist,
      track,
      artworkUrl,
      seed.isNowPlaying ?? 1,
      seed.nowPlayingKey === undefined ? queueKey : seed.nowPlayingKey,
      JSON.stringify(seed.recentArtists ?? []),
      seed.fetchedAt ?? NOW,
      NOW,
    ],
  );
  await db.exec(
    `INSERT INTO queue (user_id, song_key, artist, track, artwork_url, joined_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, queueKey, artist, track, artworkUrl, seed.joinedAt],
  );
  return id;
}

async function matchRows(db: Db): Promise<MatchRow[]> {
  return db.query<MatchRow>("SELECT * FROM matches ORDER BY id");
}

async function queuedIds(db: Db): Promise<number[]> {
  const rows = await db.query<UserIdRow>("SELECT user_id FROM queue ORDER BY user_id");
  return rows.map((row) => row.user_id);
}

describe("tryPair", () => {
  it("pairs the longer wait ahead of someone who joined later", async () => {
    const db = await tempDb();
    const later = await seedWaiting(db, {
      username: "later",
      joinedAt: 300,
      artist: "Later Artist",
      track: "Later Track",
      artworkUrl: "https://art/later",
    });
    const earliest = await seedWaiting(db, {
      username: "dj/one",
      joinedAt: 100,
      artist: "Early Artist",
      track: "Early Track",
      artworkUrl: "https://art/early",
      avatarUrl: "https://img/early",
      recentArtists: ["Alpha", "Beta"],
    });
    const middle = await seedWaiting(db, {
      username: "middle",
      joinedAt: 200,
      artist: "Middle Artist",
      track: "Middle Track",
      artworkUrl: "https://art/middle",
      avatarUrl: null,
      profileUrl: "https://www.last.fm/user/middle",
      recentArtists: ["Gamma"],
    });

    const id = await tryPair(db, KEY, NOW);
    const rows = await matchRows(db);

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
    expect(await queuedIds(db)).toEqual([later]);
  });

  it("pairs the lower user id as user_a when joined_at is equal", async () => {
    const db = await tempDb();
    const low = await seedWaiting(db, { username: "low", joinedAt: 50 });
    const mid = await seedWaiting(db, { username: "mid", joinedAt: 50 });
    const high = await seedWaiting(db, { username: "high", joinedAt: 50 });

    await tryPair(db, KEY, NOW);

    expect((await matchRows(db))[0]).toMatchObject({ user_a_id: low, user_b_id: mid });
    expect(await queuedIds(db)).toEqual([high]);
  });

  it("skips a heartbeat outside the presence window and pairs the remaining two", async () => {
    const db = await tempDb();
    const stale = await seedWaiting(db, {
      username: "stale-heart",
      joinedAt: 1,
      heartbeatAt: NOW - (PRESENCE_MS + 1000),
    });
    const second = await seedWaiting(db, { username: "second", joinedAt: 2 });
    const third = await seedWaiting(db, { username: "third", joinedAt: 3 });

    await tryPair(db, KEY, NOW);

    expect((await matchRows(db))[0]).toMatchObject({ user_a_id: second, user_b_id: third });
    expect(await queuedIds(db)).toEqual([stale]);
  });

  it("skips a mismatched now-playing key and a fetch older than 60 seconds", async () => {
    const db = await tempDb();
    const wrongSong = await seedWaiting(db, {
      username: "wrong-song",
      joinedAt: 1,
      nowPlayingKey: OTHER_KEY,
    });
    const staleFetch = await seedWaiting(db, {
      username: "stale-fetch",
      joinedAt: 2,
      fetchedAt: NOW - NOW_PLAYING_TTL_MS,
    });
    const first = await seedWaiting(db, { username: "ok-a", joinedAt: 3 });
    const second = await seedWaiting(db, { username: "ok-b", joinedAt: 4 });

    await tryPair(db, KEY, NOW);

    expect((await matchRows(db))[0]).toMatchObject({ user_a_id: first, user_b_id: second });
    expect(await queuedIds(db)).toEqual([wrongSong, staleFetch]);
  });

  it("keeps a recorded pair queued and matches the third user with the longer waiter", async () => {
    const db = await tempDb();
    const longer = await seedWaiting(db, { username: "longer", joinedAt: 10 });
    const shorter = await seedWaiting(db, { username: "shorter", joinedAt: 20 });
    const third = await seedWaiting(db, { username: "third", joinedAt: 30 });
    const lo = Math.min(longer, shorter);
    const hi = Math.max(longer, shorter);
    await db.exec("INSERT INTO pairs (user_lo, user_hi) VALUES ($1, $2)", [lo, hi]);

    await tryPair(db, KEY, NOW);

    expect((await matchRows(db))[0]).toMatchObject({ user_a_id: longer, user_b_id: third });
    expect(await queuedIds(db)).toEqual([shorter]);
    expect(await db.query<PairRow>("SELECT user_lo, user_hi FROM pairs")).toEqual([
      { user_lo: lo, user_hi: hi },
    ]);
  });

  it("creates one match when tryPair is called twice", async () => {
    const db = await tempDb();
    await seedWaiting(db, { username: "a", joinedAt: 1 });
    await seedWaiting(db, { username: "b", joinedAt: 2 });

    const first = await tryPair(db, KEY, NOW);
    const second = await tryPair(db, KEY, NOW);

    expect(first).toEqual(expect.any(Number));
    expect(second).toBeNull();
    expect(await matchRows(db)).toHaveLength(1);
    expect(await queuedIds(db)).toEqual([]);
  });

  it("aborts when a chosen queue row changes song before the re-check", async () => {
    const db = await tempDb();
    const changed = await seedWaiting(db, { username: "changed", joinedAt: 1 });
    const other = await seedWaiting(db, { username: "other", joinedAt: 2 });

    const id = await tryPair(db, KEY, NOW, async (tx) => {
      await tx.exec(
        "UPDATE queue SET song_key = $1, artist = 'Other Artist', track = 'Other Track' WHERE user_id = $2",
        [OTHER_KEY, changed],
      );
    });

    expect(id).toBeNull();
    expect(await matchRows(db)).toEqual([]);
    expect(await queuedIds(db)).toEqual([changed, other].sort((left, right) => left - right));
  });

  it("lets only one of two overlapping tryPair calls create a match", async () => {
    const db = await tempDb();
    await seedWaiting(db, { username: "a", joinedAt: 1 });
    await seedWaiting(db, { username: "b", joinedAt: 2 });

    const results = await Promise.all([tryPair(db, KEY, NOW), tryPair(db, KEY, NOW)]);

    expect(results.filter((id) => id !== null)).toHaveLength(1);
    expect(await matchRows(db)).toHaveLength(1);
  });

  it("does not put a user who already has an active match into a second one", async () => {
    const db = await tempDb();
    const busy = await seedWaiting(db, { username: "busy", joinedAt: 1 });
    const left = await seedWaiting(db, { username: "left", joinedAt: 2 });
    const right = await seedWaiting(db, { username: "right", joinedAt: 3 });
    const outsider = await db.one<IdRow>(
      "INSERT INTO users (lastfm_username, lastfm_session_key, created_at) VALUES ('outsider', 'k', $1) RETURNING id",
      [NOW],
    );
    const existing = await db.one<IdRow>(
      `INSERT INTO matches (
         song_key, artist, track, artwork_url, user_a_id, user_b_id,
         snapshot_a, snapshot_b, status, created_at
       ) VALUES ('other', 'Z', 'Song', NULL, $1, $2, '{}', '{}', 'active', $3)
       RETURNING id`,
      [Number(outsider?.id), busy, NOW - 10],
    );

    const id = await tryPair(db, KEY, NOW);
    const rows = await matchRows(db);

    expect(id).not.toBe(Number(existing?.id));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ user_a_id: left, user_b_id: right, status: "active" });
    const busyMatches = await db.query<IdRow>(
      `SELECT id FROM matches WHERE status = 'active' AND (user_a_id = $1 OR user_b_id = $1)`,
      [busy],
    );
    expect(busyMatches).toEqual([{ id: Number(existing?.id) }]);
    expect(await queuedIds(db)).toEqual([busy]);
  });
});
