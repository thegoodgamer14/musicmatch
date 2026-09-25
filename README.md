# Music Match

Music Match pairs two people who are listening to the same song right now. Last.fm is the source of identity and of what each person is playing.

## Create a Last.fm API account

1. Open [https://www.last.fm/api/account/create](https://www.last.fm/api/account/create) and create an API account.
2. Set the callback URL to `http://localhost:3000/api/auth/callback`.
3. Copy the **API key** into `LASTFM_API_KEY` and the **Shared secret** into `LASTFM_API_SECRET`. Last.fm does not issue a session secret. Music Match creates its own login session after you approve the app.

## Run

Copy `.env.example` to `.env.local`. Fill in the API key, the shared secret, and `DATABASE_URL` (the same Supabase pooler string used in production). Keep `APP_URL=http://localhost:3000`. `npm run dev` reads that database. It no longer creates a local SQLite file.

```bash
npm install
npm test
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy on Cloudflare with Supabase

1. Create a free [Supabase](https://supabase.com) project. In the SQL editor, run the SQL in `supabase/migrations/20260925120000_musicmatch.sql`.
2. Copy the transaction pooler connection string (port 6543) into `DATABASE_URL`.
3. Create a free Cloudflare Workers project. From this directory, run `npx wrangler login`, then `npm run deploy`.
4. Set these Worker secrets: `LASTFM_API_KEY`, `LASTFM_API_SECRET`, `APP_URL`, and `DATABASE_URL`.

```bash
npx wrangler secret put LASTFM_API_KEY
npx wrangler secret put LASTFM_API_SECRET
npx wrangler secret put APP_URL
npx wrangler secret put DATABASE_URL
```

5. On the Last.fm API account, register `https://<worker-host>/api/auth/callback` as the only callback URL. Set the `APP_URL` secret to `https://<worker-host>` (no trailing path).

The page checks state every 8 seconds and sends a heartbeat every 30 seconds so two open tabs stay under the Workers free daily request cap.

`npm run preview` builds the app and serves it in the Workers runtime. `npm run deploy` builds it and deploys it. Do not put those secrets in `wrangler.jsonc`.

## Manual check

Use two browsers, sign in, nothing playing, find a match, get paired, send a message, leave, and confirm those two accounts are not paired again.
