import { NOW_PLAYING_TTL_MS, PRESENCE_MS } from "./constants";
import type { Db } from "./db";

interface Eligible extends Record<string, unknown> {
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
}

interface QueueRow extends Record<string, unknown> {
  user_id: number;
  song_key: string;
  artist: string;
  track: string;
  artwork_url: string | null;
}

interface BlockedPair extends Record<string, unknown> {
  user_lo: number;
  user_hi: number;
}

interface Found extends Record<string, unknown> {
  found: number;
}

interface InsertedId extends Record<string, unknown> {
  id: number;
}

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

function placeholders(start: number, count: number): string {
  return Array.from({ length: count }, (_, index) => `$${start + index}`).join(", ");
}

async function choose(db: Db, eligible: Eligible[]): Promise<[Eligible, Eligible] | null> {
  if (eligible.length < 2) return null;
  const ids = eligible.map((row) => row.user_id);
  const blockedRows = await db.query<BlockedPair>(
    `SELECT user_lo, user_hi FROM pairs
     WHERE user_lo IN (${placeholders(1, ids.length)})
       AND user_hi IN (${placeholders(ids.length + 1, ids.length)})`,
    [...ids, ...ids],
  );
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

export async function tryPair(
  db: Db,
  songKey: string,
  now: number,
  beforeRecheck?: (tx: Db) => Promise<void>,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    await tx.exec("SELECT pg_advisory_xact_lock(hashtext($1))", [songKey]);
    const eligible = await tx.query<Eligible>(
      `SELECT q.user_id, q.song_key, q.artist, q.track, q.artwork_url, q.joined_at,
              u.lastfm_username, u.avatar_url, u.profile_url, n.recent_artists
       FROM queue q
       JOIN users u ON u.id = q.user_id
       JOIN now_playing n ON n.user_id = q.user_id
       WHERE q.song_key = $1
         AND u.last_heartbeat_at > $2
         AND n.is_now_playing = 1
         AND n.song_key = q.song_key
         AND n.fetched_at > $3
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE m.status = 'active'
             AND (m.user_a_id = q.user_id OR m.user_b_id = q.user_id)
         )
       ORDER BY q.joined_at ASC, q.user_id ASC`,
      [songKey, now - PRESENCE_MS, now - NOW_PLAYING_TTL_MS],
    );

    const chosen = await choose(tx, eligible);
    if (!chosen) return null;
    const [earlier, partner] = chosen;
    if (beforeRecheck) await beforeRecheck(tx);

    const locked = await tx.query<QueueRow>(
      `SELECT user_id, song_key, artist, track, artwork_url
       FROM queue
       WHERE user_id IN ($1, $2)
       ORDER BY user_id
       FOR UPDATE`,
      [earlier.user_id, partner.user_id],
    );
    const queueA = locked.find((row) => row.user_id === earlier.user_id);
    const queueB = locked.find((row) => row.user_id === partner.user_id);
    if (!queueA || !queueB || queueA.song_key !== songKey || queueB.song_key !== songKey) return null;

    const active = await tx.one<Found>(
      `SELECT 1 AS found FROM matches
       WHERE status = 'active' AND (user_a_id IN ($1, $2) OR user_b_id IN ($1, $2))`,
      [earlier.user_id, partner.user_id],
    );
    if (active) return null;

    const inserted = await tx.one<InsertedId>(
      `INSERT INTO matches (
         song_key, artist, track, artwork_url, user_a_id, user_b_id,
         snapshot_a, snapshot_b, status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
       RETURNING id`,
      [
        queueA.song_key,
        queueA.artist,
        queueA.track,
        queueA.artwork_url,
        earlier.user_id,
        partner.user_id,
        snapshot(earlier),
        snapshot(partner),
        now,
      ],
    );
    await tx.exec("DELETE FROM queue WHERE user_id IN ($1, $2)", [earlier.user_id, partner.user_id]);
    return inserted ? Number(inserted.id) : null;
  });
}
