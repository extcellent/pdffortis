
// ================================================================
// auth-badge.js — PDFortis (silent helpers only, no UI)
// ================================================================
// Nav-Buttons sind in index.html. Diese Datei macht nur:
//  - lädt Profil/Signatur ins window
//  - Share-Link Handler
//  - Heartbeat (Online-Status fürs Dashboard)
//  - exportiert pfLogActivity() & pfLogoutAndReload()
// ================================================================

(async function() {
  const sess = pfGetSession();
  if (!sess) return;

  try {
    const profile = await sbGetProfile(sess.user.id, sess.user.access_token);
    if (profile?.saved_signature) window.pfCompanySignature = profile.saved_signature;
    window.pfUser = { ...sess.user, ...profile };
  } catch(e) { console.warn('profile load failed', e); }

  const params = new URLSearchParams(location.search);
  const shareToken = params.get('share');
  if (shareToken) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/document_activity?share_token=eq.${encodeURIComponent(shareToken)}&select=*`,
        { headers: authHeaders(sess.user.access_token) }
      );
      const arr = await r.json();
      const row = arr?.[0];
      const stillValid = row && (!row.share_expires_at || new Date(row.share_expires_at) > new Date());
      if (stillValid) {
        const pdfUrl = await sbGetSharedPDFUrl(shareToken, sess.user.access_token);
        if (pdfUrl) {
          window.__pfSharedPDF = { url: pdfUrl, name: row.document_name };
        } else {
          console.warn('[PDFortis] Signed URL konnte nicht erzeugt werden für', shareToken);
        }
      } else {
        console.warn('[PDFortis] Share-Token nicht gefunden oder abgelaufen:', shareToken);
      }
    } catch(e) { console.warn('[PDFortis] Share-Load Fehler', e); }
  }


  sbHeartbeat(sess.user.id, sess.user.access_token);
  setInterval(() => sbHeartbeat(sess.user.id, sess.user.access_token), 30000);
})();

async function pfLogoutAndReload() {
  await sbLogout();
  window.location.reload();
}

async function pfLogActivity(documentName, action) {
  const sess = pfGetSession();
  if (!sess) return;
  await fetch(`${SUPABASE_URL}/rest/v1/document_activity`, {
    method: 'POST',
    headers: authHeaders(sess.user.access_token),
    body: JSON.stringify({ user_id: sess.user.id, document_name: documentName, action })
  });
  if (window.pfUser?.company_token) {
    sbLogTokenUsage(window.pfUser.company_token, action, documentName, sess.user.email, window.pfUser.display_name);
  }
}
