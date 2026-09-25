import { NextResponse } from "next/server";
import { createLastfmClient } from "@/server/lastfm";
import { withRequestDb } from "@/server/db";
import { authorizeUrl, failureRedirect, requireEnv } from "@/server/http";

export const runtime = "nodejs";

export async function POST() {
  const env = requireEnv();
  return withRequestDb(async () => {
    const client = createLastfmClient({ apiKey: env.apiKey, sharedSecret: env.apiSecret });
    const token = await client.getToken();
    if (!token.ok) {
      return NextResponse.redirect(new URL(failureRedirect("unreachable"), env.appUrl), 303);
    }
    return NextResponse.redirect(authorizeUrl(env.appUrl, env.apiKey), 303);
  });
}
