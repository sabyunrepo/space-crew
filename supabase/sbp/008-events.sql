create table crew_private.events (
  id bigint generated always as identity primary key,
  room_id uuid not null references crew_private.rooms(id) on delete cascade,
  revision bigint not null check (revision > 0),
  actor_user_id uuid not null references auth.users(id),
  command_type text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  unique (room_id, revision)
)
