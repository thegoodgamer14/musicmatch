import { describe, expect, it } from "vitest";
import {
  createLastfmClient,
  nowPlayingTrack,
  parseRecentTracks,
  recentArtists,
  signLastfmParams,
  type LastfmTrack,
} from "./lastfm";

describe("signLastfmParams", () => {
  it("matches the known MD5 vector and ignores format and callback", () => {
    expect(
      signLastfmParams({ method: "auth.getToken", api_key: "abc" }, "sec"),
    ).toBe("3334e36028583f782c8e6db457c76835");
    expect(
      signLastfmParams(
        {
          method: "auth.getToken",
          api_key: "abc",
          format: "json",
          callback: "https://example.test/cb",
        },
        "sec",
      ),
    ).toBe("3334e36028583f782c8e6db457c76835");
  });
});

describe("parseRecentTracks", () => {
  it("keeps punctuation in the track name", () => {
    const parsed = parseRecentTracks({
      recenttracks: {
        track: [
          {
            name: "Don't Stop",
            artist: "Journey",
            album: { "#text": "Escape" },
          },
        ],
      },
    });
    expect(parsed).toEqual({
      ok: true,
      tracks: [
        {
          artist: "Journey",
          track: "Don't Stop",
          album: "Escape",
          artworkUrl: null,
          nowPlaying: false,
        },
      ],
    });
  });

  it("reads a single track object instead of an array", () => {
    const parsed = parseRecentTracks({
      recenttracks: {
        track: {
          name: "Karma Police",
          artist: { "#text": "Radiohead" },
          album: "OK Computer",
          "@attr": { nowplaying: "true" },
        },
      },
    });
    expect(parsed).toEqual({
      ok: true,
      tracks: [
        {
          artist: "Radiohead",
          track: "Karma Police",
          album: "OK Computer",
          artworkUrl: null,
          nowPlaying: true,
        },
      ],
    });
  });

  it("treats error 9 as rejected", () => {
    expect(parseRecentTracks({ error: 9, message: "Invalid session key" })).toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  it("treats error 17 as private", () => {
    expect(parseRecentTracks({ error: 17, message: "Login required" })).toEqual({
      ok: false,
      reason: "private",
    });
  });

  it("treats a message containing private as private", () => {
    expect(
      parseRecentTracks({
        error: 6,
        message: "This user's recent tracks are private",
      }),
    ).toEqual({ ok: false, reason: "private" });
  });
});

describe("nowPlayingTrack", () => {
  it("prefers a now-playing track over a later scrobble", () => {
    const tracks: LastfmTrack[] = [
      {
        artist: "Journey",
        track: "Separate Ways",
        album: "Frontiers",
        artworkUrl: null,
        nowPlaying: false,
      },
      {
        artist: "Journey",
        track: "Don't Stop",
        album: "Escape",
        artworkUrl: null,
        nowPlaying: true,
      },
      {
        artist: "Journey",
        track: "Any Way You Want It",
        album: "Departure",
        artworkUrl: null,
        nowPlaying: false,
      },
    ];
    expect(nowPlayingTrack(tracks)).toEqual(tracks[1]);
  });
});

describe("recentArtists", () => {
  it("returns five distinct artists newest-first and skips a repeat", () => {
    const tracks: LastfmTrack[] = [
      "The Beatles",
      "the   beatles",
      "Radiohead",
      "Pink Floyd",
      "Led Zeppelin",
      "Queen",
      "David Bowie",
    ].map((artist) => ({
      artist,
      track: "Song",
      album: null,
      artworkUrl: null,
      nowPlaying: false,
    }));
    expect(recentArtists(tracks)).toEqual([
      "The Beatles",
      "Radiohead",
      "Pink Floyd",
      "Led Zeppelin",
      "Queen",
    ]);
  });

  it("puts the artist playing now first even when that track is after five others", () => {
    const tracks: LastfmTrack[] = [
      "Foo Fighters",
      "Troy",
      "Justin Bieber",
      "Taylor Swift",
      "Queen",
      "Red Hot Chili Peppers",
    ].map((artist, index, all) => ({
      artist,
      track: "Song",
      album: null,
      artworkUrl: null,
      nowPlaying: index === all.length - 1,
    }));
    expect(recentArtists(tracks)).toEqual([
      "Red Hot Chili Peppers",
      "Foo Fighters",
      "Troy",
      "Justin Bieber",
      "Taylor Swift",
    ]);
  });
});

describe("createLastfmClient", () => {
  it("requests recent tracks with limit 50", async () => {
    let requested = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requested =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return new Response(JSON.stringify({ recenttracks: { track: [] } }));
    }) as typeof fetch;

    const client = createLastfmClient({
      apiKey: "abc",
      sharedSecret: "sec",
      fetchImpl,
    });
    const result = await client.getRecentTracks("ada", "session-key");
    const url = new URL(requested);
    expect(url.origin + url.pathname).toBe("https://ws.audioscrobbler.com/2.0/");
    expect(url.searchParams.get("method")).toBe("user.getRecentTracks");
    expect(url.searchParams.get("user")).toBe("ada");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("api_key")).toBe("abc");
    expect(url.searchParams.get("sk")).toBe("session-key");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("api_sig")).toBe(
      signLastfmParams(
        {
          method: "user.getRecentTracks",
          user: "ada",
          limit: "50",
          api_key: "abc",
          sk: "session-key",
        },
        "sec",
      ),
    );
    expect(result).toEqual({ ok: true, tracks: [] });
  });

  it("returns unreachable when the network rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const client = createLastfmClient({
      apiKey: "abc",
      sharedSecret: "sec",
      fetchImpl,
    });
    await expect(client.getRecentTracks("ada", "session-key")).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
