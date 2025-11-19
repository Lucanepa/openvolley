-- ============================================================================
-- Dexie (IndexedDB) Schema Export
-- Database: escoresheet
-- Current Version: 8
-- Generated: 2025-11-19
-- ============================================================================
-- Note: This is a SQL-like representation of the Dexie/IndexedDB schema
-- for documentation purposes. IndexedDB uses a different storage model.
-- ============================================================================

-- -----------------------------------------------------------------------------
-- TABLE: teams
-- Description: Stores volleyball team information
-- -----------------------------------------------------------------------------
CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT,
  externalId TEXT,
  test BOOLEAN DEFAULT false,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP
);

CREATE INDEX idx_teams_name ON teams(name);
CREATE INDEX idx_teams_createdAt ON teams(createdAt);

-- -----------------------------------------------------------------------------
-- TABLE: players
-- Description: Stores player information linked to teams
-- -----------------------------------------------------------------------------
CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teamId INTEGER NOT NULL,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  firstName TEXT,
  lastName TEXT,
  role TEXT,
  dob TEXT,
  libero TEXT,
  isCaptain BOOLEAN DEFAULT false,
  externalId TEXT,
  test BOOLEAN DEFAULT false,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP,
  FOREIGN KEY (teamId) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX idx_players_teamId ON players(teamId);
CREATE INDEX idx_players_number ON players(number);
CREATE INDEX idx_players_name ON players(name);
CREATE INDEX idx_players_role ON players(role);
CREATE INDEX idx_players_createdAt ON players(createdAt);

-- -----------------------------------------------------------------------------
-- TABLE: referees
-- Description: Stores referee information
-- -----------------------------------------------------------------------------
CREATE TABLE referees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seedKey TEXT UNIQUE,
  firstName TEXT NOT NULL,
  lastName TEXT NOT NULL,
  country TEXT,
  dob DATE,
  externalId TEXT,
  test BOOLEAN DEFAULT false,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP
);

CREATE INDEX idx_referees_seedKey ON referees(seedKey);
CREATE INDEX idx_referees_lastName ON referees(lastName);
CREATE INDEX idx_referees_createdAt ON referees(createdAt);

-- -----------------------------------------------------------------------------
-- TABLE: scorers
-- Description: Stores scorer/assistant referee information
-- -----------------------------------------------------------------------------
CREATE TABLE scorers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seedKey TEXT UNIQUE,
  firstName TEXT NOT NULL,
  lastName TEXT NOT NULL,
  country TEXT,
  dob DATE,
  externalId TEXT,
  test BOOLEAN DEFAULT false,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP
);

CREATE INDEX idx_scorers_seedKey ON scorers(seedKey);
CREATE INDEX idx_scorers_lastName ON scorers(lastName);
CREATE INDEX idx_scorers_createdAt ON scorers(createdAt);

-- -----------------------------------------------------------------------------
-- TABLE: matches
-- Description: Stores volleyball match information
-- -----------------------------------------------------------------------------
CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeTeamId INTEGER,
  awayTeamId INTEGER,
  scheduledAt TIMESTAMP,
  status TEXT DEFAULT 'scheduled',
  externalId TEXT,
  hall TEXT,
  city TEXT,
  league TEXT,
  benchHome JSON,
  benchAway JSON,
  officials JSON,
  homeCoachSignature TEXT,
  homeCaptainSignature TEXT,
  awayCoachSignature TEXT,
  awayCaptainSignature TEXT,
  test BOOLEAN DEFAULT false,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP,
  FOREIGN KEY (homeTeamId) REFERENCES teams(id),
  FOREIGN KEY (awayTeamId) REFERENCES teams(id)
);

CREATE INDEX idx_matches_homeTeamId ON matches(homeTeamId);
CREATE INDEX idx_matches_awayTeamId ON matches(awayTeamId);
CREATE INDEX idx_matches_scheduledAt ON matches(scheduledAt);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_createdAt ON matches(createdAt);
CREATE INDEX idx_matches_externalId ON matches(externalId);
CREATE INDEX idx_matches_test ON matches(test);

-- -----------------------------------------------------------------------------
-- TABLE: sets
-- Description: Stores individual set data for matches
-- -----------------------------------------------------------------------------
CREATE TABLE sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  matchId INTEGER NOT NULL,
  index INTEGER NOT NULL,
  homePoints INTEGER DEFAULT 0,
  awayPoints INTEGER DEFAULT 0,
  finished BOOLEAN DEFAULT false,
  startTime TIMESTAMP,
  endTime TIMESTAMP,
  externalId TEXT,
  test BOOLEAN DEFAULT false,
  updatedAt TIMESTAMP,
  FOREIGN KEY (matchId) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX idx_sets_matchId ON sets(matchId);
CREATE INDEX idx_sets_index ON sets(index);
CREATE INDEX idx_sets_homePoints ON sets(homePoints);
CREATE INDEX idx_sets_awayPoints ON sets(awayPoints);
CREATE INDEX idx_sets_finished ON sets(finished);
CREATE INDEX idx_sets_startTime ON sets(startTime);
CREATE INDEX idx_sets_endTime ON sets(endTime);

-- -----------------------------------------------------------------------------
-- TABLE: events
-- Description: Stores all match events (points, substitutions, timeouts, etc.)
-- -----------------------------------------------------------------------------
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  matchId INTEGER NOT NULL,
  setIndex INTEGER NOT NULL,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  type TEXT NOT NULL,
  payload JSON NOT NULL,
  seq INTEGER,
  test BOOLEAN DEFAULT false,
  FOREIGN KEY (matchId) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX idx_events_matchId ON events(matchId);
CREATE INDEX idx_events_setIndex ON events(setIndex);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_seq ON events(seq);

-- Event Types:
-- - point
-- - substitution
-- - timeout
-- - sanction (yellow/red cards)
-- - lineup
-- - set_start
-- - set_end
-- - match_start
-- - match_end

-- -----------------------------------------------------------------------------
-- TABLE: sync_queue
-- Description: Stores pending sync operations to Supabase
-- -----------------------------------------------------------------------------
CREATE TABLE sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSON NOT NULL,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'queued'
);

CREATE INDEX idx_sync_queue_resource ON sync_queue(resource);
CREATE INDEX idx_sync_queue_action ON sync_queue(action);
CREATE INDEX idx_sync_queue_ts ON sync_queue(ts);
CREATE INDEX idx_sync_queue_status ON sync_queue(status);

-- Status Values:
-- - queued: Pending sync
-- - sent: Successfully synced
-- - error: Sync failed

-- -----------------------------------------------------------------------------
-- TABLE: match_setup
-- Description: Stores draft match setup data (single record)
-- -----------------------------------------------------------------------------
CREATE TABLE match_setup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeTeam JSON,
  awayTeam JSON,
  homeLineup JSON,
  awayLineup JSON,
  matchInfo JSON,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_match_setup_updatedAt ON match_setup(updatedAt);

-- ============================================================================
-- SCHEMA VERSION HISTORY
-- ============================================================================

-- Version 1: Initial schema
--   - teams, players, matches, sets, events, sync_queue

-- Version 2: Added signature fields
--   - Added homeCoachSignature, homeCaptainSignature
--   - Added awayCoachSignature, awayCaptainSignature to matches

-- Version 3: Added match_setup table
--   - For storing draft match configuration data

-- Version 4: Added externalId index
--   - Added externalId index to matches table

-- Version 5: Added referees and scorers tables
--   - New tables for officials management

-- Version 6: Added timing fields to sets
--   - Added startTime and endTime to sets table

-- Version 7: Added test flag index
--   - Added test index to matches for filtering test data

-- Version 8: Added sequence field to events
--   - Added seq field to events for reliable event ordering

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================

