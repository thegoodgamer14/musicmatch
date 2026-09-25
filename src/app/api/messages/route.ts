import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sendMessage } from "@/server/app-state";
import { getDb, withRequestDb } from "@/server/db";
import { loadUser, messageErrorBody, requireEnv } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  requireEnv();
  return withRequestDb(async () => {
    const now = Date.now();
    const sessionId = (await cookies()).get("musicmatch_session")?.value ?? null;
    const user = await loadUser(sessionId, now);
    if (!user) return new NextResponse(null, { status: 401 });

    let body = "";
    try {
      const json = (await request.json()) as { body?: unknown };
      body = typeof json.body === "string" ? json.body : "";
    } catch {
      body = "";
    }

    const result = await sendMessage(getDb(), user.userId, body, now);
    if (!result.ok) {
      if (result.error === "empty" || result.error === "too_long") {
        return NextResponse.json(messageErrorBody(result.error), { status: 400 });
      }
      return NextResponse.json({ error: "No active match." }, { status: 400 });
    }
    return NextResponse.json({ id: result.id }, { status: 201 });
  });
}
