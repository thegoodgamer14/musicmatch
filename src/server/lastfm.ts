import { createHash } from "node:crypto";
import { normalizeName } from "./song-key";

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

const ENDPOINT = "https://ws.audioscrobbler.com/2.0/";

export function signLastfmParams(params: Record<string, string>, secret: string): string {
  const payload =
    Object.keys(params)
      .filter((key) => key !== "format" && key !== "callback")
      .sort()
      .map((key) => key + params[key])
      .join("") + secret;
  return createHash("md5").update(payload).digest("hex");
}

export function recentArtists(tracks: LastfmTrack[]): string[] {
  const nowPlaying = tracks.find((track) => track.nowPlaying && track.artist.trim() !== "");
  const ordered = nowPlaying ? [nowPlaying, ...tracks.filter((track) => track !== nowPlaying)] : tracks;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const track of ordered) {
    if (track.artist.trim() === "") continue;
    const key = normalizeName(track.artist);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(track.artist);
    if (names.length === 5) break;
  }
  return names;
}

export function nowPlayingTrack(tracks: LastfmTrack[]): LastfmTrack | null {
  return tracks.find((track) => track.nowPlaying) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  const record = asRecord(value);
  if (!record || typeof record["#text"] !== "string" || record["#text"] === "") return null;
  return record["#text"];
}

function artworkFromImages(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let lastNonEmpty: string | null = null;
  let extralarge: string | null = null;
  for (const item of value) {
    const record = asRecord(item);
    if (!record || typeof record["#text"] !== "string" || record["#text"] === "") continue;
    lastNonEmpty = record["#text"];
    if (record.size === "extralarge") extralarge = record["#text"];
  }
  return extralarge ?? lastNonEmpty;
}

function recentFailure(json: Record<string, unknown>): LastfmFailure | null {
  if (!Object.prototype.hasOwnProperty.call(json, "error")) return null;
  const message = typeof json.message === "string" ? json.message : "";
  if (json.error === 4 || json.error === 9) return "rejected";
  if (json.error === 17 || /private/i.test(message)) return "private";
  return "unreachable";
}

function authFailure(json: Record<string, unknown>): "rejected" | "unreachable" | null {
  if (!Object.prototype.hasOwnProperty.call(json, "error")) return null;
  if (json.error === 4 || json.error === 9) return "rejected";
  return "unreachable";
}

function parseTrack(value: unknown): LastfmTrack | null {
  const record = asRecord(value);
  if (!record) return null;
  const attr = asRecord(record["@attr"]);
  return {
    artist: textValue(record.artist) ?? "",
    track: typeof record.name === "string" ? record.name : "",
    album: textValue(record.album),
    artworkUrl: artworkFromImages(record.image),
    nowPlaying: attr?.nowplaying === "true",
  };
}

export function parseRecentTracks(
  json: unknown,
): { ok: true; tracks: LastfmTrack[] } | { ok: false; reason: LastfmFailure } {
  const record = asRecord(json);
  if (!record) return { ok: false, reason: "unreachable" };
  const reason = recentFailure(record);
  if (reason) return { ok: false, reason };
  const recent = asRecord(record.recenttracks);
  if (!recent || !Object.prototype.hasOwnProperty.call(recent, "track") || recent.track == null) {
    return { ok: true, tracks: [] };
  }
  const items = Array.isArray(recent.track) ? recent.track : [recent.track];
  const tracks: LastfmTrack[] = [];
  for (const item of items) {
    const track = parseTrack(item);
    if (track) tracks.push(track);
  }
  return { ok: true, tracks };
}

export function createLastfmClient(options: {
  apiKey: string;
  sharedSecret: string;
  fetchImpl?: typeof fetch;
}): LastfmClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function call(
    params: Record<string, string>,
  ): Promise<{ ok: true; json: unknown } | { ok: false; reason: "unreachable" }> {
    const query = new URLSearchParams({
      ...params,
      api_sig: signLastfmParams(params, options.sharedSecret),
      format: "json",
    });
    try {
      const response = await fetchImpl(`${ENDPOINT}?${query.toString()}`);
      return { ok: true, json: JSON.parse(await response.text()) };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }

  return {
    async getToken() {
      const result = await call({ method: "auth.getToken", api_key: options.apiKey });
      if (!result.ok) return result;
      const record = asRecord(result.json);
      if (!record || authFailure(record) || typeof record.token !== "string" || record.token === "") {
        return { ok: false, reason: "unreachable" };
      }
      return { ok: true, token: record.token };
    },

    async getSession(token) {
      const result = await call({
        method: "auth.getSession",
        api_key: options.apiKey,
        token,
      });
      if (!result.ok) return result;
      const record = asRecord(result.json);
      if (!record) return { ok: false, reason: "unreachable" };
      const reason = authFailure(record);
      if (reason) return { ok: false, reason };
      const session = asRecord(record.session);
      const username = session && typeof session.name === "string" ? session.name : "";
      const sessionKey = session && typeof session.key === "string" ? session.key : "";
      if (username === "" || sessionKey === "") return { ok: false, reason: "unreachable" };
      return { ok: true, username, sessionKey };
    },

    async getRecentTracks(username, sessionKey) {
      const result = await call({
        method: "user.getRecentTracks",
        user: username,
        limit: "50",
        api_key: options.apiKey,
        sk: sessionKey,
      });
      if (!result.ok) return result;
      return parseRecentTracks(result.json);
    },

    async getInfo(username, sessionKey) {
      const result = await call({
        method: "user.getInfo",
        user: username,
        api_key: options.apiKey,
        sk: sessionKey,
      });
      if (!result.ok) return result;
      const record = asRecord(result.json);
      if (!record) return { ok: false, reason: "unreachable" };
      const reason = authFailure(record);
      if (reason) return { ok: false, reason };
      const user = asRecord(record.user);
      const profileUrl =
        user && typeof user.url === "string" && user.url !== ""
          ? user.url
          : `https://www.last.fm/user/${encodeURIComponent(username)}`;
      return {
        ok: true,
        avatarUrl: user ? artworkFromImages(user.image) : null,
        profileUrl,
      };
    },
  };
}
