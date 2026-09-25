import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cancelQueue, joinQueue } from "@/server/app-state";
import { getDb } from "@/server/db";
import { loadUser, requireEnv } from "@/server/http";

export const runtime = "nodejs";

async function sessionId(): Promise<string | null> {
  return (await cookies()).get("musicmatch_session")?.value ?? null;
}

export async function POST() {
  requireEnv();
  const now = Date.now();
  const user = await loadUser(await sessionId(), now);
  if (!user) return new NextResponse(null, { status: 401 });
  const status = await joinQueue(getDb(), user.userId, now);
  return NextResponse.json({ status });
}

export async function DELETE() {
  requireEnv();
  const now = Date.now();
  const user = await loadUser(await sessionId(), now);
  if (!user) return new NextResponse(null, { status: 401 });
  await cancelQueue(getDb(), user.userId);
  return new NextResponse(null, { status: 204 });
}
