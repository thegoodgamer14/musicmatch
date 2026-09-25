import { NOW_PLAYING_TTL_MS, PRESENCE_MS } from "./constants";
import { COPY } from "./copy";
import type { Db } from "./db";
import { tryPair } from "./matchmaker";
import { deleteSession, readSession } from "./presence";

export type AppState =
  | { view: "signed_out"; error: null }
  | {
      view: "home";
      nowPlaying: { artist: string; track: string; artworkUrl: string | null } | null;
      recentArtists: string[];
      canMatch: boolean;
      notice: string | null;
    }
  | {
      view: "waiting";
      song: { artist: string; track: string; artworkUrl: string | null };
      notice: string | null;
    }
  | {
      view: "chat";
      selfId: number;
      partner: {
        username: string;
        avatarUrl: string | null;
        profileUrl: string;
        recentArtists: string[];
        away: boolean;
      };
      song: { artist: string; track: string; artworkUrl: string | null };
      messages: { id: number; senderId: number; body: string; createdAt: number }[];
    };

interface NowPlayingRow extends Record<string, unknown> {
  artist: string | null;
  track: string | null;
  artwork_url: string | null;
  is_now_playing: number;
  song_key: string | null;
  recent_artists: string;
  fetched_at: number;
  error: string | null;
}

interface MatchRow extends Record<string, unknown> {
  id: number;
  artist: string;
  track: string;
  artwork_url: string | null;
  user_a_id: number;
  user_b_id: number;
  snapshot_a: string;
  snapshot_b: string;
}

interface QueueRow extends Record<string, unknown> {
  song_key: string;
  artist: string;
  track: string;
  artwork_url: string | null;
  joined_at: number;
}

interface MessageRow extends Record<string, unknown> {
  id: number;
  sender_id: number;
  body: string;
  created_at: number;
}

interface HeartbeatRow extends Record<string, unknown> {
  last_heartbeat_at: number | null;
}

interface UserIdRow extends Record<string, unknown> {
  user_id: number;
}

interface IdRow extends Record<string, unknown> {
  id: number;
}

function cacheIsCurrent(fetchedAt: number, now: number): boolean {
  return fetchedAt > now - NOW_PLAYING_TTL_MS;
}

async function nowPlaying(db: Db, userId: number): Promise<NowPlayingRow | undefined> {
  return db.one<NowPlayingRow>(
    `SELECT artist, track, artwork_url, is_now_playing, song_key, recent_artists, fetched_at, error
     FROM now_playing WHERE user_id = $1`,
    [userId],
  );
}

async function activeMatch(db: Db, userId: number): Promise<MatchRow | undefined> {
  return db.one<MatchRow>(
    `SELECT id, artist, track, artwork_url, user_a_id, user_b_id, snapshot_a, snapshot_b
     FROM matches
     WHERE status = 'active' AND (user_a_id = $1 OR user_b_id = $1)
     ORDER BY id ASC
     LIMIT 1`,
    [userId],
  );
}

async function queueFor(db: Db, userId: number): Promise<QueueRow | undefined> {
  return db.one<QueueRow>(
    "SELECT song_key, artist, track, artwork_url, joined_at FROM queue WHERE user_id = $1",
    [userId],
  );
}

function recentArtists(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function partnerSnapshot(raw: string): {
  username: string;
  avatarUrl: string | null;
  profileUrl: string;
  recentArtists: string[];
} {
  const parsed = JSON.parse(raw) as {
    username?: unknown;
    avatarUrl?: unknown;
    profileUrl?: unknown;
    recentArtists?: unknown;
  };
  return {
    username: typeof parsed.username === "string" ? parsed.username : "",
    avatarUrl: typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : null,
    profileUrl: typeof parsed.profileUrl === "string" ? parsed.profileUrl : "",
    recentArtists: Array.isArray(parsed.recentArtists)
      ? parsed.recentArtists.filter((item): item is string => typeof item === "string")
      : [],
  };
}

async function chatState(
  db: Db,
  userId: number,
  match: MatchRow,
  afterMessageId: number,
  now: number,
): Promise<AppState> {
  const selfIsA = match.user_a_id === userId;
  const partnerId = selfIsA ? match.user_b_id : match.user_a_id;
  const snapshot = partnerSnapshot(selfIsA ? match.snapshot_b : match.snapshot_a);
  const partner = await db.one<HeartbeatRow>("SELECT last_heartbeat_at FROM users WHERE id = $1", [
    partnerId,
  ]);
  const heartbeat = partner?.last_heartbeat_at ?? null;
  const away = heartbeat == null || heartbeat <= now - PRESENCE_MS;
  const messages = await db.query<MessageRow>(
    `SELECT id, sender_id, body, created_at
     FROM messages
     WHERE match_id = $1 AND id > $2
     ORDER BY id ASC`,
    [match.id, afterMessageId],
  );
  return {
    view: "chat",
    selfId: userId,
    partner: { ...snapshot, away },
    song: { artist: match.artist, track: match.track, artworkUrl: match.artwork_url },
    messages: messages.map((message) => ({
      id: message.id,
      senderId: message.sender_id,
      body: message.body,
      createdAt: message.created_at,
    })),
  };
}

function homeState(cache: NowPlayingRow | undefined, now: number): AppState {
  if (!cache) {
    return { view: "home", nowPlaying: null, recentArtists: [], canMatch: false, notice: null };
  }
  const artists = recentArtists(cache.recent_artists);
  if (cache.error === "private") {
    return {
      view: "home",
      nowPlaying: null,
      recentArtists: artists,
      canMatch: false,
      notice: COPY.privateTracks,
    };
  }
  const playing =
    cache.is_now_playing === 1 && cache.artist != null && cache.track != null
      ? { artist: cache.artist, track: cache.track, artworkUrl: cache.artwork_url }
      : null;
  if (!playing) {
    return { view: "home", nowPlaying: null, recentArtists: artists, canMatch: false, notice: null };
  }
  const current = cacheIsCurrent(cache.fetched_at, now);
  return {
    view: "home",
    nowPlaying: playing,
    recentArtists: artists,
    canMatch: current,
    notice: !current || cache.error === "unreachable" ? COPY.stale : null,
  };
}

function waitingNotice(cache: NowPlayingRow | undefined, now: number): string | null {
  if (!cache) return null;
  if (cache.error === "unreachable" || !cacheIsCurrent(cache.fetched_at, now)) return COPY.stale;
  return null;
}

export async function joinQueue(
  db: Db,
  userId: number,
  now: number,
): Promise<"waiting" | "matched" | "unavailable" | "in_chat"> {
  if (await activeMatch(db, userId)) return "in_chat";

  const cache = await nowPlaying(db, userId);
  if (
    !cache ||
    cache.is_now_playing !== 1 ||
    !cacheIsCurrent(cache.fetched_at, now) ||
    cache.error === "private" ||
    cache.song_key == null ||
    cache.artist == null ||
    cache.track == null
  ) {
    return "unavailable";
  }

  const existing = await queueFor(db, userId);
  if (existing?.song_key === cache.song_key) return "waiting";

  if (existing) {
    await db.exec(
      `UPDATE queue
       SET song_key = $1, artist = $2, track = $3, artwork_url = $4, joined_at = $5
       WHERE user_id = $6`,
      [cache.song_key, cache.artist, cache.track, cache.artwork_url, now, userId],
    );
  } else {
    await db.exec(
      `INSERT INTO queue (user_id, song_key, artist, track, artwork_url, joined_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, cache.song_key, cache.artist, cache.track, cache.artwork_url, now],
    );
  }

  await tryPair(db, cache.song_key, now);
  if (await activeMatch(db, userId)) return "matched";
  return "waiting";
}

export async function cancelQueue(db: Db, userId: number): Promise<void> {
  await db.exec("DELETE FROM queue WHERE user_id = $1", [userId]);
}

export async function logout(db: Db, sessionId: string): Promise<void> {
  const row = await db.one<UserIdRow>("SELECT user_id FROM sessions WHERE id = $1", [sessionId]);
  await deleteSession(db, sessionId);
  if (!row) return;
  await db.exec("DELETE FROM queue WHERE user_id = $1", [row.user_id]);
}

export async function sendMessage(
  db: Db,
  userId: number,
  body: string,
  now: number,
): Promise<{ ok: true; id: number } | { ok: false; error: "empty" | "too_long" | "no_match" }> {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty" };
  if (trimmed.length > 500) return { ok: false, error: "too_long" };
  const match = await activeMatch(db, userId);
  if (!match) return { ok: false, error: "no_match" };
  const inserted = await db.one<IdRow>(
    "INSERT INTO messages (match_id, sender_id, body, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
    [match.id, userId, trimmed, now],
  );
  if (!inserted) throw new Error("Message insert did not return an id");
  return { ok: true, id: inserted.id };
}

export async function leaveMatch(
  db: Db,
  userId: number,
  now: number,
): Promise<{ ended: boolean }> {
  return db.transaction(async (tx) => {
    const match = await activeMatch(tx, userId);
    if (!match) return { ended: false };
    const updated = await tx.one<IdRow>(
      `UPDATE matches
       SET status = 'ended', ended_by = $1, ended_at = $2
       WHERE id = $3 AND status = 'active'
       RETURNING id`,
      [userId, now, match.id],
    );
    if (!updated) return { ended: false };
    const lo = Math.min(match.user_a_id, match.user_b_id);
    const hi = Math.max(match.user_a_id, match.user_b_id);
    await tx.exec(
      "INSERT INTO pairs (user_lo, user_hi) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [lo, hi],
    );
    return { ended: true };
  });
}

export async function readState(
  db: Db,
  sessionId: string | null,
  now: number,
  afterMessageId: number,
): Promise<AppState> {
  if (sessionId == null) return { view: "signed_out", error: null };
  const session = await readSession(db, sessionId, now);
  if (!session) return { view: "signed_out", error: null };

  const match = await activeMatch(db, session.userId);
  if (match) return chatState(db, session.userId, match, afterMessageId, now);

  const queued = await queueFor(db, session.userId);
  if (queued) {
    await tryPair(db, queued.song_key, now);
    const paired = await activeMatch(db, session.userId);
    if (paired) return chatState(db, session.userId, paired, afterMessageId, now);
    return {
      view: "waiting",
      song: { artist: queued.artist, track: queued.track, artworkUrl: queued.artwork_url },
      notice: waitingNotice(await nowPlaying(db, session.userId), now),
    };
  }

  return homeState(await nowPlaying(db, session.userId), now);
}
