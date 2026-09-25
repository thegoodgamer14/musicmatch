import { NextResponse } from "next/server";
import { getDb, withRequestDb } from "@/server/db";
import { failureRedirect, requireEnv } from "@/server/http";
import { createLastfmClient } from "@/server/lastfm";
import { createSession, sessionCookie, upsertUser } from "@/server/presence";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const env = requireEnv();
  return withRequestDb(async () => {
    const token = new URL(request.url).searchParams.get("token");
    if (!token) {
      return NextResponse.redirect(new URL(failureRedirect("denied"), env.appUrl), 303);
    }

    const client = createLastfmClient({ apiKey: env.apiKey, sharedSecret: env.apiSecret });
    const session = await client.getSession(token);
    if (!session.ok) {
      return NextResponse.redirect(new URL(failureRedirect(session.reason), env.appUrl), 303);
    }

    const info = await client.getInfo(session.username, session.sessionKey);
    if (!info.ok) {
      return NextResponse.redirect(new URL(failureRedirect(info.reason), env.appUrl), 303);
    }

    const now = Date.now();
    const db = getDb();
    const userId = await upsertUser(db, {
      username: session.username,
      sessionKey: session.sessionKey,
      now,
      avatarUrl: info.avatarUrl,
      profileUrl: info.profileUrl,
    });
    const sessionId = await createSession(db, userId, now);
    const response = NextResponse.redirect(new URL("/", env.appUrl), 303);
    response.headers.set("Set-Cookie", sessionCookie(sessionId, env.appUrl));
    return response;
  });
}
