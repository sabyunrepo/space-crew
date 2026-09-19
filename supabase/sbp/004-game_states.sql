create table crew_private.game_states (
  room_id uuid primary key references crew_private.rooms(id) on delete cascade,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
)
