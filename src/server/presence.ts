import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { LASTFM_REFRESH_MS, PROFILE_TTL_MS, SESSION_TTL_MS } from "./constants";
import { nowPlayingTrack, recentArtists, type LastfmClient, type LastfmTrack } from "./lastfm";
import { songKey } from "./song-key";

type Db = Database.Database;

type UserRow = {
  lastfm_username: string;
  lastfm_session_key: string;
  profile_fetched_at: number | null;
};

export function upsertUser(
  db: Db,
  input: {
    username: string;
    sessionKey: string;
    now: number;
    avatarUrl: string | null;
    profileUrl: string;
  },
): number {
  const existing = db
    .prepare("SELECT id FROM users WHERE lastfm_username = ?")
    .get(input.username) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE users
       SET lastfm_session_key = ?, avatar_url = ?, profile_url = ?, profile_fetched_at = ?
       WHERE id = ?`,
    ).run(input.sessionKey, input.avatarUrl, input.profileUrl, input.now, existing.id);
    return existing.id;
  }
  const inserted = db
    .prepare(
      `INSERT INTO users (
         lastfm_username, lastfm_session_key, avatar_url, profile_url, profile_fetched_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.username,
      input.sessionKey,
      input.avatarUrl,
      input.profileUrl,
      input.now,
      input.now,
    );
  return Number(inserted.lastInsertRowid);
}

export function createSession(db: Db, userId: number, now: number): string {
  const id = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    id,
    userId,
    now + SESSION_TTL_MS,
  );
  return id;
}

export function readSession(db: Db, sessionId: string, now: number): { userId: number } | null {
  const row = db.prepare("SELECT user_id, expires_at FROM sessions WHERE id = ?").get(sessionId) as
    | { user_id: number; expires_at: number }
    | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    deleteSession(db, sessionId);
    return null;
  }
  return { userId: row.user_id };
}

export function deleteSession(db: Db, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function sessionCookie(sessionId: string, appUrl: string): string {
  const cookie = `musicmatch_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
  if (appUrl.startsWith("https://")) return `${cookie}; Secure`;
  return cookie;
}

export function recordHeartbeat(db: Db, sessionId: string, now: number): void {
  const row = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sessionId) as
    | { user_id: number }
    | undefined;
  if (!row) return;
  db.prepare("UPDATE users SET last_heartbeat_at = ? WHERE id = ?").run(now, row.user_id);
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(now + SESSION_TTL_MS, sessionId);
}

function writeSuccess(
  db: Db,
  userId: number,
  now: number,
  hasCache: boolean,
  tracks: LastfmTrack[],
  playing: LastfmTrack | null,
  key: string | null,
): void {
  const artists = JSON.stringify(recentArtists(tracks));
  const artist = playing?.artist ?? null;
  const title = playing?.track ?? null;
  const album = playing?.album ?? null;
  const artwork = playing?.artworkUrl ?? null;
  const isNow = playing ? 1 : 0;
  if (hasCache) {
    db.prepare(
      `UPDATE now_playing
       SET artist = ?, track = ?, album = ?, artwork_url = ?, is_now_playing = ?,
           song_key = ?, recent_artists = ?, fetched_at = ?, attempted_at = ?, error = NULL
       WHERE user_id = ?`,
    ).run(artist, title, album, artwork, isNow, key, artists, now, now, userId);
    return;
  }
  db.prepare(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(userId, artist, title, album, artwork, isNow, key, artists, now, now);
}

function writePrivate(db: Db, userId: number, now: number, hasCache: boolean): void {
  if (hasCache) {
    db.prepare(
      `UPDATE now_playing
       SET is_now_playing = 0, error = 'private', fetched_at = ?, attempted_at = ?
       WHERE user_id = ?`,
    ).run(now, now, userId);
    return;
  }
  db.prepare(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES (?, NULL, NULL, NULL, NULL, 0, NULL, '[]', ?, ?, 'private')`,
  ).run(userId, now, now);
}

function writeUnreachable(db: Db, userId: number, now: number, hasCache: boolean): void {
  if (hasCache) {
    db.prepare("UPDATE now_playing SET attempted_at = ?, error = 'unreachable' WHERE user_id = ?").run(
      now,
      userId,
    );
    return;
  }
  db.prepare(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES (?, NULL, NULL, NULL, NULL, 0, NULL, '[]', 0, ?, 'unreachable')`,
  ).run(userId, now);
}

function writeRejected(db: Db, userId: number, now: number, hasCache: boolean): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  if (hasCache) {
    db.prepare("UPDATE now_playing SET attempted_at = ?, error = 'rejected' WHERE user_id = ?").run(
      now,
      userId,
    );
    return;
  }
  db.prepare(
    `INSERT INTO now_playing (
       user_id, artist, track, album, artwork_url, is_now_playing, song_key,
       recent_artists, fetched_at, attempted_at, error
     ) VALUES (?, NULL, NULL, NULL, NULL, 0, NULL, '[]', 0, ?, 'rejected')`,
  ).run(userId, now);
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
    db.prepare(
      "UPDATE users SET avatar_url = ?, profile_url = ?, profile_fetched_at = ? WHERE id = ?",
    ).run(info.avatarUrl, info.profileUrl, now, userId);
    return;
  }
  if (info.reason === "rejected") {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export async function refreshIfDue(
  db: Db,
  userId: number,
  client: LastfmClient,
  now: number,
): Promise<void> {
  const cache = db.prepare("SELECT attempted_at FROM now_playing WHERE user_id = ?").get(userId) as
    | { attempted_at: number }
    | undefined;
  if (cache && now - cache.attempted_at < LASTFM_REFRESH_MS) return;

  const user = db
    .prepare(
      "SELECT lastfm_username, lastfm_session_key, profile_fetched_at FROM users WHERE id = ?",
    )
    .get(userId) as UserRow | undefined;
  if (!user) return;

  const recent = await client.getRecentTracks(user.lastfm_username, user.lastfm_session_key);
  const hasCache = cache != null;
  if (!recent.ok && recent.reason === "rejected") {
    writeRejected(db, userId, now, hasCache);
    return;
  }
  if (!recent.ok && recent.reason === "private") {
    writePrivate(db, userId, now, hasCache);
    db.prepare("DELETE FROM queue WHERE user_id = ?").run(userId);
  } else if (!recent.ok) {
    writeUnreachable(db, userId, now, hasCache);
  } else {
    const playing = nowPlayingTrack(recent.tracks);
    const key = playing ? songKey(playing.artist, playing.track) : null;
    writeSuccess(db, userId, now, hasCache, recent.tracks, playing, key);
    const queued = db.prepare("SELECT song_key FROM queue WHERE user_id = ?").get(userId) as
      | { song_key: string }
      | undefined;
    if (queued && (!playing || queued.song_key !== key)) {
      db.prepare("DELETE FROM queue WHERE user_id = ?").run(userId);
    }
  }

  await refreshProfile(db, userId, user, client, now);
}
