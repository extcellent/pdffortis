// ============================================
// supabase.js — PDFortis
// ============================================
// STEP 1: Go to supabase.com → your project → Settings → API
// STEP 2: Copy "Project URL" and "anon public" key below
// STEP 3: Save and deploy
// ============================================

const SUPABASE_URL = 'https://zzcjyfhhaithlhkcxzra.supabase.co';  // ← hier eintragen
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp6Y2p5ZmhoYWl0aGxoa2N4enJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNDE1NTYsImV4cCI6MjA5NjgxNzU1Nn0.3lQ-9vyOtx13iAZHIwrW6P_gN2bpDOOMnJ1jkU_yilA';       // ← hier eintragen

// ── Shared headers ──────────────────────────────────────────
const SB_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Prefer': 'return=representation'
};

// ── Auth headers (after login) ───────────────────────────────
function authHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${accessToken}`,
    'Prefer': 'return=representation'
  };
}

// ============================================
// AUTH
// ============================================

async function sbSignup(email, password, name) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password, data: { name } })
  });
  return r.json();
}

async function sbLogin(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password })
  });
  return r.json();
}

async function sbLogout(accessToken) {
  await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
    method: 'POST',
    headers: authHeaders(accessToken)
  });
}

// ============================================
// USER PROFILE
// ============================================

async function sbGetProfile(userId, accessToken) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=*`,
    { headers: authHeaders(accessToken) }
  );
  const d = await r.json();
  return d[0] || null;
}

async function sbSaveSignature(userId, signatureBase64, accessToken) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: { ...authHeaders(accessToken), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ saved_signature: signatureBase64, updated_at: new Date().toISOString() })
    }
  );
  return r.ok;
}

async function sbLinkToken(userId, token, accessToken) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: { ...authHeaders(accessToken), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ company_token: token })
    }
  );
  return r.ok;
}

// ============================================
// DOWNLOAD TRACKING (anonymous fingerprint)
// ============================================

async function sbGetDownloadCount(fingerprintHash) {
  const since = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/download_logs?ip_hash=eq.${fingerprintHash}&downloaded_at=gte.${since}&select=id`,
    { headers: SB_HEADERS }
  );
  const d = await r.json();
  return Array.isArray(d) ? d.length : 0;
}

async function sbLogDownload(fingerprintHash) {
  await fetch(`${SUPABASE_URL}/rest/v1/download_logs`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ ip_hash: fingerprintHash })
  });
}

// ============================================
// COMPANY TOKEN
// ============================================

async function sbValidateToken(token) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/company_tokens?token=eq.${encodeURIComponent(token)}&select=*`,
    { headers: SB_HEADERS }
  );
  const d = await r.json();
  return d.length > 0 ? d[0] : null;
}

async function sbLogTokenUsage(token, action, documentName, userEmail, userName) {
  await fetch(`${SUPABASE_URL}/rest/v1/token_usage`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({
      token,
      action,
      document_name: documentName || null,
      user_email: userEmail || null,
      user_name: userName || null
    })
  });
}

// ============================================
// DOCUMENT ACTIVITY LOG
// ============================================

async function sbLogActivity(userId, documentName, action, accessToken) {
  await fetch(`${SUPABASE_URL}/rest/v1/document_activity`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ user_id: userId, document_name: documentName, action })
  });
}

async function sbGetActivity(userId, accessToken) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/document_activity?user_id=eq.${userId}&order=created_at.desc&limit=20&select=*`,
    { headers: authHeaders(accessToken) }
  );
  return r.json();
}

// ============================================
// BROWSER FINGERPRINT (privacy-safe, no real IP)
// ============================================

async function getFingerprint() {
  const raw = [
    navigator.userAgent,
    navigator.language,
    `${screen.width}x${screen.height}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.hardwareConcurrency || 0
  ].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
