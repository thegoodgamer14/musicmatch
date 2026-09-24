# Music Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Next.js web app that signs a person in with Last.fm and pairs them, one to one, with someone else waiting on the same now-playing song.

**Architecture:** One Next.js App Router app. The browser polls Music Match. The server is the only Last.fm caller and stores users, sessions, now-playing cache, the queue, matches, messages, and pair exclusions in SQLite via `better-sqlite3`. Domain functions take a database and a `now` timestamp so tests stay deterministic. Route handlers are thin wrappers.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, SQLite (`better-sqlite3`), Vitest.

## Global Constraints

- Song identity is the pair (normalized artist, normalized track). Album is ignored.
- Each half of the song key is Unicode NFKC, lowercased, trimmed, with internal whitespace collapsed to a single space. Punctuation stays. "Don't Stop" and "Dont Stop" are different songs.
- Display artist, title, and artwork are the original Last.fm strings.
- Recent artists are the first five distinct artists in `user.getRecentTracks` (limit 50), newest first. The current track's artist is included when it appears.
- A scrobbled track without the now-playing flag is not now playing.
- State poll is 2 seconds and heartbeat is 10 seconds, both only while the tab is visible.
- A heartbeat newer than 30 seconds counts as present. The session lasts 30 days from the last heartbeat.
- Last.fm is refreshed at most once every 15 seconds per present user.
- A cached now-playing track may be treated as current for 60 seconds. Older than that, Find a match stays off.
- `user.getInfo` refreshes at sign-in and at most once an hour after that.
- A waiting user is eligible only when the heartbeat is newer than 30 seconds, the cached now-playing flag is true, the song key equals the queue song key, and the cache was fetched within the last 60 seconds, and they are not in an active match.
- Pair the two longest-waiting eligible people. Equal `joined_at` treats the lower user id as having waited longer.
- An existing pair record is never paired again. A third eligible person can match with either member of an old pair.
- One active match per user, enforced inside the transaction that creates the match and deletes both queue rows.
- Two joins that arrive together produce one match. The transaction re-checks that both users are still waiting and that neither has an active match.
- Messages are plain text. The trimmed body must be 1 to 500 JavaScript characters (`String.length`).
- Leave ends the match for both people and writes the pair record. Logout removes the queue row and does not end an active match. Closing the tab does not end a match.
- Partner heartbeat older than 30 seconds shows Away.
- Last.fm methods: `auth.getToken`, `auth.getSession`, `user.getRecentTracks`, `user.getInfo`.
- Cookie is httpOnly, `SameSite=Lax`, and `Secure` when `APP_URL` is https. The cookie name is `musicmatch_session`.
- Environment: `LASTFM_API_KEY`, `LASTFM_API_SECRET`, `SESSION_SECRET`, `APP_URL`. `DATABASE_PATH` is optional and defaults to `data/musicmatch.db`.
- Automated tests use a temporary SQLite file and a fake Last.fm client. Tests must not call Last.fm over the network.
- Copy strings, exact: denied `Last.fm didn't approve access.` Rejected session `Last.fm didn't accept this session. Sign in again.` Private `Make your recent tracks public on Last.fm to be matched.` Stale `Last.fm may be out of date.` Nothing playing `Nothing is playing right now.` Away `Away`. Empty message `Write a message first.` Too long `Messages can be at most 500 characters.`

---

### Task 1: Scaffold and song keys

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/server/song-key.ts`
- Test: `src/server/song-key.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `normalizeName(value: string): string` and `songKey(artist: string, track: string): string`. `songKey` joins the two normalized halves with a NUL character (`\u0000`). Album is not a parameter.

- [ ] **Step 1: Write the failing test**

Create `src/server/song-key.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeName, songKey } from "./song-key";

describe("songKey", () => {
  it("normalizes case and whitespace and ignores nothing about punctuation", () => {
    expect(normalizeName("  Let   It\tBe ")).toBe("let it be");
    expect(songKey(" The Beatles ", "  Let   It  Be ")).toBe(
      "the beatles\u0000let it be",
    );
    expect(songKey("THE BEATLES", "let it be")).toBe(
      songKey("the beatles", "let it be"),
    );
    expect(songKey("Journey", "Don't Stop")).not.toBe(
      songKey("Journey", "Dont Stop"),
    );
  });

  it("applies NFKC before lowercasing", () => {
    expect(songKey("ﬁle", "Ａ")).toBe(songKey("file", "A"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/song-key.test.ts`

Expected: FAIL because `./song-key` does not exist. If Vitest itself is missing, add the scaffold from Step 3 first, then re-run this test and confirm it fails on the missing module before writing `song-key.ts`.

- [ ] **Step 3: Write minimal implementation**

`package.json`:

```json
{
  "name": "musicmatch",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^11.9.0",
    "next": "^15.2.4",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.13.14",
    "@types/react": "^19.0.12",
    "@types/react-dom": "^19.0.4",
    "typescript": "^5.8.2",
    "vitest": "^3.0.9"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

`.gitignore`:

```
node_modules
.next
.env
.env.local
data
*.db
.superpowers/
.worktrees/
```

`src/server/song-key.ts`:

```ts
export function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

export function songKey(artist: string, track: string): string {
  return `${normalizeName(artist)}\u0000${normalizeName(track)}`;
}
```

Run `npm install`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/song-key.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json next.config.ts vitest.config.ts .gitignore src/server/song-key.ts src/server/song-key.test.ts
git commit -m "Add song key normalization and the app scaffold."
```

---

### Task 2: SQLite schema

**Files:**
- Create: `src/server/db.ts`
- Test: `src/server/db.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: `openDatabase(path: string): Database.Database` from `better-sqlite3`. It enables foreign keys, enables WAL when `path` is not `:memory:`, and runs `migrate`. `migrate(db)` creates the tables below if they are missing. Tests call `openDatabase` with a temp file path.

Tables:

- `users`: `id` integer primary key, `lastfm_username` text not null unique, `lastfm_session_key` text not null, `avatar_url` text, `profile_url` text, `profile_fetched_at` integer, `created_at` integer not null, `last_heartbeat_at` integer
- `sessions`: `id` text primary key, `user_id` integer not null references users, `expires_at` integer not null
- `now_playing`: `user_id` integer primary key references users, `artist` text, `track` text, `album` text, `artwork_url` text, `is_now_playing` integer not null, `song_key` text, `recent_artists` text not null, `fetched_at` integer not null, `attempted_at` integer not null, `error` text
- `queue`: `user_id` integer primary key references users, `song_key` text not null, `artist` text not null, `track` text not null, `artwork_url` text, `joined_at` integer not null
- `matches`: `id` integer primary key, `song_key` text not null, `artist` text not null, `track` text not null, `artwork_url` text, `user_a_id` integer not null, `user_b_id` integer not null, `snapshot_a` text not null, `snapshot_b` text not null, `status` text not null, `ended_by` integer, `created_at` integer not null, `ended_at` integer
- `messages`: `id` integer primary key, `match_id` integer not null references matches, `sender_id` integer not null, `body` text not null, `created_at` integer not null
- `pairs`: `user_lo` integer not null, `user_hi` integer not null, primary key `(user_lo, user_hi)`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";

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

describe("openDatabase", () => {
  it("creates the match tables and enforces one queue row per user", () => {
    const db = tempDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const name of [
      "users",
      "sessions",
      "now_playing",
      "queue",
      "matches",
      "messages",
      "pairs",
    ]) {
      expect(tables).toContain(name);
    }

    db.prepare(
      "INSERT INTO users (lastfm_username, lastfm_session_key, created_at) VALUES ('a', 'k', 1)",
    ).run();
    db.prepare(
      "INSERT INTO queue (user_id, song_key, artist, track, joined_at) VALUES (1, 'k', 'A', 'T', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO queue (user_id, song_key, artist, track, joined_at) VALUES (1, 'k2', 'A', 'T2', 2)",
        )
        .run(),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/db.test.ts`

Expected: FAIL because `./db` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/server/db.ts` opens the database, sets `foreign_keys = ON`, sets `journal_mode = WAL` unless the path is `:memory:`, and runs:

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  lastfm_username TEXT NOT NULL UNIQUE,
  lastfm_session_key TEXT NOT NULL,
  avatar_url TEXT,
  profile_url TEXT,
  profile_fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS now_playing (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  artist TEXT,
  track TEXT,
  album TEXT,
  artwork_url TEXT,
  is_now_playing INTEGER NOT NULL,
  song_key TEXT,
  recent_artists TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  attempted_at INTEGER NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS queue (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  song_key TEXT NOT NULL,
  artist TEXT NOT NULL,
  track TEXT NOT NULL,
  artwork_url TEXT,
  joined_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  song_key TEXT NOT NULL,
  artist TEXT NOT NULL,
  track TEXT NOT NULL,
  artwork_url TEXT,
  user_a_id INTEGER NOT NULL,
  user_b_id INTEGER NOT NULL,
  snapshot_a TEXT NOT NULL,
  snapshot_b TEXT NOT NULL,
  status TEXT NOT NULL,
  ended_by INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  sender_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairs (
  user_lo INTEGER NOT NULL,
  user_hi INTEGER NOT NULL,
  PRIMARY KEY (user_lo, user_hi)
);
```

Export `openDatabase` and `migrate`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/db.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/db.test.ts
git commit -m "Add the SQLite schema for users, queue, matches, and pairs."
```

---

### Task 3: Last.fm parsing and client

**Files:**
- Create: `src/server/lastfm.ts`
- Test: `src/server/lastfm.test.ts`

**Interfaces:**
- Consumes: `normalizeName` from `src/server/song-key.ts` only to compare artist identity. Display names stay original.
- Produces:

```ts
export type LastfmTrack = {
  artist: string;
  track: string;
  album: string | null;
  artworkUrl: string | null;
  nowPlaying: boolean;
};

export type LastfmFailure = "private" | "rejected" | "unreachable";

export interface LastfmClient {
  getToken(): Promise<{ ok: true; token: string } | { ok: false; reason: "unreachable" }>;
  getSession(token: string): Promise<
    | { ok: true; username: string; sessionKey: string }
    | { ok: false; reason: "rejected" | "unreachable" }
  >;
  getRecentTracks(
    username: string,
    sessionKey: string,
  ): Promise<{ ok: true; tracks: LastfmTrack[] } | { ok: false; reason: LastfmFailure }>;
  getInfo(
    username: string,
    sessionKey: string,
  ): Promise<
    | { ok: true; avatarUrl: string | null; profileUrl: string }
    | { ok: false; reason: "rejected" | "unreachable" }
  >;
}

export function recentArtists(tracks: LastfmTrack[]): string[];
export function nowPlayingTrack(tracks: LastfmTrack[]): LastfmTrack | null;
export function parseRecentTracks(json: unknown): { ok: true; tracks: LastfmTrack[] } | { ok: false; reason: LastfmFailure };
export function signLastfmParams(params: Record<string, string>, secret: string): string;
export function createLastfmClient(options: {
  apiKey: string;
  sharedSecret: string;
  fetchImpl?: typeof fetch;
}): LastfmClient;
```

`recentArtists` walks tracks from first to last and returns at most five distinct display names. Distinct means `normalizeName` is equal. `nowPlayingTrack` returns the first track with `nowPlaying` true, or null.

`parseRecentTracks`: a JSON object with numeric `error` 4 or 9 is `rejected`. Error 17, or a message matching `/private/i`, is `private`. Any other `error` is `unreachable`. A `recenttracks.track` object or array becomes tracks. Missing track list is an empty success. Artist may be a string or `{ "#text": string }`. Album the same. Artwork is the last non-empty `image[].#text`, preferring the `extralarge` size when present. `@attr.nowplaying === "true"` sets `nowPlaying`.

`signLastfmParams` sorts keys alphabetically, concatenates `key + value` with no separator, appends the secret, and returns the hex MD5. Do not include `format` or `callback` in the signed params. The known vector `signLastfmParams({ method: "auth.getToken", api_key: "abc" }, "sec")` is `3334e36028583f782c8e6db457c76835`.

`createLastfmClient` calls `https://ws.audioscrobbler.com/2.0/` with `format=json`. `getRecentTracks` sends `method=user.getRecentTracks`, `user`, `limit=50`, `api_key`, and `sk`, signed. `getInfo` sends `method=user.getInfo`, `user`, `api_key`, and `sk`, signed. `getToken` sends `method=auth.getToken`. `getSession` sends `method=auth.getSession` and `token`. Network failures and non-JSON bodies are `unreachable`. Session and info responses with error 4 or 9 are `rejected`. `getInfo` profile URL falls back to `https://www.last.fm/user/` plus `encodeURIComponent(username)` when `user.url` is missing. Avatar uses the same image rule as tracks.

- [ ] **Step 1: Write the failing test**

Cover the signature vector, NFKC-unrelated punctuation staying in the track name through parsing, a now-playing track preferred over a later scrobble, five distinct recent artists in newest-first order with a repeated artist skipped, a single track object instead of an array, error 9 as rejected, error 17 as private, and a message containing "private" as private. Use a fake `fetchImpl` to assert `getRecentTracks` requests `limit=50` and does not throw on a network rejection (returns `unreachable`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/lastfm.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement `src/server/lastfm.ts` to the interfaces above. Use `node:crypto` `createHash("md5")`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/lastfm.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/lastfm.ts src/server/lastfm.test.ts
git commit -m "Parse Last.fm now playing, recent artists, and signed API calls."
```

---

### Task 4: Sessions, heartbeat, and now-playing refresh

**Files:**
- Create: `src/server/constants.ts`
- Create: `src/server/copy.ts`
- Create: `src/server/presence.ts`
- Test: `src/server/presence.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `songKey`, `LastfmClient`, `LastfmTrack`
- Produces:

```ts
export const PRESENCE_MS = 30_000;
export const LASTFM_REFRESH_MS = 15_000;
export const NOW_PLAYING_TTL_MS = 60_000;
export const PROFILE_TTL_MS = 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const COPY: {
  denied: "Last.fm didn't approve access.";
  rejected: "Last.fm didn't accept this session. Sign in again.";
  privateTracks: "Make your recent tracks public on Last.fm to be matched.";
  stale: "Last.fm may be out of date.";
  nothingPlaying: "Nothing is playing right now.";
  away: "Away";
  emptyMessage: "Write a message first.";
  tooLong: "Messages can be at most 500 characters.";
};

export function upsertUser(db, input: {
  username: string;
  sessionKey: string;
  now: number;
  avatarUrl: string | null;
  profileUrl: string;
}): number;

export function createSession(db, userId: number, now: number): string;
export function readSession(db, sessionId: string, now: number): { userId: number } | null;
export function deleteSession(db, sessionId: string): void;
export function sessionCookie(sessionId: string, appUrl: string): string;

export function recordHeartbeat(db, sessionId: string, now: number): void;
export function refreshIfDue(db, userId: number, client: LastfmClient, now: number): Promise<void>;
```

`createSession` stores `randomBytes(32).toString("hex")` and `expires_at = now + SESSION_TTL_MS`. `readSession` returns null and deletes the row when `expires_at <= now`. `sessionCookie` is `musicmatch_session=<id>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` and appends `; Secure` only when `appUrl` starts with `https://`.

`recordHeartbeat` sets `users.last_heartbeat_at` and extends that session's `expires_at` by `SESSION_TTL_MS` from `now`. No session row means it does nothing.

`refreshIfDue` returns immediately when `now_playing.attempted_at` is within `LASTFM_REFRESH_MS`. Otherwise it calls `getRecentTracks`. On success it sets the cache from `nowPlayingTrack` and `recentArtists`, `fetched_at` and `attempted_at` to `now`, and `error` null. A missing now-playing track stores `is_now_playing = 0` and a null song key. If a queue row exists and the fresh result is not now playing or its song key differs, delete that queue row. On `private`, set `is_now_playing = 0`, `error = 'private'`, `fetched_at` and `attempted_at` to `now`, and delete the queue row. On `unreachable`, set `attempted_at` and `error = 'unreachable'` without changing `fetched_at` or the track fields; if no cache row exists, insert one with `fetched_at = 0`, `is_now_playing = 0`, `recent_artists = '[]'`. On `rejected`, delete every session for that user and set `error = 'rejected'`.

After a non-rejected recent-tracks attempt, if `profile_fetched_at` is null or older than `PROFILE_TTL_MS`, call `getInfo`. Success updates avatar, profile URL, and `profile_fetched_at`. `rejected` from info deletes every session for that user. `unreachable` leaves the profile as it was.

`upsertUser` updates the session key when the Last.fm username already exists and inserts otherwise. It sets profile fields and `profile_fetched_at = now`.

- [ ] **Step 1: Write the failing test**

Use a temp database and a fake `LastfmClient`. Cover:

- A heartbeat extends `expires_at` to `now + SESSION_TTL_MS` and sets `last_heartbeat_at`.
- An expired session reads as null.
- The cookie for `http://localhost:3000` has no `Secure` flag. The cookie for `https://music.example` has `Secure`, `HttpOnly`, and `SameSite=Lax`.
- A successful refresh stores the now-playing track and five recent artists, and a second call 10 seconds later does not call `getRecentTracks` again.
- A refresh that changes the song deletes the queue row. A refresh with no now-playing flag deletes the queue row.
- A private result deletes the queue row and sets `error` to `private`.
- An unreachable result keeps a cache fetched 10 seconds ago and sets `error` to `unreachable` without moving `fetched_at`.
- A rejected recent-tracks result deletes the user's session.
- Profile info is not requested again when `profile_fetched_at` is 30 minutes old.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/presence.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement `constants.ts`, `copy.ts`, and `presence.ts` as specified. Queue deletion belongs in `refreshIfDue`, not in a separate helper that the tests cannot see.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/presence.test.ts src/server/song-key.test.ts src/server/db.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/constants.ts src/server/copy.ts src/server/presence.ts src/server/presence.test.ts
git commit -m "Refresh Last.fm now playing and keep the session alive on heartbeat."
```

---

### Task 5: Matchmaker

**Files:**
- Create: `src/server/matchmaker.ts`
- Test: `src/server/matchmaker.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `songKey`, `PRESENCE_MS`, `NOW_PLAYING_TTL_MS`
- Produces: `tryPair(db, songKey: string, now: number): number | null`. The return value is the new match id, or null when no pair was made.

A user is eligible when their queue song key matches the argument, `last_heartbeat_at > now - PRESENCE_MS`, `now_playing.is_now_playing = 1`, `now_playing.song_key` equals the queue song key, `now_playing.fetched_at > now - NOW_PLAYING_TTL_MS`, and no `matches` row with `status = 'active'` contains them.

Sort eligible users by `joined_at` ascending, then `user id` ascending. Walk that list and pair the first user with the earliest later user who has no `pairs` row for the two ids (`user_lo` is the smaller id). Create the match inside `db.transaction(...).immediate()`:

- Re-read both queue rows. If either is gone, return null without inserting.
- Re-check that neither user has an active match. If either does, return null.
- `user_a_id` is the earlier waiter. `user_b_id` is the partner.
- Snapshots are JSON: `{ username, avatarUrl, profileUrl, recentArtists }`. Username and profile come from `users`. `recentArtists` is the parsed `now_playing.recent_artists` array. Profile URL falls back to `https://www.last.fm/user/` plus the encoded username.
- Song display fields and artwork come from the earlier waiter's queue row.
- `status` is `active`. `created_at` is `now`.
- Delete both queue rows in the same transaction.

- [ ] **Step 1: Write the failing test**

Seed users, now-playing rows, and queue rows in a temp database. Assert all of these:

- The longer wait wins over someone who joined later.
- Equal `joined_at` pairs the lower user id as `user_a_id` with the next person.
- A heartbeat older than 30 seconds is skipped, and the remaining two still pair.
- A now-playing song key that differs from the queue removes eligibility. A `fetched_at` older than 60 seconds removes eligibility.
- Two users with a `pairs` row stay queued, and a third eligible user matches with the longer-waiting of those two.
- Calling `tryPair` twice creates one match.
- Open the same temp file in a second connection and call `tryPair` on both. Exactly one returns a match id. Exactly one `matches` row exists.
- A user who already has an active match is not inserted into a second one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/matchmaker.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement `tryPair` as specified. Do not end matches here. Do not call Last.fm.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/matchmaker.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/matchmaker.ts src/server/matchmaker.test.ts
git commit -m "Pair the two longest-waiting listeners on a song."
```

---

### Task 6: Queue, chat, leave, logout, and state

**Files:**
- Create: `src/server/app-state.ts`
- Test: `src/server/app-state.test.ts`

**Interfaces:**
- Consumes: `tryPair`, `openDatabase`, `songKey`, `COPY`, `PRESENCE_MS`, `NOW_PLAYING_TTL_MS`, `deleteSession` from presence (export it if Task 4 did)
- Produces:

```ts
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

export function joinQueue(db, userId: number, now: number): "waiting" | "matched" | "unavailable" | "in_chat";
export function cancelQueue(db, userId: number): void;
export function logout(db, sessionId: string): void;
export function sendMessage(
  db,
  userId: number,
  body: string,
  now: number,
): { ok: true; id: number } | { ok: false; error: "empty" | "too_long" | "no_match" };
export function leaveMatch(db, userId: number, now: number): { ended: boolean };
export function readState(db, sessionId: string | null, now: number, afterMessageId: number): AppState;
```

`joinQueue`: an active match returns `in_chat` and does not insert a queue row. No cache, `is_now_playing` not 1, `fetched_at` older than 60 seconds, or `error === "private"` returns `unavailable`. An existing queue row with the same song key returns `waiting` and does not change `joined_at`. Otherwise replace the queue row, using the cache's original artist, track, artwork, and song key, with `joined_at = now`. Then call `tryPair`. Return `matched` when it returns an id, otherwise `waiting`.

`cancelQueue` deletes the user's queue row. `logout` deletes that session and that user's queue row, and does not change matches.

`sendMessage` trims the body. Length 0 is `empty`. Length greater than 500 is `too_long`. No active match for the sender is `no_match`. Otherwise insert and return the id.

`leaveMatch` on an active match sets `status = 'ended'`, `ended_by`, `ended_at = now`, and inserts the pair row with the lower id first. A missing match returns `{ ended: false }`.

`readState`: unknown or expired session is `{ view: "signed_out", error: null }`. An active match is `chat`. The partner snapshot is the other user's snapshot JSON. `away` is true when the partner's `last_heartbeat_at` is null or `<= now - PRESENCE_MS`. Messages are those for the match with `id > afterMessageId`, ordered by id. The header song is the match row, not the live now-playing cache. When the caller has a queue row and no active match, call `tryPair` for that song key and return `chat` if a match now exists. Otherwise return `waiting`. The waiting song is the queue display. Waiting `notice` is `COPY.stale` when the cache `error` is `unreachable` or `fetched_at` is older than 60 seconds; otherwise null. Home: `notice` is `COPY.privateTracks` when `error` is `private` (and `nowPlaying` is null, `canMatch` is false). `canMatch` is true only when `is_now_playing` is 1 and `fetched_at` is within 60 seconds. When that is true and `error` is `unreachable`, `notice` is `COPY.stale`. When the cache is now playing but older than 60 seconds, still return the song and set `canMatch` false and `notice` to `COPY.stale`. When nothing is now playing and the cache is fresh, `nowPlaying` is null, `canMatch` is false, `notice` is null, and `recentArtists` still comes from the cache.

- [ ] **Step 1: Write the failing test**

Cover leave (both users' next `readState` is `home`, a pair row exists, and `joinQueue` plus the resulting pair attempt does not match those two again), a third person matching with one of them, message empty and 501-character bodies, a message after leave, a message from a user who is not in the match, logout removing a queue row while the active match remains, `joinQueue` being idempotent for `joined_at`, and `joinQueue` during an active match returning `in_chat`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/app-state.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement `src/server/app-state.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`

Expected: the whole suite PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/app-state.ts src/server/app-state.test.ts
git commit -m "Add queue, chat, leave, and the polled app state."
```

---

### Task 7: Routes and the single screen

**Files:**
- Create: `src/server/http.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `src/app/api/auth/lastfm/route.ts`
- Create: `src/app/api/auth/callback/route.ts`
- Create: `src/app/api/auth/logout/route.ts`
- Create: `src/app/api/presence/route.ts`
- Create: `src/app/api/state/route.ts`
- Create: `src/app/api/queue/route.ts`
- Create: `src/app/api/match/leave/route.ts`
- Create: `src/app/api/messages/route.ts`
- Create: `.env.example`
- Create: `README.md`
- Modify: `src/server/db.ts` to add `getDb()` singleton using `DATABASE_PATH` or `data/musicmatch.db`, creating the parent directory
- Test: `src/server/http.test.ts`

**Interfaces:**
- Consumes: every exported function from Tasks 3 through 6, plus `getDb`
- Produces: route handlers with these exact methods and paths:

| Method and path | Behavior |
| --- | --- |
| `POST /api/auth/lastfm` | `getToken`, then redirect to `https://www.last.fm/api/auth/?api_key&cb` where `cb` is `${APP_URL}/api/auth/callback`. Unreachable token redirects to `/?error=unreachable`. |
| `GET /api/auth/callback` | Missing `token` redirects to `/?error=denied`. `getSession` then `getInfo`. Rejected redirects to `/?error=rejected`. Unreachable redirects to `/?error=unreachable`. Success upserts the user, creates a session, sets `musicmatch_session`, redirects to `/`. |
| `POST /api/auth/logout` | `logout` for the cookie session, clears the cookie, redirects to `/`. |
| `POST /api/presence` | `recordHeartbeat` and `refreshIfDue` for the cookie user. Responds 204. Also refreshes `Set-Cookie` with a new 30-day max age. Missing session is 401. If the refresh deleted the session because Last.fm rejected it, respond 401 `{ "error": "Last.fm didn't accept this session. Sign in again." }` and clear the cookie. |
| `GET /api/state` | `readState` with optional `after` query (default 0). JSON body. |
| `POST /api/queue` | `joinQueue`. JSON `{ status }`. |
| `DELETE /api/queue` | `cancelQueue`. 204. |
| `POST /api/match/leave` | `leaveMatch`. JSON `{ ended }`. |
| `POST /api/messages` | `sendMessage`. 201 `{ id }` or 400 `{ error }` using `COPY.emptyMessage` and `COPY.tooLong`. |

Each route sets `export const runtime = "nodejs"`. Missing session on mutating routes is 401, except logout, which still clears the cookie and redirects.

`http.test.ts` tests `authorizeUrl(appUrl, apiKey)` and `failureRedirect(reason)` if you extract them, plus `messageErrorBody("empty" | "too_long")` returning the exact `COPY` strings. Do not boot Next and do not call Last.fm.

The page is one client component. While `document.visibilityState` is `visible`, it `GET`s `/api/state?after=` every 2 seconds and `POST`s `/api/presence` every 10 seconds. A hidden tab clears those actions until it is visible again, then fires both immediately. Chat messages append by id. The screen renders only one of: sign-in, home, waiting, chat.

Sign-in is a form `POST /api/auth/lastfm` labeled `Continue with Last.fm`. Query `error=denied` shows `COPY.denied`. `error=rejected` shows `COPY.rejected`. `error=unreachable` shows `Last.fm could not be reached. Try again.` If a signed-in screen receives presence 401 with `COPY.rejected`, or the next state is `signed_out` after a signed-in view, show `COPY.rejected`. Auth routes call `requireEnv()`, which throws if `LASTFM_API_KEY`, `LASTFM_API_SECRET`, `SESSION_SECRET`, or `APP_URL` is missing. The session id stays a random database key. `SESSION_SECRET` is required because the spec lists it; it is not written into the cookie.

Home shows artwork, title, and artist when `nowPlaying` is set, otherwise `COPY.nothingPlaying`. Recent artists sit under the song. The button label is `Find a match`. It is disabled when `canMatch` is false. It `POST`s `/api/queue`. Show `notice` when present.

Waiting shows the queued song and a `Cancel` button that `DELETE`s `/api/queue`.

Chat shows the partner username (linking `profileUrl`), avatar, recent artists, the frozen song, an `Away` label when `partner.away` is true, messages, a text field, and `Leave`. Leave `POST`s `/api/match/leave`. The composer refuses to send an empty body and shows the API error string on a 400.

Visual design: background `#1a1410`, card `#241c17`, text `#f6f0e6`, muted `#b5a89a`, accent `#e85d34`. Song titles use `"Iowan Old Style", Palatino, Georgia, serif`. UI text uses `"Avenir Next", "Segoe UI", sans-serif`. One column, max width `32rem`, comfortable at 375px wide and on a desktop window. No purple gradient, no default Next.js starter page.

`.env.example` lists `LASTFM_API_KEY`, `LASTFM_API_SECRET`, `SESSION_SECRET`, and `APP_URL=http://localhost:3000`.

`README.md` says how to create a Last.fm API account, set the callback to `http://localhost:3000/api/auth/callback`, copy `.env.example` to `.env.local`, and run `npm install`, `npm test`, and `npm run dev`. It states the manual check: two browsers, sign in, nothing playing, find a match, get paired, send a message, leave, and confirm those two accounts are not paired again.

- [ ] **Step 1: Write the failing test**

Write `src/server/http.test.ts` for the authorize URL and the message error strings.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/http.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write minimal implementation**

Add the routes, the page, the styles, `getDb`, `.env.example`, and `README.md`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`

Expected: whole suite PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/http.ts src/server/http.test.ts src/server/db.ts src/app .env.example README.md
git commit -m "Serve the Last.fm sign-in, polling, and one-to-one match screen."
```
