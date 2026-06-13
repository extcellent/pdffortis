// ================================================================
// auth-badge.js — Mini-Snippet für index.html
// ================================================================
// Zeigt rechts oben einen "Dashboard"-Button wenn eingeloggt,
// sonst "Login". Setzt außerdem die Firmen-Signatur als Default
// in der globalen Variable window.pfCompanySignature.
//
// Einbinden in index.html ganz am Ende vor </body>:
//   <script src="/supabase.js"></script>
//   <script src="/auth-badge.js"></script>
// ================================================================

(async function() {
  // 1) Floating Top-Right Badge erzeugen
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;top:14px;right:14px;z-index:9999;display:flex;gap:8px;align-items:center;font-family:Inter,system-ui,sans-serif';
  document.body.appendChild(badge);

  const sess = pfGetSession();

  if (!sess) {
    badge.innerHTML = `
      <a href="/dashboard.html" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;box-shadow:0 4px 12px rgba(99,102,241,.3)">
        🔐 Login / Register
      </a>`;
    return;
  }

  // 2) Profil holen + Signatur ins Window
  const profile = await sbGetProfile(sess.user.id, sess.user.access_token);
  const name = profile?.display_name || sess.user.email;
  const initials = (name || '?').slice(0, 2).toUpperCase();

  if (profile?.saved_signature) {
    window.pfCompanySignature = profile.saved_signature;
  }
  window.pfUser = { ...sess.user, ...profile };

  badge.innerHTML = `
    <a href="/dashboard.html" style="background:white;color:#111827;padding:6px 10px 6px 6px;border-radius:30px;border:1px solid #e5e7eb;font-size:13px;font-weight:600;text-decoration:none;display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,.06)">
      <span style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">${initials}</span>
      ${name.split(' ')[0]}
    </a>
    <button onclick="pfLogoutAndReload()" style="background:#f3f4f6;border:1px solid #e5e7eb;color:#6b7280;padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer">Logout</button>`;

  // 3) Share-Link Handler: ?share=UUID → Aktivität loggen
  const params = new URLSearchParams(location.search);
  const shareToken = params.get('share');
  if (shareToken) {
    // optional: lade Doku-Info via document_activity?share_token=eq.X
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/document_activity?share_token=eq.${encodeURIComponent(shareToken)}&select=*`,
        { headers: authHeaders(sess.user.access_token) });
      const arr = await r.json();
      if (arr?.[0]) {
        console.log('Opened shared document:', arr[0].document_name);
        // → hier ggf. Filename als window.title setzen oder Toast zeigen
      }
    } catch(e) {}
  }

  // 4) Heartbeat (zeigt User im Dashboard als "online")
  sbHeartbeat(sess.user.id, sess.user.access_token);
  setInterval(() => sbHeartbeat(sess.user.id, sess.user.access_token), 30000);
})();

async function pfLogoutAndReload() {
  await sbLogout();
  window.location.reload();
}

// ================================================================
// Helfer: Aufrufen wenn ein Dokument bearbeitet/signiert wurde
// in index.html z.B. nach erfolgreichem PDF-Export:
//   pfLogActivity('Vertrag.pdf', 'signed')
// ================================================================
async function pfLogActivity(documentName, action) {
  const sess = pfGetSession();
  if (!sess) return;
  await fetch(`${SUPABASE_URL}/rest/v1/document_activity`, {
    method: 'POST',
    headers: authHeaders(sess.user.access_token),
    body: JSON.stringify({ user_id: sess.user.id, document_name: documentName, action })
  });
  // Token-Usage parallel
  if (window.pfUser?.company_token) {
    sbLogTokenUsage(window.pfUser.company_token, action, documentName, sess.user.email, window.pfUser.display_name);
  }
}
