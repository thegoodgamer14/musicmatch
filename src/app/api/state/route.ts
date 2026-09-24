import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readState } from "@/server/app-state";
import { getDb } from "@/server/db";
import { requireEnv } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  requireEnv();
  const now = Date.now();
  const raw = new URL(request.url).searchParams.get("after");
  const parsed = raw == null || raw === "" ? 0 : Number(raw);
  const after = Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
  const sessionId = (await cookies()).get("musicmatch_session")?.value ?? null;
  const state = readState(getDb(), sessionId, now, after);
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}
