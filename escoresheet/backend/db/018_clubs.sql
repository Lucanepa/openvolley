-- 018_clubs.sql: scorers score the home games of their own club (indoor).
--
-- Owner decisions 2026-10-13 (docs/scorer-accounts-spec.md section 9):
--   a. a scorer scores only the HOME games of their club(s);
--   b. an account may belong to several clubs;
--   c. a scorer without a club scores no official game until an admin adds one;
--   d. indoor only (beach matches are not checked).
--
-- A club is a name and the VolleyManager team names that play for it
-- (svrz_games.team_home / team_away, e.g. "KSC Wiedikon H1"); a team name
-- belongs to one club at most. account_clubs says which clubs an account
-- scores for. An invite code may carry a club: whoever redeems it joins it.
--
-- The rule is checked by the database (ov_matches_club_guard) whenever a
-- signed-in account's write makes a match an official indoor game it was not
-- before: an insert (not the INSERT half of an upsert of a stored match), or
-- an update that changes game_n or turns a test / beach row into an official
-- indoor one. The home team is VolleyManager's (svrz_games), never the
-- client's. Admins, trusted server code (no ov.user_id) and test, beach,
-- numberless and exempted matches are not checked; matches already stored
-- are left alone. SQLSTATEs (lib/pgQuery.js errorMap):
--   OVL01  the account has no club              -> 403 OV_CLUB_REQUIRED
--   OVL02  the home team is not of its clubs    -> 403 OV_NOT_YOUR_CLUB
--   OVL03  VolleyManager does not know the game -> 403 OV_GAME_NOT_IN_SCHEDULE
--
-- The rule is off until an admin turns it on (public.club_rule, the manager's
-- Clubs tab): with it on, every scorer without a club is blocked at once, so
-- the clubs and their scorers are set up first.
--
-- roles.sql: no change (ov_app's table grants cover new tables); run
-- apply-roles.sh after this file as with every migration all the same.
-- None of these tables is on the /api/db allowlist (server.js ALLOWED_TABLES):
-- only the admin endpoints (lib/clubs.js) read and write them.
--
-- Idempotent. Deploy: 018, apply-roles.sh, the backend image, the clients.
-- Old clients keep working while the rule is off; with it on they get the 403s.
BEGIN;

CREATE TABLE IF NOT EXISTS public.clubs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS clubs_name_uidx ON public.clubs (lower(btrim(name)));

-- The club's VolleyManager team names, as svrz_games spells them
CREATE TABLE IF NOT EXISTS public.club_teams (
  club_id     uuid        NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  team_name   text        NOT NULL CHECK (length(btrim(team_name)) BETWEEN 1 AND 200),
  PRIMARY KEY (club_id, team_name)
);
-- A team plays for one club
CREATE UNIQUE INDEX IF NOT EXISTS club_teams_name_uidx ON public.club_teams (lower(btrim(team_name)));

CREATE TABLE IF NOT EXISTS public.account_clubs (
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  club_id     uuid        NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  granted_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, club_id)
);
CREATE INDEX IF NOT EXISTS account_clubs_club_idx ON public.account_clubs (club_id);

-- An invite code's club (the free-text `club` stays as its label)
ALTER TABLE public.invite_codes ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL;

-- One row: is the rule on?
CREATE TABLE IF NOT EXISTS public.club_rule (
  id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
  enabled     boolean     NOT NULL DEFAULT false,
  changed_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at  timestamptz
);
INSERT INTO public.club_rule (id, enabled) VALUES (true, false) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS clubs_touch_updated_at ON public.clubs;
CREATE TRIGGER clubs_touch_updated_at BEFORE UPDATE ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.ov_touch_updated_at();

-- ov.user_id: the acting account (pgQuery / matchRestore set it in the write's
-- transaction, as for db/007's guard)
CREATE OR REPLACE FUNCTION public.ov_matches_club_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor uuid;
  home text;
BEGIN
  IF NOT coalesce((SELECT r.enabled FROM public.club_rule r WHERE r.id), false) THEN
    RETURN NEW;
  END IF;
  actor := nullif(current_setting('ov.user_id', true), '')::uuid;
  IF actor IS NULL THEN
    RETURN NEW; -- trusted server code
  END IF;
  -- an official indoor game only
  IF NEW.test IS TRUE OR NEW.sport_type IS NOT DISTINCT FROM 'beach'
     OR NEW.game_n IS NULL OR NEW.game_n <= 0 OR NEW.official_game_exempt IS TRUE THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- the INSERT half of an upsert of a stored match: its UPDATE decides
    IF EXISTS (SELECT 1 FROM public.matches m WHERE m.external_id = NEW.external_id) THEN
      RETURN NEW;
    END IF;
  ELSIF OLD.test IS NOT TRUE AND OLD.sport_type IS DISTINCT FROM 'beach'
        AND OLD.game_n IS NOT DISTINCT FROM NEW.game_n THEN
    RETURN NEW; -- already this official game
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p
              WHERE p.user_id = actor AND p.roles && ARRAY['admin', 'super_admin']::text[]) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_clubs ac WHERE ac.user_id = actor) THEN
    RAISE EXCEPTION 'the account has no club' USING ERRCODE = 'OVL01';
  END IF;
  IF to_regclass('public.svrz_games') IS NOT NULL THEN
    EXECUTE 'SELECT g.team_home FROM public.svrz_games g WHERE g.game_number = $1 AND g.team_home IS NOT NULL ORDER BY g.id DESC LIMIT 1'
      INTO home USING NEW.game_n::text;
  END IF;
  IF home IS NULL THEN
    RAISE EXCEPTION 'the game is not in the VolleyManager schedule' USING ERRCODE = 'OVL03';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_clubs ac
                   JOIN public.club_teams ct ON ct.club_id = ac.club_id
                  WHERE ac.user_id = actor AND lower(btrim(ct.team_name)) = lower(btrim(home))) THEN
    RAISE EXCEPTION 'not a home game of the account''s clubs' USING ERRCODE = 'OVL02';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS matches_club_guard ON public.matches;
CREATE TRIGGER matches_club_guard
  BEFORE INSERT OR UPDATE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.ov_matches_club_guard();

COMMENT ON TABLE public.clubs IS 'Clubs whose scorers score their home games (db/018).';
COMMENT ON TABLE public.club_teams IS 'A club''s VolleyManager team names (svrz_games.team_home), one club per team (db/018).';
COMMENT ON TABLE public.account_clubs IS 'The clubs an account scores for (db/018).';
COMMENT ON TABLE public.club_rule IS 'One row: is the home-games-of-your-club rule on (db/018)?';

COMMIT;
