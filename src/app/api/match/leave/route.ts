import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { leaveMatch } from "@/server/app-state";
import { getDb } from "@/server/db";
import { loadUser, requireEnv } from "@/server/http";

export const runtime = "nodejs";

export async function POST() {
  requireEnv();
  const now = Date.now();
  const sessionId = (await cookies()).get("musicmatch_session")?.value ?? null;
  const user = await loadUser(sessionId, now);
  if (!user) return new NextResponse(null, { status: 401 });
  const ended = await leaveMatch(getDb(), user.userId, now);
  return NextResponse.json(ended);
}
