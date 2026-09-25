import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logout } from "@/server/app-state";
import { getDb, withRequestDb } from "@/server/db";
import { clearedSessionCookie, requireEnv } from "@/server/http";

export const runtime = "nodejs";

export async function POST() {
  const env = requireEnv();
  return withRequestDb(async () => {
    const sessionId = (await cookies()).get("musicmatch_session")?.value;
    if (sessionId) await logout(getDb(), sessionId);
    const response = NextResponse.redirect(new URL("/", env.appUrl), 303);
    response.headers.set("Set-Cookie", clearedSessionCookie(env.appUrl));
    return response;
  });
}
