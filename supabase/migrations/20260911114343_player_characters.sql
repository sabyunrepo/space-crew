-- Prepared for the future Supabase repository; not applied to any remote project.
-- Room-local identity: choosing a character in one room does not change another.
begin;
alter table crew_private.room_members
  add column character_id text not null default 'otter'
  constraint room_members_character_id_check check (character_id in (
    'otter', 'gary', 'moby-dick', 'spongebob', 'green-dino', 'coral', 'komodo',
    'hangyodon', 'pingu', 'ilu', 'snow', 'tamama', 'sun', 'tree', 'bay'
  ));
comment on column crew_private.room_members.character_id is
  'Public character identity projected by crew-api. Change only in lobby via set_character; reset ready and increment revision in the same transaction.';
commit;
