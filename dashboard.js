// ================================================================
// dashboard.js — PDFortis Company Dashboard
// ================================================================
// Voraussetzung: <script src="/supabase.js"></script> MUSS VORHER geladen sein.
// Einbinden in dashboard.html ganz am Ende vor </body>:
//   <script src="/supabase.js"></script>
//   <script src="/dashboard.js"></script>
// ================================================================

// ════════════════════════════════════
// STATE
// ════════════════════════════════════
let currentUser = null;          // {id, email, access_token, name, company_token}
let currentToken = null;         // company_tokens row
let teamMembers = [];            // user_profiles[]
let allDocs = [];                // document_activity[]
let currentDocFilter = 'all';
let chatPollInterval = null;
let heartbeatInterval = null;
let teamPollInterval = null;
let lastMsgId = null;
const ONLINE_THRESHOLD_MS = 90 * 1000; // 90s
const ADOBE_PRICE = 23.99;

// ════════════════════════════════════
// INIT
// ════════════════════════════════════
window.addEventListener('load', async () => {
  const sess = pfGetSession();
  if (sess && sess.user) {
    currentUser = sess.user;
    await initDashboard();
    return;
  }
  showAuthGate();
});

function showAuthGate() {
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('app').classList.remove('visible');
}

async function initDashboard() {
  await loadUserProfile();

  document.getElementById('auth-gate').style.display = 'none';
  document.getElementById('app').classList.add('visible');

  // 🔒 GATE: kein Firmen-Token → freundlicher Hinweis statt Crash-Cascade
  if (!currentUser.company_token) {
    showNoTokenScreen();
    return;
  }

  await loadTeam();
  await loadDocuments();
  renderOverviewActivity();
  await renderUsageStats();
  await renderMessages(await fetchMessages());

  chatPollInterval     = setInterval(pollChat, 5000);
  teamPollInterval     = setInterval(pollTeam, 15000);
  heartbeatInterval    = setInterval(() => sbHeartbeat(currentUser.id, currentUser.access_token), 30000);
  sbHeartbeat(currentUser.id, currentUser.access_token);
}

function showNoTokenScreen() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:40px;">
      <div style="max-width:480px;text-align:center;background:#fff;padding:48px 32px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.08)">
        <div style="font-size:48px;margin-bottom:16px">🏢</div>
        <h2 style="margin:0 0 12px;color:#111">Kein Firmen-Workspace aktiv</h2>
        <p style="color:#555;line-height:1.6;margin:0 0 24px">
          Dein Konto ist nicht mit einer Firma verknüpft.<br>
          Gib einen <b>Firmen-Token</b> ein, den du von deinem Admin bekommen hast.
        </p>
        <input id="late-token" placeholder="z. B. ACME-2026-XYZ"
               style="width:100%;padding:14px;border:1px solid #ddd;border-radius:10px;font-size:15px;margin-bottom:12px;text-transform:uppercase">
        <button onclick="attachTokenLate()"
                style="width:100%;padding:14px;background:#6366f1;color:#fff;border:0;border-radius:10px;font-weight:600;cursor:pointer">
          Token verknüpfen
        </button>
        <button onclick="doLogout()"
                style="margin-top:12px;background:none;border:0;color:#888;cursor:pointer">
          Abmelden
        </button>
        <div id="late-token-err" style="color:#dc2626;margin-top:12px;display:none"></div>
      </div>
    </div>`;
}

async function attachTokenLate() {
  const t  = document.getElementById('late-token').value.trim().toUpperCase();
  const er = document.getElementById('late-token-err');
  er.style.display = 'none';
  if (!t) { er.textContent='Bitte Token eingeben'; er.style.display='block'; return; }

  const tk = await sbValidateToken(t);
  if (!tk) { er.textContent='Ungültiger Token'; er.style.display='block'; return; }

  await sbUpsertProfile(currentUser.id, { company_token: t }, currentUser.access_token);
  window.location.reload();
}
// ════════════════════════════════════
// AUTH UI
// ════════════════════════════════════
function switchAuthTab(t) {
  document.querySelectorAll('.auth-tab').forEach((b, i) =>
    b.classList.toggle('active', ['login', 'signup'][i] === t));
  document.getElementById('auth-login').classList.toggle('hidden', t !== 'login');
  document.getElementById('auth-signup').classList.toggle('hidden', t !== 'signup');
}

async function doLogin() {
  const email = document.getElementById('l-email').value.trim();
  const pw    = document.getElementById('l-pw').value;
  const err   = document.getElementById('l-err');
  err.style.display = 'none';
  if (!email || !pw) return showErr(err, 'Bitte alle Felder ausfüllen');

  try {
    const d = await sbLogin(email, pw);
    if (d.error || d.error_description) {
      return showErr(err, d.error_description || d.msg || d.error);
    }
    currentUser = { ...d.user, access_token: d.access_token };
    pfSaveSession(d);
    await initDashboard();
  } catch (e) {
    showErr(err, 'Verbindungsfehler — Supabase erreichbar?');
  }
}

async function doSignup() {
  const name  = document.getElementById('s-name').value.trim();
  const email = document.getElementById('s-email').value.trim();
  const pw    = document.getElementById('s-pw').value;
  const token = document.getElementById('s-token').value.trim().toUpperCase();
  const err   = document.getElementById('s-err');
  err.style.display = 'none';

  if (!name || !email || !pw) return showErr(err, 'Bitte alle Pflichtfelder ausfüllen');
  if (pw.length < 8)            return showErr(err, 'Passwort muss min. 8 Zeichen lang sein');

  // Token validieren (falls angegeben)
  if (token) {
    const tk = await sbValidateToken(token);
    if (!tk) return showErr(err, 'Ungültiger Firmen-Token — beim Admin nachfragen');
  }

  try {
    const d = await sbSignup(email, pw, name, token || null);
    if (d.error || d.error_description || d.msg) {
      return showErr(err, d.error_description || d.msg || d.error);
    }

    // Falls Email-Confirmation an ist: kein access_token → freundlich anzeigen
    if (!d.access_token) {
      return showErr(err, '✅ Konto erstellt. Bitte E-Mail bestätigen und dann einloggen.');
    }

    currentUser = { ...d.user, access_token: d.access_token };
    pfSaveSession(d);

    // Profil-Trigger sollte schon Row angelegt haben — sicherheitshalber upsert
    await sbUpsertProfile(currentUser.id, {
      email,
      display_name: name,
      company_token: token || null
    }, d.access_token);

    await initDashboard();
    toast('Willkommen bei PDFortis! 🎉', 'ok');
  } catch (e) {
    showErr(err, 'Verbindungsfehler');
  }
}

async function doLogout() {
  clearInterval(chatPollInterval);
  clearInterval(teamPollInterval);
  clearInterval(heartbeatInterval);
  await sbLogout();
  window.location.reload();
}

function showErr(el, msg) { el.textContent = msg; el.style.display = 'block'; }

// ════════════════════════════════════
// PROFILE
// ════════════════════════════════════
async function loadUserProfile() {
  let profile = await sbGetProfile(currentUser.id, currentUser.access_token);

  // Fallback: Falls Trigger nicht lief, jetzt anlegen
  if (!profile) {
    profile = await sbUpsertProfile(currentUser.id, {
      email: currentUser.email,
      display_name: currentUser.user_metadata?.name || currentUser.email.split('@')[0],
      company_token: currentUser.user_metadata?.company_token || null
    }, currentUser.access_token);
  }

  currentUser.name = profile?.display_name || currentUser.email;
  currentUser.company_token = profile?.company_token || null;
  currentUser.saved_signature = profile?.saved_signature || null;
  currentUser.created_at = currentUser.created_at || profile?.created_at;

  // Company-Token-Daten laden
  if (currentUser.company_token) {
    currentToken = await sbValidateToken(currentUser.company_token);
  }

  // UI
  const initials = (currentUser.name || '?').slice(0, 2).toUpperCase();
  setText('topbar-avatar', initials);
  setText('topbar-name', currentUser.name);
  setText('set-user-name', currentUser.name);
  setText('set-user-email', currentUser.email);
  setText('set-member-since', new Date(currentUser.created_at || Date.now()).toLocaleDateString('de-DE'));

  if (currentToken) {
    setText('topbar-company-name', currentToken.company_name);
    setText('topbar-company-sub', currentToken.company_address || 'Company workspace');
    setText('chat-company-title', currentToken.company_name + ' — Team Chat');
    setText('set-company-name', currentToken.company_name);
    setText('set-company-address', currentToken.company_address || '—');
    setText('set-company-email', currentToken.email);
    setText('set-token-display', currentToken.token);
  } else {
    setText('topbar-company-name', 'Personal Workspace');
    setText('topbar-company-sub', 'Kein Firmen-Token — füge einen in den Einstellungen hinzu');
  }

  // Signatur
  if (currentUser.saved_signature) {
    const img = document.getElementById('sig-preview-img');
    img.src = currentUser.saved_signature;
    img.classList.remove('hidden');
    document.getElementById('sig-remove-btn').style.display = 'block';
    document.getElementById('sig-upload-label').style.display = 'none';
  }
}

// ════════════════════════════════════
// TEAM
// ════════════════════════════════════
async function loadTeam() {
  if (!currentUser.company_token) {
    teamMembers = [currentUser];
    setText('stat-members', 1);
    return;
  }
  const members = await sbFetch('GET',
    `/rest/v1/user_profiles?company_token=eq.${encodeURIComponent(currentUser.company_token)}&select=*&order=updated_at.desc`
  );
  teamMembers = members || [];

  setText('stat-members', teamMembers.length);
  setText('set-member-count', teamMembers.length + ' members');
  setText('chat-member-count', teamMembers.length + ' members');

  const savings = Math.round(teamMembers.length * ADOBE_PRICE);
  setText('savings-display', `€${savings}/mo`);
  setText('stat-saved', `€${savings}`);
  setText('set-savings', `€${savings}`);

  renderTeam();
  renderOnlineMembers();
}

async function pollTeam() {
  if (!currentUser?.company_token) return;
  const members = await sbFetch('GET',
    `/rest/v1/user_profiles?company_token=eq.${encodeURIComponent(currentUser.company_token)}&select=id,display_name,email,updated_at`
  ).catch(() => null);
  if (!members) return;
  // Update updated_at-Mapping
  members.forEach(m => {
    const local = teamMembers.find(x => x.id === m.id);
    if (local) local.updated_at = m.updated_at;
  });
  renderTeam();
  renderOnlineMembers();
}

function isOnline(member) {
  if (!member?.updated_at) return false;
  return (Date.now() - new Date(member.updated_at).getTime()) < ONLINE_THRESHOLD_MS;
}

function renderTeam() {
  const grid = document.getElementById('team-grid');
  if (!teamMembers.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>Keine Teammitglieder — Token mit Kollegen teilen!</p></div>';
    setText('online-count', 0);
    return;
  }
  grid.innerHTML = teamMembers.map((m, i) => {
    const initials = (m.display_name || m.email || '?').slice(0, 2).toUpperCase();
    const color = avatarColor(i);
    const isMe  = m.id === currentUser.id;
    const online = isMe || isOnline(m);
    const seen = m.updated_at ? timeAgo(new Date(m.updated_at)) : '—';
    return `
      <div class="member-card" onclick="loadMemberDocs('${m.id}', this)">
        <div class="member-avatar" style="background:${color}">${initials}</div>
        <div class="member-name">${esc(m.display_name || 'Unknown')}${isMe ? ' (you)' : ''}</div>
        <div class="member-email">${esc(m.email || '')}</div>
        <div class="member-status">
          <div class="status-dot ${online ? 'online' : 'offline'}" id="status-${m.id}"></div>
          <span id="status-txt-${m.id}">${online ? 'online' : 'zuletzt ' + seen}</span>
        </div>
        <div class="member-docs" id="member-docs-${m.id}" style="display:none"></div>
      </div>`;
  }).join('');

  const onlineCount = teamMembers.filter(m => m.id === currentUser.id || isOnline(m)).length;
  setText('online-count', onlineCount);
  setText('stat-online', onlineCount);
}

async function loadMemberDocs(userId, cardEl) {
  document.querySelectorAll('.member-card').forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');

  const area = document.getElementById('member-docs-' + userId);
  area.style.display = 'block';
  area.innerHTML = '<div style="font-size:11px;color:var(--gray-400)">Loading...</div>';

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const docs = await sbFetch('GET',
    `/rest/v1/document_activity?user_id=eq.${userId}&created_at=gte.${since}&order=created_at.desc&select=*`
  );
  if (!docs?.length) {
    area.innerHTML = '<div style="font-size:11px;color:var(--gray-400)">Keine Dokumente in den letzten 48h</div>';
    return;
  }
  area.innerHTML = docs.map(d => {
    const expired = d.share_expires_at && new Date(d.share_expires_at) < new Date();
    const cls = expired ? 'member-doc-item member-doc-expired' : 'member-doc-item';
    const onclick = expired || !d.share_token ? '' : `onclick="openSharedDoc('${d.share_token}')"`;
    return `<div class="${cls}" ${onclick}>
      <svg width="12" height="12" fill="none" viewBox="0 0 16 16"><rect x="2" y="1" width="10" height="13" rx="1.5" fill="#e0e7ff" stroke="#a5b4fc" stroke-width="1"/></svg>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(d.document_name)}</span>
      ${expired ? '<span style="font-size:9px;color:var(--red)">expired</span>' : '<span style="font-size:9px;color:var(--blue)">open →</span>'}
    </div>`;
  }).join('');
}

function renderOnlineMembers() {
  const onlineArea = document.getElementById('overview-online');
  const chatArea   = document.getElementById('online-members-chat');
  if (!teamMembers.length) return;

  const online = teamMembers.filter(m => m.id === currentUser.id || isOnline(m));

  onlineArea.innerHTML = online.length ? online.map((m, i) => {
    const initials = (m.display_name || '?').slice(0, 2).toUpperCase();
    return `
      <div class="activity-item">
        <div class="activity-avatar" style="background:${avatarColor(i)}">${initials}</div>
        <div class="activity-info">
          <div class="activity-name">${esc(m.display_name || m.email)}</div>
          <div class="activity-meta">${m.id === currentUser.id ? 'you' : 'aktiv'}</div>
        </div>
        <div class="status-dot online"></div>
      </div>`;
  }).join('') : '<div class="empty"><p>Keine Kollegen gerade online</p></div>';

  chatArea.innerHTML = online.map((m, i) => `
    <div class="online-member">
      <div class="activity-avatar" style="background:${avatarColor(i)};width:24px;height:24px;font-size:9px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-weight:700">${(m.display_name || '?').slice(0, 2).toUpperCase()}</div>
      <div class="online-member-info">
        <div class="online-member-name">${esc(m.display_name || m.email)}</div>
        <div class="online-member-action">${m.id === currentUser.id ? 'you' : 'online'}</div>
      </div>
    </div>`).join('');
}

// ════════════════════════════════════
// DOCUMENTS
// ════════════════════════════════════
async function loadDocuments() {
  if (!teamMembers.length) return;
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const memberIds = teamMembers.map(m => m.id).join(',');

  // Embedded user_profiles join via REST (=> select=*,user_profiles(...))
  const docs = await sbFetch('GET',
    `/rest/v1/document_activity?user_id=in.(${memberIds})&created_at=gte.${since}&order=created_at.desc&select=*,user_profiles!document_activity_user_id_fkey(display_name,email)`
  );
  // Fallback ohne Join falls FK-Name anders heisst
  allDocs = Array.isArray(docs) ? docs : [];
  if (!allDocs.length || allDocs[0]?.code) {
    const fallback = await sbFetch('GET',
      `/rest/v1/document_activity?user_id=in.(${memberIds})&created_at=gte.${since}&order=created_at.desc&select=*`
    );
    allDocs = (fallback || []).map(d => {
      const u = teamMembers.find(t => t.id === d.user_id);
      return { ...d, user_profiles: u ? { display_name: u.display_name, email: u.email } : null };
    });
  }

  setText('doc-count', allDocs.length);
  renderDocTable(allDocs);
  renderDeadlines();
}

function renderDocTable(docs) {
  const tbody = document.getElementById('doc-tbody');
  if (!docs.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty"><p>Noch keine Dokumente geteilt</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = docs.map(d => {
    const expired = d.share_expires_at && new Date(d.share_expires_at) < new Date();
    const expiresIn = d.share_expires_at ? timeAgo(new Date(d.share_expires_at), true) : '—';
    const deadlineBadge = d.deadline ? getDeadlineBadge(d.deadline) : '—';
    const authorName = d.user_profiles?.display_name || d.user_profiles?.email || 'Unknown';
    const badgeCls = ({ edited:'badge-edit', signed:'badge-sign', compressed:'badge-compress', merged:'badge-merge' })[d.action] || 'badge-edit';
    return `
      <tr>
        <td><div class="doc-name">
          <svg width="14" height="14" fill="none" viewBox="0 0 16 16"><rect x="2" y="1" width="10" height="13" rx="1.5" fill="#e0e7ff" stroke="#a5b4fc" stroke-width="1"/></svg>
          ${esc(d.document_name)}
        </div>${d.comment ? `<div style="font-size:10px;color:var(--gray-400);margin-top:2px">💬 ${esc(d.comment)}</div>` : ''}</td>
        <td>${esc(authorName)}</td>
        <td><span class="activity-badge ${badgeCls}">${esc(d.action)}</span></td>
        <td>${deadlineBadge}</td>
        <td style="font-size:11px;color:${expired ? 'var(--red)' : 'var(--gray-400)'}">${expiresIn}</td>
        <td>
          <div class="doc-actions">
            ${!expired && d.share_token
              ? `<button class="doc-btn primary" onclick="openSharedDoc('${d.share_token}')">Open</button>
                 <button class="doc-btn" onclick="copyShareLink('${d.share_token}', this)">Copy link</button>`
              : `<span style="font-size:11px;color:var(--red)">Expired</span>`}
          </div>
        </td>
      </tr>`;
  }).join('');
}

function filterDocs(filter) {
  currentDocFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b =>
    b.classList.toggle('active', b.textContent.trim().toLowerCase() === filter ||
      (filter === 'all' && b.textContent.trim() === 'All')));
  const filtered = filter === 'all' ? allDocs : allDocs.filter(d => d.action === filter);
  renderDocTable(filtered);
}

function renderOverviewActivity() {
  const area = document.getElementById('overview-activity');
  if (!allDocs.length) {
    area.innerHTML = '<div class="empty"><p>Heute noch keine Aktivität</p></div>';
  } else {
    area.innerHTML = allDocs.slice(0, 6).map((d, i) => {
      const authorName = d.user_profiles?.display_name || 'Unknown';
      const initials = authorName.slice(0, 2).toUpperCase();
      const badgeCls = ({ edited:'badge-edit', signed:'badge-sign', compressed:'badge-compress', merged:'badge-merge' })[d.action] || 'badge-edit';
      return `
        <div class="activity-item" ${d.share_token ? `onclick="openSharedDoc('${d.share_token}')"` : ''}>
          <div class="activity-avatar" style="background:${avatarColor(i)}">${initials}</div>
          <div class="activity-info">
            <div class="activity-name">${esc(d.document_name)}</div>
            <div class="activity-meta">${esc(authorName)}</div>
          </div>
          <span class="activity-badge ${badgeCls}">${esc(d.action)}</span>
          <div class="activity-time">${timeAgo(new Date(d.created_at))}</div>
        </div>`;
    }).join('');
  }

  const today = allDocs.filter(d => new Date(d.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000));
  const week  = allDocs.filter(d => new Date(d.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  setText('stat-today', today.length);
  setText('stat-week', week.length);
}

async function renderUsageStats() {
  if (!currentUser.company_token) return;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const usage = await sbFetch('GET',
    `/rest/v1/token_usage?token=eq.${encodeURIComponent(currentUser.company_token)}&user_id=eq.${currentUser.id}&used_at=gte.${since}&select=action`
  ).catch(() => []);
  if (!Array.isArray(usage)) return;
  setText('set-edits',     usage.filter(u => u.action === 'edit' || u.action === 'edited').length);
  setText('set-signs',     usage.filter(u => u.action === 'sign' || u.action === 'signed').length);
  setText('set-downloads', usage.filter(u => u.action === 'download').length);
}

function renderDeadlines() {
  const upcoming = allDocs.filter(d => d.deadline && new Date(d.deadline) > new Date());
  const card = document.getElementById('deadline-card');
  if (!upcoming.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  document.getElementById('deadline-list').innerHTML = upcoming
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
    .map(d => `
      <div class="activity-item">
        <div style="flex:1">
          <div style="font-size:12px;font-weight:600">${esc(d.document_name)}</div>
          <div style="font-size:11px;color:var(--gray-400)">${esc(d.user_profiles?.display_name || 'Unknown')}</div>
        </div>
        ${getDeadlineBadge(d.deadline)}
      </div>`).join('');
}

function getDeadlineBadge(deadline) {
  const diff = new Date(deadline) - new Date();
  const h = diff / 3600000;
  if (h < 2)  return `<span class="deadline-badge deadline-urgent">⚡ in ${Math.max(0, Math.round(h * 60))}min</span>`;
  if (h < 24) return `<span class="deadline-badge deadline-soon">⏰ in ${Math.round(h)}h</span>`;
  return `<span class="deadline-badge deadline-ok">📅 ${new Date(deadline).toLocaleDateString('de-DE')}</span>`;
}

// ════════════════════════════════════
// SHARE
// ════════════════════════════════════
function openShareModal() { document.getElementById('share-modal').classList.remove('hidden'); }

async function shareDocument() {
  const name     = document.getElementById('share-name').value.trim();
  const action   = document.getElementById('share-action').value;
  const deadline = document.getElementById('share-deadline').value;
  const comment  = document.getElementById('share-comment').value.trim();
  if (!name) return toast('Bitte Dokumentnamen eingeben', 'err');

  const shareToken = crypto.randomUUID();
  const expiresAt  = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const ok = await sbFetch('POST', '/rest/v1/document_activity', {
    user_id: currentUser.id,
    document_name: name,
    action,
    share_token: shareToken,
    share_expires_at: expiresAt,
    deadline: deadline ? new Date(deadline).toISOString() : null,
    comment: comment || null
  });

  if (!ok) return toast('Fehler beim Teilen', 'err');

  if (currentUser.company_token) {
    sbLogTokenUsage(currentUser.company_token, action, name, currentUser.email, currentUser.name);
  }

  closeModal('share-modal');
  ['share-name', 'share-deadline', 'share-comment'].forEach(id => document.getElementById(id).value = '');
  toast('Dokument für 48h geteilt!', 'ok');
  await loadDocuments();
  renderOverviewActivity();
}

function openSharedDoc(shareToken) {
  window.open(`/index.html?share=${shareToken}`, '_blank');
}

async function copyShareLink(shareToken, btn) {
  const link = `${window.location.origin}/index.html?share=${shareToken}`;
  await navigator.clipboard.writeText(link);
  btn.textContent = '✓ Copied';
  btn.classList.add('share-link-copied');
  setTimeout(() => { btn.textContent = 'Copy link'; btn.classList.remove('share-link-copied'); }, 2000);
}

// ════════════════════════════════════
// CHAT
// ════════════════════════════════════
async function fetchMessages() {
  if (!currentUser?.company_token) return [];
  return await sbFetch('GET',
    `/rest/v1/team_messages?company_token=eq.${encodeURIComponent(currentUser.company_token)}&order=created_at.asc&limit=100&select=*`
  ) || [];
}

async function pollChat() {
  const msgs = await fetchMessages();
  if (!msgs.length) return;
  const newest = msgs[msgs.length - 1].id;
  if (newest === lastMsgId) return;
  lastMsgId = newest;
  renderMessages(msgs);
}

function renderMessages(msgs) {
  const area = document.getElementById('chat-messages');
  if (!msgs.length) return;
  const wasAtBottom = area.scrollHeight - area.scrollTop <= area.clientHeight + 60;

  const memberMap = {};
  teamMembers.forEach((m, i) => { memberMap[m.id] = { name: m.display_name || m.email, color: avatarColor(i) }; });

  area.innerHTML = msgs.map(m => {
    const isOwn  = m.user_id === currentUser.id;
    const member = memberMap[m.user_id] || { name: m.user_name || 'Unknown', color: '#6b7280' };
    const initials = member.name.slice(0, 2).toUpperCase();
    const time = new Date(m.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const docLink = m.document_id ? `
      <div class="chat-doc-link" onclick="openSharedDoc('${m.document_id}')">
        <svg width="12" height="12" fill="none" viewBox="0 0 16 16"><rect x="2" y="1" width="10" height="13" rx="1.5" fill="#dbeafe" stroke="#93c5fd" stroke-width="1"/></svg>
        Geteiltes Dokument öffnen
      </div>` : '';

    return `
      <div class="chat-msg ${isOwn ? 'own' : ''}">
        <div class="chat-msg-avatar" style="background:${member.color}">${initials}</div>
        <div class="chat-msg-body">
          ${!isOwn ? `<div class="chat-msg-name">${esc(member.name)}</div>` : ''}
          <div class="chat-msg-bubble">${esc(m.message)}</div>
          ${docLink}
          <div class="chat-msg-time">${time}</div>
        </div>
      </div>`;
  }).join('');

  lastMsgId = msgs[msgs.length - 1].id;
  if (wasAtBottom) area.scrollTop = area.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const msg   = input.value.trim();
  if (!msg || !currentUser.company_token) return;

  input.value = ''; input.style.height = 'auto';

  await sbFetch('POST', '/rest/v1/team_messages', {
    company_token: currentUser.company_token,
    user_id: currentUser.id,
    user_name: currentUser.name,
    message: msg,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });
  renderMessages(await fetchMessages());
}

function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

async function attachDocToChat() {
  if (!allDocs.length) return toast('Noch keine Dokumente geteilt', 'err');
  const list = allDocs.slice(0, 5).map((d, i) => `${i + 1}. ${d.document_name}`).join('\n');
  const pick = prompt(`Welches Dokument anhängen? Nummer eingeben:\n${list}`);
  const idx = parseInt(pick) - 1;
  if (isNaN(idx) || !allDocs[idx]) return;
  const doc = allDocs[idx];

  await sbFetch('POST', '/rest/v1/team_messages', {
    company_token: currentUser.company_token,
    user_id: currentUser.id,
    user_name: currentUser.name,
    message: `📎 Geteilt: ${doc.document_name}`,
    document_id: doc.share_token,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });
  renderMessages(await fetchMessages());
  toast('Dokument angehängt!', 'ok');
}

// ════════════════════════════════════
// SETTINGS
// ════════════════════════════════════
async function uploadCompanySig(e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 500 * 1024) return toast('Bild zu groß (max. 500KB)', 'err');
  const reader = new FileReader();
  reader.onload = async ev => {
    const b64 = ev.target.result;
    const ok = await sbFetch('PATCH', `/rest/v1/user_profiles?id=eq.${currentUser.id}`, { saved_signature: b64 });
    if (!ok) return toast('Fehler beim Speichern', 'err');
    document.getElementById('sig-preview-img').src = b64;
    document.getElementById('sig-preview-img').classList.remove('hidden');
    document.getElementById('sig-remove-btn').style.display = 'block';
    document.getElementById('sig-upload-label').style.display = 'none';
    currentUser.saved_signature = b64;
    toast('Signatur gespeichert!', 'ok');
  };
  reader.readAsDataURL(file);
}

async function removeCompanySig() {
  await sbFetch('PATCH', `/rest/v1/user_profiles?id=eq.${currentUser.id}`, { saved_signature: null });
  document.getElementById('sig-preview-img').classList.add('hidden');
  document.getElementById('sig-remove-btn').style.display = 'none';
  document.getElementById('sig-upload-label').style.display = 'block';
  currentUser.saved_signature = null;
  toast('Signatur entfernt');
}

function copyToken() {
  if (!currentToken) return toast('Kein Token vorhanden', 'err');
  navigator.clipboard.writeText(currentToken.token);
  toast('Token kopiert! 📋', 'ok');
}

// ════════════════════════════════════
// CLEANUP
// ════════════════════════════════════
async function cleanupExpired() {
  const nowIso = new Date().toISOString();
  await Promise.all([
    sbFetch('DELETE', `/rest/v1/team_messages?expires_at=lt.${nowIso}`),
    sbFetch('DELETE', `/rest/v1/document_activity?share_expires_at=lt.${nowIso}`),
    sbFetch('DELETE', `/rest/v1/download_logs?downloaded_at=lt.${new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString()}`)
  ]).catch(() => {});
}

// ════════════════════════════════════
// CORE FETCH
// ════════════════════════════════════
async function sbFetch(method, path, body) {
  const opts = { method, headers: { ...authHeaders(currentUser?.access_token) } };
  if (body) opts.body = JSON.stringify(body);
  if (method === 'DELETE' || method === 'PATCH') opts.headers['Prefer'] = 'return=representation';
  const r = await fetch(SUPABASE_URL + path, opts);
  if (r.status === 401) { pfClearSession(); window.location.reload(); return null; }
  if (method === 'DELETE') return r.ok;
  if (!r.ok) { console.warn('sbFetch error', method, path, r.status); return null; }
  try { return await r.json(); } catch(e) { return null; }
}

// ════════════════════════════════════
// TABS
// ════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(n => {
    const label = n.textContent.trim().split('\n')[0].trim().toLowerCase();
    n.classList.toggle('active',
      label === tab ||
      (tab === 'overview' && label === 'overview') ||
      (tab === 'team' && label.startsWith('team') && !label.includes('chat')) ||
      (tab === 'chat' && label.includes('chat')) ||
      (tab === 'documents' && label === 'documents') ||
      (tab === 'settings' && label === 'settings')
    );
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
document.addEventListener('click', e => { if (e.target.classList.contains('modal-bg')) e.target.classList.add('hidden'); });

// ════════════════════════════════════
// UTILS
// ════════════════════════════════════
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = type === 'err' ? '#dc2626' : type === 'ok' ? '#16a34a' : '#111827';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function timeAgo(date, future = false) {
  const diff = future ? date - new Date() : new Date() - date;
  if (diff < 0 && !future) return 'just now';
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (future) {
    if (h < 1) return `${Math.max(0, m)}min`;
    if (h < 24) return `${h}h`;
    return `${d}d`;
  }
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m}min`;
  if (h < 24) return `vor ${h}h`;
  return `vor ${d}d`;
}

function avatarColor(i) {
  const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#14b8a6'];
  return colors[i % colors.length];
}
