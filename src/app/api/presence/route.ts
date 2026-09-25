import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COPY } from "@/server/copy";
import { getDb, withRequestDb } from "@/server/db";
import { clearedSessionCookie, loadUser, requireEnv } from "@/server/http";
import { createLastfmClient } from "@/server/lastfm";
import { readSession, recordHeartbeat, refreshIfDue, sessionCookie } from "@/server/presence";

export const runtime = "nodejs";

export async function POST() {
  const env = requireEnv();
  return withRequestDb(async () => {
    const now = Date.now();
    const sessionId = (await cookies()).get("musicmatch_session")?.value ?? null;
    const user = await loadUser(sessionId, now);
    if (!user) return new NextResponse(null, { status: 401 });

    const db = getDb();
    await recordHeartbeat(db, user.sessionId, now);
    const client = createLastfmClient({ apiKey: env.apiKey, sharedSecret: env.apiSecret });
    await refreshIfDue(db, user.userId, client, now);

    if (!(await readSession(db, user.sessionId, now))) {
      const response = NextResponse.json(
        { error: COPY.rejected },
        { status: 401 },
      );
      response.headers.set("Set-Cookie", clearedSessionCookie(env.appUrl));
      return response;
    }

    const response = new NextResponse(null, { status: 204 });
    response.headers.set("Set-Cookie", sessionCookie(user.sessionId, env.appUrl));
    return response;
  });
}
