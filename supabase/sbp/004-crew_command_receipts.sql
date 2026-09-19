create table public.crew_command_receipts (
  actor_user_id uuid not null references auth.users(id),
  command_id uuid not null,
  room_id uuid references public.crew_rooms(id) on delete cascade,
  request_hash text not null check (char_length(request_hash) = 64 and request_hash !~ '[^0-9a-f]'),
  committed_revision bigint check (committed_revision >= 0),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  primary key (actor_user_id, command_id)
)
