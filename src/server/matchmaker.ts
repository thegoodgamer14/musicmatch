import Database from "better-sqlite3";
import { NOW_PLAYING_TTL_MS, PRESENCE_MS } from "./constants";

type Db = Database.Database;

type Eligible = {
  user_id: number;
  song_key: string;
  artist: string;
  track: string;
  artwork_url: string | null;
  joined_at: number;
  lastfm_username: string;
  avatar_url: string | null;
  profile_url: string | null;
  recent_artists: string;
};

type QueueRow = {
  user_id: number;
  song_key: string;
  artist: string;
  track: string;
  artwork_url: string | null;
};

function profileUrl(username: string, stored: string | null): string {
  if (stored) return stored;
  return `https://www.last.fm/user/${encodeURIComponent(username)}`;
}

function snapshot(row: Eligible): string {
  const recent: unknown = JSON.parse(row.recent_artists);
  return JSON.stringify({
    username: row.lastfm_username,
    avatarUrl: row.avatar_url,
    profileUrl: profileUrl(row.lastfm_username, row.profile_url),
    recentArtists: Array.isArray(recent) ? recent : [],
  });
}

function pairKey(left: number, right: number): string {
  const lo = Math.min(left, right);
  const hi = Math.max(left, right);
  return `${lo}:${hi}`;
}

function choose(db: Db, eligible: Eligible[]): [Eligible, Eligible] | null {
  if (eligible.length < 2) return null;
  const ids = eligible.map((row) => row.user_id);
  const placeholders = ids.map(() => "?").join(", ");
  const blockedRows = db
    .prepare(
      `SELECT user_lo, user_hi FROM pairs
       WHERE user_lo IN (${placeholders}) AND user_hi IN (${placeholders})`,
    )
    .all(...ids, ...ids) as { user_lo: number; user_hi: number }[];
  const blocked = new Set(blockedRows.map((row) => pairKey(row.user_lo, row.user_hi)));

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (!blocked.has(pairKey(eligible[i].user_id, eligible[j].user_id))) {
        return [eligible[i], eligible[j]];
      }
    }
  }
  return null;
}

export function tryPair(db: Db, songKey: string, now: number): number | null {
  const run = db.transaction(() => {
    const eligible = db
      .prepare(
        `SELECT q.user_id, q.song_key, q.artist, q.track, q.artwork_url, q.joined_at,
                u.lastfm_username, u.avatar_url, u.profile_url, n.recent_artists
         FROM queue q
         JOIN users u ON u.id = q.user_id
         JOIN now_playing n ON n.user_id = q.user_id
         WHERE q.song_key = ?
           AND u.last_heartbeat_at > ?
           AND n.is_now_playing = 1
           AND n.song_key = q.song_key
           AND n.fetched_at > ?
           AND NOT EXISTS (
             SELECT 1 FROM matches m
             WHERE m.status = 'active'
               AND (m.user_a_id = q.user_id OR m.user_b_id = q.user_id)
           )
         ORDER BY q.joined_at ASC, q.user_id ASC`,
      )
      .all(songKey, now - PRESENCE_MS, now - NOW_PLAYING_TTL_MS) as Eligible[];

    const chosen = choose(db, eligible);
    if (!chosen) return null;
    const [earlier, partner] = chosen;

    const queueA = db
      .prepare(
        "SELECT user_id, song_key, artist, track, artwork_url FROM queue WHERE user_id = ?",
      )
      .get(earlier.user_id) as QueueRow | undefined;
    const queueB = db
      .prepare(
        "SELECT user_id, song_key, artist, track, artwork_url FROM queue WHERE user_id = ?",
      )
      .get(partner.user_id) as QueueRow | undefined;
    if (!queueA || !queueB) return null;

    const active = db
      .prepare(
        `SELECT 1 AS found FROM matches
         WHERE status = 'active' AND (user_a_id IN (?, ?) OR user_b_id IN (?, ?))`,
      )
      .get(earlier.user_id, partner.user_id, earlier.user_id, partner.user_id) as
      | { found: number }
      | undefined;
    if (active) return null;

    const inserted = db
      .prepare(
        `INSERT INTO matches (
           song_key, artist, track, artwork_url, user_a_id, user_b_id,
           snapshot_a, snapshot_b, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        queueA.song_key,
        queueA.artist,
        queueA.track,
        queueA.artwork_url,
        earlier.user_id,
        partner.user_id,
        snapshot(earlier),
        snapshot(partner),
        now,
      );
    db.prepare("DELETE FROM queue WHERE user_id IN (?, ?)").run(earlier.user_id, partner.user_id);
    return Number(inserted.lastInsertRowid);
  });

  return run.immediate();
}
