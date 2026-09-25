import { randomBytes } from "node:crypto";
import { LASTFM_REFRESH_MS, PROFILE_TTL_MS, SESSION_TTL_MS } from "./constants";
import type { Db } from "./db";
import { nowPlayingTrack, recentArtists, type LastfmClient, type LastfmTrack } from "./lastfm";
import { songKey } from "./song-key";

interface UserRow extends Record<string, unknown> {
  lastfm_username: string;
  lastfm_session_key: string;
  profile_fetched_at: number | null;
}

interface IdRow extends Record<string, unknown> {
  id: number;
}

interface SessionRow extends Record<string, unknown> {
  user_id: number;
  expires_at: number;
}

interface UserIdRow extends Record<string, unknown> {
  user_id: number;
}

interface AttemptedRow extends Record<string, unknown> {
  attempted_at: number;
}

interface SongKeyRow extends Record<string, unknown> {
  song_key: string;
}

export async function upsertUser(
  db: Db,
  input: {
    username: string;
    sessionKey: string;
    now: number;
    avatarUrl: string | null;
    profileUrl: string;
  },
): Promise<number> {
  const existing = await db.one<IdRow>("SELECT id FROM users WHERE lastfm_username = $1", [
    input.username,
  ]);
  if (existing) {
    await db.exec(
      `UPDATE users
       SET lastfm_session_key = $1, avatar_url = $2, profile_url = $3, profile_fetched_at = $4
       WHERE id = $5`,
      [input.sessionKey, input.avatarUrl, input.profileUrl, input.now, existing.id],
    );
    return existing.id;
  }
  const inserted = await db.one<IdRow>(
    `INSERT INTO users (
       lastfm_username, lastfm_session_key, avatar_url, profile_url, profile_fetched_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [input.username, input.sessionKey, input.avatarUrl, input.profileUrl, input.now, input.now],
  );
  if (!inserted) throw new Error("User insert did not return an id");
  return inserted.id;
}

export async function createSession(db: Db, userId: number, now: number): Promise<string> {
  const id = randomBytes(32).toString("hex");
  await db.exec("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [
    id,
    userId,
    now + SESSION_TTL_MS,
  ]);
  return id;
}

export async function readSession(
  db: Db,
  sessionId: string,
  now: number,
): Promise<{ userId: number } | null> {
  const row = await db.one<SessionRow>("SELECT user_id, expires_at FROM sessions WHERE id = $1", [
    sessionId,
  ]);
  if (!row) return null;
  if (row.expires_at <= now) {
    await deleteSession(db, sessionId);
    return null;
  }
  return { userId: row.user_id };
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.exec("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export function sessionCookie(sessionId: string, appUrl: string): string {
  const cookie = `musicmatch_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
  if (appUrl.startsWith("https://")) return `${cookie}; Secure`;
  return cookie;
}

export async function recordHeartbeat(db: Db, sessionId: string, now: number): Promise<void> {
  const row = await db.one<UserIdRow>("SELECT user_id FROM sessions WHERE id = $1", [sessionId]);
  if (!row) return;
  await db.exec("UPDATE users SET last_heartbeat_at = $1 WHERE id = $2", [now, row.user_id]);
  await db.exec("UPDATE sessions SET expires_at = $1 WHERE id = $2", [now + SESSION_TTL_MS, sessionId]);
}

async function writeSuccess(
  db: Db,
  userId: number,
  now: number,
  hasCache: boolean,
  tracks: LastfmTrack[],
  playing: LastfmTrack | null,
  key: string | null,
): Promise<void> {
  const artists = JSON.stringify(recentArtists(tracks));
  const artist = playing?.artist ?? null;
  const title = playing?.track ?? null;
  const album = playing?.album ?? null;
  const artwork = playing?.artworkUrl ?? null;
  const isNow = playing ? 1 : 0;
  if (hasCache) {
    await db.exec(
      `UPDATE now_playing
       SET artist = $1, track = $2, album = $3, artwork_url = $4, is_now_playing = $5,
           song_key = $6, recent_artists = $7, fetched_at = $8, attempted_at = $9, error = NULL
       WHERE user_id = $10`,
      [artist, title, album, artwork, isNow, key, artists, now, now, userId],
    );
    return;
  }
  await db.exec(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
    [userId, artist, title, album, artwork, isNow, key, artists, now, now],
  );
}

async function writePrivate(db: Db, userId: number, now: number, hasCache: boolean): Promise<void> {
  if (hasCache) {
    await db.exec(
      `UPDATE now_playing
       SET is_now_playing = 0, error = 'private', fetched_at = $1, attempted_at = $2
       WHERE user_id = $3`,
      [now, now, userId],
    );
    return;
  }
  await db.exec(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES ($1, NULL, NULL, NULL, NULL, 0, NULL, '[]', $2, $3, 'private')`,
    [userId, now, now],
  );
}

async function writeUnreachable(db: Db, userId: number, now: number, hasCache: boolean): Promise<void> {
  if (hasCache) {
    await db.exec("UPDATE now_playing SET attempted_at = $1, error = 'unreachable' WHERE user_id = $2", [
      now,
      userId,
    ]);
    return;
  }
  await db.exec(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES ($1, NULL, NULL, NULL, NULL, 0, NULL, '[]', 0, $2, 'unreachable')`,
    [userId, now],
  );
}

async function writeRejected(db: Db, userId: number, now: number, hasCache: boolean): Promise<void> {
  await db.exec("DELETE FROM sessions WHERE user_id = $1", [userId]);
  if (hasCache) {
    await db.exec("UPDATE now_playing SET attempted_at = $1, error = 'rejected' WHERE user_id = $2", [
      now,
      userId,
    ]);
    return;
  }
  await db.exec(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES ($1, NULL, NULL, NULL, NULL, 0, NULL, '[]', 0, $2, 'rejected')`,
    [userId, now],
  );
}

async function refreshProfile(
  db: Db,
  userId: number,
  user: UserRow,
  client: LastfmClient,
  now: number,
): Promise<void> {
  if (user.profile_fetched_at != null && now - user.profile_fetched_at <= PROFILE_TTL_MS) return;
  const info = await client.getInfo(user.lastfm_username, user.lastfm_session_key);
  if (info.ok) {
    await db.exec(
      "UPDATE users SET avatar_url = $1, profile_url = $2, profile_fetched_at = $3 WHERE id = $4",
      [info.avatarUrl, info.profileUrl, now, userId],
    );
    return;
  }
  if (info.reason === "rejected") {
    await db.exec("DELETE FROM sessions WHERE user_id = $1", [userId]);
  }
}

export async function refreshIfDue(
  db: Db,
  userId: number,
  client: LastfmClient,
  now: number,
): Promise<void> {
  const cache = await db.one<AttemptedRow>("SELECT attempted_at FROM now_playing WHERE user_id = $1", [
    userId,
  ]);
  if (cache && now - cache.attempted_at < LASTFM_REFRESH_MS) return;

  const user = await db.one<UserRow>(
    "SELECT lastfm_username, lastfm_session_key, profile_fetched_at FROM users WHERE id = $1",
    [userId],
  );
  if (!user) return;

  const recent = await client.getRecentTracks(user.lastfm_username, user.lastfm_session_key);
  const hasCache = cache != null;
  if (!recent.ok && recent.reason === "rejected") {
    await writeRejected(db, userId, now, hasCache);
    return;
  }
  if (!recent.ok && recent.reason === "private") {
    await writePrivate(db, userId, now, hasCache);
    await db.exec("DELETE FROM queue WHERE user_id = $1", [userId]);
  } else if (!recent.ok) {
    await writeUnreachable(db, userId, now, hasCache);
  } else {
    const playing = nowPlayingTrack(recent.tracks);
    const key = playing ? songKey(playing.artist, playing.track) : null;
    await writeSuccess(db, userId, now, hasCache, recent.tracks, playing, key);
    const queued = await db.one<SongKeyRow>("SELECT song_key FROM queue WHERE user_id = $1", [userId]);
    if (queued && (!playing || queued.song_key !== key)) {
      await db.exec("DELETE FROM queue WHERE user_id = $1", [userId]);
    }
  }

  await refreshProfile(db, userId, user, client, now);
}
