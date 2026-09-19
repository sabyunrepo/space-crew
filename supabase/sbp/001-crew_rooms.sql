create table public.crew_rooms (
  id uuid primary key,
  host_user_id uuid not null references auth.users(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 32),
  capacity smallint not null check (capacity between 3 and 5),
  mission_mode text not null check (mission_mode in ('sequential','random')),
  start_mission smallint not null check (start_mission between 1 and 50),
  phase text not null default 'lobby' check (phase in ('lobby','briefing','task_selection','preparation','playing','trick_result','success','failure','campaign_complete')),
  revision bigint not null default 0 check (revision >= 0),
  ruleset_version text not null,
  attempt_id uuid,
  invite_token_hash text not null unique check (char_length(invite_token_hash) = 64 and invite_token_hash !~ '[^0-9a-f]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
