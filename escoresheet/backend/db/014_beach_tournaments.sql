-- 014_beach_tournaments.sql: OpenBeach tournaments (draws, entries, the
-- double-elimination bracket, the schedule) on the server
-- (~/ov-ops/openbeach-separation-tournaments-PLAN.md, section 3.1, phase T1;
-- docs/beach-tournaments-spec.md).
--
-- None of these tables is on the /api/db allowlist (server.js ALLOWED_TABLES):
-- they are served only by /api/beach/* (lib/beachTournaments.js), which checks
-- the beach roles, and by the public projection /api/public/beach/t/:slug
-- (names and countries only, never licence numbers; decision D9).
--
--   beach_tournaments           an event at one venue (several draws share its courts)
--   beach_tournament_managers   co-managers (the creator, they and the global admin edit)
--   beach_courts                court 1..n
--   beach_draws                 one category + gender (one Swiss Volley "tournament")
--   beach_entries               a pair in a draw (seed, player snapshot, final rank)
--   beach_pools / _members      pool formats (later phases; empty in T1)
--   beach_tmatches              every match of a draw, also the ones still empty;
--                               source1/source2 ('seed:4', 'winner:W1', 'loser:W3')
--                               drive the bracket
--   matches.tournament_match_id the scored match of a tournament match (unique;
--                               server-only: never written through /api/db)
--
-- Times are timestamptz, entered and shown in Europe/Zurich.
-- Run as ov_owner after 013, then roles.sql. Idempotent. One transaction.
-- Safe under the running backend: new tables, and one nullable column on
-- matches with no default (no table rewrite).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.beach_tournaments (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 80),
  title       text        NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  venue       text        CHECK (venue IS NULL OR length(venue) <= 160),
  city        text        CHECK (city IS NULL OR length(city) <= 120),
  plus_code   text        CHECK (plus_code IS NULL OR length(plus_code) <= 40),
  starts_on   date        NOT NULL,
  ends_on     date        NOT NULL,
  day_start   time        NOT NULL DEFAULT '09:00',
  day_end     time        NOT NULL DEFAULT '19:00',
  status      text        NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'published', 'live', 'finished', 'archived')),
  public      boolean     NOT NULL DEFAULT false,
  source      text        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'xlsx', 'swissvolley')),
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on AND ends_on <= starts_on + 14),
  CHECK (day_end > day_start)
);
CREATE INDEX IF NOT EXISTS beach_tournaments_starts_idx ON public.beach_tournaments (starts_on DESC);
CREATE INDEX IF NOT EXISTS beach_tournaments_created_by_idx ON public.beach_tournaments (created_by);

CREATE TABLE IF NOT EXISTS public.beach_tournament_managers (
  tournament_id uuid        NOT NULL REFERENCES public.beach_tournaments(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);
CREATE INDEX IF NOT EXISTS beach_tournament_managers_user_idx ON public.beach_tournament_managers (user_id);

CREATE TABLE IF NOT EXISTS public.beach_courts (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid    NOT NULL REFERENCES public.beach_tournaments(id) ON DELETE CASCADE,
  number        integer NOT NULL CHECK (number BETWEEN 1 AND 99),
  name          text    CHECK (name IS NULL OR length(name) <= 60),
  active        boolean NOT NULL DEFAULT true,
  flex          boolean NOT NULL DEFAULT false,
  UNIQUE (tournament_id, number)
);

CREATE TABLE IF NOT EXISTS public.beach_draws (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id     uuid        NOT NULL REFERENCES public.beach_tournaments(id) ON DELETE CASCADE,
  sv_tournament_id  text        UNIQUE CHECK (sv_tournament_id IS NULL OR length(sv_tournament_id) <= 40),
  gender            text        NOT NULL CHECK (gender IN ('men', 'women', 'mixed')),
  category          text        NOT NULL CHECK (length(category) BETWEEN 1 AND 20),
  format            text        NOT NULL DEFAULT 'DE' CHECK (format IN ('DE', 'POOLS_SE', 'POOLS_DE', 'MPP', 'RR')),
  board_size        integer     CHECK (board_size IS NULL OR board_size IN (8, 16, 32)),
  scoring           jsonb       NOT NULL DEFAULT '{"best_of": 3, "points": [21, 21, 15]}'::jsonb,
  slot_minutes      integer     NOT NULL DEFAULT 50 CHECK (slot_minutes BETWEEN 10 AND 240),
  rest_minutes      integer     NOT NULL DEFAULT 0 CHECK (rest_minutes BETWEEN 0 AND 240),
  registration_end  timestamptz,
  coaching_allowed  boolean     NOT NULL DEFAULT false,
  status            text        NOT NULL DEFAULT 'entries'
                                CHECK (status IN ('entries', 'seeded', 'drawn', 'playing', 'done')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beach_draws_tournament_idx ON public.beach_draws (tournament_id);

CREATE TABLE IF NOT EXISTS public.beach_entries (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id     uuid        NOT NULL REFERENCES public.beach_draws(id) ON DELETE CASCADE,
  seed        integer     CHECK (seed IS NULL OR seed BETWEEN 1 AND 128),
  team_id     uuid        REFERENCES public.competition_teams(id) ON DELETE SET NULL,
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- {first, last, licence, country}: frozen when the draw is made
  player1     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  player2     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sv_team_id  text        CHECK (sv_team_id IS NULL OR length(sv_team_id) <= 40),
  wildcard    boolean     NOT NULL DEFAULT false,
  late        boolean     NOT NULL DEFAULT false,
  status      text        NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'withdrawn', 'replaced', 'dq')),
  final_rank  integer     CHECK (final_rank IS NULL OR final_rank BETWEEN 1 AND 128),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- swapping two seeds in one statement or transaction
  CONSTRAINT beach_entries_draw_seed_key UNIQUE (draw_id, seed) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS beach_entries_draw_idx ON public.beach_entries (draw_id);
CREATE INDEX IF NOT EXISTS beach_entries_team_idx ON public.beach_entries (team_id);

CREATE TABLE IF NOT EXISTS public.beach_pools (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id  uuid NOT NULL REFERENCES public.beach_draws(id) ON DELETE CASCADE,
  label    text NOT NULL CHECK (length(label) BETWEEN 1 AND 8),
  UNIQUE (draw_id, label)
);
CREATE TABLE IF NOT EXISTS public.beach_pool_members (
  pool_id   uuid    NOT NULL REFERENCES public.beach_pools(id) ON DELETE CASCADE,
  entry_id  uuid    NOT NULL REFERENCES public.beach_entries(id) ON DELETE CASCADE,
  position  integer NOT NULL CHECK (position BETWEEN 1 AND 16),
  PRIMARY KEY (pool_id, entry_id),
  UNIQUE (pool_id, position)
);

CREATE TABLE IF NOT EXISTS public.beach_tmatches (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id   uuid        NOT NULL REFERENCES public.beach_tournaments(id) ON DELETE CASCADE,
  draw_id         uuid        NOT NULL REFERENCES public.beach_draws(id) ON DELETE CASCADE,
  game_n          integer     NOT NULL CHECK (game_n BETWEEN 1 AND 9999),
  code            text        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9-]{0,15}$'),
  phase           text        NOT NULL CHECK (phase IN ('pool', 'winners', 'losers', 'placement', 'final')),
  round           integer     NOT NULL CHECK (round BETWEEN 1 AND 20),
  position        integer     NOT NULL CHECK (position BETWEEN 1 AND 64),
  wave            integer     NOT NULL CHECK (wave BETWEEN 1 AND 40),
  source1         text        NOT NULL CHECK (source1 ~ '^(seed:[0-9]{1,3}|winner:[A-Z][A-Z0-9-]{0,15}|loser:[A-Z][A-Z0-9-]{0,15}|pool:[A-Z0-9]{1,8}:[0-9]{1,2})$'),
  source2         text        NOT NULL CHECK (source2 ~ '^(seed:[0-9]{1,3}|winner:[A-Z][A-Z0-9-]{0,15}|loser:[A-Z][A-Z0-9-]{0,15}|pool:[A-Z0-9]{1,8}:[0-9]{1,2})$'),
  entry1_id       uuid        REFERENCES public.beach_entries(id) ON DELETE SET NULL,
  entry2_id       uuid        REFERENCES public.beach_entries(id) ON DELETE SET NULL,
  -- the final rank of this match's winner / loser when it ends there (NULL: plays on)
  winner_rank     integer     CHECK (winner_rank IS NULL OR winner_rank BETWEEN 1 AND 128),
  loser_rank      integer     CHECK (loser_rank IS NULL OR loser_rank BETWEEN 1 AND 128),
  court_id        uuid        REFERENCES public.beach_courts(id) ON DELETE SET NULL,
  scheduled_at    timestamptz,
  duration_min    integer     CHECK (duration_min IS NULL OR duration_min BETWEEN 10 AND 240),
  status          text        NOT NULL DEFAULT 'scheduled'
                              CHECK (status IN ('scheduled', 'ready', 'called', 'in_progress', 'finished', 'walkover', 'cancelled')),
  match_id        uuid        UNIQUE REFERENCES public.matches(id) ON DELETE SET NULL,
  claimed_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_at      timestamptz,
  winner_entry_id uuid        REFERENCES public.beach_entries(id) ON DELETE SET NULL,
  result          text        CHECK (result IS NULL OR result IN ('played', 'retired', 'forfeit', 'walkover')),
  sets            jsonb,      -- [[21, 17], [19, 21], [15, 12]]: points of entry 1 and entry 2 per set
  referee         text        CHECK (referee IS NULL OR length(referee) <= 120),
  scorer          text        CHECK (scorer IS NULL OR length(scorer) <= 120),
  source_ref      text        CHECK (source_ref IS NULL OR length(source_ref) <= 120),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, game_n),
  UNIQUE (draw_id, code)
);
CREATE INDEX IF NOT EXISTS beach_tmatches_draw_idx ON public.beach_tmatches (draw_id, game_n);
CREATE INDEX IF NOT EXISTS beach_tmatches_court_idx ON public.beach_tmatches (court_id, scheduled_at);

-- updated_at follows every UPDATE (006's function)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['beach_tournaments', 'beach_draws', 'beach_entries', 'beach_tmatches'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.ov_touch_updated_at()',
                   t || '_touch_updated_at', t);
  END LOOP;
END $$;

-- The scored match of a tournament match. Server-only (server.js
-- WRITE_DENYLIST, lib/matchRestore.js serverOnlyColumns): phase T3 links it
-- for the account that claimed the tournament match. Beach matches only.
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS tournament_match_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'matches_tournament_match_id_fkey' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_tournament_match_id_fkey FOREIGN KEY (tournament_match_id)
      REFERENCES public.beach_tmatches(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'matches_tournament_match_beach_check' AND conrelid = 'public.matches'::regclass) THEN
    -- every existing row is NULL: NOT VALID skips the scan, new rows are checked
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_tournament_match_beach_check
      CHECK (tournament_match_id IS NULL OR sport_type IS NOT DISTINCT FROM 'beach') NOT VALID;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS matches_tournament_match_uidx ON public.matches (tournament_match_id)
  WHERE tournament_match_id IS NOT NULL;

-- Grants: roles.sql (run next) gives ov_app DML on every public table; this
-- covers running 014 after roles.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.beach_tournaments, public.beach_tournament_managers,
      public.beach_courts, public.beach_draws, public.beach_entries, public.beach_pools,
      public.beach_pool_members, public.beach_tmatches TO ov_app;
  END IF;
END $$;

COMMIT;
