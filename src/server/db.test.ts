import { describe, expect, it } from "vitest";
import { openTestDatabase } from "./db";

describe("openTestDatabase", () => {
  it("creates users and rejects a second queue row for the same user", async () => {
    const db = await openTestDatabase();
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = tables.map((row) => row.table_name);
    for (const name of [
      "users",
      "sessions",
      "now_playing",
      "queue",
      "matches",
      "messages",
      "pairs",
    ]) {
      expect(names).toContain(name);
    }

    await db.exec(
      "INSERT INTO users (lastfm_username, lastfm_session_key, created_at) VALUES ($1, $2, $3)",
      ["a", "k", 1],
    );
    await db.exec(
      "INSERT INTO queue (user_id, song_key, artist, track, joined_at) VALUES ($1, $2, $3, $4, $5)",
      [1, "k", "A", "T", 1],
    );
    await expect(
      db.exec(
        "INSERT INTO queue (user_id, song_key, artist, track, joined_at) VALUES ($1, $2, $3, $4, $5)",
        [1, "k2", "A", "T2", 2],
      ),
    ).rejects.toThrow();
  });
});
