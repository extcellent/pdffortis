// ============================================
// supabase.js — PDFortis (drop-in replacement)
// ============================================
// Wird VON index.html UND dashboard.html geladen.
// Reihenfolge:  <script src="/supabase.js"></script>  ZUERST,
//               dann <script src="/dashboard.js"></script>
// ============================================

const SUPABASE_URL = 'https://zzcjyfhhaithlhkcxzra.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp6Y2p5ZmhoYWl0aGxoa2N4enJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNDE1NTYsImV4cCI6MjA5NjgxNzU1Nn0.3lQ-9vyOtx13iAZHIwrW6P_gN2bpDOOMnJ1jkU_yilA';

// ── Headers ─────────────────────────────────────────────────
const SB_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Prefer': 'return=representation'
};

function authHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
    'Prefer': 'return=representation'
  };
}

// ── Session-Helpers (überall verfügbar) ─────────────────────
function pfGetSession() {
  try {
    const raw = localStorage.getItem('pf_session');
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.expires_at < Date.now()) { localStorage.removeItem('pf_session'); return null; }
    return s;
  } catch(e) { return null; }
}

function pfSaveSession(authResp) {
  localStorage.setItem('pf_session', JSON.stringify({
    user: { ...authResp.user, access_token: authResp.access_token },
    expires_at: Date.now() + (authResp.expires_in || 3600) * 1000
  }));
}

function pfClearSession() { localStorage.removeItem('pf_session'); }

// ============================================
// AUTH
// ============================================
async function sbSignup(email, password, name, companyToken) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({
      email,
      password,
      data: { name, company_token: companyToken || null }
    })
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

async function sbLogout() {
  const s = pfGetSession();
  if (s) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: authHeaders(s.user.access_token)
    }).catch(() => {});
  }
  pfClearSession();
}

// ============================================
// PROFILE
// ============================================
async function sbGetProfile(userId, accessToken) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=*`,
    { headers: authHeaders(accessToken) }
  );
  const d = await r.json();
  return d?.[0] || null;
}

async function sbUpsertProfile(userId, fields, accessToken) {
  // Versucht erst PATCH, falls Row noch nicht da: POST
  const patch = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`,
    { method: 'PATCH', headers: authHeaders(accessToken),
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }) }
  );
  if (patch.ok) {
    const arr = await patch.json().catch(() => []);
    if (arr.length) return arr[0];
  }
  // Insert fallback
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
    method: 'POST',
    headers: { ...authHeaders(accessToken), 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ id: userId, ...fields, updated_at: new Date().toISOString() })
  });
  const d = await ins.json().catch(() => null);
  return Array.isArray(d) ? d[0] : d;
}

async function sbHeartbeat(userId, accessToken) {
  // Bumpe updated_at → wird als "online" interpretiert (< 60s alt)
  return fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(accessToken), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ updated_at: new Date().toISOString() })
  });
}

// ============================================
// COMPANY TOKEN
// ============================================
async function sbValidateToken(token) {
  if (!token) return null;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/company_tokens?token=eq.${encodeURIComponent(token)}&select=*`,
    { headers: SB_HEADERS }
  );
  const d = await r.json();
  return d?.[0] || null;
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
  return fetch(`${SUPABASE_URL}/rest/v1/download_logs`, {
    method: 'POST', headers: SB_HEADERS,
    body: JSON.stringify({ ip_hash: fingerprintHash })
  });
}

async function sbLogTokenUsage(token, action, documentName, userEmail, userName) {
  return fetch(`${SUPABASE_URL}/rest/v1/token_usage`, {
    method: 'POST', headers: SB_HEADERS,
    body: JSON.stringify({
      token, action,
      document_name: documentName || null,
      user_email: userEmail || null,
      user_name: userName || null
    })
  });
}

// ============================================
// FINGERPRINT
// ============================================
async function getFingerprint() {
  const raw = [
    navigator.userAgent, navigator.language,
    `${screen.width}x${screen.height}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.hardwareConcurrency || 0
  ].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function sbUploadSharedPDF(shareToken, pdfBytes, accessToken) {
  const path = `${shareToken}.pdf`;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/shared-pdfs/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true'
    },
    body: pdfBytes
  });
  return r.ok;
}

async function sbGetSharedPDFUrl(shareToken, accessToken) {
  const path = `${shareToken}.pdf`;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/shared-pdfs/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expiresIn: 172800 }) // 48h
  });
  if (!r.ok) { console.warn('signedURL request failed', r.status); return null; }
  const d = await r.json();
  const signed = d?.signedURL || d?.signedUrl; // beide Varianten akzeptieren
  return signed ? `${SUPABASE_URL}/storage/v1${signed}` : null;
}
