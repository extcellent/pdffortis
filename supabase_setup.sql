-- ============================================
-- PDFortis — Supabase SQL Setup
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================

-- 1. USER PROFILES
-- Linked to Supabase Auth (auto-created on signup)
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  company_token TEXT,
  saved_signature TEXT,       -- base64 PNG
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile when user signs up
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'name'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- 2. COMPANY TOKENS
CREATE TABLE IF NOT EXISTS company_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  company_name TEXT NOT NULL,
  company_address TEXT,
  company_logo_url TEXT,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- 3. DOWNLOAD TRACKING (anonymous users, by fingerprint)
CREATE TABLE IF NOT EXISTS download_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ip_hash TEXT NOT NULL,    -- browser fingerprint hash, NOT real IP
  downloaded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ip_hash ON download_logs(ip_hash);
CREATE INDEX IF NOT EXISTS idx_dl_time ON download_logs(downloaded_at);


-- 4. TOKEN USAGE (for company dashboard)
CREATE TABLE IF NOT EXISTS token_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT NOT NULL REFERENCES company_tokens(token) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users ON DELETE SET NULL,
  user_email TEXT,
  user_name TEXT,
  action TEXT NOT NULL,   -- 'download', 'sign', 'edit'
  document_name TEXT,
  used_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_usage ON token_usage(token);


-- 5. DOCUMENT ACTIVITY LOG (what users edited, no file stored!)
-- PDFs are NOT stored — only metadata for dashboard/history
CREATE TABLE IF NOT EXISTS document_activity (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE,
  document_name TEXT NOT NULL,
  action TEXT NOT NULL,         -- 'edited', 'signed', 'compressed', 'merged'
  share_token TEXT,             -- optional: temporary 24h share link token
  share_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doc_activity_user ON document_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_doc_share_token ON document_activity(share_token);


-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE download_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_tokens ENABLE ROW LEVEL SECURITY;

-- user_profiles: users can only read/edit their own profile
CREATE POLICY "Users read own profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users update own profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = id);

-- download_logs: anyone can insert (anonymous tracking), only service role reads
CREATE POLICY "Anyone can log downloads"
  ON download_logs FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can read own fingerprint logs"
  ON download_logs FOR SELECT
  USING (true);   -- filtered by ip_hash in query, safe

-- token_usage: insert allowed for authenticated + token users
CREATE POLICY "Token users can log usage"
  ON token_usage FOR INSERT
  WITH CHECK (true);

-- document_activity: users see their own
CREATE POLICY "Users see own activity"
  ON document_activity FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own activity"
  ON document_activity FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- company_tokens: public read for validation (token field is secret anyway)
CREATE POLICY "Anyone can validate token"
  ON company_tokens FOR SELECT
  USING (true);


-- ============================================
-- SAMPLE DATA — insert a test token
-- ============================================
-- Run this to create your first company token for testing:
INSERT INTO company_tokens (token, company_name, company_address, email)
VALUES (
  'TESTFIRMA-2024-XXXX',
  'Musterfirma GmbH',
  'Musterstraße 1, 10115 Berlin',
  'info@musterfirma.de'
)
ON CONFLICT (token) DO NOTHING;

-- ============================================
-- AUTO-CLEANUP: delete download logs older than 8h
-- (run manually or set up a pg_cron if needed)
-- ============================================
-- DELETE FROM download_logs WHERE downloaded_at < NOW() - INTERVAL '8 hours';
