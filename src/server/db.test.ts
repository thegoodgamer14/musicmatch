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
