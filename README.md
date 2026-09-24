# Music Match

Music Match pairs two people who are listening to the same song right now. Last.fm is the source of identity and of what each person is playing.

## Create a Last.fm API account

1. Open [https://www.last.fm/api/account/create](https://www.last.fm/api/account/create) and create an API account.
2. Set the callback URL to `http://localhost:3000/api/auth/callback`.
3. Copy the **API key** into `LASTFM_API_KEY` and the **Shared secret** into `LASTFM_API_SECRET`. Last.fm does not issue a session secret. Music Match creates its own login session after you approve the app.

## Run

Copy `.env.example` to `.env.local`. Fill in the API key and shared secret. Keep `APP_URL=http://localhost:3000`.

```bash
npm install
npm test
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Manual check

Use two browsers, sign in, nothing playing, find a match, get paired, send a message, leave, and confirm those two accounts are not paired again.
