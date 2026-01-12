-- Migration: Add user authentication tables
-- Run this in Supabase SQL Editor

-- profiles table (linked to auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  country TEXT DEFAULT 'CHE',
  dob DATE,
  roles TEXT[] DEFAULT ARRAY['scorer'],  -- 'scorer', 'referee', 'admin', 'super_admin'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure matches.external_id has a unique constraint (required for foreign key reference)
-- Skip if constraint already exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matches_external_id_unique'
  ) THEN
    ALTER TABLE matches ADD CONSTRAINT matches_external_id_unique UNIQUE (external_id);
  END IF;
END $$;

-- user_matches junction table (links users to matches they've scored/officiated)
-- References matches.external_id (the seedKey) since match creation happens before Supabase sync
CREATE TABLE IF NOT EXISTS user_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  match_external_id TEXT REFERENCES matches(external_id) ON DELETE CASCADE NOT NULL,
  role TEXT NOT NULL,  -- 'scorer', '1st referee', '2nd referee', 'assistant scorer'
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, match_external_id, role)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_matches_user_id ON user_matches(user_id);
CREATE INDEX IF NOT EXISTS idx_user_matches_match_id ON user_matches(match_external_id);

-- Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_matches ENABLE ROW LEVEL SECURITY;

-- RLS Policies for profiles
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- RLS Policies for user_matches
DROP POLICY IF EXISTS "Users can view own matches" ON user_matches;
CREATE POLICY "Users can view own matches" ON user_matches
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own matches" ON user_matches;
CREATE POLICY "Users can insert own matches" ON user_matches
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own matches" ON user_matches;
CREATE POLICY "Users can delete own matches" ON user_matches
  FOR DELETE USING (auth.uid() = user_id);

-- Trigger to auto-create profile on user signup (reads from user metadata)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (
    user_id,
    first_name,
    last_name,
    country,
    dob,
    roles
  )
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'first_name',
    NEW.raw_user_meta_data->>'last_name',
    COALESCE(NEW.raw_user_meta_data->>'country', 'CHE'),
    (NEW.raw_user_meta_data->>'dob')::DATE,
    COALESCE(
      (SELECT array_agg(value::TEXT) FROM jsonb_array_elements_text(NEW.raw_user_meta_data->'roles')),
      ARRAY['scorer']
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing trigger if exists, then create
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for profiles updated_at
DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Function to allow users to delete their own account
-- Called via: supabase.rpc('delete_user')
CREATE OR REPLACE FUNCTION public.delete_user()
RETURNS void AS $$
DECLARE
  current_user_id UUID;
BEGIN
  -- Get the current user's ID
  current_user_id := auth.uid();

  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Delete the user from auth.users
  -- This will cascade delete from profiles and user_matches due to ON DELETE CASCADE
  DELETE FROM auth.users WHERE id = current_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
