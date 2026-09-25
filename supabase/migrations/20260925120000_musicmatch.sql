-- Roles exist on Supabase. Create them for a bare Postgres/PGlite so the revokes below succeed.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

create table users (
  id bigint generated always as identity primary key,
  lastfm_username text not null unique,
  lastfm_session_key text not null,
  avatar_url text,
  profile_url text,
  profile_fetched_at bigint,
  created_at bigint not null,
  last_heartbeat_at bigint
);

create table sessions (
  id text primary key,
  user_id bigint not null references users (id),
  expires_at bigint not null
);

create table now_playing (
  user_id bigint primary key references users (id),
  artist text,
  track text,
  album text,
  artwork_url text,
  is_now_playing smallint not null,
  song_key text,
  recent_artists text not null,
  fetched_at bigint not null,
  attempted_at bigint not null,
  error text
);

create table queue (
  user_id bigint primary key references users (id),
  song_key text not null,
  artist text not null,
  track text not null,
  artwork_url text,
  joined_at bigint not null
);

create table matches (
  id bigint generated always as identity primary key,
  song_key text not null,
  artist text not null,
  track text not null,
  artwork_url text,
  user_a_id bigint not null,
  user_b_id bigint not null,
  snapshot_a text not null,
  snapshot_b text not null,
  status text not null,
  ended_by bigint,
  created_at bigint not null,
  ended_at bigint
);

create index matches_active_users on matches (status, user_a_id, user_b_id);

create table messages (
  id bigint generated always as identity primary key,
  match_id bigint not null references matches (id),
  sender_id bigint not null,
  body text not null,
  created_at bigint not null
);

create table pairs (
  user_lo bigint not null,
  user_hi bigint not null,
  primary key (user_lo, user_hi)
);

alter table users enable row level security;
alter table sessions enable row level security;
alter table now_playing enable row level security;
alter table queue enable row level security;
alter table matches enable row level security;
alter table messages enable row level security;
alter table pairs enable row level security;

revoke all on table users from anon, authenticated;
revoke all on table sessions from anon, authenticated;
revoke all on table now_playing from anon, authenticated;
revoke all on table queue from anon, authenticated;
revoke all on table matches from anon, authenticated;
revoke all on table messages from anon, authenticated;
revoke all on table pairs from anon, authenticated;
