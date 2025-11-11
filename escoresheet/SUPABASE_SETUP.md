# Supabase Setup Guide

This application uses Supabase for cloud data synchronization. Follow these steps to set up Supabase:

## 1. Create a Supabase Project

1. Go to [https://app.supabase.com](https://app.supabase.com)
2. Sign up or log in
3. Click "New Project"
4. Fill in your project details:
   - **Name**: eScoresheet (or any name you prefer)
   - **Database Password**: Choose a strong password (save it!)
   - **Region**: Choose the closest region to you
5. Click "Create new project" and wait for it to be ready (2-3 minutes)

## 2. Get Your API Keys

1. In your Supabase project dashboard, go to **Settings** → **API**
2. Copy the following values:
   - **Project URL** (under "Project URL")
   - **anon/public key** (under "Project API keys")

## 3. Set Up Environment Variables

1. Copy `.env.example` to `.env` in the `frontend` directory:
   ```bash
   cd escoresheet/frontend
   cp .env.example .env
   ```

2. Edit `.env` and add your Supabase credentials:
   ```
   VITE_SUPABASE_URL=https://your-project-id.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key-here
   ```

## 4. Create Database Tables

Run the following SQL in your Supabase SQL Editor (Settings → SQL Editor):

```sql
-- Create matches table
CREATE TABLE IF NOT EXISTS matches (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT UNIQUE,
  home_team_id BIGINT,
  away_team_id BIGINT,
  scheduled_at TIMESTAMPTZ,
  status TEXT,
  hall TEXT,
  city TEXT,
  league TEXT,
  test BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create teams table
CREATE TABLE IF NOT EXISTS teams (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT UNIQUE,
  name TEXT NOT NULL,
  color TEXT,
  test BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create players table
CREATE TABLE IF NOT EXISTS players (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT UNIQUE,
  team_id BIGINT REFERENCES teams(id),
  number INTEGER,
  name TEXT,
  first_name TEXT,
  last_name TEXT,
  dob TEXT,
  libero TEXT,
  is_captain BOOLEAN DEFAULT FALSE,
  role TEXT,
  test BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create sets table
CREATE TABLE IF NOT EXISTS sets (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT UNIQUE,
  match_id BIGINT REFERENCES matches(id),
  index INTEGER,
  home_points INTEGER DEFAULT 0,
  away_points INTEGER DEFAULT 0,
  finished BOOLEAN DEFAULT FALSE,
  test BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create events table
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT UNIQUE,
  match_id BIGINT REFERENCES matches(id),
  set_index INTEGER,
  type TEXT NOT NULL,
  payload JSONB,
  test BOOLEAN DEFAULT FALSE,
  ts TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_events_match_id ON events(match_id);
CREATE INDEX IF NOT EXISTS idx_events_set_index ON events(set_index);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_players_team_id ON players(team_id);

-- Add test column to existing tables (if tables already exist)
-- Run these ALTER TABLE statements if you've already created the tables:
ALTER TABLE matches ADD COLUMN IF NOT EXISTS test BOOLEAN DEFAULT FALSE;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS test BOOLEAN DEFAULT FALSE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS test BOOLEAN DEFAULT FALSE;
ALTER TABLE sets ADD COLUMN IF NOT EXISTS test BOOLEAN DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS test BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_sets_match_id ON sets(match_id);
```

## 5. Set Up Row Level Security (RLS)

For now, we'll allow public read/write access. In production, you should set up proper RLS policies:

```sql
-- Enable RLS on all tables
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Allow all operations for now (adjust for production)
CREATE POLICY "Allow all operations" ON matches FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON teams FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON players FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON sets FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON events FOR ALL USING (true);
```

## 6. Test the Connection

1. Start the development server:
   ```bash
   npm run dev
   ```

2. The app will work in offline mode if Supabase is not configured
3. Once configured, data will sync to Supabase when online

## How It Works

- **Offline-First**: The app uses IndexedDB (via Dexie) for local storage
- **Sync Queue**: When events occur, they're queued locally
- **Auto-Sync**: When online, the sync queue automatically sends data to Supabase
- **Real-time**: You can enable Supabase Realtime subscriptions for live updates across devices

## Next Steps

- Set up proper authentication if needed
- Configure RLS policies for production
- Set up database backups
- Enable Supabase Realtime for multi-device sync

