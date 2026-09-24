import Database from "better-sqlite3";
import { NOW_PLAYING_TTL_MS, PRESENCE_MS } from "./constants";
import { COPY } from "./copy";
import { tryPair } from "./matchmaker";
import { deleteSession, readSession } from "./presence";

type Db = Database.Database;

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

type NowPlayingRow = {
  artist: string | null;
  track: string | null;
  artwork_url: string | null;
  is_now_playing: number;
  song_key: string | null;
  recent_artists: string;
  fetched_at: number;
  error: string | null;
};

type MatchRow = {
  id: number;
  artist: string;
  track: string;
  artwork_url: string | null;
  user_a_id: number;
  user_b_id: number;
  snapshot_a: string;
  snapshot_b: string;
};

type QueueRow = {
  song_key: string;
  artist: string;
  track: string;
  artwork_url: string | null;
  joined_at: number;
};

type MessageRow = {
  id: number;
  sender_id: number;
  body: string;
  created_at: number;
};

function cacheIsCurrent(fetchedAt: number, now: number): boolean {
  return fetchedAt > now - NOW_PLAYING_TTL_MS;
}

function nowPlaying(db: Db, userId: number): NowPlayingRow | undefined {
  return db
    .prepare(
      `SELECT artist, track, artwork_url, is_now_playing, song_key, recent_artists, fetched_at, error
       FROM now_playing WHERE user_id = ?`,
    )
    .get(userId) as NowPlayingRow | undefined;
}

function activeMatch(db: Db, userId: number): MatchRow | undefined {
  return db
    .prepare(
      `SELECT id, artist, track, artwork_url, user_a_id, user_b_id, snapshot_a, snapshot_b
       FROM matches
       WHERE status = 'active' AND (user_a_id = ? OR user_b_id = ?)
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(userId, userId) as MatchRow | undefined;
}

function queueFor(db: Db, userId: number): QueueRow | undefined {
  return db
    .prepare(
      "SELECT song_key, artist, track, artwork_url, joined_at FROM queue WHERE user_id = ?",
    )
    .get(userId) as QueueRow | undefined;
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

function chatState(
  db: Db,
  userId: number,
  match: MatchRow,
  afterMessageId: number,
  now: number,
): AppState {
  const selfIsA = match.user_a_id === userId;
  const partnerId = selfIsA ? match.user_b_id : match.user_a_id;
  const snapshot = partnerSnapshot(selfIsA ? match.snapshot_b : match.snapshot_a);
  const partner = db.prepare("SELECT last_heartbeat_at FROM users WHERE id = ?").get(partnerId) as
    | { last_heartbeat_at: number | null }
    | undefined;
  const heartbeat = partner?.last_heartbeat_at ?? null;
  const away = heartbeat == null || heartbeat <= now - PRESENCE_MS;
  const messages = db
    .prepare(
      `SELECT id, sender_id, body, created_at
       FROM messages
       WHERE match_id = ? AND id > ?
       ORDER BY id ASC`,
    )
    .all(match.id, afterMessageId) as MessageRow[];
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

export function joinQueue(
  db: Db,
  userId: number,
  now: number,
): "waiting" | "matched" | "unavailable" | "in_chat" {
  if (activeMatch(db, userId)) return "in_chat";

  const cache = nowPlaying(db, userId);
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

  const existing = queueFor(db, userId);
  if (existing?.song_key === cache.song_key) return "waiting";

  if (existing) {
    db.prepare(
      `UPDATE queue
       SET song_key = ?, artist = ?, track = ?, artwork_url = ?, joined_at = ?
       WHERE user_id = ?`,
    ).run(cache.song_key, cache.artist, cache.track, cache.artwork_url, now, userId);
  } else {
    db.prepare(
      `INSERT INTO queue (user_id, song_key, artist, track, artwork_url, joined_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, cache.song_key, cache.artist, cache.track, cache.artwork_url, now);
  }

  tryPair(db, cache.song_key, now);
  if (activeMatch(db, userId)) return "matched";
  return "waiting";
}

export function cancelQueue(db: Db, userId: number): void {
  db.prepare("DELETE FROM queue WHERE user_id = ?").run(userId);
}

export function logout(db: Db, sessionId: string): void {
  const row = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sessionId) as
    | { user_id: number }
    | undefined;
  deleteSession(db, sessionId);
  if (!row) return;
  db.prepare("DELETE FROM queue WHERE user_id = ?").run(row.user_id);
}

export function sendMessage(
  db: Db,
  userId: number,
  body: string,
  now: number,
): { ok: true; id: number } | { ok: false; error: "empty" | "too_long" | "no_match" } {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty" };
  if (trimmed.length > 500) return { ok: false, error: "too_long" };
  const match = activeMatch(db, userId);
  if (!match) return { ok: false, error: "no_match" };
  const inserted = db
    .prepare("INSERT INTO messages (match_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)")
    .run(match.id, userId, trimmed, now);
  return { ok: true, id: Number(inserted.lastInsertRowid) };
}

export function leaveMatch(db: Db, userId: number, now: number): { ended: boolean } {
  const end = db.transaction(() => {
    const match = activeMatch(db, userId);
    if (!match) return { ended: false };
    const updated = db
      .prepare(
        `UPDATE matches
         SET status = 'ended', ended_by = ?, ended_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(userId, now, match.id);
    if (updated.changes === 0) return { ended: false };
    const lo = Math.min(match.user_a_id, match.user_b_id);
    const hi = Math.max(match.user_a_id, match.user_b_id);
    db.prepare("INSERT OR IGNORE INTO pairs (user_lo, user_hi) VALUES (?, ?)").run(lo, hi);
    return { ended: true };
  });
  return end.immediate();
}

export function readState(
  db: Db,
  sessionId: string | null,
  now: number,
  afterMessageId: number,
): AppState {
  if (sessionId == null) return { view: "signed_out", error: null };
  const session = readSession(db, sessionId, now);
  if (!session) return { view: "signed_out", error: null };

  const match = activeMatch(db, session.userId);
  if (match) return chatState(db, session.userId, match, afterMessageId, now);

  const queued = queueFor(db, session.userId);
  if (queued) {
    tryPair(db, queued.song_key, now);
    const paired = activeMatch(db, session.userId);
    if (paired) return chatState(db, session.userId, paired, afterMessageId, now);
    return {
      view: "waiting",
      song: { artist: queued.artist, track: queued.track, artworkUrl: queued.artwork_url },
      notice: waitingNotice(nowPlaying(db, session.userId), now),
    };
  }

  return homeState(nowPlaying(db, session.userId), now);
}
