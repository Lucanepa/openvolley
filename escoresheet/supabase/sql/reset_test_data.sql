begin;

-- Delete prior test records
delete from events   where match_id in (select id from matches where external_id = 'test-match-default');
delete from sets     where match_id in (select id from matches where external_id = 'test-match-default');
delete from players  where external_id like 'test-team-alpha-%' or external_id like 'test-team-bravo-%';
delete from matches  where external_id = 'test-match-default';
delete from referees where seed_key    in ('test-referee-alpha','test-referee-bravo');
delete from scorers  where seed_key    in ('test-scorer-alpha','test-scorer-bravo');
delete from teams    where external_id in ('test-team-alpha','test-team-bravo');

-- Ensure the new players.functions column exists
alter table players
  add column if not exists functions text[] default array['player'];

-- Ensure teams.bench_staff column exists
alter table teams
  add column if not exists bench_staff jsonb;

with
home_team as (
  insert into teams (external_id, name, color, bench_staff, test, updated_at)
  values (
    'test-team-alpha',
    'Volley Zürich Test',
    '#3b82f6',
    jsonb_build_array(
      jsonb_build_object('role','Coach','first_name','Marco','last_name','Frei'),
      jsonb_build_object('role','Assistant Coach 1','first_name','Jan','last_name','Widmer'),
      jsonb_build_object('role','Assistant Coach 2','first_name','Helen','last_name','Huber'),
      jsonb_build_object('role','Physiotherapist','first_name','Eva','last_name','Gerber')
    ),
    true,
    now()
  )
  on conflict (external_id)
  do update set
    name        = excluded.name,
    color       = excluded.color,
    bench_staff = excluded.bench_staff,
    test        = true,
    updated_at  = now()
  returning id
),
away_team as (
  insert into teams (external_id, name, color, bench_staff, test, updated_at)
  values (
    'test-team-bravo',
    'Volley Basel Test',
    '#ef4444',
    jsonb_build_array(
      jsonb_build_object('role','Coach','first_name','Stefan','last_name','Keller'),
      jsonb_build_object('role','Assistant Coach 1','first_name','Lars','last_name','Brunner')
    ),
    true,
    now()
  )
  on conflict (external_id)
  do update set
    name        = excluded.name,
    color       = excluded.color,
    bench_staff = excluded.bench_staff,
    test        = true,
    updated_at  = now()
  returning id
),
match_row as (
  insert into matches (
    external_id, home_team_id, away_team_id, status, scheduled_at,
    hall, city, league, officials, test, updated_at
  )
  select
    'test-match-default',
    (select id from home_team),
    (select id from away_team),
    'scheduled',
    date_trunc('minute', now()) + interval '4 hour',
    'Kantonsschule Wiedikon (Halle A)',
    'Zürich',
    '3L B',
    jsonb_build_array(
      jsonb_build_object('role','1st referee','external_id','test-referee-alpha'),
      jsonb_build_object('role','2nd referee','external_id','test-referee-bravo'),
      jsonb_build_object('role','scorer','external_id','test-scorer-alpha'),
      jsonb_build_object('role','assistant scorer','external_id','test-scorer-bravo')
    ),
    true,
    now()
  on conflict (external_id)
  do update set
    home_team_id = excluded.home_team_id,
    away_team_id = excluded.away_team_id,
    status        = excluded.status,
    scheduled_at  = excluded.scheduled_at,
    hall          = excluded.hall,
    city          = excluded.city,
    league        = excluded.league,
    officials     = excluded.officials,
    test          = true,
    updated_at    = now()
  returning id
),
referee_seed as (
  insert into referees (external_id, seed_key, first_name, last_name, country, dob, test, updated_at)
  values
    ('test-referee-alpha','test-referee-alpha','Claudia','Moser','CH','1982-04-19',true,now()),
    ('test-referee-bravo','test-referee-bravo','Martin','Kunz','CH','1979-09-02',true,now())
  on conflict (seed_key)
  do update set
    external_id = excluded.external_id,
    first_name  = excluded.first_name,
    last_name   = excluded.last_name,
    country     = excluded.country,
    dob         = excluded.dob,
    test        = true,
    updated_at  = now()
  returning id
),
scorer_seed as (
  insert into scorers (external_id, seed_key, first_name, last_name, country, dob, test, updated_at)
  values
    ('test-scorer-alpha','test-scorer-alpha','Petra','Schneider','CH','1990-01-15',true,now()),
    ('test-scorer-bravo','test-scorer-bravo','Lukas','Baumann','CH','1988-06-27',true,now())
  on conflict (seed_key)
  do update set
    external_id = excluded.external_id,
    first_name  = excluded.first_name,
    last_name   = excluded.last_name,
    country     = excluded.country,
    dob         = excluded.dob,
    test        = true,
    updated_at  = now()
  returning id
),
home_players as (
  insert into players (
    external_id, team_id, number, name, first_name, last_name,
    dob, libero, is_captain, test, created_at, updated_at, functions
  ) values
    ('test-team-alpha-p01',(select id from home_team),  1,'Keller Luca',    'Luca',    'Keller',    '1998-01-05','',        false,true,now(),now(),array['player']),
    ('test-team-alpha-p02',(select id from home_team),  3,'Hofmann Jonas',  'Jonas',   'Hofmann',   '1997-03-12','',        false,true,now(),now(),array['player']),
    ('test-team-alpha-p03',(select id from home_team),  4,'Schmid Noah',    'Noah',    'Schmid',    '1996-07-23','',        false,true,now(),now(),array['player']),
    ('test-team-alpha-p04',(select id from home_team),  6,'Meier Simon',    'Simon',   'Meier',     '1995-09-18','',        true, true,now(),now(),array['player']),
    ('test-team-alpha-p05',(select id from home_team),  7,'Graf Felix',     'Felix',   'Graf',      '1999-11-30','',        false,true,now(),now(),array['player']),
    ('test-team-alpha-p06',(select id from home_team),  8,'Brunner David',  'David',   'Brunner',   '1998-01-14','',        false,true,now(),now(),array['player','physio']),
    ('test-team-alpha-p07',(select id from home_team),  9,'Fischer Anna',   'Anna',    'Fischer',   '1996-02-09','',        false,true,now(),now(),array['player']),
    ('test-team-alpha-p08',(select id from home_team), 11,'Wenger Sarah',   'Sarah',   'Wenger',    '1999-04-27','',        false,true,now(),now(),array['player']),
    ('test-team-alpha-p09',(select id from home_team), 13,'Bachmann Laura', 'Laura',   'Bachmann',  '1997-06-08','',        false,true,now(),now(),array['player']),
    ('test-team-alpha-p10',(select id from home_team), 15,'Baumann Emma',   'Emma',    'Baumann',   '2000-08-16','',        false,true,now(),now(),array['player']),
    ('test-team-alpha-p11',(select id from home_team), 18,'Arnold Sophie',  'Sophie',  'Arnold',    '1998-12-02','',        false,true,now(),now(),array['player']),
    ('test-team-alpha-p12',(select id from home_team), 12,'Huber Nina',     'Nina',    'Huber',     '1997-03-19','libero1', false,true,now(),now(),array['player']),
    ('test-team-alpha-p13',(select id from home_team), 17,'Roth Lea',       'Lea',     'Roth',      '1999-09-05','libero2', false,true,now(),now(),array['player'])
  on conflict (external_id)
  do update set
    team_id    = excluded.team_id,
    number     = excluded.number,
    name       = excluded.name,
    first_name = excluded.first_name,
    last_name  = excluded.last_name,
    dob        = excluded.dob,
    libero     = excluded.libero,
    is_captain = excluded.is_captain,
    test       = true,
    updated_at = now(),
    functions  = excluded.functions
  returning external_id
),
away_players as (
  insert into players (
    external_id, team_id, number, name, first_name, last_name,
    dob, libero, is_captain, test, created_at, updated_at, functions
  ) values
    ('test-team-bravo-p01',(select id from away_team),  2,'Weber Tom',     'Tom',     'Weber',     '1998-01-11','',        false,true,now(),now(),array['player']),
    ('test-team-bravo-p02',(select id from away_team),  5,'Schneider Max', 'Max',     'Schneider', '1996-03-24','',        false,true,now(),now(),array['player','coach']),
    ('test-team-bravo-p03',(select id from away_team),  7,'Vogt Daniel',   'Daniel',  'Vogt',      '1997-05-06','',        false,true,now(),now(),array['player']),
    ('test-team-bravo-p04',(select id from away_team),  9,'Imhof Michael', 'Michael', 'Imhof',     '1995-07-22','',        true, true,now(),now(),array['player']),
    ('test-team-bravo-p05',(select id from away_team), 11,'Ackermann Jonas','Jonas',  'Ackermann', '1999-09-18','',        false,true,now(),now(),array['player']),
    ('test-team-bravo-p06',(select id from away_team), 14,'Gerber Lisa',   'Lisa',    'Gerber',    '1998-12-03','libero1', false,true,now(),now(),array['player']),
    ('test-team-bravo-p07',(select id from away_team), 16,'Aebi Julia',    'Julia',   'Aebi',      '1997-02-15','',        false,true,now(),now(),array['player']),
    ('test-team-bravo-p08',(select id from away_team), 18,'Egli Maria',    'Maria',   'Egli',      '1996-04-28','',        false,true,now(),now(),array['player']),
    ('test-team-bravo-p09',(select id from away_team), 19,'Frey Sara',     'Sara',    'Frey',      '1999-06-09','',        false,true,now(),now(),array['player']),
    ('test-team-bravo-p10',(select id from away_team), 20,'Ryser Emma',    'Emma',    'Ryser',     '2000-08-17','',        false,true,now(),now(),array['player']),
    ('test-team-bravo-p11',(select id from away_team),  4,'Hauser Laura',  'Laura',   'Hauser',    '1997-10-05','',        false,true,now(),now(),array['player'])
  on conflict (external_id)
  do update set
    team_id    = excluded.team_id,
    number     = excluded.number,
    name       = excluded.name,
    first_name = excluded.first_name,
    last_name  = excluded.last_name,
    dob        = excluded.dob,
    libero     = excluded.libero,
    is_captain = excluded.is_captain,
    test       = true,
    updated_at = now(),
    functions  = excluded.functions
  returning external_id
)
select 'Test seed complete' as message;

commit;

