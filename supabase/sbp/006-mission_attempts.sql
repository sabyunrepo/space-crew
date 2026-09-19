create table crew_private.mission_attempts (
  attempt_id uuid primary key,
  room_id uuid not null references crew_private.rooms(id) on delete cascade,
  mission_id smallint not null check (mission_id between 1 and 50),
  attempt_number integer not null check (attempt_number > 0),
  ruleset_version text not null,
  status text not null check (status in ('active','success','failure','abandoned')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
)
