-- svrz_games + svrz_sync_log exactly as in the production schema (schema-only
-- pg_dump of public, 2026-10): tables, sequences, defaults, constraints,
-- indexes. Used by tests/vmSync.pg.test.js. No data.


CREATE TABLE public.svrz_games (
    id bigint NOT NULL,
    game_number text NOT NULL,
    date text,
    "time" text,
    datetime text,
    city text,
    hall text,
    match_type text,
    championship_type text,
    gender text,
    match_level text,
    league text,
    match_format integer,
    team_home text,
    team_away text,
    referee_1 text,
    referee_1_dob date,
    referee_2 text,
    referee_2_dob date,
    hall_address text,
    hall_postal_code text,
    group_display text,
    phase_name text,
    linesman_1 text,
    linesman_2 text,
    is_supervised boolean DEFAULT false,
    has_supervised_referee boolean DEFAULT false,
    convocations jsonb DEFAULT '[]'::jsonb,
    synced_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    referee_1_first_name text,
    referee_1_last_name text,
    referee_2_first_name text,
    referee_2_last_name text
);

CREATE SEQUENCE public.svrz_games_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.svrz_games_id_seq OWNED BY public.svrz_games.id;

ALTER TABLE ONLY public.svrz_games ALTER COLUMN id SET DEFAULT nextval('public.svrz_games_id_seq'::regclass);

CREATE TABLE public.svrz_sync_log (
    id bigint NOT NULL,
    started_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone,
    games_fetched integer,
    games_created integer,
    games_updated integer,
    games_unchanged integer,
    errors integer DEFAULT 0,
    status text DEFAULT 'running'::text,
    message text
);

CREATE SEQUENCE public.svrz_sync_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.svrz_sync_log_id_seq OWNED BY public.svrz_sync_log.id;

ALTER TABLE ONLY public.svrz_sync_log ALTER COLUMN id SET DEFAULT nextval('public.svrz_sync_log_id_seq'::regclass);

ALTER TABLE ONLY public.svrz_games
    ADD CONSTRAINT svrz_games_game_number_key UNIQUE (game_number);

ALTER TABLE ONLY public.svrz_games
    ADD CONSTRAINT svrz_games_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.svrz_sync_log
    ADD CONSTRAINT svrz_sync_log_pkey PRIMARY KEY (id);

CREATE INDEX idx_svrz_city ON public.svrz_games USING btree (city);

CREATE INDEX idx_svrz_date ON public.svrz_games USING btree (date);

CREATE INDEX idx_svrz_datetime ON public.svrz_games USING btree (datetime);

CREATE INDEX idx_svrz_gender ON public.svrz_games USING btree (gender);

CREATE INDEX idx_svrz_hall ON public.svrz_games USING btree (hall);

CREATE INDEX idx_svrz_league ON public.svrz_games USING btree (league);

CREATE INDEX idx_svrz_match_type ON public.svrz_games USING btree (match_type, gender, match_level);

CREATE INDEX idx_svrz_referee1 ON public.svrz_games USING btree (referee_1);

CREATE INDEX idx_svrz_team_away ON public.svrz_games USING btree (team_away);

CREATE INDEX idx_svrz_team_home ON public.svrz_games USING btree (team_home);
