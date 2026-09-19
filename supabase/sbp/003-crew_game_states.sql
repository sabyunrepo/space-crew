create table public.crew_game_states (
  room_id uuid primary key references public.crew_rooms(id) on delete cascade,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
)
