import { afterEach, describe, expect, it } from "vitest";
import { getDb, openTestDatabase, setPostgresConnectorForTests, withRequestDb } from "./db";

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

describe("withRequestDb", () => {
  afterEach(() => {
    setPostgresConnectorForTests(null);
  });

  it("uses a distinct client per call and throws outside a request", async () => {
    const created: object[] = [];
    let ended = 0;
    setPostgresConnectorForTests(() => {
      const client = {
        async unsafe() {
          return Object.assign([], { columns: null as { name: string; type: number }[] | null });
        },
        async end() {
          ended += 1;
        },
      };
      created.push(client);
      return client;
    });

    expect(() => getDb()).toThrow("Database client used outside a request");

    const first = await withRequestDb(async () => getDb());
    const second = await withRequestDb(async () => getDb());
    expect(first).not.toBe(second);
    expect(created).toHaveLength(2);

    await expect(
      withRequestDb(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(created).toHaveLength(3);
    expect(ended).toBe(3);
    expect(() => getDb()).toThrow("Database client used outside a request");
  });

  it("returns the handler result when closing the client never finishes", async () => {
    setPostgresConnectorForTests(() => ({
      async unsafe() {
        return Object.assign([], { columns: null });
      },
      end() {
        return new Promise(() => undefined);
      },
    }));

    const result = await withRequestDb(async () => "ready");
    expect(result).toBe("ready");
  });
});
