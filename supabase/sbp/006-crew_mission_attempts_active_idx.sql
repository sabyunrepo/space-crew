create unique index crew_one_active_attempt_per_room on public.crew_mission_attempts (room_id) where status = 'active'
