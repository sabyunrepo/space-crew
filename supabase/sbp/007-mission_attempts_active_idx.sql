create unique index one_active_attempt_per_room on crew_private.mission_attempts (room_id) where status = 'active'
