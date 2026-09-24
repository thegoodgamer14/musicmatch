"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AppState } from "@/server/app-state";
import { COPY } from "@/server/copy";

type ChatMessage = Extract<AppState, { view: "chat" }>["messages"][number];
type SongInfo = { artist: string; track: string; artworkUrl: string | null };

const UNREACHABLE = "Last.fm could not be reached. Try again.";

function signInCopy(code: string | null): string | null {
  if (code === "denied") return COPY.denied;
  if (code === "rejected") return COPY.rejected;
  if (code === "unreachable") return UNREACHABLE;
  return null;
}

export default function Page() {
  const [state, setState] = useState<AppState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [kicked, setKicked] = useState(false);
  const [draft, setDraft] = useState("");
  const [composerError, setComposerError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const signedInRef = useRef(false);
  const pullGen = useRef(0);

  const applyState = useCallback((data: AppState) => {
    if (data.view === "signed_out") {
      if (signedInRef.current) setKicked(true);
      signedInRef.current = false;
      messagesRef.current = [];
      setMessages([]);
    } else {
      signedInRef.current = true;
      if (data.view === "chat") {
        const seen = new Set(messagesRef.current.map((message) => message.id));
        const added = data.messages.filter((message) => !seen.has(message.id));
        if (added.length > 0) {
          const next = [...messagesRef.current, ...added];
          messagesRef.current = next;
          setMessages(next);
        }
      } else if (messagesRef.current.length > 0) {
        messagesRef.current = [];
        setMessages([]);
      }
    }
    setState(data);
  }, []);

  const pullState = useCallback(async () => {
    const generation = ++pullGen.current;
    const after = messagesRef.current.at(-1)?.id ?? 0;
    try {
      const response = await fetch(`/api/state?after=${after}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as AppState;
      if (generation !== pullGen.current) return;
      applyState(data);
    } catch {
      return;
    }
  }, [applyState]);

  const beat = useCallback(async () => {
    try {
      const response = await fetch("/api/presence", { method: "POST" });
      if (response.status !== 401) return;
      let error = "";
      try {
        const body = (await response.json()) as { error?: unknown };
        error = typeof body.error === "string" ? body.error : "";
      } catch {
        error = "";
      }
      if (error === COPY.rejected) {
        signedInRef.current = false;
        messagesRef.current = [];
        setMessages([]);
        setKicked(true);
        setState({ view: "signed_out", error: null });
      }
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    setQueryError(new URLSearchParams(window.location.search).get("error"));
  }, []);

  useEffect(() => {
    let stateTimer = 0;
    let presenceTimer = 0;

    function stop() {
      window.clearInterval(stateTimer);
      window.clearInterval(presenceTimer);
      stateTimer = 0;
      presenceTimer = 0;
    }

    function start() {
      stop();
      void pullState();
      void beat();
      stateTimer = window.setInterval(() => {
        void pullState();
      }, 2000);
      presenceTimer = window.setInterval(() => {
        void beat();
      }, 10000);
    }

    function onVisibility() {
      if (document.visibilityState === "visible") start();
      else stop();
    }

    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [beat, pullState]);

  async function findMatch() {
    await fetch("/api/queue", { method: "POST" });
    await pullState();
  }

  async function cancelWait() {
    await fetch("/api/queue", { method: "DELETE" });
    await pullState();
  }

  async function leave() {
    await fetch("/api/match/leave", { method: "POST" });
    await pullState();
  }

  async function onSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim().length === 0) {
      setComposerError(COPY.emptyMessage);
      return;
    }
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: draft }),
    });
    if (response.status === 400) {
      const body = (await response.json()) as { error?: unknown };
      setComposerError(typeof body.error === "string" ? body.error : COPY.emptyMessage);
      return;
    }
    if (!response.ok) {
      await pullState();
      return;
    }
    setDraft("");
    setComposerError(null);
    await pullState();
  }

  const banner = kicked ? COPY.rejected : signInCopy(queryError);

  return (
    <main className="shell">
      <header className="top">
        <p className="brand">Music Match</p>
        {state && state.view !== "signed_out" ? (
          <form method="post" action="/api/auth/logout">
            <button className="text-button" type="submit">
              Log out
            </button>
          </form>
        ) : null}
      </header>
      {state == null ? <p className="muted">Loading…</p> : null}
      {state?.view === "signed_out" ? <SignIn banner={banner} /> : null}
      {state?.view === "home" ? <Home state={state} onFind={() => void findMatch()} /> : null}
      {state?.view === "waiting" ? <Waiting state={state} onCancel={() => void cancelWait()} /> : null}
      {state?.view === "chat" ? (
        <Chat
          state={state}
          messages={messages}
          draft={draft}
          composerError={composerError}
          onDraft={(value) => {
            setDraft(value);
            if (composerError) setComposerError(null);
          }}
          onSend={(event) => void onSend(event)}
          onLeave={() => void leave()}
        />
      ) : null}
    </main>
  );
}

function SignIn({ banner }: { banner: string | null }) {
  return (
    <section className="card">
      <h1>Listen with someone on the same song.</h1>
      <p className="muted">Sign in with Last.fm. A match is only offered while a song is playing.</p>
      {banner ? (
        <p className="notice" role="alert">
          {banner}
        </p>
      ) : null}
      <form method="post" action="/api/auth/lastfm">
        <button type="submit">Continue with Last.fm</button>
      </form>
    </section>
  );
}

function Home({ state, onFind }: { state: Extract<AppState, { view: "home" }>; onFind: () => void }) {
  return (
    <section className="card">
      <Song song={state.nowPlaying} empty={COPY.nothingPlaying} />
      <Artists artists={state.recentArtists} />
      {state.notice ? <p className="notice">{state.notice}</p> : null}
      <button type="button" disabled={!state.canMatch} onClick={onFind}>
        Find a match
      </button>
    </section>
  );
}

function Waiting({
  state,
  onCancel,
}: {
  state: Extract<AppState, { view: "waiting" }>;
  onCancel: () => void;
}) {
  return (
    <section className="card">
      <p className="muted">Waiting for someone on this song.</p>
      <Song song={state.song} empty="" />
      {state.notice ? <p className="notice">{state.notice}</p> : null}
      <button className="secondary" type="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

function Chat({
  state,
  messages,
  draft,
  composerError,
  onDraft,
  onSend,
  onLeave,
}: {
  state: Extract<AppState, { view: "chat" }>;
  messages: ChatMessage[];
  draft: string;
  composerError: string | null;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onLeave: () => void;
}) {
  return (
    <section className="card">
      <div className="partner">
        {state.partner.avatarUrl ? (
          <img className="avatar" src={state.partner.avatarUrl} alt="" />
        ) : (
          <span className="avatar fallback" aria-hidden="true">
            {state.partner.username.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div>
          <a href={state.partner.profileUrl}>{state.partner.username}</a>
          {state.partner.away ? <span className="away">{COPY.away}</span> : null}
        </div>
      </div>
      <Artists artists={state.partner.recentArtists} />
      <Song song={state.song} empty="" />
      <ol className="messages">
        {messages.map((message) => (
          <li key={message.id} className={message.senderId === state.selfId ? "mine" : "theirs"}>
            {message.body}
          </li>
        ))}
      </ol>
      <form className="composer" onSubmit={onSend}>
        <label htmlFor="message">Message</label>
        <input
          id="message"
          name="body"
          type="text"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
        />
        {composerError ? (
          <p className="notice" role="alert">
            {composerError}
          </p>
        ) : null}
        <div className="row">
          <button type="submit">Send</button>
          <button className="secondary" type="button" onClick={onLeave}>
            Leave
          </button>
        </div>
      </form>
    </section>
  );
}

function Song({ song, empty }: { song: SongInfo | null; empty: string }) {
  if (!song) return <p>{empty}</p>;
  return (
    <div className="song">
      {song.artworkUrl ? (
        <img className="art" src={song.artworkUrl} alt="" />
      ) : (
        <span className="art fallback" aria-hidden="true" />
      )}
      <div>
        <h2 className="song-title">{song.track}</h2>
        <p className="muted">{song.artist}</p>
      </div>
    </div>
  );
}

function Artists({ artists }: { artists: string[] }) {
  if (artists.length === 0) return null;
  return (
    <ul className="artists">
      {artists.map((artist) => (
        <li key={artist}>{artist}</li>
      ))}
    </ul>
  );
}
