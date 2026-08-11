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
// Draft history for inline text edits
// Undo becomes active immediately while typing, not just after blur/Enter
// ═══════════════════════════════════════
document.addEventListener('input', function(e){

  const span=e.target;

  if(
    !span ||
    !span.classList ||
    !span.classList.contains('pdf-text-item')
  ) return;

  if(span.getAttribute('contenteditable')!=='true') return;

  const origText=
    span.dataset.originalText || '';

  const currentText=
    span.textContent;

  if(span.dataset._draftHistoryPushed!=='1'){

    if(currentText===origText){
      return;
    }

    const spanRef=span;

    const beforeHTML=
      span.dataset._historyBeforeHTML ??
      span.innerHTML;

    const beforeState={
      html:beforeHTML,
      cssColor:span.dataset.cssColor || '',
      cssWeight:span.dataset.cssWeight || '400',
      cssStyle:span.dataset.cssStyle || 'normal',
      textDecoration:span.style.textDecoration || 'none',
      typing:{..._fmtTypingState}
    };

    pushHistory({

      undo:async()=>{

        spanRef.innerHTML=
          beforeState.html;

        spanRef.dataset.editedText=
          spanRef.textContent;

        spanRef.classList.remove(
          'is-edited'
        );

        spanRef.style.color=
          'transparent';

        delete spanRef.dataset._draftHistoryPushed;

        if(
          window.activeInlineSpan===spanRef
        ){
          setTimeout(()=>{
            _restoreFormatSelection();
          },0);
        }
      },

      redo:async()=>{

        const finalHTML=
          spanRef.dataset._draftFinalHTML ||
          spanRef.innerHTML;

        spanRef.innerHTML=
          finalHTML;

        spanRef.dataset.editedText=
          spanRef.textContent;

        spanRef.classList.add(
          'is-edited'
        );

        spanRef.style.color=
          spanRef.dataset.cssColor ||
          'black';

        if(
          window.activeInlineSpan===spanRef
        ){
          setTimeout(()=>{
            _restoreFormatSelection();
          },0);
        }
      }

    });

    span.dataset._draftHistoryPushed='1';

    span.dataset._draftFinalHTML=
      span.innerHTML;

  }else{

    span.dataset._draftFinalHTML=
      span.innerHTML;
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
  // If another span is currently open/being edited (not yet committed),
  // re-apply its temporary mask — otherwise its old text briefly
  // flashes back and creates duplicate text with the still-open span
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
    if(inTextField) return; 
    e.preventDefault(); undo();
  }else if(key==='y' || (key==='z' && e.shiftKey)){
    if(inTextField) return;
    e.preventDefault(); redo();
  }
});
let pageMasks={}; // {pageNum: [{x,y,w,h,bg}, ...]} – preview masks per page
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

let pfCaptchaVerified = false;
let pfSignupTime = null;
const BLOCKED_DOMAINS = [
  'mailinator.com','guerrillamail.com','tempmail.com','10minutemail.com',
  'throwaway.email','sharklasers.com','trashmail.com','yopmail.com',
  'getnada.com','fakeinbox.com','dispostable.com','maildrop.cc','temp-mail.org'
];

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
  // Read directly from URL, do NOT wait for auth-badge.js (race condition!)
  const params = new URLSearchParams(location.search);
  const shareToken = params.get('share');

  // Variant A: already set by auth-badge.js
  if (window.__pfSharedPDF) {
    return loadSharedFromObj(window.__pfSharedPDF);
  }

  // Variant B: share token in URL, but auth-badge.js not ready yet
  if (shareToken && typeof pfGetSession === 'function') {
    const sess = pfGetSession();
    if (!sess) {
      console.warn('[PDFortis] Share link but not logged in');
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
        console.warn('[PDFortis] Share token invalid/expired:', shareToken);
        return;
      }
      const pdfUrl = await sbGetSharedPDFUrl(shareToken, sess.user.access_token);
      if (!pdfUrl) {
        console.warn('[PDFortis] Could not generate signed URL');
        return;
      }
      await loadSharedFromObj({ url: pdfUrl, name: row.document_name });
    } catch(e) {
      console.error('[PDFortis] Share load error', e);
    }
  }
});
// ═══════════════════════════════════════
// AUDIT LOG — embedded directly in the PDF, no server storage needed
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
  const lineLen = 34;   
  const gap = 8;
  const placed = { left: [], right: [] }; 

  entries.forEach(entry => {
    const anchorX = entry.x * scaleX;
    const anchorY = canvasCssH - (entry.y * scaleY);

  // Always at the fixed canvas edge, regardless of how far the change is from there
    const side = anchorX < canvasCssW / 2 ? 'right' : 'left';
    const boxLeft = side === 'right'
      ? canvasCssW - boxWidth - 8
      : 8;

    // Avoid vertical collision with boxes already placed on the same side
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
      <div>${new Date(entry.ts).toLocaleString('en-GB')}</div>
      <div>Action: ${esc(actionLabels[entry.action] || entry.action)}</div>
      ${entry.ip ? `<div style="color:#9ca3af">IP: ${esc(entry.ip)}</div>` : ''}
      ${entry.vpn ? `<div style="color:#f59e0b">⚠ Used VPN</div>` : ''}
    `;
    ol.appendChild(box);

    placed[side].push({ top: boxTop, bottom: boxTop + box.offsetHeight });
  });
}
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
  showPdfLoader('Loading shared document...');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Download fehlgeschlagen');
    const blob = await res.blob();
    const file = new File([blob], name || 'shared.pdf', { type: 'application/pdf' });
    await loadPDF(file);
  } catch(e) {
    console.error(e);
    alert('PDF could not be loaded');
  } finally {
    hidePdfLoader();
  }
}

function showPdfLoader(msg = 'Loading…') {
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

  // Backing store always stays native (fixed) — only the CSS display size
  // adapts to viewport/zoom. This keeps pixel masks always correct,
  // regardless of browser zoom.
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
  // Re-apply edit masks (painted-over original text areas)
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

  const pdfNativeWidth=imgWidth/2;

  const scale=canvasWidth/pdfNativeWidth;

  // pageHeight from backend = actual PDF height in points
  // compute canvasHeight so top coordinates are correct
  const canvas=document.getElementById('pdf-canvas');
  const canvasHeight=canvas.height;

  const editActive=(editorMode==='edit'&&currentTab==='edit');

  const layer=document.createElement('div');
  layer.className='pdf-text-layer';
  layer.style.cssText='position:absolute;inset:0;overflow:hidden;pointer-events:none;';

  items.forEach((item, itemIdx) => {
    // Check if a saved (not yet downloaded) edit already exists for this text position
    const existingEdit = pendingEdits.find(e =>
      e.page===pageNum && Math.abs(e.x-item.x)<1 && Math.abs(e.y-item.y)<1
    );

    const span=document.createElement('span');
    span.className='pdf-text-item';
    if(existingEdit && existingEdit.formattedHTML){
      span.innerHTML = existingEdit.formattedHTML;
    }else{
      span.textContent =
        existingEdit
          ? existingEdit.newText
          : item.text;
    }
    span.dataset.originalText = existingEdit ? existingEdit.spanOrigText : item.text;
    span.dataset.editedText   = existingEdit ? existingEdit.newText : item.text;

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

    // Color (PyMuPDF gives  int sRGB)
    const ci=item.color|0;
    const r=(ci>>16)&255, g=(ci>>8)&255, b=ci&255;
    const rgb=`rgb(${r},${g},${b})`;

    // Font-Family out of Fontnamen 
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
    // Save original color for later
    span.dataset.cssColor=rgb;
    span.dataset.cssFamily=family;
    span.dataset.cssWeight=weight;
    span.dataset.cssStyle=style;    

    if(existingEdit){
      span.style.color = rgb;         
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
  // Immediately set text layer and spans to the correct state
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
  // Automatically activate edit mode for any tool tab; only Navigate stays in look mode
  if(tab!=='nav'&&editorMode!=='edit'){setMode('edit')}
}

// ═══════════════════════════════════════
// TEXT BOX (Add)
// ═══════════════════════════════════════
function addTextBox(x,y){
  if(!pdfLibDoc){toast('Load a PDF first','err');return}
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
  dragH.className='pf-tbox-drag';dragH.innerHTML='⠿';dragH.title='Move';
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

  // ── DRAG (only via ⠿ handle) ──
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

  // ── TOOLBAR ACTION ──
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

  // ── Click inside wrap → don't bubble outward (prevents an immediate new addTextBox) ──
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
  el.textContent=new Date().toLocaleDateString('en-GB');
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
  // Only set position if not already set
  if(!el.style.position||el.style.position==='static'){
    el.style.position='absolute';
  }
  el.appendChild(btn);
}

// ═══════════════════════════════════════════════════════════════════
// FORMAT — INLINE TEXT FORMATTING
// ═══════════════════════════════════════════════════════════════════
//
// Verhalten:
//   - Keine Auswahl:
//       Bold/Farbe/Italic/Underline wird ab dem Cursor für neu
//       geschriebenen Text verwendet.
//   - Auswahl vorhanden:
//       Nur die Auswahl wird formatiert.
//   - Mausauswahl bleibt erhalten.
//   - Toolbar darf den Fokus übernehmen, ohne die Selection zu zerstören.
//   - Formatierungen werden über innerHTML gespeichert und sind damit
//     nicht mehr auf den kompletten PDF-Text beschränkt.
//

let _fmtSavedRange = null;
let _fmtTypingState = {
  bold: false,
  italic: false,
  underline: false,
  color: null
};

function _isRangeInsideSpan(range, span){
  if(!range || !span) return false;

  const container = range.commonAncestorContainer;

  return container === span ||
         span.contains(container);
}

function _getInlineSelection(){
  const span = window.activeInlineSpan;
  if(!span) return null;

  const sel = window.getSelection();
  if(!sel || !sel.rangeCount) return null;

  const range = sel.getRangeAt(0);

  if(!_isRangeInsideSpan(range, span)) return null;

  return {
    selection: sel,
    range
  };
}

// Speichert IMMER die letzte gültige Auswahl innerhalb des Textfeldes.
document.addEventListener('selectionchange', () => {
  const span = window.activeInlineSpan;
  if(!span) return;

  const sel = window.getSelection();
  if(!sel || !sel.rangeCount) return;

  const range = sel.getRangeAt(0);

  if(_isRangeInsideSpan(range, span)){
    _fmtSavedRange = range.cloneRange();
  }
});

function _restoreFormatSelection(){
  const span = window.activeInlineSpan;
  if(!span) return false;

  span.focus();

  const sel = window.getSelection();
  if(!sel) return false;

  sel.removeAllRanges();

  if(_fmtSavedRange && _isRangeInsideSpan(_fmtSavedRange, span)){
    try{
      sel.addRange(_fmtSavedRange);
      return true;
    }catch(e){}
  }

  // Kein gespeicherter Bereich:
  // Cursor ans Ende setzen.
  const r=document.createRange();
  r.selectNodeContents(span);
  r.collapse(false);

  sel.addRange(r);

  _fmtSavedRange=r.cloneRange();

  return true;
}

function _saveInlineFormatState(span){
  if(!span) return null;

  return {
    html: span.innerHTML,
    cssColor: span.dataset.cssColor || '',
    cssWeight: span.dataset.cssWeight || '400',
    cssStyle: span.dataset.cssStyle || 'normal',
    textDecoration: span.style.textDecoration || 'none',
    typing: {..._fmtTypingState}
  };
}

function _restoreInlineFormatState(span, state){
  if(!span || !state) return;

  span.innerHTML = state.html;

  span.dataset.cssColor = state.cssColor || '';
  span.dataset.cssWeight = state.cssWeight || '400';
  span.dataset.cssStyle = state.cssStyle || 'normal';

  span.style.color =
    state.cssColor ||
    span.style.color ||
    'black';

  span.style.fontWeight =
    state.cssWeight || '400';

  span.style.fontStyle =
    state.cssStyle || 'normal';

  span.style.textDecoration =
    state.textDecoration || 'none';

  _fmtTypingState = {...state.typing};

  // Selection nach Undo/Redo wiederherstellen
  setTimeout(()=>{
    if(window.activeInlineSpan === span){
      _restoreFormatSelection();
    }
  },0);
}

function _pushInlineFormatHistory(span, before, after){
  if(!span || !before || !after) return;

  if(
    before.html === after.html &&
    before.cssColor === after.cssColor &&
    before.cssWeight === after.cssWeight &&
    before.cssStyle === after.cssStyle &&
    before.textDecoration === after.textDecoration &&
    JSON.stringify(before.typing) === JSON.stringify(after.typing)
  ){
    return;
  }

  pushHistory({
    undo: async ()=>{
      _restoreInlineFormatState(span,before);
    },

    redo: async ()=>{
      _restoreInlineFormatState(span,after);
    }
  });
}

// Erzeugt einen echten DOM-Bereich für das aktuelle Selection-Verhalten.
function _getCurrentOrSavedRange(){
  const span=window.activeInlineSpan;
  if(!span) return null;

  const sel=window.getSelection();

  if(sel && sel.rangeCount){
    const r=sel.getRangeAt(0);

    if(_isRangeInsideSpan(r,span)){
      return r.cloneRange();
    }
  }

  if(_fmtSavedRange && _isRangeInsideSpan(_fmtSavedRange,span)){
    return _fmtSavedRange.cloneRange();
  }

  return null;
}

// Prüft ob wirklich Text markiert wurde.
function _hasRealSelection(range){
  if(!range) return false;

  return !range.collapsed &&
         range.toString().length > 0;
}

// Nach execCommand Auswahl/Cursor möglichst exakt wiederherstellen.
function _restoreRangeAfterCommand(range){
  if(!range) return;

  const span=window.activeInlineSpan;
  if(!span) return;

  const sel=window.getSelection();
  if(!sel) return;

  try{
    sel.removeAllRanges();
    sel.addRange(range);
    _fmtSavedRange=range.cloneRange();
  }catch(e){}
}

function _toggleTypingFormat(cmd,value){
  if(cmd==='bold'){
    _fmtTypingState.bold =
      value !== undefined ? !!value : !_fmtTypingState.bold;
  }

  if(cmd==='italic'){
    _fmtTypingState.italic =
      value !== undefined ? !!value : !_fmtTypingState.italic;
  }

  if(cmd==='underline'){
    _fmtTypingState.underline =
      value !== undefined ? !!value : !_fmtTypingState.underline;
  }

  if(cmd==='color'){
    _fmtTypingState.color=value;
  }
}

function _updateFormatButtons(){
  document.getElementById('fmt-bold')
    ?.classList.toggle('on',_fmtTypingState.bold);

  document.getElementById('fmt-italic')
    ?.classList.toggle('on',_fmtTypingState.italic);

  document.getElementById('fmt-underline')
    ?.classList.toggle('on',_fmtTypingState.underline);
}

function _applyTypingFormat(span){
  if(!span) return;

  // Browser-Editing-State für zukünftige Eingaben.
  //
  // Diese execCommand-Aufrufe arbeiten auch bei einem collapsed Cursor:
  // Der nächste eingegebene Text übernimmt den Stil.
  try{
    document.execCommand(
      'bold',
      false,
      null
    );
  }catch(e){}

  try{
    document.execCommand(
      'italic',
      false,
      null
    );
  }catch(e){}

  try{
    document.execCommand(
      'underline',
      false,
      null
    );
  }catch(e){}

  if(_fmtTypingState.color){
    try{
      document.execCommand(
        'foreColor',
        false,
        _fmtTypingState.color
      );
    }catch(e){}
  }
}

function applyFormat(cmd){

  const span=window.activeInlineSpan;

  if(!span){
    toast('Click into a text field first','err');
    return;
  }

  const before=_saveInlineFormatState(span);

  // Selection wiederherstellen, bevor der Toolbar-Button den Fokus übernimmt.
  _restoreFormatSelection();

  const range=_getCurrentOrSavedRange();
  const hasSelection=_hasRealSelection(range);

  /*
   * ================================================================
   * FALL A:
   * TEXT IST MARKIERT
   *
   * Nur die Auswahl wird formatiert.
   * ================================================================
   */
  if(hasSelection){

    const savedRange=range.cloneRange();

    span.focus();

    const sel=window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);

    try{

      if(cmd==='bold'){
        document.execCommand('bold',false,null);
      }

      else if(cmd==='italic'){
        document.execCommand('italic',false,null);
      }

      else if(cmd==='underline'){
        document.execCommand('underline',false,null);
      }

      else if(cmd==='color'){
        const color=
          document.getElementById('text-color')?.value ||
          '#000000';

        document.execCommand(
          'foreColor',
          false,
          color
        );
      }

      else if(cmd==='font'){
        const family=
          document.getElementById('font-family')?.value;

        if(family){
          document.execCommand(
            'fontName',
            false,
            family
          );
        }
      }

      else if(cmd==='size'){
        const size=
          document.getElementById('font-size')?.value;

        if(size){
          document.execCommand(
            'fontSize',
            false,
            '7'
          );

          // execCommand fontSize benutzt HTML <font size="7">.
          // Anschließend auf die gewünschte CSS-Größe umstellen.
          span.querySelectorAll('font[size="7"]').forEach(el=>{
            el.removeAttribute('size');
            el.style.fontSize=size+'px';
          });
        }
      }

    }catch(e){
      console.warn('Inline format failed:',e);
    }

    // Auswahl wiederherstellen, damit der Benutzer direkt weiterarbeiten kann.
    setTimeout(()=>{
      _restoreRangeAfterCommand(savedRange);
    },0);

    const after=_saveInlineFormatState(span);

    _pushInlineFormatHistory(
      span,
      before,
      after
    );

    return;
  }

  /*
   * ================================================================
   * FALL B:
   * KEINE AUSWAHL
   *
   * Nur der zukünftige Text wird formatiert.
   * Der bestehende Text bleibt unverändert.
   * ================================================================
   */

  if(cmd==='bold'){
    _toggleTypingFormat('bold');
  }

  else if(cmd==='italic'){
    _toggleTypingFormat('italic');
  }

  else if(cmd==='underline'){
    _toggleTypingFormat('underline');
  }

  else if(cmd==='color'){
    const color=
      document.getElementById('text-color')?.value ||
      '#000000';

    _toggleTypingFormat('color',color);
  }

  else if(cmd==='font'){
    const family=
      document.getElementById('font-family')?.value;

    if(family){
      _fmtTypingState.font=family;
    }
  }

  else if(cmd==='size'){
    const size=
      document.getElementById('font-size')?.value;

    if(size){
      _fmtTypingState.size=size;
    }
  }

  _updateFormatButtons();

  /*
   * Bei collapsed Cursor den Editing-State setzen.
   * Der vorhandene Text wird NICHT verändert.
   */
  _restoreFormatSelection();

  const after=_saveInlineFormatState(span);

  _pushInlineFormatHistory(
    span,
    before,
    after
  );
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
  toast('Signature inserted — drag to position');
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
  toast('Page rotated 90°');

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
  if(!pdfLibDoc||totalPages<=1){toast('At least one page required','err');return}
  if(!confirm(`Delete page ${currentPage}?`))return;

  const deletedIndex = currentPage - 1;
  // Save the page separately for undo, before it's removed
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
  toast('Page deleted');

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
    toast('Merging PDFs...');
    const merged=await PDFLib.PDFDocument.create();
    if(pdfLibDoc){const pgs=await merged.copyPages(pdfLibDoc,pdfLibDoc.getPageIndices());pgs.forEach(p=>merged.addPage(p))}
    for(const f of files){const b=new Uint8Array(await f.arrayBuffer());const doc=await PDFLib.PDFDocument.load(b);const pgs=await merged.copyPages(doc,doc.getPageIndices());pgs.forEach(p=>merged.addPage(p))}
    pdfBytes=await merged.save();pdfLibDoc=merged;
    pdfDoc=await pdfjsLib.getDocument({data:pdfBytes.slice()}).promise;
    totalPages=pdfDoc.numPages;currentPage=1;
    await buildThumbs();await renderPage(1);
    toast(`${'Merged'}: ${totalPages} ${'pages'}`);
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
  toast(`${'Saved'}${saved>0?` (${saved}% ${'smaller'})`:''}`)
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
  toast('Saving PDF...','info');

  try{
    // ── Step 1: embed edit-text changes via backend ──
    let workBytes = pdfBytes;
    if(pendingEdits.length > 0){
      workBytes = await editBatchLocal(workBytes, pendingEdits);
      pendingEdits = [];
      pageImages = {};
      pageMasks = {};

      // The edited version becomes the new working base — invisible to the user,
      // but now PDF bytes/text layer/masks are consistent with each other again
      pdfBytes = workBytes;
      pdfDoc = await pdfjsLib.getDocument({data:pdfBytes.slice()}).promise;
      pdfLibDoc = await PDFLib.PDFDocument.load(pdfBytes);
      await renderPage(currentPage);
    }

// ── Step 2: embed add-text & image overlays via pdf-lib ──
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

        // ── Image overlay (signature or uploaded image) ──
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

    // ── Step 2b: embed translation overlays via pdf-lib (all translated pages) ──
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
          // it.lines: array of already-wrapped lines (buildDownloadOverlayData()
          // returns multi-line text since paragraph grouping). PDFLib doesn't
          // wrap \n itself -> draw line by line, top to bottom.
          const lines = it.lines && it.lines.length ? it.lines : [it.text];
          const lineHeightPdf = (it.lineHeight || it.fontSize * 1.18) * scaleY2;
          const fontSizePdf = Math.max(6, it.fontSize * scaleY2);
          let lineY = pdfY2 + it.h * scaleY2 - lineHeightPdf * 0.85;
          lines.forEach(lineText => {
            if (lineY < pdfY2) return; // paragraph overflows downward -> cut off instead of overwriting neighboring text
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

    // Log activity → visible in the dashboard
    if(typeof pfLogActivity === 'function'){
      pfLogActivity(fileName || 'document.pdf', 'edited');
    }
    
    toast('PDF saved!','ok');

  }catch(e){
    console.error('Download fehlgeschlagen:',e);
    toast('Save failed','err');
  }
}
  
function _doDownload(bytes){
  const blob=new Blob([bytes],{type:'application/pdf'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=fileName||'pdffortis.pdf';a.click();
  URL.revokeObjectURL(url);
  toast('PDF saved!','ok');
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
  if(!isLoggedIn()){ closeModal('token-modal'); openAuth('signup'); return; }
  const val=document.getElementById('token-val').value.trim();
  if(!val){toast('Enter a token','err');return}
  toast('Checking token...');
  try{
    const data=await sbValidateToken(val);
    if(!data){toast('Invalid token','err');return}
    localStorage.setItem(LS_TOKDAT,JSON.stringify(data));
    currentToken=data;applyTokenUI(data);

    // ► Persist token on the profile → user becomes visible in the dashboard team
    if(currentUser?.id && currentUser?.token){
      await sbUpsertProfile(currentUser.id, { company_token: data.token }, currentUser.token);
      currentUser.company_token = data.token;
    }

    closeModal('token-modal');
    toast(`${'Token activated'}: ${data.company_name}`,'ok');
    updateDLDisplay();
  }catch(e){toast('Connection error','err')}
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
  document.getElementById('token-label-bar').textContent='Token';
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
  if(!email||!pw){err.textContent='Please fill all fields';err.classList.remove('hidden');return}
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

    // Session mirror with real name (so anti-flicker knows the name on reload)
    try{
      const userObj = {...d.user, access_token: d.access_token};
      userObj.user_metadata = {...(d.user.user_metadata||{}), name: currentUser.name};
      localStorage.setItem('pf_session', JSON.stringify({
        user: userObj,
        expires_at: Date.now()+(d.expires_in||3600)*1000
      }));
    }catch(e){}

    // If profile already has a company_token → apply token UI immediately
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
    toast('Welcome back!','ok');
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
  if(!name||!email||!pw){err.textContent='Please fill all fields';err.classList.remove('hidden');return}
  if(pw.length<8){err.textContent='Password min. 8 characters';err.classList.remove('hidden');return}
  // Honeypot Check
  if(document.getElementById('hp-field')?.value){ return; }
  // Disposable Email
  const domain = email.split('@')[1]?.toLowerCase();
  const blocked = ['mailinator.com','guerrillamail.com','tempmail.com','10minutemail.com',
    'throwaway.email','sharklasers.com','trashmail.com','yopmail.com',
    'getnada.com','fakeinbox.com','dispostable.com','maildrop.cc','temp-mail.org'];
  if(blocked.includes(domain)){
    err.textContent='Please use a real email address';
    err.classList.remove('hidden');return;
  }
  // Captcha
  if(!pfCaptchaVerified){
    err.textContent='Please verify you are not a robot';
    err.classList.remove('hidden');return;
  }
  
  try{
    // Optional: an already-entered company token is passed along
    const preToken = (currentToken && currentToken.token) || null;

    const d = await sbSignup(email, pw, name, preToken);
    if(d.error||d.error_description||d.msg){
      err.textContent=d.error_description||d.msg||d.error;
      err.classList.remove('hidden');return;
    }

    // Email confirm ON → no access_token returned
    if(!d.access_token){
      err.textContent = '✅ Account created. Please confirm email and sign in.';
      err.classList.remove('hidden');
      return;
    }

    pfSaveSession(d);

    // ► Create user_profiles row (this was the missing part in the index!)
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

    // Session mirror with name
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
    toast('Account created! Welcome.','ok');
  }catch(e){
    err.textContent='Connection error';
    err.classList.remove('hidden');
  }
}

function applyUserUI(){
  if(!currentUser) return;
  const initials=(currentUser.name||'?').slice(0,2).toUpperCase();

  // ► Switch anti-flicker class to authed now (was 'pf-anon' on load)
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

  // ► Remove local session and token data (token was tied to the account)
  localStorage.removeItem('pf_session');
  localStorage.removeItem(LS_TOKDAT);
  currentToken=null;
  document.getElementById('token-label-bar').textContent='Token';
  document.getElementById('token-input-area')?.classList.remove('hidden');
  document.getElementById('token-active-display')?.classList.add('hidden');
  
  // ► Anti-flicker class back to anon
  document.documentElement.classList.remove('pf-authed');
  document.documentElement.classList.add('pf-anon');

  ['upload-auth-btns','landing-auth-btns'].forEach(id=>document.getElementById(id)?.classList.remove('hidden'));
  ['upload-user-area','landing-user-area','landing-logout-btn'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.classList.add('hidden'); el.classList.remove('pf-ready'); }
  });
  const lock=document.getElementById('sign-lock-icon'); if(lock) lock.style.display='';
  document.getElementById('recent-section')?.classList.add('hidden');
  toast('Logged out');
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
    // Subscription-Status loading, so isPaidUser() after Reload/Redirect is correct
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
    toast('Please wait a moment','err'); return;
  }
  el.classList.add('verified');
  document.getElementById('pf-captcha-text').textContent = 'Verified ✓';
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
    document.getElementById('pf-captcha-text').textContent = "I'm not a robot";
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
  toast('Please sign in first','warn');
  openAuth('signup');
}  
// ═══════════════════════════════════════
// MODALS
// ═══════════════════════════════════════
function openSignModal(){
  if(!currentUser&&!currentToken){toast('Please sign in first','warn');openAuth('signup');return}
  document.getElementById('sign-modal').classList.remove('hidden');
}
function openTokenModal(){
  if(!isLoggedIn()){ openAuth('signup'); return; }
  document.getElementById('token-modal').classList.remove('hidden');
}
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


// ── ADD TEXT: click on empty area ──
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

  // ── EDIT TEXT: click on PDF text span → floating editor ──
document.addEventListener('click',function(e){
  if(editorMode!=='edit') return;
  if(currentTab!=='edit') return;

  const target=e.target.closest?.('.pdf-text-item');
  if(!target) return;

  e.stopPropagation();

  // WICHTIG:
  // Wenn genau dieser Text bereits bearbeitet wird,
  // NICHT erneut openInlineEditor() aufrufen.
  //
  // Das war der Grund dafür, dass eine Mausauswahl
  // nach dem Mouse-Up wieder zum Ende gesprungen ist.
  if(window.activeInlineSpan === target){
    return;
  }

  openInlineEditor(target);
});

window.activeInlineSpan = window.activeInlineSpan || null;
window.activeInlineInput = window.activeInlineInput || null;

// ═══════════════════════════════════════════════════════════════════
// 2. OPEN TEXT EDITOR
// ═══════════════════════════════════════════════════════════════════
async function openInlineEditor(span){
  if(window.activeInlineSpan){
    await closeInlineEditor(true);
  }

  window.activeInlineSpan=span;

  // Formatierungsstatus für neu geschriebenen Text zurücksetzen
  _fmtSavedRange=null;

  _fmtTypingState={
    bold:false,
    italic:false,
    underline:false,
    color:null
  };

  _updateFormatButtons();

  if(!span.dataset.originalText){
    span.dataset.originalText=span.textContent;
  }

  const pageNum=parseInt(span.dataset.pageNumber||currentPage,10);
  const canvas=document.getElementById('pdf-canvas');
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const img=pageImages[pageNum];

  // === Actually remove the original text from the canvas ===
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
   
    // Sampling too wide hits neighboring lines (dark) or leaves
    // colored bars (page=white). Right around the bbox is always the bar's BG.
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
    // SIDES: 1-4 px next to bbox, sample every height (weighted 2x for reliability)
    for(let i=1;i<=4;i++){
      for(let f=0.15;f<=0.85;f+=0.20){
        pick(cx-i,        cy+ch*f, 2);
        pick(cx+cw-1+i,   cy+ch*f, 2);
      }
    }
    // UP/BELOW:5 only 1-2 px (more hits neighbourtext!)
    for(let i=1;i<=2;i++){
      for(let f=0.10;f<=0.90;f+=0.10){
        pick(cx+cw*f, cy-i,     1);
        pick(cx+cw*f, cy+ch-1+i,1);
      }
    }
    // CORNERS: 1-2 px diagonal (very reliable)
    for(let i=1;i<=2;i++){
      pick(cx-i,      cy-i,      2);
      pick(cx+cw-1+i, cy-i,      2);
      pick(cx-i,      cy+ch-1+i, 2);
      pick(cx+cw-1+i, cy+ch-1+i, 2);
    }

    // Find the dominant cluster – coarser grid (>>5 = 8 steps/channel)
    // → slight BG variations (antialiasing/compression) land in the same bucket
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

    // Range: 0 horizontal, 1 vertical — pass 1/2 crops to actual text pixels anyway
    const padX=0;
    const padY=1;
    const mx0=Math.max(0, Math.floor(cx-padX));
    const my0=Math.max(0, Math.floor(cy-padY));
    const mw =Math.min(canvas.width -mx0, Math.ceil(cw+padX*2));
    const mh =Math.min(canvas.height-my0, Math.ceil(ch+padY*2));

    // === Step 1: Text-Pixel  (Scan, without writing) ===
    // → determine the actual top/bottom edge of the glyphs so the mask sits exactly
    let savedData=null;
    try{
      const imgData=ctx.getImageData(mx0,my0,mw,mh);
      const d=imgData.data;
      const TH2=18*18;
      const SOFT2=42*42;

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
      // Tight bounding of the text pixels
      let yMin=0; while(yMin<mh && !rowHasText[yMin]) yMin++;
      let yMax=mh-1; while(yMax>=0 && !rowHasText[yMax]) yMax--;
      let xMin=0; while(xMin<mw && !colHasText[xMin]) xMin++;
      let xMax=mw-1; while(xMax>=0 && !colHasText[xMax]) xMax--;
      if(yMin>yMax || xMin>xMax){ yMin=0; yMax=mh-1; xMin=0; xMax=mw-1; }

      // Pass 2: replace ONLY within the found text box (+1px AA slack)
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

      // Crop the mask to the actual text area
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

      // Make maskRect tight, so pageMasks later restores the same thing
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

  // Make span editable – use original color & font, NO white background
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
// INLINE FORMAT RUNS
// Wandelt z.B.
//
//   Hello <b>World</b> <span style="color:red">!</span>
//
// in einzelne PDF-Zeichenbereiche um.
// ═══════════════════════════════════════════════════════════════════

function _extractInlineFormatRuns(span){

  const runs=[];

  function walk(node,state){

    if(node.nodeType===Node.TEXT_NODE){

      const text=node.nodeValue || '';

      if(!text) return;

      runs.push({
        text,

        bold:!!state.bold,
        italic:!!state.italic,
        underline:!!state.underline,

        color:state.color || null,

        fontFamily:state.fontFamily || null,
        fontSize:state.fontSize || null
      });

      return;
    }

    if(node.nodeType!==Node.ELEMENT_NODE) return;

    const tag=node.tagName.toLowerCase();

    const next={
      ...state
    };

    if(tag==='b' || tag==='strong'){
      next.bold=true;
    }

    if(tag==='i' || tag==='em'){
      next.italic=true;
    }

    if(tag==='u'){
      next.underline=true;
    }

    if(tag==='font'){
      if(node.color){
        next.color=node.color;
      }

      if(node.face){
        next.fontFamily=node.face;
      }
    }

    if(node.style){

      if(node.style.color){
        next.color=node.style.color;
      }

      if(node.style.fontWeight){
        next.bold =
          node.style.fontWeight==='bold' ||
          parseInt(node.style.fontWeight,10)>=600;
      }

      if(node.style.fontStyle){
        next.italic =
          node.style.fontStyle==='italic';
      }

      if(node.style.textDecoration){
        next.underline =
          node.style.textDecoration.includes('underline');
      }

      if(node.style.fontFamily){
        next.fontFamily=node.style.fontFamily;
      }

      if(node.style.fontSize){
        next.fontSize=node.style.fontSize;
      }
    }

    node.childNodes.forEach(child=>{
      walk(child,next);
    });
  }

  walk(span,{
    bold:false,
    italic:false,
    underline:false,
    color:null,
    fontFamily:null,
    fontSize:null
  });

  return runs;
}

// ═══════════════════════════════════════════════════════════════════
// 3. TEXT-EDITOR — Closing & SAVE INTO PDF
// ═══════════════════════════════════════════════════════════════════
async function closeInlineEditor(save=true){

  if(!window.activeInlineSpan) return;

  const span = window.activeInlineSpan;

  // WICHTIG:
  // activeInlineSpan erst NACH dem Sichern der relevanten Daten löschen.
  window.activeInlineSpan = null;

  span.removeEventListener('keydown', _inlineKeyHandler);

  // ────────────────────────────────────────────────────────────────
  // ORIGINAL / AKTUELL
  // ────────────────────────────────────────────────────────────────

  const origText =
    span.dataset.originalText || '';

  const plainText =
    span.textContent.trim();

  // Das ist der entscheidende Unterschied:
  //
  // textContent  = reiner Text
  // innerHTML    = Text + Bold + Farbe + Italic + Underline
  //
  const formattedHTML =
    span.innerHTML;

  const pageNum =
    parseInt(
      span.dataset.pageNumber || currentPage,
      10
    );

  // ────────────────────────────────────────────────────────────────
  // FORMATIERUNG ERKENNEN
  // ────────────────────────────────────────────────────────────────

  const hasInlineFormatting =
    span.querySelector(
      'b,strong,i,em,u,font,[style]'
    ) !== null;

  span.dataset._hasInlineFormatting =
    hasInlineFormatting ? '1' : '0';

  // ────────────────────────────────────────────────────────────────
  // EDITOR-MODUS SCHLIESSEN
  // ────────────────────────────────────────────────────────────────

  span.contentEditable = 'false';
  span.classList.remove('editing');

  span.style.boxShadow = 'none';
  span.style.border    = 'none';
  span.style.outline   = 'none';
  span.style.background= 'transparent';
  span.style.padding   = '0';

  // ────────────────────────────────────────────────────────────────
  // CANVAS / ORIGINAL SEITE
  // ────────────────────────────────────────────────────────────────

  const canvas =
    document.getElementById('pdf-canvas');

  const ctx =
    canvas.getContext(
      '2d',
      {willReadFrequently:true}
    );

  const img =
    pageImages[pageNum];

  const restorePage = () => {

    if(!img) return;

    ctx.drawImage(
      img,
      0,
      0,
      canvas.width,
      canvas.height
    );

    (pageMasks[pageNum] || []).forEach(m => {

      ctx.fillStyle = m.bg;

      ctx.fillRect(
        m.x,
        m.y,
        m.w,
        m.h
      );

    });
  };

  // ────────────────────────────────────────────────────────────────
  // CANCEL / KEINE ÄNDERUNG
  // ────────────────────────────────────────────────────────────────

  if(
    !save ||
    (
      plainText === origText &&
      !hasInlineFormatting
    )
  ){

    span.textContent =
      origText;

    span.style.color =
      'transparent';

    span.style.background =
      'transparent';

    span.classList.remove(
      'is-edited'
    );

    delete span.dataset.maskInfo;
    delete span.dataset.maskPage;

    restorePage();

    return;
  }

  // ────────────────────────────────────────────────────────────────
  // SEITE ALS EDITIERT MARKIEREN
  // ────────────────────────────────────────────────────────────────

  if(
    typeof window.pftNotifyPageEdited ===
    'function'
  ){

    window.pftNotifyPageEdited(
      pageNum
    );
  }

  // ────────────────────────────────────────────────────────────────
  // MASK RECT
  // ────────────────────────────────────────────────────────────────

  const _prevMaskRect =
    span._maskRect;

  if(span._maskRect){

    if(!pageMasks[pageNum]){
      pageMasks[pageNum] = [];
    }

    pageMasks[pageNum].push(
      span._maskRect
    );

    delete span._maskRect;
    delete span.dataset.maskInfo;
    delete span.dataset.maskPage;
  }

  // ────────────────────────────────────────────────────────────────
  // WICHTIG:
  //
  // NICHT:
  // span.textContent = newText
  //
  // Denn das würde alle Inline-Formatierungen zerstören.
  //
  // Stattdessen bleibt innerHTML erhalten.
  // ────────────────────────────────────────────────────────────────

  span.dataset.editedText =
    plainText;

  span.dataset.formattedHTML =
    formattedHTML;

  span.style.color =
    span.dataset.cssColor ||
    'black';

  span.style.fontFamily =
    span.dataset.cssFamily ||
    'Arial,sans-serif';

  span.style.fontWeight =
    span.dataset.cssWeight ||
    '400';

  span.style.fontStyle =
    span.dataset.cssStyle ||
    'normal';

  span.style.background =
    'transparent';

  span.style.boxShadow =
    'none';

  span.style.border =
    'none';

  span.style.outline =
    'none';

  span.style.padding =
    '0';

  span.classList.add(
    'is-edited'
  );

  // ────────────────────────────────────────────────────────────────
  // PDF POSITION / FONT
  // ────────────────────────────────────────────────────────────────

  const x =
    parseFloat(
      span.dataset.pdfX
    );

  const y =
    parseFloat(
      span.dataset.pdfY
    );

  const x1 =
    parseFloat(
      span.dataset.pdfX1
    );

  const y1 =
    parseFloat(
      span.dataset.pdfY1
    );

  const size =
    parseFloat(
      span.dataset.pdfFontSize
    ) || 12;

  const color =
    parseInt(
      span.dataset.pdfColor || 0,
      10
    );

  const font =
    span.dataset.pdfFont || '';

  const flags =
    parseInt(
      span.dataset.pdfFlags || 0,
      10
    );

  const itemIndex =
    parseInt(
      span.dataset.pdfItemIndex,
      10
    );

  // ────────────────────────────────────────────────────────────────
  // FORMAT RUNS ERZEUGEN
  //
  // Beispiel:
  //
  // Hallo <b>Welt</b> <span style="color:red">!</span>
  //
  // wird zu:
  //
  // [
  //   {text:"Hallo ", bold:false},
  //   {text:"Welt", bold:true},
  //   {text:" !", color:"red"}
  // ]
  // ────────────────────────────────────────────────────────────────

  const formatRuns =
    typeof _extractInlineFormatRuns ===
    'function'
      ? _extractInlineFormatRuns(span)
      : [];

  // ────────────────────────────────────────────────────────────────
  // EXISTING PENDING EDIT
  // ────────────────────────────────────────────────────────────────

  const idx =
    pendingEdits.findIndex(
      e =>
        e.page === pageNum &&
        e.x === x &&
        e.y === y
    );

  const prevEdit =
    idx > -1
      ? {...pendingEdits[idx]}
      : null;

  const bgColor =
    _prevMaskRect
      ? _prevMaskRect.bg
      : null;

  // ────────────────────────────────────────────────────────────────
  // EDIT OBJEKT
  // ────────────────────────────────────────────────────────────────

  const edit = {

    page: pageNum,

    x,
    y,
    x1,
    y1,

    size,
    color,
    font,
    flags,

    // Reiner Text
    newText: plainText,

    // KOMPLETTER HTML-INHALT
    formattedHTML,

    // GEMISCHTE FORMATIERUNG
    formatRuns,

    spanOrigText:
      origText,

    bgColor,

    originalItemIndices:
      isNaN(itemIndex)
        ? []
        : [itemIndex],

    pdfJsTotalItemsCount:
      (window._pfItemCounts || {})[pageNum] || 0
  };

  const editIdx =
    idx > -1
      ? idx
      : pendingEdits.length;

  if(idx > -1){

    pendingEdits[idx] =
      edit;

  }else{

    pendingEdits.push(
      edit
    );
  }

  // ────────────────────────────────────────────────────────────────
  // UNDO / REDO
  // ────────────────────────────────────────────────────────────────

  if(
    span.dataset._draftHistoryPushed ===
    '1' &&
    historyStack[historyIndex]
  ){

    // Draft-History existiert bereits.
    // Wir aktualisieren nur den finalen Zustand.

    span.dataset._draftFinalText =
      plainText;

    span.dataset._draftFinalHTML =
      formattedHTML;

    delete span.dataset._draftHistoryPushed;

    const _draftEntry =
      historyStack[historyIndex];

    const _origUndo =
      _draftEntry.undo;

    _draftEntry.undo =
      async () => {

        await _origUndo();

        const idx2 =
          pendingEdits.findIndex(
            ed => ed === edit
          );

        if(idx2 > -1){

          pendingEdits.splice(
            idx2,
            1
          );
        }
      };

    _draftEntry.redo =
      async () => {

        pendingEdits[editIdx] =
          edit;

        // HTML wiederherstellen,
        // NICHT textContent!
        span.innerHTML =
          formattedHTML;

        span.dataset.editedText =
          plainText;

        span.classList.add(
          'is-edited'
        );

        span.style.color =
          span.dataset.cssColor ||
          'black';

        if(
          pageNum === currentPage &&
          typeof redrawPageCanvas ===
          'function'
        ){

          redrawPageCanvas(
            pageNum
          );
        }
      };

    updateUndoRedoButtons();

  }else{

    // ────────────────────────────────────────────────────────────
    // NORMALER UNDO/REDO EINTRAG
    // ────────────────────────────────────────────────────────────

    pushHistory({

      undo: () => {

        if(_prevMaskRect){

          const arr =
            pageMasks[pageNum] ||
            [];

          const mi =
            arr.indexOf(
              _prevMaskRect
            );

          if(mi > -1){

            arr.splice(
              mi,
              1
            );
          }
        }

        if(prevEdit){

          pendingEdits[editIdx] =
            prevEdit;

          // Vorherigen HTML-Zustand wiederherstellen
          if(prevEdit.formattedHTML){

            span.innerHTML =
              prevEdit.formattedHTML;

          }else{

            span.textContent =
              prevEdit.newText;
          }

          span.classList.add(
            'is-edited'
          );

          span.style.color =
            span.dataset.cssColor ||
            'black';

        }else{

          pendingEdits.splice(
            editIdx,
            1
          );

          span.textContent =
            origText;

          span.classList.remove(
            'is-edited'
          );

          span.style.color =
            'transparent';
        }

        if(
          pageNum === currentPage
        ){

          redrawPageCanvas(
            pageNum
          );
        }
      },

      redo: () => {

        if(_prevMaskRect){

          if(!pageMasks[pageNum]){
            pageMasks[pageNum] = [];
          }

          pageMasks[pageNum].push(
            _prevMaskRect
          );
        }

        pendingEdits[editIdx] =
          edit;

        // HTML wiederherstellen
        span.innerHTML =
          formattedHTML;

        span.dataset.editedText =
          plainText;

        span.classList.add(
          'is-edited'
        );

        span.style.color =
          span.dataset.cssColor ||
          'black';

        if(
          pageNum === currentPage
        ){

          redrawPageCanvas(
            pageNum
          );
        }
      }
    });
  }
}
   
// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
window.addEventListener('load',()=>{
  loadStoredToken();
  updateDLDisplay();
  loadRecent();
});
// ── expose for pdfortis-translate.js ──────────────────────────
Object.defineProperty(window, 'currentPDF',     { get: () => pdfBytes });
Object.defineProperty(window, 'currentPageNum', { get: () => currentPage });
Object.defineProperty(window, 'currentPdfDocLocal', { get: () => pdfDoc });   
window.openAuthModal = () => document.getElementById('auth-modal')?.classList.remove('hidden');
