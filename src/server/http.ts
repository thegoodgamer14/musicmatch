import { COPY } from "./copy";
import { getDb } from "./db";
import { readSession } from "./presence";

export type AuthFailure = "denied" | "rejected" | "unreachable";

export function requireEnv(): {
  apiKey: string;
  apiSecret: string;
  sessionSecret: string;
  appUrl: string;
} {
  const apiKey = process.env.LASTFM_API_KEY;
  const apiSecret = process.env.LASTFM_API_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  const appUrl = process.env.APP_URL;
  // The cookie stores a random session id. SESSION_SECRET is required, not written into it.
  if (!apiKey || !apiSecret || !sessionSecret || !appUrl) {
    const missing = ["LASTFM_API_KEY", "LASTFM_API_SECRET", "SESSION_SECRET", "APP_URL"].filter(
      (name) => !process.env[name],
    );
    throw new Error(`Missing required environment: ${missing.join(", ")}`);
  }
  return { apiKey, apiSecret, sessionSecret, appUrl };
}

export function authorizeUrl(appUrl: string, apiKey: string): string {
  const base = appUrl.endsWith("/") ? appUrl.slice(0, -1) : appUrl;
  const params = new URLSearchParams({
    api_key: apiKey,
    cb: `${base}/api/auth/callback`,
  });
  return `https://www.last.fm/api/auth/?${params.toString()}`;
}

export function failureRedirect(reason: AuthFailure): string {
  return `/?error=${reason}`;
}

export function messageErrorBody(error: "empty" | "too_long"): { error: string } {
  if (error === "empty") return { error: COPY.emptyMessage };
  return { error: COPY.tooLong };
}

export function clearedSessionCookie(appUrl: string): string {
  const cookie = "musicmatch_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
  if (appUrl.startsWith("https://")) return `${cookie}; Secure`;
  return cookie;
}

export function loadUser(
  sessionId: string | null,
  now: number,
): { sessionId: string; userId: number } | null {
  if (!sessionId) return null;
  const session = readSession(getDb(), sessionId, now);
  if (!session) return null;
  return { sessionId, userId: session.userId };
}
