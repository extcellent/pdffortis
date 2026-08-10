// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
let pdfDoc=null, pdfLibDoc=null, pdfBytes=null;
const API = 'https://pdffortis-api.onrender.com';
let pendingEdits=[];

// ═══════════════════════════════════════
// UNDO / REDO
// ═══════════════════════════════════════
let historyStack = [];
let historyIndex = -1;
const MAX_HISTORY = 50;

function pushHistory(action){
  historyStack = historyStack.slice(0, historyIndex + 1);
  historyStack.push(action);
  if(historyStack.length > MAX_HISTORY) historyStack.shift();
  historyIndex = historyStack.length - 1;
  updateUndoRedoButtons();
}

async function undo(){
  if(historyIndex < 0) return;
  await historyStack[historyIndex].undo();
  historyIndex--;
  updateUndoRedoButtons();
}

async function redo(){
  if(historyIndex >= historyStack.length - 1) return;
  historyIndex++;
  await historyStack[historyIndex].redo();
  updateUndoRedoButtons();
}
// ═══════════════════════════════════════
// Draft-History für Inline-Text-Edits
// → Undo wird sofort beim Tippen aktiv, nicht erst nach blur/Enter
// ═══════════════════════════════════════
document.addEventListener('input', function(e){
  const span = e.target;
  if(!span || !span.classList || !span.classList.contains('pdf-text-item')) return;
  if(span.getAttribute('contenteditable') !== 'true') return;

  const origText = span.dataset.originalText || '';
  const currentText = span.textContent;

  if(span.dataset._draftHistoryPushed !== '1'){
    // Erster Input → Draft-History-Eintrag pushen
    if(currentText === origText) return; // wirklich noch keine Änderung

    const spanRef = span;
    const pageNum = parseInt(span.dataset.pageNumber || currentPage, 10);
    const x = parseFloat(span.dataset.pdfX);
    const y = parseFloat(span.dataset.pdfY);

    pushHistory({
      undo: async () => {
        spanRef.textContent = origText;
        spanRef.dataset.editedText = origText;
        spanRef.classList.remove('is-edited');
        spanRef.style.color = 'transparent';
        const idx = pendingEdits.findIndex(ed => ed.page===pageNum && ed.x===x && ed.y===y);
        if(idx > -1) pendingEdits.splice(idx, 1);
        if(pageNum === currentPage && typeof redrawPageCanvas === 'function') redrawPageCanvas(pageNum);
        delete spanRef.dataset._draftHistoryPushed;
      },
      redo: async () => {
        const finalText = spanRef.dataset._draftFinalText || spanRef.textContent;
        spanRef.textContent = finalText;
        spanRef.dataset.editedText = finalText;
        spanRef.classList.add('is-edited');
        spanRef.style.color = spanRef.dataset.cssColor || 'black';
      }
    });
    span.dataset._draftHistoryPushed = '1';
    span.dataset._draftFinalText = currentText;
  } else {
    // Folgeinputs → nur den Redo-Ziel-Text aktualisieren
    span.dataset._draftFinalText = currentText;
  }
});

function updateUndoRedoButtons(){
  document.querySelectorAll('.undo-btn').forEach(b=>b.disabled = historyIndex < 0);
  document.querySelectorAll('.redo-btn').forEach(b=>b.disabled = historyIndex >= historyStack.length - 1);
}

function redrawPageCanvas(n){
  const canvas=document.getElementById('pdf-canvas');
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const img=pageImages[n];
  if(!img) return;
  ctx.drawImage(img,0,0,canvas.width,canvas.height);
  (pageMasks[n]||[]).forEach(m=>{
    if(m.data){ ctx.putImageData(m.data,m.x,m.y); }
    else { ctx.fillStyle=m.bg; ctx.fillRect(m.x,m.y,m.w,m.h); }
  });
  // Falls gerade ein ANDERER Span offen/in Bearbeitung ist (noch nicht committed),
  // dessen temporäre Maske erneut auftragen — sonst blitzt dessen alter Text
  // hier kurz wieder auf und erzeugt Doppeltext mit dem noch offenen Span
  const activeSpan = window.activeInlineSpan;
  if(activeSpan && activeSpan._maskRect && parseInt(activeSpan.dataset.pageNumber,10)===n){
    const m = activeSpan._maskRect;
    if(m.data){ ctx.putImageData(m.data,m.x,m.y); }
    else { ctx.fillStyle=m.bg; ctx.fillRect(m.x,m.y,m.w,m.h); }
  }
}

document.addEventListener('keydown', e=>{
  const ae = document.activeElement;
  const inTextField = ae && (ae.isContentEditable || ae.tagName==='INPUT' || ae.tagName==='TEXTAREA');
  const mod = e.ctrlKey || e.metaKey;
  if(!mod) return;
  const key = e.key.toLowerCase();
  if(key==='z' && !e.shiftKey){
    if(inTextField) return; // native Undo im Textfeld hat Vorrang
    e.preventDefault(); undo();
  }else if(key==='y' || (key==='z' && e.shiftKey)){
    if(inTextField) return;
    e.preventDefault(); redo();
  }
});
let pageMasks={}; // {pageNum: [{x,y,w,h,bg}, ...]} – Vorschau-Masken pro Seite
let pageImages={};
let currentPage=1, totalPages=0, fileName='';
let editorMode='look', currentTab='edit', compressQ='medium';
let sigDrawing=false, sigLX=0, sigLY=0;
let currentUser=null, currentToken=null;
let currentSubscription=null;
let clientFP=null;
let thumbCanvases=[];

function isPaidUser(){
  return CONFIG.ENABLE_PAYWALL && currentSubscription
    && (currentSubscription.tier === 'pro' || currentSubscription.tier === 'team')
    && currentSubscription.status === 'active';
}
  
const CONFIG = {
  ENABLE_PAYWALL: false,
  ENABLE_ADS: false,
  DAILY_FREE_LOGGED_IN_LIMIT: 3,
  GUEST_DL_LIMIT: 1
};
const MAX_DL=CONFIG.DAILY_FREE_LOGGED_IN_LIMIT, LIMIT_MS=8*60*60*1000;
const LS_DL='pf_dl', LS_GUEST_DL='pdfortis_guest_downloads_used', LS_TOKEN='pf_tok', LS_TOKDAT='pf_tokdat', LS_USER='pf_user';
  
let lang='en';
// ── CAPTCHA ──
let pfCaptchaVerified = false;
let pfSignupTime = null;
const BLOCKED_DOMAINS = [
  'mailinator.com','guerrillamail.com','tempmail.com','10minutemail.com',
  'throwaway.email','sharklasers.com','trashmail.com','yopmail.com',
  'getnada.com','fakeinbox.com','dispostable.com','maildrop.cc','temp-mail.org'
];
// ═══════════════════════════════════════
// i18n
// ═══════════════════════════════════════
const i18n={
  en:{nav_login:'Sign in',nav_signup:'Get started',logout:'Logout',tagline:'why would you need to pay for such a thing anyway?',hero_cta:'Start Editing',privacy_note:'Your files never leave your browser · 100% private',tools_label:'Everything you need',f1t:'Edit PDF Text',f1d:'Click any text and edit directly. Copy-paste works perfectly.',f2t:'Sign & Fill',f2d:'Draw, type or upload your signature. Save it for next time.',f3t:'Compress',f3d:'Shrink your PDF without losing quality. Great for email.',f4t:'Merge & Split',f4d:'Combine multiple PDFs or extract individual pages.',f5t:'Organize Pages',f5d:'Rotate, delete or reorder pages with one click.',f6t:'Team Dashboard',f6d:'Company accounts with shared access and activity logs.',f7t:'100% Private',f7d:'Processing happens in your browser. No uploads to servers.',privacy_banner:'PDFs are never stored or uploaded without your account.',upload_heading:'Upload your PDF',upload_sub:'Drag and drop or browse — editing starts immediately in your browser.',drop_title:'Drop your PDF here',drop_or:'or',drop_browse:'Browse files',drop_note:'PDF files only · processed locally · never uploaded',recent_title:'Recent documents',mode_look:'View',mode_edit:'Edit',tab_edit:'Edit Text',tab_add:'Add Text',tab_sign:'Sign',tab_organize:'Organize',add_text:'Add Text Box',add_img:'Image',add_date:'Date',sign_draw:'Sign Here',sign_init:'Initials',rotate:'Rotate',delete_pg:'Delete Page',merge:'Merge',nav_pages:'Pages',tools_compress:'Compress',q_high:'High',q_med:'Med',q_low:'Small',compress_save:'Compress & Save',tools_actions:'Actions',token_btn:'Token',save_btn:'Save PDF',color_lbl:'Color',firm_sig:'Company sig:',sign_modal_title:'Add Signature',sign_draw_tab:'Draw',sign_type_tab:'Type',sign_upload_tab:'Upload',clear:'Clear',insert:'Insert',upload_sig:'Upload signature image',token_title:'Company Token',token_desc:'Enter your company token for unlimited downloads and company branding.',token_activate:'Activate Token',remove_token:'Remove token',or_request:'No token yet?',token_request:'Request a free company token →',limit_title:'Daily limit reached',limit_sub:"You've used all 5 free downloads.",limit_reset:'Resets in',company_q:'Are you a company?',company_desc:'Get a free company token for unlimited downloads.',contact_us:'Contact us →',create_acc_q:'Create a free account?',create_acc_desc:'Save your signature, view document history.',nudge_msg:'💾 Save your signature for next time',nudge_cta:'Create free account',email_lbl:'Email',pw_lbl:'Password',name_lbl:'Name',no_account:'No account? Create one free →',has_account:'Already have an account? Sign in →',auth_tab_login:'Sign in',auth_tab_signup:'Create account',footer_firms:'For businesses & teams →',footer_legal:'Legal Notice',footer_privacy:'Privacy',footer_contact:'Contact'},
  de:{nav_login:'Anmelden',nav_signup:'Loslegen',logout:'Abmelden',tagline:'warum sollte man dafür bezahlen müssen?',hero_cta:'Jetzt bearbeiten',privacy_note:'Deine Dateien verlassen nie deinen Browser · 100% privat',tools_label:'Alles was du brauchst',f1t:'PDF Text bearbeiten',f1d:'Klicke auf Text und bearbeite ihn direkt.',f2t:'Signieren & Ausfüllen',f2d:'Zeichne, tippe oder lade deine Unterschrift hoch.',f3t:'Komprimieren',f3d:'PDF verkleinern ohne Qualitätsverlust.',f4t:'Zusammenfügen & Trennen',f4d:'PDFs verbinden oder Seiten herauslösen.',f5t:'Seiten organisieren',f5d:'Seiten drehen, löschen oder neu anordnen.',f6t:'Team Dashboard',f6d:'Firmenkonten mit gemeinsamem Zugriff.',f7t:'100% Privat',f7d:'Verarbeitung findet nur in deinem Browser statt.',privacy_banner:'PDFs werden ohne Konto nicht gespeichert oder hochgeladen.',upload_heading:'PDF hochladen',upload_sub:'Ablegen oder durchsuchen — Bearbeitung startet sofort.',drop_title:'PDF hier ablegen',drop_or:'oder',drop_browse:'Datei auswählen',drop_note:'Nur PDF-Dateien · lokal verarbeitet · nie hochgeladen',recent_title:'Zuletzt bearbeitete Dokumente',mode_look:'Ansicht',mode_edit:'Bearbeiten',tab_edit:'Text bearbeiten',tab_add:'Text hinzufügen',tab_sign:'Signieren',tab_organize:'Organisieren',add_text:'Textfeld hinzufügen',add_img:'Bild',add_date:'Datum',sign_draw:'Hier unterschreiben',sign_init:'Initialen',rotate:'Drehen',delete_pg:'Seite löschen',merge:'Zusammenfügen',nav_pages:'Seiten',tools_compress:'Komprimieren',q_high:'Hoch',q_med:'Mittel',q_low:'Klein',compress_save:'Komprimieren & Speichern',tools_actions:'Aktionen',token_btn:'Token',save_btn:'PDF speichern',color_lbl:'Farbe',firm_sig:'Firmensignatur:',sign_modal_title:'Unterschrift hinzufügen',sign_draw_tab:'Zeichnen',sign_type_tab:'Tippen',sign_upload_tab:'Hochladen',clear:'Löschen',insert:'Einfügen',upload_sig:'Unterschriftsbild hochladen',token_title:'Firmen-Token',token_desc:'Gib deinen Firmen-Token ein für unbegrenzte Downloads.',token_activate:'Token aktivieren',remove_token:'Token entfernen',or_request:'Noch kein Token?',token_request:'Kostenlosen Firmen-Token anfragen →',limit_title:'Tageslimit erreicht',limit_sub:'Du hast heute alle 5 Downloads verbraucht.',limit_reset:'Zurücksetzen in',company_q:'Bist du ein Unternehmen?',company_desc:'Erhalte einen kostenlosen Firmen-Token für unbegrenzte Downloads.',contact_us:'Jetzt anfragen →',create_acc_q:'Kostenloses Konto erstellen?',create_acc_desc:'Unterschrift speichern und Dokumentverlauf ansehen.',nudge_msg:'💾 Unterschrift für das nächste Mal speichern',nudge_cta:'Konto erstellen',email_lbl:'E-Mail',pw_lbl:'Passwort',name_lbl:'Name',no_account:'Noch kein Konto? Kostenlos registrieren →',has_account:'Bereits ein Konto? Anmelden →',auth_tab_login:'Anmelden',auth_tab_signup:'Konto erstellen',footer_firms:'Für Unternehmen & Teams →',footer_legal:'Impressum',footer_privacy:'Datenschutz',footer_contact:'Kontakt'}
};

function setLang(l){
  lang=l;
  document.querySelectorAll('.lang-btn').forEach(b=>{b.classList.toggle('active',b.textContent===l.toUpperCase())});
  document.querySelectorAll('[data-i]').forEach(el=>{const k=el.dataset.i;if(i18n[l][k])el.textContent=i18n[l][k]});
}

// ═══════════════════════════════════════
// PAGE NAVIGATION
// ═══════════════════════════════════════
function goTo(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.add('out'));
  document.getElementById('page-'+id).classList.remove('out');
  if(id === 'landing'){ window.startTubes && window.startTubes(); }
  else { window.stopTubes && window.stopTubes(); }
}
function goToUpload(){goTo('upload')}

//NAV
function toggleNavDropdown(which){
  const dd = document.getElementById(which + '-nav-dropdown');
  if (!dd) return;
  const isOpen = dd.classList.contains('open');
  document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('open'));
  if (!isOpen) dd.classList.add('open');
}

document.addEventListener('click', function(e){
  if (!e.target.closest('.nav-user-wrap')) {
    document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('open'));
  }
});
  
// ═══════════════════════════════════════
// LANDING HERO ANIMATION
// ═══════════════════════════════════════
(function(){
  const items=['hc0','hc1','hc2'];let i=0;
  function next(){
    document.querySelectorAll('.hero-cycle-item').forEach(e=>e.classList.remove('active'));
    document.getElementById(items[i]).classList.add('active');
    i=(i+1)%items.length;
  }
  next();setInterval(next,3000);
})();

// ═══════════════════════════════════════
// FEATURE CARDS DRAG SCROLL
// ═══════════════════════════════════════
(function(){
  const wrap=document.getElementById('feat-track-wrap');
  let down=false,startX,scrollL;
  wrap.addEventListener('mousedown',e=>{down=true;startX=e.pageX-wrap.offsetLeft;scrollL=wrap.scrollLeft;wrap.classList.add('grabbing')});
  wrap.addEventListener('mouseleave',()=>{down=false;wrap.classList.remove('grabbing')});
  wrap.addEventListener('mouseup',()=>{down=false;wrap.classList.remove('grabbing')});
  wrap.addEventListener('mousemove',e=>{if(!down)return;e.preventDefault();wrap.scrollLeft=scrollL-(e.pageX-wrap.offsetLeft-startX)});
})();

// ═══════════════════════════════════════
// DROP ZONE
// ═══════════════════════════════════════
(function(){
  const dz=document.getElementById('drop-zone');
  ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('over')}));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('over')}));
  dz.addEventListener('drop',e=>{const f=e.dataTransfer?.files?.[0];if(f?.type==='application/pdf')loadPDF(f);else toast('Please drop a PDF file','err')});
})();
function handleFile(e){const f=e.target.files?.[0];if(f)loadPDF(f)}

// ═══════════════════════════════════════
// LOAD PDF
// ═══════════════════════════════════════
async function loadPDF(file){
  fileName=file.name;
  document.getElementById('editor-filename').textContent=fileName;
  const buf=await file.arrayBuffer();
  pdfBytes=new Uint8Array(buf);
  pdfDoc=await pdfjsLib.getDocument({data:pdfBytes.slice()}).promise;
  // Seitenanzahl: pdf-lib
  pdfLibDoc=await PDFLib.PDFDocument.load(pdfBytes);
  totalPages=pdfLibDoc.getPageCount();
  currentPage=1;
  const kb=Math.round(pdfBytes.length/1024);
  document.getElementById('file-size-txt').textContent=kb>1024?`${(kb/1024).toFixed(1)} MB`:`${kb} KB`;
  await buildThumbs();
  await renderPage(currentPage);
  updateHistoryButtonVisibility(); 
  logRecent(fileName);
  goTo('editor');
}

window.addEventListener('load', async () => {
  // Direkt aus URL lesen, NICHT auf auth-badge.js warten (Race-Condition!)
  const params = new URLSearchParams(location.search);
  const shareToken = params.get('share');

  // Variante A: bereits von auth-badge.js gesetzt
  if (window.__pfSharedPDF) {
    return loadSharedFromObj(window.__pfSharedPDF);
  }

  // Variante B: Share-Token in URL, aber auth-badge.js noch nicht fertig
  if (shareToken && typeof pfGetSession === 'function') {
    const sess = pfGetSession();
    if (!sess) {
      console.warn('[PDFortis] Share-Link aber nicht eingeloggt');
      return;
    }
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/document_activity?share_token=eq.${encodeURIComponent(shareToken)}&select=*`,
        { headers: authHeaders(sess.user.access_token) }
      );
      const arr = await r.json();
      const row = arr?.[0];
      const valid = row && (!row.share_expires_at || new Date(row.share_expires_at) > new Date());
      if (!valid) {
        console.warn('[PDFortis] Share-Token ungültig/abgelaufen:', shareToken);
        return;
      }
      const pdfUrl = await sbGetSharedPDFUrl(shareToken, sess.user.access_token);
      if (!pdfUrl) {
        console.warn('[PDFortis] Signed URL konnte nicht erzeugt werden');
        return;
      }
      await loadSharedFromObj({ url: pdfUrl, name: row.document_name });
    } catch(e) {
      console.error('[PDFortis] Share-Load Fehler', e);
    }
  }
});
// ═══════════════════════════════════════
// AUDIT LOG — direkt im PDF eingebettet, kein Server-Storage nötig
// ═══════════════════════════════════════
const PF_AUDIT_KEY = 'PDFortisAudit';

async function getClientIp(){
  try{
    const r = await fetch('/api/ip');
    if(!r.ok) return null;
    const d = await r.json();
    return d.ip || null;
  }catch(e){ return null; }
}

function readAuditLog(pdfLibDocInstance){
  try{
    const raw = pdfLibDocInstance.catalog.get(PDFLib.PDFName.of(PF_AUDIT_KEY));
    if(!raw) return [];
    return JSON.parse(raw.decodeText());
  }catch(e){ return []; }
}

function writeAuditLog(pdfLibDocInstance, newEntries){
  const existing = readAuditLog(pdfLibDocInstance);
  const merged = existing.concat(newEntries);
  pdfLibDocInstance.catalog.set(
    PDFLib.PDFName.of(PF_AUDIT_KEY),
    PDFLib.PDFString.of(JSON.stringify(merged))
  );
}
  
function esc(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function renderHistoryOverlay(){
  const ol = document.getElementById('overlay-layer');
  ol.querySelectorAll('.pf-history-item').forEach(e=>e.remove());
  if(!historyOverlayOn || !pdfLibDoc) return;

  const entries = readAuditLog(pdfLibDoc).filter(e => e.page === currentPage);
  if(!entries.length) return;

  const canvas = document.getElementById('pdf-canvas');
  const page = pdfLibDoc.getPage(currentPage - 1);
  const {width: pdfW, height: pdfH} = page.getSize();
  const cssScale = parseFloat(canvas.style.width) / canvas.width;
  const scaleX = (canvas.width / pdfW) * cssScale;
  const scaleY = (canvas.height / pdfH) * cssScale;
  const canvasCssW = canvas.width * cssScale;
  const canvasCssH = canvas.height * cssScale;

  const actionLabels = {signed:'Signed', add_text:'Add Text', add_image:'Add Image', add_date:'Add Date', add_initials:'Add Initials'};
  const boxWidth = 150;
  const lineLen = 34;           // kurzer Strich statt bis zum Rand
  const gap = 8;                // Mindestabstand zwischen gestapelten Boxen
  const placed = { left: [], right: [] }; // schon platzierte Boxen pro Seite, zur Kollisionsprüfung

  entries.forEach(entry => {
    const anchorX = entry.x * scaleX;
    const anchorY = canvasCssH - (entry.y * scaleY);

// Immer am festen Canvas-Rand, egal wie weit die Änderung von dort weg ist
    const side = anchorX < canvasCssW / 2 ? 'right' : 'left';
    const boxLeft = side === 'right'
      ? canvasCssW - boxWidth - 8
      : 8;

    // Vertikale Kollision mit bereits platzierten Boxen derselben Seite vermeiden
    let boxTop = anchorY - 10;
    const stack = placed[side];
    for(const p of stack){
      if(boxTop < p.bottom + gap && boxTop + 60 > p.top - gap){
        boxTop = p.bottom + gap;
      }
    }
    boxTop = Math.max(4, Math.min(boxTop, canvasCssH - 70));

    const lineEndX = side === 'right' ? boxLeft : boxLeft + boxWidth;
    const line = document.createElement('div');
    line.className = 'pf-history-item';
    const dx = lineEndX - anchorX, dy = (boxTop+20) - anchorY;
    const len = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * 180/Math.PI;
    line.style.cssText = `position:absolute;left:${anchorX}px;top:${anchorY}px;width:${len}px;height:1px;background:rgba(156,163,175,.7);transform:rotate(${angle}deg);transform-origin:0 0;z-index:40;pointer-events:none;`;
    ol.appendChild(line);

    const box = document.createElement('div');
    box.className = 'pf-history-item';
    box.style.cssText = `position:absolute;left:${boxLeft}px;top:${boxTop}px;width:${boxWidth}px;background:rgba(243,244,246,.9);border:1px solid rgba(209,213,219,.7);border-radius:6px;padding:6px 8px;font-size:11px;color:#374151;z-index:41;pointer-events:none;`;
    box.innerHTML = `
      <div style="font-weight:600">${esc(entry.name)}</div>
      ${entry.email ? `<div style="color:#6b7280">${esc(entry.email)}</div>` : ''}
      <div>${new Date(entry.ts).toLocaleString(lang==='de'?'de-DE':'en-GB')}</div>
      <div>Action: ${esc(actionLabels[entry.action] || entry.action)}</div>
      ${entry.ip ? `<div style="color:#9ca3af">IP: ${esc(entry.ip)}</div>` : ''}
      ${entry.vpn ? `<div style="color:#f59e0b">⚠ Used VPN</div>` : ''}
    `;
    ol.appendChild(box);

    placed[side].push({ top: boxTop, bottom: boxTop + box.offsetHeight });
  });
}
// NEU — History-Toggle-Button-Logik, direkt dahinter:
let historyOverlayOn = false;

function updateHistoryButtonVisibility(){
  const section = document.getElementById('history-section');
  if(!section || !pdfLibDoc) return;
  const hasEntries = readAuditLog(pdfLibDoc).length > 0;
  section.style.display = hasEntries ? 'block' : 'none';
}

function toggleHistoryOverlay(){
  historyOverlayOn = document.getElementById('history-toggle-btn').checked;
  renderHistoryOverlay();
}

async function loadSharedFromObj({ url, name }) {
  showPdfLoader('Geteiltes Dokument wird geladen...');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Download fehlgeschlagen');
    const blob = await res.blob();
    const file = new File([blob], name || 'shared.pdf', { type: 'application/pdf' });
    await loadPDF(file);
  } catch(e) {
    console.error(e);
    alert('PDF konnte nicht geladen werden');
  } finally {
    hidePdfLoader();
  }
}

function showPdfLoader(msg = 'Lädt…') {
  let el = document.getElementById('pdf-loader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pdf-loader';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;font-family:system-ui';
    el.innerHTML = `
      <div style="width:48px;height:48px;border:4px solid #e0e7ff;border-top-color:#6366f1;border-radius:50%;animation:pfspin .8s linear infinite"></div>
      <div id="pdf-loader-msg" style="margin-top:16px;color:#374151;font-size:14px;font-weight:500"></div>
      <style>@keyframes pfspin{to{transform:rotate(360deg)}}</style>`;
    document.body.appendChild(el);
  }
  el.querySelector('#pdf-loader-msg').textContent = msg;
  el.style.display = 'flex';
}
function hidePdfLoader() {
  const el = document.getElementById('pdf-loader');
  if (el) el.style.display = 'none';
}

async function renderPage(n){
  if(!pdfBytes)return;
  const canvas=document.getElementById('pdf-canvas');
  const ol=document.getElementById('overlay-layer');
  const userEls=Array.from(ol.querySelectorAll('.pdf-overlay'));

  if(!pageImages[n]){
      pageImages[n] = await renderPageLocal(pdfDoc, n-1);
    }

  const img=pageImages[n];
  const vw=document.getElementById('canvas-area').clientWidth-48;
  const scale=Math.min(1,vw/img.width);

  // Backing-Store bleibt IMMER nativ (fix) — nur die CSS-Anzeigegröße
  // passt sich Viewport/Zoom an. So bleiben Pixel-Masken immer korrekt,
  // egal bei welchem Browser-Zoom.
  canvas.width=img.width;
  canvas.height=img.height;
  canvas.style.width=(img.width*scale)+'px';
  canvas.style.height=(img.height*scale)+'px';

  ol.style.width=canvas.style.width;
  ol.style.height=canvas.style.height;
  ol.innerHTML='';
  userEls.forEach(el=>ol.appendChild(el));
  const _ctx=canvas.getContext('2d',{willReadFrequently:true});
  _ctx.drawImage(img,0,0,canvas.width,canvas.height);
  // Editier-Masken (übermalte Originaltext-Bereiche) erneut auftragen
  (pageMasks[n]||[]).forEach(m=>{
    if(m.data){
      _ctx.putImageData(m.data, m.x, m.y);
    }else{
      _ctx.fillStyle=m.bg;
      _ctx.fillRect(m.x,m.y,m.w,m.h);
    }
  });
  loadTextItems(n, img.width, img.width*scale);

  document.getElementById('page-info-txt').textContent=`${n} / ${totalPages}`;
  document.querySelectorAll('.thumb-item').forEach((t,i)=>t.classList.toggle('active',i===n-1));
  renderHistoryOverlay(); 
}
   
async function loadTextItems(pageNum, imgWidth, canvasWidth){
  const ol=document.getElementById('overlay-layer');
  ol.querySelector('.pdf-text-layer')?.remove();

  const {items, pageWidth, pageHeight}=await extractPageLocal(pdfDoc, pageNum-1);
  window._pfItemCounts = window._pfItemCounts || {};
  window._pfItemCounts[pageNum] = items.length;

  // imgWidth ist 2x (Matrix 2,2) → native PDF Breite
  const pdfNativeWidth=imgWidth/2;
  // scale: wie viel Canvas-Pixel pro PDF-Punkt
  const scale=canvasWidth/pdfNativeWidth;

  // pageHeight vom Backend = echte PDF-Höhe in Punkten
  // canvasHeight berechnen damit top-Koordinaten stimmen
  const canvas=document.getElementById('pdf-canvas');
  const canvasHeight=canvas.height;

  const editActive=(editorMode==='edit'&&currentTab==='edit');

  const layer=document.createElement('div');
  layer.className='pdf-text-layer';
  layer.style.cssText='position:absolute;inset:0;overflow:hidden;pointer-events:none;';

  items.forEach((item, itemIdx) => {
    // Prüfen, ob für diese Textposition schon eine gespeicherte (noch nicht heruntergeladene) Änderung existiert
    const existingEdit = pendingEdits.find(e =>
      e.page===pageNum && Math.abs(e.x-item.x)<1 && Math.abs(e.y-item.y)<1
    );

    const span=document.createElement('span');
    span.className='pdf-text-item';
    span.textContent = existingEdit ? existingEdit.newText : item.text;
    span.dataset.originalText = existingEdit ? existingEdit.spanOrigText : item.text;
    span.dataset.editedText   = existingEdit ? existingEdit.newText : item.text;

    //neu
    span.dataset.pdfItemIndex = itemIdx;
    
    span.dataset.pageNumber=pageNum;
    span.dataset.pdfX=item.x;
    span.dataset.pdfY=item.y;
    span.dataset.pdfX1=item.x1;
    span.dataset.pdfY1=item.y1;
    span.dataset.pdfFontSize=item.size;
    span.dataset.pdfPageHeight=pageHeight;
    span.dataset.pdfColor=item.color||0;
    span.dataset.pdfFont=item.font||'';
    span.dataset.pdfFlags=item.flags||0;

    // Farbe (PyMuPDF gibt int sRGB)
    const ci=item.color|0;
    const r=(ci>>16)&255, g=(ci>>8)&255, b=ci&255;
    const rgb=`rgb(${r},${g},${b})`;

    // Font-Family aus Fontnamen ableiten
    const fn=(item.font||'').toLowerCase();
    const fl=item.flags||0;
    let family='Arial, Helvetica, sans-serif';
    if(fl&8 || /mono|courier/.test(fn))      family='"Courier New", Courier, monospace';
    else if(fl&4 || /times|roman|serif/.test(fn)) family='"Times New Roman", Times, serif';
    else if(/helv|arial|sans/.test(fn))      family='Arial, Helvetica, sans-serif';
    const weight=(fl&16 || /bold/.test(fn))?'700':'400';
    const style =(fl&2  || /italic|oblique/.test(fn))?'italic':'normal';

    const left=item.x*scale;
    const top =item.y*scale;
    const w=(item.x1-item.x)*scale;
    const h=(item.y1-item.y)*scale;

    span.style.cssText=`
      position:absolute;
      left:${left}px;
      top:${top}px;
      width:${Math.max(w,20)}px;
      height:${Math.max(h,10)}px;
      font-size:${item.size*scale}px;
      line-height:${h}px;
      font-family:${family};
      font-weight:${weight};
      font-style:${style};
      color:transparent;
      white-space:pre;
      cursor:text;
      overflow:visible;
      pointer-events:${editActive?'all':'none'};
    `;
    // Original-Farbe für später speichern
  // Original-Farbe für später speichern
    span.dataset.cssColor=rgb;
    span.dataset.cssFamily=family;
    span.dataset.cssWeight=weight;
    span.dataset.cssStyle=style;    

    if(existingEdit){
      span.style.color = rgb;         // sichtbar statt transparent
      span.classList.add('is-edited');
    }

    layer.appendChild(span);
  });

  layer.style.pointerEvents=editActive?'all':'none';
  ol.appendChild(layer);
}
   
async function buildThumbs(){
  const panel=document.getElementById('pages-panel');
  panel.innerHTML='';
  for(let i=1;i<=totalPages;i++){
    const wrap=document.createElement('div');
    wrap.className='thumb-item'+(i===1?' active':'');
    wrap.onclick=(()=>{const pg=i;return()=>{currentPage=pg;renderPage(pg)}})();
    const tc=document.createElement('canvas');
    wrap.appendChild(tc);
    const num=document.createElement('div');
    num.className='thumb-num';num.textContent=i;
    wrap.appendChild(num);
    panel.appendChild(wrap);

    const img=await renderPageLocal(pdfDoc, i-1);
    tc.width=80;tc.height=80*(img.height/img.width);
    tc.getContext('2d').drawImage(img,0,0,tc.width,tc.height);
  }
}

function prevPage(){if(currentPage>1){currentPage--;renderPage(currentPage)}}
function nextPage(){if(currentPage<totalPages){currentPage++;renderPage(currentPage)}}

// ═══════════════════════════════════════
// EDITOR MODE
// ═══════════════════════════════════════
function setMode(m){
  editorMode=m;
  ['look','edit'].forEach(x=>{document.getElementById('mode-'+x).classList.toggle('active',x===m)});
  const ca=document.getElementById('canvas-area');
  ca.className='canvas-area '+(m==='look'?'look-mode':'edit-mode');
  const ol=document.getElementById('overlay-layer');
  ol.style.pointerEvents=m==='edit'?'all':'none';
  // Text-layer direkt updaten ohne Event
  const editActive=(m==='edit'&&currentTab==='edit');
  const layer=document.querySelector('.pdf-text-layer');
  if(layer){
    layer.style.pointerEvents=editActive?'all':'none';
    layer.querySelectorAll('.pdf-text-item').forEach(s=>{
      if(!s.classList.contains('editing')){
        s.style.pointerEvents=editActive?'all':'none';
      }
    });
  }
}

// ═══════════════════════════════════════
// RIBBON TABS
// ═══════════════════════════════════════
function switchRTab(tab){
  if(tab==='nav'){setMode('look')}
  currentTab=tab;
  document.querySelectorAll('.rtab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
  document.querySelectorAll('.ribbon-panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+tab));
  if(tab==='sign'&&!currentUser&&!currentToken){showSignLock();return}
  // Text-layer und Spans sofort auf korrekten State setzen
  const editActive=(tab==='edit'&&editorMode==='edit');
  const layer=document.querySelector('.pdf-text-layer');
  if(layer){
    layer.style.pointerEvents=editActive?'all':'none';
    layer.querySelectorAll('.pdf-text-item').forEach(s=>{
      if(!s.classList.contains('editing')){
        s.style.pointerEvents=editActive?'all':'none';
      }
    });
  }
  // Edit-Mode automatisch aktivieren wenn Edit-Tab gewählt
  if(tab==='edit'&&editorMode!=='edit'){setMode('edit')}
}

// ═══════════════════════════════════════
// TEXT BOX (Add)
// ═══════════════════════════════════════
function addTextBox(x,y){
  if(!pdfLibDoc){toast('Lade zuerst ein PDF','err');return}
  const ol=document.getElementById('overlay-layer');
  const canvas=document.getElementById('pdf-canvas');

  const wrap=document.createElement('div');
  wrap.className='pf-tbox-wrap selected';
  wrap.dataset.pfAction='add_text';
  wrap.dataset.pfPage=currentPage;
  wrap.dataset.pfCanvasW=canvas.width;
  wrap.dataset.pfCanvasH=canvas.height;
  wrap.style.cssText=`position:absolute;left:${x}px;top:${y}px;width:200px;min-width:80px;min-height:28px;z-index:30;`;

  // ── TOOLBAR ──
  const tb=document.createElement('div');
  tb.className='pf-tbox-toolbar';

  const fontSel=document.createElement('select');
  fontSel.className='pf-tb-select';fontSel.style.width='88px';
  ['Arial','Times New Roman','Courier New','Georgia','Verdana'].forEach(f=>{
    const o=document.createElement('option');o.value=f;o.textContent=f;fontSel.appendChild(o);
  });
  const sizeInp=document.createElement('input');
  sizeInp.type='number';sizeInp.value='14';sizeInp.min='6';sizeInp.max='96';
  sizeInp.className='pf-tb-select';sizeInp.style.width='44px';

  const btnB=document.createElement('button');btnB.className='pf-tb-btn';btnB.innerHTML='<b>B</b>';
  const btnI=document.createElement('button');btnI.className='pf-tb-btn';btnI.innerHTML='<i>I</i>';
  const btnU=document.createElement('button');btnU.className='pf-tb-btn';btnU.innerHTML='<u>U</u>';
  const colorPick=document.createElement('input');
  colorPick.type='color';colorPick.value='#000000';colorPick.className='pf-tb-color';
  const dragH=document.createElement('div');
  dragH.className='pf-tbox-drag';dragH.innerHTML='⠿';dragH.title='Verschieben';
  const delBtn=document.createElement('button');
  delBtn.className='pf-tb-btn';delBtn.innerHTML='✕';delBtn.style.color='#f87171';

  const mk=()=>{const d=document.createElement('div');d.className='pf-tb-sep';return d};
  tb.append(fontSel,mk(),sizeInp,mk(),btnB,btnI,btnU,mk(),colorPick,dragH,delBtn);

  // ── BODY ──
  const body=document.createElement('div');
  body.contentEditable='true';
  body.className='pf-tbox-body';
  body.spellcheck=false;
  body.style.cssText='width:100%;min-height:28px;outline:none;border:1.5px dashed #6366f1;border-radius:4px;padding:5px 8px;font-size:14px;line-height:1.5;color:#000;background:rgba(255,255,255,0.96);white-space:pre-wrap;word-break:break-word;cursor:text;box-sizing:border-box;font-family:Arial,sans-serif;';

  // ── RESIZE HANDLE ──
  const resH=document.createElement('div');
  resH.className='pf-tbox-resize';
  resH.style.cssText='position:absolute;right:-5px;bottom:-5px;width:14px;height:14px;background:#6366f1;border:2px solid white;border-radius:3px;cursor:se-resize;z-index:10;';

  wrap.appendChild(tb);
  wrap.appendChild(body);
  wrap.appendChild(resH);
  ol.appendChild(wrap);
  pushHistory({undo:()=>wrap.remove(),redo:()=>ol.appendChild(wrap)});

  // ── DRAG (nur über ⠿ Handle) ──
  let dSx,dSy,dLx,dLy,dragging=false;
  dragH.addEventListener('mousedown',e=>{
    e.stopPropagation();e.preventDefault();
    dragging=true;
    dSx=e.clientX;dSy=e.clientY;
    dLx=parseInt(wrap.style.left)||0;
    dLy=parseInt(wrap.style.top)||0;
    const mv=e2=>{
      if(!dragging)return;
      wrap.style.left=(dLx+e2.clientX-dSx)+'px';
      wrap.style.top=(dLy+e2.clientY-dSy)+'px';
    };
    const up=()=>{
      dragging=false;document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
      const nx=parseInt(wrap.style.left)||0, ny=parseInt(wrap.style.top)||0;
      if(nx!==dLx||ny!==dLy){
        pushHistory({
          undo:()=>{wrap.style.left=dLx+'px';wrap.style.top=dLy+'px'},
          redo:()=>{wrap.style.left=nx+'px';wrap.style.top=ny+'px'}
        });
      }
    };
    document.addEventListener('mousemove',mv);
    document.addEventListener('mouseup',up);
  });

  // ── RESIZE ──
  let rSx,rSy,rW,rH,resizing=false;
  resH.addEventListener('mousedown',e=>{
    e.stopPropagation();e.preventDefault();
    resizing=true;
    rSx=e.clientX;rSy=e.clientY;
    rW=wrap.offsetWidth;rH=wrap.offsetHeight;
    const mv=e2=>{
      if(!resizing)return;
      wrap.style.width=Math.max(80,rW+e2.clientX-rSx)+'px';
      wrap.style.height=Math.max(28,rH+e2.clientY-rSy)+'px';
      body.style.height='100%';
    };
    const up=()=>{
      resizing=false;document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
      const nw=wrap.offsetWidth, nh=wrap.offsetHeight;
      if(nw!==rW||nh!==rH){
        pushHistory({
          undo:()=>{wrap.style.width=rW+'px';wrap.style.height=rH+'px';body.style.height='100%'},
          redo:()=>{wrap.style.width=nw+'px';wrap.style.height=nh+'px';body.style.height='100%'}
        });
      }
    };
    document.addEventListener('mousemove',mv);
    document.addEventListener('mouseup',up);
  });

  // ── TOOLBAR AKTIONEN ──
  fontSel.addEventListener('change',()=>{body.style.fontFamily=fontSel.value});
  sizeInp.addEventListener('input',()=>{body.style.fontSize=sizeInp.value+'px'});
  colorPick.addEventListener('input',()=>{body.style.color=colorPick.value});
  let bold=false,italic=false,underline=false;
  btnB.addEventListener('click',e=>{e.stopPropagation();bold=!bold;body.style.fontWeight=bold?'700':'400';btnB.classList.toggle('on',bold)});
  btnI.addEventListener('click',e=>{e.stopPropagation();italic=!italic;body.style.fontStyle=italic?'italic':'normal';btnI.classList.toggle('on',italic)});
  btnU.addEventListener('click',e=>{e.stopPropagation();underline=!underline;body.style.textDecoration=underline?'underline':'none';btnU.classList.toggle('on',underline)});
  delBtn.addEventListener('click',e=>{
    e.stopPropagation();
    wrap.remove();
    pushHistory({undo:()=>ol.appendChild(wrap),redo:()=>wrap.remove()});
  });

  // ── Klick innerhalb wrap → nicht nach außen bubblen (verhindert sofortiges neues addTextBox) ──
  wrap.addEventListener('click',e=>e.stopPropagation());

  setTimeout(()=>body.focus(),30);
}

function pfTboxDeselect(wrap){
  if(!wrap||!wrap.classList.contains('pf-tbox-wrap'))return;
  wrap.classList.remove('selected');
  const body=wrap.querySelector('.pf-tbox-body');
  if(!body)return;
  body.contentEditable='false';
  if(!body.textContent.trim()){wrap.remove();return}
  body.style.border='none';
  body.style.background='transparent';
  body.addEventListener('click',()=>{
    body.contentEditable='true';
    wrap.classList.add('selected');
    body.style.border='1.5px dashed #6366f1';
    body.style.background='rgba(255,255,255,0.96)';
    body.focus();
  },{once:true});
}

  
function addDateBox(){
  if(!pdfLibDoc){toast('Load a PDF first','err');return}
  setMode('edit');
  const ol=document.getElementById('overlay-layer');
  const el=document.createElement('div');
  el.contentEditable='true';
  el.className='pdf-overlay pdf-text-box';
  el.style.left='60px';el.style.top='140px';
  el.textContent=new Date().toLocaleDateString(lang==='de'?'de-DE':'en-GB');
  addDelBtn(el);
  makeDraggable(el);
  ol.appendChild(el);
  pushHistory({undo:()=>el.remove(),redo:()=>ol.appendChild(el)});
}

function addInitials(){
  if(!pdfDoc){toast('Load a PDF first','err');return}
  const ol=document.getElementById('overlay-layer');
  const el=document.createElement('div');
  el.contentEditable='true';
  el.className='pdf-overlay pdf-text-box';
  el.style.left='60px';el.style.top='180px';
  el.style.fontWeight='800';el.style.fontSize='18px';
  el.textContent='A.B.';
  addDelBtn(el);
  makeDraggable(el);
  ol.appendChild(el);
  pushHistory({undo:()=>el.remove(),redo:()=>ol.appendChild(el)});
}

function addImageOverlay(){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='image/*';
  inp.onchange=e=>{
    const f=e.target.files[0];if(!f)return;
    const rd=new FileReader();
    rd.onload=ev=>{
      const wrap=document.createElement('div');
      wrap.className='pdf-overlay';
      wrap.dataset.pfAction='add_image';
      wrap.style.cssText='position:absolute;left:80px;top:80px;z-index:10;display:inline-block;';

      const del=document.createElement('button');
      del.innerHTML='&times;';
      del.style.cssText=`
        position:absolute;top:-10px;right:-10px;
        width:22px;height:22px;
        background:#ef4444;color:white;
        border:2px solid white;border-radius:50%;
        font-size:14px;font-weight:700;
        cursor:pointer;display:none;
        align-items:center;justify-content:center;
        line-height:1;z-index:20;
        box-shadow:0 2px 6px rgba(0,0,0,.25);
      `;
      del.onclick=e=>{
        e.stopPropagation();
        const parent=wrap.parentNode;
        wrap.remove();
        pushHistory({undo:()=>parent.appendChild(wrap),redo:()=>wrap.remove()});
      };
      wrap.appendChild(del);
      wrap.addEventListener('mouseenter',()=>del.style.display='flex');
      wrap.addEventListener('mouseleave',()=>del.style.display='none');

      const img=document.createElement('img');
      img.src=ev.target.result;
      img.style.cssText='max-width:240px;display:block;border-radius:3px;border:2px dashed #6366f1;pointer-events:none;';
      img.draggable=false;
      wrap.appendChild(img);

      // Drag
      let sx,sy,il,it,dragging=false;
      wrap.addEventListener('mousedown',e=>{
        if(e.target===del)return;
        dragging=true;
        sx=e.clientX;sy=e.clientY;
        il=parseInt(wrap.style.left)||0;it=parseInt(wrap.style.top)||0;
        e.preventDefault();
      });
      document.addEventListener('mousemove',e=>{
        if(!dragging)return;
        wrap.style.left=(il+e.clientX-sx)+'px';
        wrap.style.top=(it+e.clientY-sy)+'px';
      });
      document.addEventListener('mouseup',()=>{
        if(!dragging)return;
        dragging=false;
        const nl=parseInt(wrap.style.left)||0, nt=parseInt(wrap.style.top)||0;
        if(nl!==il||nt!==it){
          pushHistory({
            undo:()=>{wrap.style.left=il+'px';wrap.style.top=it+'px'},
            redo:()=>{wrap.style.left=nl+'px';wrap.style.top=nt+'px'}
          });
        }
      });

      const ol_ = document.getElementById('overlay-layer');
      ol_.appendChild(wrap);
      pushHistory({undo:()=>wrap.remove(),redo:()=>ol_.appendChild(wrap)});
    };rd.readAsDataURL(f);
  };inp.click();
}
function addDelBtn(el){
  const btn=document.createElement('button');
  btn.className='overlay-delete';
  btn.innerHTML='&times;';
  btn.onclick=e=>{
    e.stopPropagation();e.preventDefault();
    const parent=el.parentNode;
    el.remove();
    pushHistory({undo:()=>parent.appendChild(el),redo:()=>el.remove()});
  };
  // Position nur setzen wenn noch nicht gesetzt
  if(!el.style.position||el.style.position==='static'){
    el.style.position='absolute';
  }
  el.appendChild(btn);
}

// ═══════════════════════════════════════
// FORMAT (ribbon Edit tab)
// ═══════════════════════════════════════
function applyFormat(cmd){
  const sel=window.getSelection();
  if(!sel||sel.rangeCount===0)return;
  if(cmd==='bold'){document.execCommand('bold')}
  else if(cmd==='italic'){document.execCommand('italic')}
  else if(cmd==='underline'){document.execCommand('underline')}
  else if(cmd==='font'){document.execCommand('fontName',false,document.getElementById('font-family').value)}
  else if(cmd==='size'){document.execCommand('fontSize',false,'3');const nodes=document.querySelectorAll('font[size="3"]');nodes.forEach(n=>{n.removeAttribute('size');n.style.fontSize=document.getElementById('font-size').value+'px'})}
  else if(cmd==='color'){document.execCommand('foreColor',false,document.getElementById('text-color').value)}
  else if(cmd==='align-left'){document.execCommand('justifyLeft')}
  else if(cmd==='align-center'){document.execCommand('justifyCenter')}
}

// ═══════════════════════════════════════
// DRAGGABLE
// ═══════════════════════════════════════
function makeDraggable(el){
  let sx,sy,il,it;
  el.addEventListener('mousedown',e=>{
    if(e.target.contentEditable==='true'&&e.target!==el)return;
    if(e.target.tagName==='BUTTON')return;
    sx=e.clientX;sy=e.clientY;
    il=parseInt(el.style.left)||0;it=parseInt(el.style.top)||0;
    function mv(e){el.style.left=(il+e.clientX-sx)+'px';el.style.top=(it+e.clientY-sy)+'px'}
    function up(){
      document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
      const nl=parseInt(el.style.left)||0, nt=parseInt(el.style.top)||0;
      if(nl!==il||nt!==it){
        pushHistory({
          undo:()=>{el.style.left=il+'px';el.style.top=it+'px'},
          redo:()=>{el.style.left=nl+'px';el.style.top=nt+'px'}
        });
      }
    }
    document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    e.preventDefault();
  });
}

// ═══════════════════════════════════════
// SIGNATURE
// ═══════════════════════════════════════
(function initSig(){
  window.addEventListener('load',()=>{
    const c=document.getElementById('sig-canvas');
    if(!c)return;
    const ctx=c.getContext('2d');
    ctx.lineWidth=2.5;ctx.strokeStyle='#111';ctx.lineCap='round';ctx.lineJoin='round';
    function pos(e){const r=c.getBoundingClientRect();return[(e.clientX-r.left)*(c.width/r.width),(e.clientY-r.top)*(c.height/r.height)]}
    c.addEventListener('mousedown',e=>{sigDrawing=true;[sigLX,sigLY]=pos(e);ctx.beginPath();ctx.moveTo(sigLX,sigLY)});
    c.addEventListener('mousemove',e=>{if(!sigDrawing)return;const[x,y]=pos(e);ctx.lineTo(x,y);ctx.stroke();sigLX=x;sigLY=y});
    ['mouseup','mouseleave'].forEach(ev=>c.addEventListener(ev,()=>sigDrawing=false));
    c.addEventListener('touchstart',e=>{e.preventDefault();c.dispatchEvent(new MouseEvent('mousedown',{clientX:e.touches[0].clientX,clientY:e.touches[0].clientY}))},{passive:false});
    c.addEventListener('touchmove',e=>{e.preventDefault();c.dispatchEvent(new MouseEvent('mousemove',{clientX:e.touches[0].clientX,clientY:e.touches[0].clientY}))},{passive:false});
    c.addEventListener('touchend',()=>sigDrawing=false);
  });
})();

function clearSig(){const c=document.getElementById('sig-canvas');c.getContext('2d').clearRect(0,0,c.width,c.height)}
function applySig(){placeSig(document.getElementById('sig-canvas').toDataURL());closeModal('sign-modal')}
function applyTypedSig(){placeSig(document.getElementById('typed-sig-canvas').toDataURL());closeModal('sign-modal')}
function loadSigImage(e){const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>{placeSig(ev.target.result);closeModal('sign-modal')};r.readAsDataURL(f)}

function placeSig(src){
  const ol=document.getElementById('overlay-layer');
  const wrap=document.createElement('div');
  wrap.className='pdf-overlay';
  wrap.dataset.pfAction='signed';
  wrap.style.cssText='position:absolute;left:80px;top:100px;width:180px;display:inline-block;';
  const img=document.createElement('img');
  img.src=src;img.className='pdf-img-overlay';
  img.style.cssText='display:block;width:100%;pointer-events:none;';
  wrap.appendChild(img);
  addDelBtn(wrap);makeDraggable(wrap);
  ol.appendChild(wrap);
  pushHistory({undo:()=>wrap.remove(),redo:()=>ol.appendChild(wrap)});
  setMode('edit');
  toast(lang==='de'?'Unterschrift eingefügt':'Signature inserted — drag to position');
}

function updateTypedSig(){
  const t=document.getElementById('sig-type-input').value||'Signature';
  const f=document.getElementById('sig-font').value;
  const c=document.getElementById('typed-sig-canvas');
  const ctx=c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  ctx.font=`38px ${f}`;ctx.fillStyle='#111';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(t,c.width/2,c.height/2);
}

function switchSignTab(t){
  ['draw','type','upload'].forEach(x=>{
    document.getElementById('sp-'+x).classList.toggle('active',x===t);
    document.getElementById('sp-'+x).style.display=x===t?'block':'none';
  });
  document.querySelectorAll('.sign-tab').forEach((b,i)=>b.classList.toggle('active',['draw','type','upload'][i]===t));
  if(t==='type')updateTypedSig();
}

// ═══════════════════════════════════════
// ORGANIZE
// ═══════════════════════════════════════
async function rotatePage(){
  if(!pdfLibDoc){toast('No document loaded','err');return}
  const rotatedPage=currentPage;
  const pages=pdfLibDoc.getPages();
  const p=pages[currentPage-1];
  p.setRotation(PDFLib.degrees((p.getRotation().angle+90)%360));
  await refreshDoc();
  toast(lang==='de'?'Seite gedreht':'Page rotated 90°');

  pushHistory({
    undo: async ()=>{
      const pg=pdfLibDoc.getPages()[rotatedPage-1];
      pg.setRotation(PDFLib.degrees((pg.getRotation().angle+270)%360));
      currentPage=rotatedPage;
      await refreshDoc();
    },
    redo: async ()=>{
      const pg=pdfLibDoc.getPages()[rotatedPage-1];
      pg.setRotation(PDFLib.degrees((pg.getRotation().angle+90)%360));
      currentPage=rotatedPage;
      await refreshDoc();
    }
  });
}

async function deletePage(){
  if(!pdfLibDoc||totalPages<=1){toast(lang==='de'?'Mindestens eine Seite':'At least one page required','err');return}
  if(!confirm(lang==='de'?`Seite ${currentPage} löschen?`:`Delete page ${currentPage}?`))return;

  const deletedIndex = currentPage - 1;
  // Seite für Undo separat sichern, bevor sie entfernt wird
  const holder = await PDFLib.PDFDocument.create();
  const [copiedPage] = await holder.copyPages(pdfLibDoc, [deletedIndex]);
  holder.addPage(copiedPage);
  const holderBytes = await holder.save();

  pdfLibDoc.removePage(deletedIndex);
  pdfBytes=await pdfLibDoc.save();
  pdfDoc=await pdfjsLib.getDocument({data:pdfBytes.slice()}).promise;
  totalPages=pdfDoc.numPages;
  currentPage=Math.min(currentPage,totalPages);
  await buildThumbs();
  await renderPage(currentPage);
  toast(lang==='de'?'Seite gelöscht':'Page deleted');

  pushHistory({
    undo: async ()=>{
      const holderDoc = await PDFLib.PDFDocument.load(holderBytes);
      const [restoredPage] = await pdfLibDoc.copyPages(holderDoc,[0]);
      pdfLibDoc.insertPage(deletedIndex, restoredPage);
      currentPage = deletedIndex+1;
      await refreshDoc();
    },
    redo: async ()=>{
      pdfLibDoc.removePage(deletedIndex);
      currentPage = Math.min(deletedIndex+1, pdfLibDoc.getPageCount());
      await refreshDoc();
    }
  });
}

function mergePDFs(){
  const inp=document.createElement('input');inp.type='file';inp.accept='.pdf';inp.multiple=true;
  inp.onchange=async e=>{
    const files=Array.from(e.target.files);if(!files.length)return;
    toast(lang==='de'?'PDFs werden zusammengeführt...':'Merging PDFs...');
    const merged=await PDFLib.PDFDocument.create();
    if(pdfLibDoc){const pgs=await merged.copyPages(pdfLibDoc,pdfLibDoc.getPageIndices());pgs.forEach(p=>merged.addPage(p))}
    for(const f of files){const b=new Uint8Array(await f.arrayBuffer());const doc=await PDFLib.PDFDocument.load(b);const pgs=await merged.copyPages(doc,doc.getPageIndices());pgs.forEach(p=>merged.addPage(p))}
    pdfBytes=await merged.save();pdfLibDoc=merged;
    pdfDoc=await pdfjsLib.getDocument({data:pdfBytes.slice()}).promise;
    totalPages=pdfDoc.numPages;currentPage=1;
    await buildThumbs();await renderPage(1);
    toast(`${lang==='de'?'Zusammengeführt':'Merged'}: ${totalPages} ${lang==='de'?'Seiten':'pages'}`);
  };inp.click();
}

async function refreshDoc(){
  pdfBytes=await pdfLibDoc.save();
  pdfDoc=await pdfjsLib.getDocument({data:pdfBytes.slice()}).promise;
  totalPages=pdfDoc.numPages;
  await buildThumbs();await renderPage(currentPage);
}

// ═══════════════════════════════════════
// COMPRESS
// ═══════════════════════════════════════
function setQ(q){
  compressQ=q;
  document.querySelectorAll('.qbtn').forEach(b=>{
    const map={high:'q_high',medium:'q_med',low:'q_low'};
    b.classList.toggle('active',b.dataset.i===map[q]||(q==='high'&&b.textContent==='High')||(q==='medium'&&(b.textContent==='Med'||b.textContent==='Mittel'))||(q==='low'&&(b.textContent==='Small'||b.textContent==='Klein')));
  });
}
async function compressAndSave(){
  if(!pdfLibDoc){toast('No document loaded','err');return}
  const bytes=await pdfLibDoc.save({useObjectStreams:true});
  const before=pdfBytes.length,after=bytes.length;
  const saved=Math.max(0,Math.round((1-after/before)*100));
  const blob=new Blob([bytes],{type:'application/pdf'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='compressed_'+fileName;a.click();
  URL.revokeObjectURL(url);
  toast(`${lang==='de'?'Gespeichert':'Saved'}${saved>0?` (${saved}% ${lang==='de'?'kleiner':'smaller'})`:''}`)
}

// ═══════════════════════════════════════
// DOWNLOAD GATE
// ═══════════════════════════════════════
async function triggerDownload(){
  if(!pdfLibDoc){toast('No document loaded','err');return}
  if(currentToken || isPaidUser()){await logTokenUsage('download');await performDownload();return}

  if(!isLoggedIn()){
    // Guest path — mirrors translate: 1 free, then sign-up wall
    if(guestDLUsed() >= CONFIG.GUEST_DL_LIMIT){
      document.getElementById('auth-modal')?.classList.remove('hidden');
      return;
    }
    incGuestDLUsed();
    updateDLDisplay();
    await performDownload();
    return;
  }

  // Logged-in path — daily cap
  const lsCount=getLSDLCount();
  let sbCount=0;
  try{sbCount=await sbGetDLCount(await getFingerprint())}catch(e){}
  const used=Math.max(lsCount,sbCount);
  if(!isPaidUser() && used>=MAX_DL){showLimitModal();return}
  logLSDL();
  try{await sbLogDL(await getFingerprint())}catch(e){}
  updateDLDisplay();
  await performDownload();
}

async function performDownload(){
  toast(lang==='de'?'PDF wird gespeichert...':'Saving PDF...','info');

  try{
    // ── Schritt 1: Edit-Text Änderungen via Backend einbetten ──
    let workBytes = pdfBytes;
    if(pendingEdits.length > 0){
      workBytes = await editBatchLocal(workBytes, pendingEdits);
      pendingEdits = [];
      pageImages = {};
      pageMasks = {};

      // Bearbeitete Version wird die neue Arbeitsgrundlage — unsichtbar für den Nutzer,
      // aber jetzt sind PDF-Bytes/Textlayer/Masken wieder konsistent zueinander
      pdfBytes = workBytes;
      pdfDoc = await pdfjsLib.getDocument({data:pdfBytes.slice()}).promise;
      pdfLibDoc = await PDFLib.PDFDocument.load(pdfBytes);
      await renderPage(currentPage);
    }

// ── Schritt 2: Add-Text & Bild-Overlays via pdf-lib einbetten ──
    const overlays = document.querySelectorAll('#overlay-layer .pdf-overlay, #overlay-layer .pf-tbox-wrap');
    if(overlays.length > 0){
      const doc = await PDFLib.PDFDocument.load(workBytes);
      const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const liveCanvas = document.getElementById('pdf-canvas');

      const dataURLToBytes = (dataURL) => {
        const base64 = dataURL.split(',')[1];
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        return bytes;
      };
     
      const auditEntries = [];
      
      for(const wrap of overlays){
        const boxPage = parseInt(wrap.dataset.pfPage, 10) || currentPage;
        const page = doc.getPage(boxPage - 1);
        const {width: pdfW, height: pdfH} = page.getSize();
        const canvasW = parseFloat(wrap.dataset.pfCanvasW) || liveCanvas.width;
        const canvasH = parseFloat(wrap.dataset.pfCanvasH) || liveCanvas.height;
        const scaleX = pdfW / canvasW;
        const scaleY = pdfH / canvasH;

        // ── Bild-Overlay (Signatur oder hochgeladenes Bild) ──
        const imgEl = wrap.tagName === 'IMG' ? wrap : wrap.querySelector('img');
        if(imgEl){
          try{
            const isPng = imgEl.src.startsWith('data:image/png');
            const bytes = dataURLToBytes(imgEl.src);
            const embedded = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);

            const dispW = imgEl.offsetWidth  || 180;
            const dispH = imgEl.offsetHeight || 80;
            const wrapLeft = parseFloat(wrap.style.left) || 0;
            const wrapTop  = parseFloat(wrap.style.top)  || 0;

            const pdfImgW = dispW * scaleX;
            const pdfImgH = dispH * scaleY;
            const pdfX = wrapLeft * scaleX;
            const pdfY = pdfH - (wrapTop * scaleY) - pdfImgH;

            page.drawImage(embedded, {x: pdfX, y: pdfY, width: pdfImgW, height: pdfImgH});
            auditEntries.push({
              name: currentUser?.name || 'Anonymous',
              email: currentUser?.email || null,
              ts: new Date().toISOString(),
              action: wrap.dataset.pfAction || 'add_image',
              page: boxPage, x: pdfX, y: pdfY
            });            
          }catch(e){ console.warn('Image overlay embed failed', e); }
          continue;
        }

        // ── Text-Box (Add Text / Date / Initials) ──
        const box = wrap.querySelector('.pdf-text-box, [contenteditable]');
        if(!box) continue;
        const text = box.innerText?.trim();
        if(!text) continue;

        const wrapLeft = parseFloat(wrap.style.left) || 0;
        const wrapTop  = parseFloat(wrap.style.top)  || 0;

        const pdfX = wrapLeft * scaleX;
        const pdfY = pdfH - (wrapTop * scaleY) - (parseFloat(getComputedStyle(box).fontSize) * scaleY);

        const fontSize = parseFloat(getComputedStyle(box).fontSize) * scaleX;
        const colorRaw = getComputedStyle(box).color;
        const rgb = colorRaw.match(/\d+/g)||['0','0','0'];
        const color = PDFLib.rgb(parseInt(rgb[0])/255, parseInt(rgb[1])/255, parseInt(rgb[2])/255);

        const lines = text.split('\n');
        const lineH = fontSize * 1.3;
        lines.forEach((line, i) => {
          if(!line.trim()) return;
          page.drawText(line, {
            x: pdfX,
            y: pdfY - (i * lineH),
            size: Math.max(6, fontSize),
            font,
            color
          });
        });
        auditEntries.push({
          name: currentUser?.name || 'Anonymous',
          email: currentUser?.email || null,
          ts: new Date().toISOString(),
          action: wrap.dataset.pfAction || 'add_text',
          page: boxPage, x: pdfX, y: pdfY
        });        
      }
      if(auditEntries.length){
        const ip = await getClientIp();
        auditEntries.forEach(e => e.ip = ip);
        writeAuditLog(doc, auditEntries);
      }
      workBytes = await doc.save();
    }

    // ── Schritt 2b: Translation Overlays via pdf-lib einbetten (alle übersetzten Seiten) ──
    const pft = window.PFTranslate;
    const overlayPages = pft ? await pft.buildDownloadOverlayData() : [];
    if (overlayPages.length){
      const doc2 = await PDFLib.PDFDocument.load(workBytes);
      const font2 = await doc2.embedFont(PDFLib.StandardFonts.Helvetica);
      for (const pd of overlayPages){
        const page2 = doc2.getPage(pd.page - 1);
        const {width: pdfW2, height: pdfH2} = page2.getSize();
        const scaleX2 = pdfW2 / pd.pageWidth;
        const scaleY2 = pdfH2 / pd.pageHeight;
        pd.items.forEach(it => {
          const pdfX2 = it.x * scaleX2;
          const pdfY2 = pdfH2 - ((it.y + it.h) * scaleY2);
          page2.drawRectangle({
            x: pdfX2, y: pdfY2, width: it.w * scaleX2, height: it.h * scaleY2,
            color: PDFLib.rgb(it.bg[0]/255, it.bg[1]/255, it.bg[2]/255),
          });
          // it.lines: Array bereits umgebrochener Zeilen (buildDownloadOverlayData()
          // liefert seit der Absatz-Gruppierung mehrzeiligen Text). PDFLib bricht
          // \n nicht selbst um -> zeilenweise zeichnen, von oben nach unten.
          const lines = it.lines && it.lines.length ? it.lines : [it.text];
          const lineHeightPdf = (it.lineHeight || it.fontSize * 1.18) * scaleY2;
          const fontSizePdf = Math.max(6, it.fontSize * scaleY2);
          let lineY = pdfY2 + it.h * scaleY2 - lineHeightPdf * 0.85;
          lines.forEach(lineText => {
            if (lineY < pdfY2) return; // Absatz überläuft nach unten -> abschneiden statt Nachbartext zu überschreiben
            page2.drawText(lineText, {
              x: pdfX2, y: lineY,
              size: fontSizePdf,
              font: font2,
              color: PDFLib.rgb(it.color[0]/255, it.color[1]/255, it.color[2]/255),
            });
            lineY -= lineHeightPdf;
          });
        });
      }
      workBytes = await doc2.save();
    }
    
    // ── Schritt 3: Download ──
    const blob = new Blob([workBytes],{type:'application/pdf'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href=url; a.download=fileName||'pdffortis.pdf'; a.click();
    URL.revokeObjectURL(url);

    // Aktivität loggen → im Dashboard sichtbar
    if(typeof pfLogActivity === 'function'){
      pfLogActivity(fileName || 'document.pdf', 'edited');
    }
    
    toast(lang==='de'?'PDF gespeichert!':'PDF saved!','ok');

  }catch(e){
    console.error('Download fehlgeschlagen:',e);
    toast(lang==='de'?'Fehler beim Speichern':'Save failed','err');
  }
}
  
function _doDownload(bytes){
  const blob=new Blob([bytes],{type:'application/pdf'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=fileName||'pdffortis.pdf';a.click();
  URL.revokeObjectURL(url);
  toast(lang==='de'?'PDF gespeichert!':'PDF saved!','ok');
}
  
function isLoggedIn(){ return !!currentUser; }
function guestDLUsed(){ return parseInt(localStorage.getItem(LS_GUEST_DL) || '0', 10); }
function incGuestDLUsed(){ localStorage.setItem(LS_GUEST_DL, String(guestDLUsed() + 1)); }  

function getLSDLCount(){
  const raw=localStorage.getItem(LS_DL);if(!raw)return 0;
  const cut=Date.now()-LIMIT_MS;
  const fresh=JSON.parse(raw).filter(t=>t>cut);
  localStorage.setItem(LS_DL,JSON.stringify(fresh));
  return fresh.length;
}
function logLSDL(){
  const raw=localStorage.getItem(LS_DL);
  const d=raw?JSON.parse(raw):[];d.push(Date.now());
  const cut=Date.now()-LIMIT_MS;
  localStorage.setItem(LS_DL,JSON.stringify(d.filter(t=>t>cut)));
}
function updateDLDisplay(){
  if(currentToken || isPaidUser()){document.getElementById('dl-count-display').textContent='∞';return}
  if(!isLoggedIn()){
    const left=Math.max(0,CONFIG.GUEST_DL_LIMIT-guestDLUsed());
    document.getElementById('dl-count-display').textContent=`${left} left`;
    return;
  }
  const left=Math.max(0,MAX_DL-getLSDLCount());
  document.getElementById('dl-count-display').textContent=`${left} left`;
}

// ═══════════════════════════════════════
// SUPABASE HELPERS
// ═══════════════════════════════════════
async function getFingerprint(){
  if(clientFP)return clientFP;
  const fp=[navigator.userAgent,navigator.language,screen.width+'x'+screen.height,Intl.DateTimeFormat().resolvedOptions().timeZone].join('|');
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fp));
  clientFP=Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
  return clientFP;
}
async function sbGetDLCount(fp){
  const since=new Date(Date.now()-LIMIT_MS).toISOString();
  const r=await fetch(`${SUPABASE_URL}/rest/v1/download_logs?ip_hash=eq.${fp}&downloaded_at=gte.${since}&select=id`,{headers:SB_HEADERS});
  const d=await r.json();return Array.isArray(d)?d.length:0;
}
async function sbLogDL(fp){
  await fetch(`${SUPABASE_URL}/rest/v1/download_logs`,{method:'POST',headers:SB_HEADERS,body:JSON.stringify({ip_hash:fp})});
}
  
async function logTokenUsage(action){
  if(!currentToken)return;
  await fetch(`${SUPABASE_URL}/rest/v1/token_usage`,{method:'POST',headers:SB_HEADERS,body:JSON.stringify({token:currentToken.token,action})});
}

// ═══════════════════════════════════════
// TOKEN SYSTEM
// ═══════════════════════════════════════
function loadStoredToken(){
  const raw=localStorage.getItem(LS_TOKDAT);if(!raw)return;
  try{currentToken=JSON.parse(raw);applyTokenUI(currentToken)}catch(e){localStorage.removeItem(LS_TOKDAT)}
}
  
async function validateToken(){
  const val=document.getElementById('token-val').value.trim();
  if(!val){toast('Enter a token','err');return}
  toast(lang==='de'?'Token wird geprüft...':'Checking token...');
  try{
    const data=await sbValidateToken(val);
    if(!data){toast(lang==='de'?'Ungültiger Token':'Invalid token','err');return}
    localStorage.setItem(LS_TOKDAT,JSON.stringify(data));
    currentToken=data;applyTokenUI(data);

    // ► Token am Profil persistieren → User wird im Dashboard-Team sichtbar
    if(currentUser?.id && currentUser?.token){
      await sbUpsertProfile(currentUser.id, { company_token: data.token }, currentUser.token);
      currentUser.company_token = data.token;
    }

    closeModal('token-modal');
    toast(`${lang==='de'?'Token aktiviert':'Token activated'}: ${data.company_name}`,'ok');
    updateDLDisplay();
  }catch(e){toast(lang==='de'?'Verbindungsfehler':'Connection error','err')}
}
  
function applyTokenUI(d){
  document.getElementById('token-label-bar').textContent=d.company_name;
  document.getElementById('token-input-area').classList.add('hidden');
  document.getElementById('token-active-display').classList.remove('hidden');
  document.getElementById('token-company-name').textContent=d.company_name;
  if(d.company_name){document.getElementById('firm-sig-info').classList.remove('hidden');document.getElementById('firm-sig-name').textContent=d.company_name}
  document.getElementById('sign-lock-icon').style.display='none';
  updateDLDisplay();
}
function removeToken(){
  localStorage.removeItem(LS_TOKDAT);currentToken=null;
  if(currentUser?.id && currentUser?.token){
  sbUpsertProfile(currentUser.id, { company_token: null }, currentUser.token).catch(()=>{});
  currentUser.company_token = null;
}
  document.getElementById('token-label-bar').textContent=i18n[lang].token_btn;
  document.getElementById('token-input-area').classList.remove('hidden');
  document.getElementById('token-active-display').classList.add('hidden');
  document.getElementById('sign-lock-icon').style.display='';
  updateDLDisplay();closeModal('token-modal');
}

// ═══════════════════════════════════════
// AUTH (Supabase Auth)
// ═══════════════════════════════════════
function openAuth(tab){
  document.getElementById('auth-modal').classList.remove('hidden');
  switchAuthTab(tab);
}
function switchAuthTab(tab){
  ['login','signup'].forEach(t=>{
    document.getElementById(`auth-${t}-form`).classList.toggle('hidden',t!==tab);
    document.getElementById(`auth-tab-${t}`).classList.toggle('active',t===tab);
  });
  if(tab === 'signup'){ pfResetCaptcha(); }
}

async function doLogin(){
  const email=document.getElementById('login-email').value.trim();
  const pw=document.getElementById('login-pw').value;
  const err=document.getElementById('login-error');
  err.classList.add('hidden');
  if(!email||!pw){err.textContent=lang==='de'?'Bitte alle Felder ausfüllen':'Please fill all fields';err.classList.remove('hidden');return}
  try{
    const d = await sbLogin(email, pw);
    if(d.error||d.error_description){
      err.textContent=d.error_description||d.msg||d.error;
      err.classList.remove('hidden');return;
    }
    pfSaveSession(d);

    // Profil aus DB laden (wie dashboard.js loadUserProfile)
    let profile = await sbGetProfile(d.user.id, d.access_token);
    if(!profile){
      profile = await sbUpsertProfile(d.user.id, {
        email,
        display_name: d.user.user_metadata?.name || email.split('@')[0]
      }, d.access_token);
    }
    
    currentSubscription = {
      tier: profile?.subscription_tier || 'free',
      status: profile?.subscription_status || 'inactive'
    };    

    currentUser = {
      id: d.user.id,
      email,
      name: profile?.display_name || d.user.user_metadata?.name || email.split('@')[0],
      token: d.access_token,
      company_token: profile?.company_token || null
    };

    // Session-Mirror mit echtem Namen (damit Anti-Flicker beim Reload den Namen kennt)
    try{
      const userObj = {...d.user, access_token: d.access_token};
      userObj.user_metadata = {...(d.user.user_metadata||{}), name: currentUser.name};
      localStorage.setItem('pf_session', JSON.stringify({
        user: userObj,
        expires_at: Date.now()+(d.expires_in||3600)*1000
      }));
    }catch(e){}

    // Falls Profil bereits company_token hat → Token-UI sofort anwenden
    if(currentUser.company_token){
      const tok = await sbValidateToken(currentUser.company_token);
      if(tok){
        currentToken = tok;
        localStorage.setItem(LS_TOKDAT, JSON.stringify(tok));
        applyTokenUI(tok);
      }
    }

    applyUserUI();
    closeModal('auth-modal');
    toast(lang==='de'?'Willkommen zurück!':'Welcome back!','ok');
  }catch(e){
    err.textContent='Connection error';
    err.classList.remove('hidden');
  }
}

async function doSignup(){
  const name=document.getElementById('signup-name').value.trim();
  const email=document.getElementById('signup-email').value.trim();
  const pw=document.getElementById('signup-pw').value;
  const err=document.getElementById('signup-error');
  err.classList.add('hidden');
  if(!name||!email||!pw){err.textContent=lang==='de'?'Bitte alle Felder ausfüllen':'Please fill all fields';err.classList.remove('hidden');return}
  if(pw.length<8){err.textContent=lang==='de'?'Passwort min. 8 Zeichen':'Password min. 8 characters';err.classList.remove('hidden');return}
  // Honeypot Check
  if(document.getElementById('hp-field')?.value){ return; }
  // Disposable Email
  const domain = email.split('@')[1]?.toLowerCase();
  const blocked = ['mailinator.com','guerrillamail.com','tempmail.com','10minutemail.com',
    'throwaway.email','sharklasers.com','trashmail.com','yopmail.com',
    'getnada.com','fakeinbox.com','dispostable.com','maildrop.cc','temp-mail.org'];
  if(blocked.includes(domain)){
    err.textContent=lang==='de'?'Bitte eine echte E-Mail verwenden':'Please use a real email address';
    err.classList.remove('hidden');return;
  }
  // Captcha
  if(!pfCaptchaVerified){
    err.textContent=lang==='de'?'Bitte bestätige dass du kein Roboter bist':'Please verify you are not a robot';
    err.classList.remove('hidden');return;
  }
  
  try{
    // Optional: schon eingegebener Firmen-Token wird mit übergeben
    const preToken = (currentToken && currentToken.token) || null;

    const d = await sbSignup(email, pw, name, preToken);
    if(d.error||d.error_description||d.msg){
      err.textContent=d.error_description||d.msg||d.error;
      err.classList.remove('hidden');return;
    }

    // Email-Confirm AN → kein access_token zurück
    if(!d.access_token){
      err.textContent = lang==='de'
        ? '✅ Konto erstellt. Bitte E-Mail bestätigen und einloggen.'
        : '✅ Account created. Please confirm email and sign in.';
      err.classList.remove('hidden');
      return;
    }

    pfSaveSession(d);

    // ► user_profiles-Row anlegen (DAS war der fehlende Teil im Index!)
    const profile = await sbUpsertProfile(d.user.id, {
      email,
      display_name: name,
      company_token: preToken
    }, d.access_token);

    currentUser = {
      id: d.user.id, email, name,
      token: d.access_token,
      company_token: profile?.company_token || preToken || null
    };

    // Session-Mirror mit Namen
    try{
      const userObj = {...d.user, access_token: d.access_token};
      userObj.user_metadata = {...(d.user.user_metadata||{}), name};
      localStorage.setItem('pf_session', JSON.stringify({
        user: userObj,
        expires_at: Date.now()+(d.expires_in||3600)*1000
      }));
    }catch(e){}

    applyUserUI();
    closeModal('auth-modal');
    toast(lang==='de'?'Konto erstellt! Willkommen.':'Account created! Welcome.','ok');
  }catch(e){
    err.textContent='Connection error';
    err.classList.remove('hidden');
  }
}

function applyUserUI(){
  if(!currentUser) return;
  const initials=(currentUser.name||'?').slice(0,2).toUpperCase();

  // ► Anti-Flicker-Klasse jetzt auf authed umschalten (war 'pf-anon' beim Laden)
  document.documentElement.classList.remove('pf-anon');
  document.documentElement.classList.add('pf-authed');

  ['upload-auth-btns','landing-auth-btns'].forEach(id=>document.getElementById(id)?.classList.add('hidden'));
  ['upload-user-area','landing-user-area','landing-logout-btn'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.classList.remove('hidden'); el.classList.add('pf-ready'); }
  });

  const setAv=(id)=>{const el=document.getElementById(id);if(el)el.textContent=initials};
  const setNm=(id)=>{const el=document.getElementById(id);if(el)el.textContent=currentUser.name};
  setAv('upload-avatar');  setNm('upload-username');
  setAv('landing-avatar'); setNm('landing-username');

  const lock=document.getElementById('sign-lock-icon'); if(lock) lock.style.display='none';
  loadRecent();
}

async function logout(){
  try{ await sbLogout(); }catch(e){}
  currentUser=null;

  // ► Lokale Session- und Token-Daten entfernen (Token war an den Account gekoppelt)
  localStorage.removeItem('pf_session');
  localStorage.removeItem(LS_TOKDAT);
  currentToken=null;
  document.getElementById('token-label-bar').textContent=i18n[lang].token_btn;
  document.getElementById('token-input-area')?.classList.remove('hidden');
  document.getElementById('token-active-display')?.classList.add('hidden');
  
  // ► Anti-Flicker-Klasse zurück auf anon
  document.documentElement.classList.remove('pf-authed');
  document.documentElement.classList.add('pf-anon');

  ['upload-auth-btns','landing-auth-btns'].forEach(id=>document.getElementById(id)?.classList.remove('hidden'));
  ['upload-user-area','landing-user-area','landing-logout-btn'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.classList.add('hidden'); el.classList.remove('pf-ready'); }
  });
  const lock=document.getElementById('sign-lock-icon'); if(lock) lock.style.display='';
  document.getElementById('recent-section')?.classList.add('hidden');
  toast(lang==='de'?'Abgemeldet':'Logged out');
}
  
async function restoreSessionFromStorage(){
  try{
    const raw=localStorage.getItem('pf_session');
    if(!raw) return;
    const s=JSON.parse(raw);
    if(!s?.user || (s.expires_at && s.expires_at < Date.now())){
      localStorage.removeItem('pf_session');
      localStorage.removeItem(LS_TOKDAT);
      return;
    }
    currentUser={
      id: s.user.id,
      email: s.user.email,
      name: s.user.user_metadata?.name || s.user.email?.split('@')[0] || 'User',
      token: s.user.access_token
    };
    // Subscription-Status nachladen, damit isPaidUser() nach Reload/Redirect korrekt ist
    try{
      const profile = await sbGetProfile(currentUser.id, currentUser.token);
      currentSubscription = {
        tier: profile?.subscription_tier || 'free',
        status: profile?.subscription_status || 'inactive'
      };
      currentUser.company_token = profile?.company_token || null;
    }catch(e){ console.warn('subscription restore failed', e); }
    applyUserUI();
  }catch(e){ console.warn('session restore failed', e); }
}
window.addEventListener('load', restoreSessionFromStorage);
  
function pfVerifyCaptcha(){
  const el = document.getElementById('pf-captcha');
  if(el.classList.contains('verified')) return;
  if(pfSignupTime && Date.now() - pfSignupTime < 2000){
    toast('Bitte warte einen Moment','err'); return;
  }
  el.classList.add('verified');
  document.getElementById('pf-captcha-text').textContent = 'Verifiziert ✓';
  pfCaptchaVerified = true;
  setTimeout(()=>{
    const sh=document.getElementById('pf-captcha-shimmer');
    const w=el.offsetWidth; const sw=100; let t0=null;
    sh.style.display='block';
    function f(ts){if(!t0)t0=ts;const p=Math.min((ts-t0)/900,1);
      sh.style.transform=`translateX(${-sw+(w+sw*2)*p}px) skewX(-12deg)`;
      p<1?requestAnimationFrame(f):sh.style.display='none';}
    requestAnimationFrame(f);
  },100);
}

function pfResetCaptcha(){
  pfCaptchaVerified = false;
  pfSignupTime = Date.now();
  const el = document.getElementById('pf-captcha');
  if(el){ el.classList.remove('verified');
    document.getElementById('pf-captcha-text').textContent = 'Ich bin kein Roboter';
  }
}
// ═══════════════════════════════════════
// RECENT DOCS (localStorage, no real storage)
// ═══════════════════════════════════════
function logRecent(name){
  const raw=localStorage.getItem('pf_recent');
  const list=raw?JSON.parse(raw):[];
  const existing=list.findIndex(r=>r.name===name);
  if(existing>-1)list.splice(existing,1);
  list.unshift({name,date:Date.now()});
  if(list.length>5)list.pop();
  localStorage.setItem('pf_recent',JSON.stringify(list));
}
function loadRecent(){
  if(!currentUser)return;
  const raw=localStorage.getItem('pf_recent');if(!raw)return;
  const list=JSON.parse(raw);if(!list.length)return;
  const section=document.getElementById('recent-section');
  section.classList.remove('hidden');
  const ul=document.getElementById('recent-list');ul.innerHTML='';
  list.forEach(item=>{
    const d=document.createElement('div');d.className='recent-item';
    d.innerHTML=`<div class="recent-icon"><svg width="16" height="16" fill="none" viewBox="0 0 16 16"><rect x="2" y="1" width="9" height="12" rx="1.5" fill="#e0e7ff" stroke="#a5b4fc" stroke-width="1"/><path d="M5 5h4M5 7.5h4M5 10h2.5" stroke="#6366f1" stroke-width=".8" stroke-linecap="round"/></svg></div><span class="recent-name">${item.name}</span><span class="recent-date">${new Date(item.date).toLocaleDateString()}</span>`;
    ul.appendChild(d);
  });
}

// ═══════════════════════════════════════
// LIMIT MODAL + NUDGE
// ═══════════════════════════════════════
function showLimitModal(){
  document.getElementById('limit-modal').classList.remove('hidden');
  const raw=localStorage.getItem(LS_DL);
  if(!raw)return;
  const times=JSON.parse(raw).sort((a,b)=>a-b);
  if(!times.length)return;
  const resetAt=times[0]+LIMIT_MS;
  const el=document.getElementById('reset-countdown');
  (function tick(){
    const d=resetAt-Date.now();if(d<=0){el.textContent='00:00:00';return}
    el.textContent=[Math.floor(d/3600000),Math.floor((d%3600000)/60000),Math.floor((d%60000)/1000)].map(n=>String(n).padStart(2,'0')).join(':');
    setTimeout(tick,1000);
  })();
}
  
function showNudge(){
  const nb=document.getElementById('nudge-bar');nb.classList.remove('hidden');
  setTimeout(()=>nb.classList.add('hidden'),8000);
}
function closeNudge(){document.getElementById('nudge-bar').classList.add('hidden')}

function showSignLock(){
  toast(lang==='de'?'Bitte zuerst einloggen':'Please sign in first','warn');
  openAuth('signup');
}  
// ═══════════════════════════════════════
// MODALS
// ═══════════════════════════════════════
function openSignModal(){
  if(!currentUser&&!currentToken){toast(lang==='de'?'Bitte zuerst einloggen':'Please sign in first','warn');openAuth('signup');return}
  document.getElementById('sign-modal').classList.remove('hidden');
}
function openTokenModal(){document.getElementById('token-modal').classList.remove('hidden')}
function closeModal(id){document.getElementById(id).classList.add('hidden')}
document.addEventListener('click',e=>{if(e.target.classList.contains('modal-bg'))e.target.classList.add('hidden')});

// ═══════════════════════════════════════
// TOAST
// ═══════════════════════════════════════
function toast(msg,type='info'){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.style.background=type==='err'?'#ef4444':type==='ok'?'#16a34a':type==='warn'?'#d97706':'#111827';
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),3000);
}

// ═══════════════════════════════════════
// TEXT EDITOR (Floating contentEditable)
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded',()=>{
  const ol=document.getElementById('overlay-layer');
  if(!ol)return;


// ── ADD TEXT: Klick auf leere Fläche ──
  let _wasDragging=false;
  document.addEventListener('mousedown',()=>{_wasDragging=false});
  document.addEventListener('mousemove',()=>{_wasDragging=true},{passive:true});
  ol.addEventListener('click',function(e){
    if(editorMode!=='edit')return;
    if(currentTab!=='add')return;
    if(_wasDragging){_wasDragging=false;return}
    if(e.target.closest('.pf-tbox-wrap'))return;
    const active=document.querySelector('.pf-tbox-wrap.selected');
    if(active){pfTboxDeselect(active);return}
    const rect=ol.getBoundingClientRect();
    addTextBox(e.clientX-rect.left,e.clientY-rect.top);
  });

  // ── EDIT TEXT: Klick auf PDF-Text-Span → Floating Editor ──
document.addEventListener('click',function(e){
  if(editorMode!=='edit')return;
  if(currentTab!=='edit')return;
  if(!e.target.classList.contains('pdf-text-item'))return;
  e.stopPropagation();
  openInlineEditor(e.target);
});

  // Klick auf leere Fläche im Edit-Tab → Editor schließen
  ol.addEventListener('click',function(e){
    if(e.target.classList.contains('pdf-text-item'))return;
    if(e.target.id==='pdf-inline-editor')return;
    closeInlineEditor();
  });
});

// 1. SICHERSTELLEN, DASS DIE VARIABLEN GLOBAL EXISTIEREN
window.activeInlineSpan = window.activeInlineSpan || null;
window.activeInlineInput = window.activeInlineInput || null;

// ═══════════════════════════════════════════════════════════════════
// 2. TEXT-EDITOR ÖFFNEN
// ═══════════════════════════════════════════════════════════════════
async function openInlineEditor(span){
  if(window.activeInlineSpan){
    await closeInlineEditor(true);
  }

  window.activeInlineSpan=span;

  if(!span.dataset.originalText){
    span.dataset.originalText=span.textContent;
  }

  const pageNum=parseInt(span.dataset.pageNumber||currentPage,10);
  const canvas=document.getElementById('pdf-canvas');
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const img=pageImages[pageNum];

  // === Originaltext WIRKLICH vom Canvas entfernen ===
  if(img){
    const pdfNativeWidth =img.width/2;
    const pdfNativeHeight=img.height/2;
    const scaleX=canvas.width /pdfNativeWidth;
    const scaleY=canvas.height/pdfNativeHeight;

    const x =parseFloat(span.dataset.pdfX);
    const y =parseFloat(span.dataset.pdfY);
    const x1=parseFloat(span.dataset.pdfX1);
    const y1=parseFloat(span.dataset.pdfY1);

    const cx=x*scaleX, cy=y*scaleY;
    const cw=(x1-x)*scaleX, ch=(y1-y)*scaleY;
   
    // === BG-Farbe per CLUSTER-MODE — eng am Text sampeln (1-4px) ===
    // Zu weites Sampling trifft Nachbar-Zeilen (dunkel) oder verlässt
    // farbige Balken (Seite=weiß). Direkt um die Bbox ist immer Balken-BG.
    const samples=[];
    const pick=(sx,sy,weight)=>{
      if(sx<0||sy<0||sx>=canvas.width||sy>=canvas.height) return;
      try{
        const px=ctx.getImageData(sx|0,sy|0,1,1).data;
        const w=weight||1;
        for(let k=0;k<w;k++) samples.push([px[0],px[1],px[2]]);
      }catch(e){}
    };
    const midY=cy+ch/2;
    // SEITLICH: 1-4 px neben Bbox, jede Höhe samplen (gewichtet 2x weil sicherer)
    for(let i=1;i<=4;i++){
      for(let f=0.15;f<=0.85;f+=0.20){
        pick(cx-i,        cy+ch*f, 2);
        pick(cx+cw-1+i,   cy+ch*f, 2);
      }
    }
    // OBEN/UNTEN: nur 1-2 px (mehr trifft Nachbarzeilen!)
    for(let i=1;i<=2;i++){
      for(let f=0.10;f<=0.90;f+=0.10){
        pick(cx+cw*f, cy-i,     1);
        pick(cx+cw*f, cy+ch-1+i,1);
      }
    }
    // ECKEN: 1-2 px diagonal (sehr verlässlich)
    for(let i=1;i<=2;i++){
      pick(cx-i,      cy-i,      2);
      pick(cx+cw-1+i, cy-i,      2);
      pick(cx-i,      cy+ch-1+i, 2);
      pick(cx+cw-1+i, cy+ch-1+i, 2);
    }

    // Dominanten Cluster finden – gröberes Raster (>>5 = 8 Stufen/Kanal)
    // → leichte BG-Variationen (Antialiasing/Kompression) landen im gleichen Bucket
    let bgR=255,bgG=255,bgB=255;
    if(samples.length){
      const buckets={};
      samples.forEach(s=>{
        const k=(s[0]>>5)+','+(s[1]>>5)+','+(s[2]>>5);
        if(!buckets[k]) buckets[k]={n:0,r:0,g:0,b:0};
        buckets[k].n++; buckets[k].r+=s[0]; buckets[k].g+=s[1]; buckets[k].b+=s[2];
      });
      let best=null;
      for(const k in buckets){
        if(!best||buckets[k].n>best.n) best=buckets[k];
      }
      if(best){
        bgR=Math.round(best.r/best.n);
        bgG=Math.round(best.g/best.n);
        bgB=Math.round(best.b/best.n);
      }
    }
    const bg=`rgb(${bgR},${bgG},${bgB})`;

    // Bereich: 0 horizontal, 1 vertikal — Pass1/2 croppt eh auf echte Text-Pixel
    const padX=0;
    const padY=1;
    const mx0=Math.max(0, Math.floor(cx-padX));
    const my0=Math.max(0, Math.floor(cy-padY));
    const mw =Math.min(canvas.width -mx0, Math.ceil(cw+padX*2));
    const mh =Math.min(canvas.height-my0, Math.ceil(ch+padY*2));

    // === Schritt 1: Text-Pixel finden (Scan, ohne zu schreiben) ===
    // → echte Ober-/Unterkante der Glyphen ermitteln, damit Maske exakt sitzt
    let savedData=null;
    try{
      const imgData=ctx.getImageData(mx0,my0,mw,mh);
      const d=imgData.data;
      const TH2=18*18;
      const SOFT2=42*42;

      // Pass 1: ermitteln, in welchen Zeilen Text-Pixel auftreten
      const rowHasText=new Uint8Array(mh);
      const colHasText=new Uint8Array(mw);
      for(let y=0;y<mh;y++){
        for(let x=0;x<mw;x++){
          const i=(y*mw+x)*4;
          const dr=d[i]-bgR, dg=d[i+1]-bgG, db=d[i+2]-bgB;
          if(dr*dr+dg*dg+db*db > TH2){
            rowHasText[y]=1;
            colHasText[x]=1;
          }
        }
      }
      // Tightes Bounding der Text-Pixel
      let yMin=0; while(yMin<mh && !rowHasText[yMin]) yMin++;
      let yMax=mh-1; while(yMax>=0 && !rowHasText[yMax]) yMax--;
      let xMin=0; while(xMin<mw && !colHasText[xMin]) xMin++;
      let xMax=mw-1; while(xMax>=0 && !colHasText[xMax]) xMax--;
      if(yMin>yMax || xMin>xMax){ yMin=0; yMax=mh-1; xMin=0; xMax=mw-1; }

      // Pass 2: NUR innerhalb der gefundenen Text-Box ersetzen (+1px AA-Slack)
      const yA=Math.max(0,yMin-1), yB=Math.min(mh-1,yMax+1);
      const xA=Math.max(0,xMin-1), xB=Math.min(mw-1,xMax+1);
      for(let y=yA;y<=yB;y++){
        for(let x=xA;x<=xB;x++){
          const i=(y*mw+x)*4;
          const dr=d[i]-bgR, dg=d[i+1]-bgG, db=d[i+2]-bgB;
          const dist2=dr*dr+dg*dg+db*db;
          if(dist2 > SOFT2){
            d[i]=bgR; d[i+1]=bgG; d[i+2]=bgB;
          } else if(dist2 > TH2){
            const t=(Math.sqrt(dist2)-18)/(42-18);
            d[i  ]=Math.round(d[i  ]+(bgR-d[i  ])*t);
            d[i+1]=Math.round(d[i+1]+(bgG-d[i+1])*t);
            d[i+2]=Math.round(d[i+2]+(bgB-d[i+2])*t);
          }
        }
      }

      // Maske auf tatsächlichen Text-Bereich zuschneiden
      const tightX=mx0+xA, tightY=my0+yA;
      const tightW=xB-xA+1, tightH=yB-yA+1;
      const tightData=ctx.createImageData(tightW,tightH);
      const td=tightData.data;
      for(let y=0;y<tightH;y++){
        for(let x=0;x<tightW;x++){
          const si=((y+yA)*mw+(x+xA))*4;
          const ti=(y*tightW+x)*4;
          td[ti  ]=d[si  ];
          td[ti+1]=d[si+1];
          td[ti+2]=d[si+2];
          td[ti+3]=d[si+3];
        }
      }
      ctx.putImageData(tightData,tightX,tightY);
      savedData=tightData;

      // maskRect tight machen, damit pageMasks später dasselbe wiederherstellt
      var _maskFinal={ x:tightX, y:tightY, w:tightW, h:tightH, bg, data:tightData };
    }catch(e){
      ctx.fillStyle=bg;
      ctx.fillRect(mx0,my0,mw,mh);
      var _maskFinal={ x:mx0, y:my0, w:mw, h:mh, bg, data:null };
    }

    const maskRect=_maskFinal;
    span.dataset.maskInfo='1';
    span._maskRect=maskRect;
    span.dataset.maskPage=pageNum;
  }

  // Span editierbar machen – Original-Farbe & Font verwenden, KEIN weißer Hintergrund
  span.classList.remove('is-edited');
  span.classList.add('editing');
  span.style.color       = span.dataset.cssColor  || 'black';
  span.style.fontFamily  = span.dataset.cssFamily || 'Arial,sans-serif';
  span.style.fontWeight  = span.dataset.cssWeight || '400';
  span.style.fontStyle   = span.dataset.cssStyle  || 'normal';
  span.style.background  = 'transparent';
  span.style.boxShadow   = 'none';
  span.style.border      = 'none';
  span.style.outline     = 'none';
  span.style.padding     = '0';
  span.style.caretColor  = '#4f46e5';
  span.style.minWidth    = '20px';
  span.contentEditable   = 'true';
  span.spellcheck        = false;


  span.focus();
  const range=document.createRange();
  range.selectNodeContents(span);
  range.collapse(false);
  const sel=window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  span.addEventListener('keydown',_inlineKeyHandler);
}

function _inlineKeyHandler(e){
  if(e.key==='Enter'){
    e.preventDefault();
    closeInlineEditor(true);
  }else if(e.key==='Escape'){
    e.preventDefault();
    closeInlineEditor(false);
  }
}
// ═══════════════════════════════════════════════════════════════════
// 3. TEXT-EDITOR SCHLIESSEN & INS PDF SPEICHERN
// ═══════════════════════════════════════════════════════════════════
async function closeInlineEditor(save=true){
  if(!window.activeInlineSpan) return;
  const span = window.activeInlineSpan;
  window.activeInlineSpan = null;
  span.removeEventListener('keydown', _inlineKeyHandler);

  const newText  = span.textContent.trim();
  const origText = span.dataset.originalText || '';
  const pageNum  = parseInt(span.dataset.pageNumber || currentPage, 10);

  span.contentEditable = 'false';
  span.classList.remove('editing');
  // Sicherheit: alle inline-Styles vom Editing-Modus killen
  span.style.boxShadow = 'none';
  span.style.border    = 'none';
  span.style.outline   = 'none';
  span.style.background= 'transparent';
  span.style.padding   = '0';

  const canvas = document.getElementById('pdf-canvas');
  const ctx    = canvas.getContext('2d',{willReadFrequently:true});
  const img    = pageImages[pageNum];

  const restorePage = () => {
    if(!img) return;
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    // Bereits zuvor gespeicherte Masken (andere Edits) wieder auftragen
    (pageMasks[pageNum]||[]).forEach(m=>{
      ctx.fillStyle=m.bg;
      ctx.fillRect(m.x,m.y,m.w,m.h);
    });
  };

  // Abbruch ODER keine Änderung → Originaltext wiederherstellen
  if(!save || newText === origText){
    span.textContent     = origText;
    span.style.color     = 'transparent';
    span.style.background= 'transparent';
    span.classList.remove('is-edited');
    delete span.dataset.maskInfo;
    delete span.dataset.maskPage;
    restorePage();
    return;
  }

  // === Text wurde geändert ===
  if (typeof window.pftNotifyPageEdited === 'function') {
    window.pftNotifyPageEdited(pageNum);
  }

  // === Text wurde geändert ===
  const _prevMaskRect = span._maskRect;

  // 1) Maske dauerhaft in pageMasks übernehmen → bleibt nach Re-Render erhalten
  if(span._maskRect){
    if(!pageMasks[pageNum]) pageMasks[pageNum]=[];
    pageMasks[pageNum].push(span._maskRect);
    delete span._maskRect;
    delete span.dataset.maskInfo;
    delete span.dataset.maskPage;
  }

  // 2) Neuen Text im Span sichtbar lassen – Original-Farbe/Font
  span.textContent        = newText;
  span.dataset.editedText = newText;
  span.style.color        = span.dataset.cssColor  || 'black';
  span.style.fontFamily   = span.dataset.cssFamily || 'Arial,sans-serif';
  span.style.fontWeight   = span.dataset.cssWeight || '400';
  span.style.fontStyle    = span.dataset.cssStyle  || 'normal';
  span.style.background   = 'transparent';
  span.style.boxShadow    = 'none';
  span.style.border       = 'none';
  span.style.outline      = 'none';
  span.style.padding      = '0';
  span.classList.add('is-edited');

  // 3) Für Download an Backend merken
  const x  = parseFloat(span.dataset.pdfX);
  const y  = parseFloat(span.dataset.pdfY);
  const x1 = parseFloat(span.dataset.pdfX1);
  const y1 = parseFloat(span.dataset.pdfY1);
  const size = parseFloat(span.dataset.pdfFontSize) || 12;

  const color = parseInt(span.dataset.pdfColor||0,10);
  const font  = span.dataset.pdfFont  || '';
  const flags = parseInt(span.dataset.pdfFlags||0,10);
  const idx = pendingEdits.findIndex(e => e.page===pageNum && e.x===x && e.y===y);
  const prevEdit = idx > -1 ? {...pendingEdits[idx]} : null;
  const bgColor = _prevMaskRect ? _prevMaskRect.bg : null; // exakte Hintergrundfarbe aus der Vorschau
  const itemIndex = parseInt(span.dataset.pdfItemIndex, 10);
  const edit = {
      page:pageNum,
      x, y, x1, y1,
      size,
      color,
      font,
      flags,
      newText,
      spanOrigText:origText,
      bgColor,
      originalItemIndices: isNaN(itemIndex) ? [] : [itemIndex],
      pdfJsTotalItemsCount: (window._pfItemCounts || {})[pageNum] || 0
  };
  const editIdx = idx > -1 ? idx : pendingEdits.length;
  if(idx > -1) pendingEdits[idx] = edit;
  else pendingEdits.push(edit);

  // 4) Undo/Redo registrieren — Draft aus Input-Listener übernehmen falls vorhanden
  if(span.dataset._draftHistoryPushed === '1' && historyStack[historyIndex]){
    // Draft-Entry existiert bereits — nur den Redo-Text auf finalen Wert setzen
    span.dataset._draftFinalText = newText;
    delete span.dataset._draftHistoryPushed;
    // Redo-Closure aktualisieren, damit Redo den finalen edit-Zustand wiederherstellt
    const _draftEntry = historyStack[historyIndex];
    const _origUndo = _draftEntry.undo;
    _draftEntry.undo = async () => {
      await _origUndo();
      // zusätzlich: pendingEdits sauber entfernen wie im vollen closeInlineEditor
      const idx2 = pendingEdits.findIndex(ed => ed===edit);
      if(idx2 > -1) pendingEdits.splice(idx2, 1);
    };
    _draftEntry.redo = async () => {
      pendingEdits[editIdx]=edit;
      span.textContent=newText;
      span.classList.add('is-edited');
      span.style.color=span.dataset.cssColor||'black';
      if(pageNum===currentPage && typeof redrawPageCanvas==='function') redrawPageCanvas(pageNum);
    };
    updateUndoRedoButtons();
  } else {
  pushHistory({
    undo:()=>{
      if(_prevMaskRect){
        const arr=pageMasks[pageNum]||[];
        const mi=arr.indexOf(_prevMaskRect);
        if(mi>-1) arr.splice(mi,1);
      }
      if(prevEdit){
        pendingEdits[editIdx]=prevEdit;
        span.textContent=prevEdit.newText;
        span.classList.add('is-edited');
        span.style.color=span.dataset.cssColor||'black';
      } else {
        pendingEdits.splice(editIdx,1);
        span.textContent=origText;
        span.classList.remove('is-edited');
        span.style.color='transparent';
      }
      if(pageNum===currentPage) redrawPageCanvas(pageNum);
    },
    redo:()=>{
      if(_prevMaskRect){
        if(!pageMasks[pageNum]) pageMasks[pageNum]=[];
        pageMasks[pageNum].push(_prevMaskRect);
      }
      pendingEdits[editIdx]=edit;
      span.textContent=newText;
      span.classList.add('is-edited');
      span.style.color=span.dataset.cssColor||'black';
      if(pageNum===currentPage) redrawPageCanvas(pageNum);
    }
  });
}
}
   
// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
window.addEventListener('load',()=>{
  setLang('en');
  loadStoredToken();
  updateDLDisplay();
  loadRecent();
});
// ── expose for pdfortis-translate.js ──────────────────────────
Object.defineProperty(window, 'currentPDF',     { get: () => pdfBytes });
Object.defineProperty(window, 'currentPageNum', { get: () => currentPage });
Object.defineProperty(window, 'currentPdfDocLocal', { get: () => pdfDoc });   // NEU
window.openAuthModal = () => document.getElementById('auth-modal')?.classList.remove('hidden');


