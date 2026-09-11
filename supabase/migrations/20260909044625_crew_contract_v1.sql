-- Prepared contract schema, not applied to a remote project.
-- Authoritative state and invite secrets must never be exposed through Data API / Realtime.
begin;
create schema if not exists crew_private;
revoke all on schema crew_private from public, anon, authenticated;
do $$ begin
  if not exists (select from pg_roles where rolname = 'crew_server') then create role crew_server nologin; end if;
end $$;
grant usage on schema crew_private to crew_server;

create table crew_private.players (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 16),
  created_at timestamptz not null default now()
);
create table crew_private.rooms (
  id uuid primary key default gen_random_uuid(),
  host_player_id uuid not null references crew_private.players(id),
  name text not null check (char_length(btrim(name)) between 1 and 32),
  capacity smallint not null check (capacity between 3 and 5),
  mission_mode text not null check (mission_mode in ('sequential','random')),
  start_mission smallint not null check (start_mission between 1 and 50),
  phase text not null default 'lobby' check (phase in ('lobby','briefing','task_selection','playing','trick_result','success','failure','campaign_complete')),
  revision bigint not null default 0 check (revision >= 0),
  ruleset_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rooms_host_idx on crew_private.rooms(host_player_id);
create table crew_private.room_members (
  room_id uuid not null references crew_private.rooms(id) on delete cascade,
  player_id uuid not null references crew_private.players(id) on delete restrict,
  seat smallint not null check (seat between 0 and 4),
  ready boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (room_id,player_id), unique(room_id,seat)
);
create index room_members_player_idx on crew_private.room_members(player_id);
create table crew_private.invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references crew_private.rooms(id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_by uuid not null references crew_private.players(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create index invites_room_idx on crew_private.invites(room_id);
create index invites_creator_idx on crew_private.invites(created_by);
create table crew_private.mission_attempts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references crew_private.rooms(id) on delete cascade,
  mission_id smallint not null check (mission_id between 1 and 50),
  attempt_number integer not null check (attempt_number > 0),
  ruleset_version text not null,
  status text not null check (status in ('active','success','failure')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(room_id,attempt_number), unique(room_id,id)
);
create unique index one_active_attempt_per_room on crew_private.mission_attempts(room_id) where status = 'active';
-- One authoritative JSON state: hands, goals, trick, mission draw history and communication.
-- No parallel hands table: avoid two competing sources of truth. Project per user in server code.
create table crew_private.game_states (
  room_id uuid primary key references crew_private.rooms(id) on delete cascade,
  attempt_id uuid,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now(),
  foreign key (room_id,attempt_id) references crew_private.mission_attempts(room_id,id)
);
create table crew_private.command_receipts (
  actor_player_id uuid not null references crew_private.players(id) on delete restrict,
  command_id uuid not null,
  room_id uuid references crew_private.rooms(id) on delete cascade,
  request_hash bytea not null check (octet_length(request_hash) = 32),
  committed_revision bigint check (committed_revision >= 0),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  primary key(actor_player_id,command_id)
);
create index command_receipts_room_idx on crew_private.command_receipts(room_id);
create table crew_private.events (
  id bigint generated always as identity primary key,
  room_id uuid not null references crew_private.rooms(id) on delete cascade,
  attempt_id uuid,
  revision bigint not null check (revision > 0),
  actor_player_id uuid not null references crew_private.players(id),
  command_type text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  unique(room_id,revision),
  foreign key (room_id,attempt_id) references crew_private.mission_attempts(room_id,id)
);
create index events_actor_idx on crew_private.events(actor_player_id);

-- Only the caller's own membership mapping is visible. Contains no nickname/seat/hand.
create table public.room_subscriptions (
  room_id uuid not null references crew_private.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key(room_id,user_id)
);
create index room_subscriptions_user_idx on public.room_subscriptions(user_id,room_id);
create table public.room_versions (
  room_id uuid primary key references crew_private.rooms(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0)
);
alter table public.room_subscriptions enable row level security;
alter table public.room_versions enable row level security;
revoke all on public.room_subscriptions, public.room_versions from public,anon,authenticated;
grant select on public.room_subscriptions, public.room_versions to authenticated;
create policy own_subscription on public.room_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy member_version on public.room_versions for select to authenticated using (
  exists (select 1 from public.room_subscriptions m where m.room_id = room_versions.room_id and m.user_id = (select auth.uid()))
);
grant usage on schema public to crew_server;
grant all on public.room_subscriptions,public.room_versions to crew_server;
create policy server_subscriptions on public.room_subscriptions for all to crew_server using (true) with check (true);
create policy server_versions on public.room_versions for all to crew_server using (true) with check (true);

-- Defense in depth: a later accidental grant to authenticated still cannot read private rows.
do $$ declare t text; begin
  foreach t in array array['players','rooms','room_members','invites','mission_attempts','game_states','command_receipts','events'] loop
    execute format('alter table crew_private.%I enable row level security',t);
    execute format('create policy server_only on crew_private.%I for all to crew_server using (true) with check (true)',t);
  end loop;
end $$;
revoke all on all tables in schema crew_private from public, anon, authenticated;
revoke all on all sequences in schema crew_private from public, anon, authenticated;
grant select,insert,update,delete on all tables in schema crew_private to crew_server;
grant usage,select on all sequences in schema crew_private to crew_server;
alter default privileges in schema crew_private revoke all on tables from public,anon,authenticated;
alter default privileges in schema crew_private revoke execute on functions from public;
-- Publish version notifications only. Never add crew_private tables to this publication.
do $$ begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='room_versions') then
    alter publication supabase_realtime add table public.room_versions;
  end if;
end $$;
commit;
