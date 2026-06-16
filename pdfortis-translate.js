/* ====================================================================
 * pdfortis-translate.js
 * Self-installing PDF translation module for PDFortis
 *  - Server-First (Azure → MyMemory → LibreTranslate via your backend)
 *  - Privacy-Fallback (Transformers.js / m2m100 ~250MB, runs in browser)
 *  - Inline-Overlay Toggle + Side-by-Side modal
 *  - Auth Gate (guests: 1 free, registered users: unlimited)
 * --------------------------------------------------------------------
 * Requires in index.html:
 *   window.PDFORTIS_API = "https://your-render-url"; // optional, else same-origin
 *   <script src="/pdfortis-translate.js" defer></script>
 *
 * Hooks into existing PDFortis runtime:
 *   - window.currentPDF      (Uint8Array of current PDF — already used by editor)
 *   - window.currentPageNum  (1-based active page)
 *   - window.pfGetSession()  (Supabase auth — already present)
 *   - #canvas-wrap , #overlay-layer , #pdf-canvas (existing IDs)
 *   - #editor-toolbar / .editor-bar (we attach our button to first found)
 * ==================================================================== */
(function () {
  'use strict';

  const API_BASE = (window.PDFORTIS_API || '').replace(/\/+$/, '');
  const LS_GUEST_KEY = 'pdfortis_guest_translations_used';
  const GUEST_LIMIT = 1;

  // --------------------------------------------------------------
  // 1. STATE
  // --------------------------------------------------------------
  const state = {
    mode: 'server',          // 'server' | 'local'
    localReady: false,
    localLoading: false,
    localError: null,
    translator: null,        // Transformers.js pipeline
    lastResult: null,        // { items:[{orig,trans,...}], page, source, target, provider }
    overlayOn: false,
    autoFit: true,           // pro-mode: auto-shrink + small overflow tolerance
  };

  // --------------------------------------------------------------
  // 2. LANGUAGES (m2m100 codes; identical to ISO-639-1 for these)
  // --------------------------------------------------------------
  const LANGS = [
    ['auto','Auto-detect'],
    ['de','Deutsch'],['en','English'],['fr','Français'],['es','Español'],
    ['it','Italiano'],['pt','Português'],['nl','Nederlands'],['pl','Polski'],
    ['tr','Türkçe'],['ru','Русский'],['uk','Українська'],['cs','Čeština'],
    ['ro','Română'],['sv','Svenska'],['da','Dansk'],['fi','Suomi'],
    ['el','Ελληνικά'],['hu','Magyar'],['bg','Български'],
    ['ar','العربية'],['he','עברית'],['hi','हिन्दी'],
    ['zh','中文'],['ja','日本語'],['ko','한국어'],
  ];

  // --------------------------------------------------------------
  // 3. STYLES
  // --------------------------------------------------------------
  function injectStyles() {
    const css = `
      .pft-fab{position:fixed;right:18px;bottom:18px;z-index:550;background:#0b1220;color:#fff;border:none;border-radius:999px;padding:12px 18px;font:600 13px/1 Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(11,18,32,.28);display:flex;align-items:center;gap:8px;transition:transform .15s,box-shadow .15s}
      .pft-fab:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(11,18,32,.34)}
      .pft-fab .pft-dot{width:8px;height:8px;border-radius:50%;background:#10b981}
      .pft-fab.local .pft-dot{background:#6366f1}
      .pft-fab.loading .pft-dot{background:#f59e0b;animation:pftpulse 1.2s infinite}
      @keyframes pftpulse{0%,100%{opacity:.4}50%{opacity:1}}

      .pft-bg{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(6px);z-index:600;display:none;align-items:center;justify-content:center;padding:24px}
      .pft-bg.open{display:flex}
      .pft-modal{background:#fff;border-radius:16px;width:min(880px,100%);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.32);font-family:Inter,system-ui,sans-serif}
      .pft-head{padding:18px 22px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e5e7eb}
      .pft-head h3{margin:0;font-size:17px;font-weight:700;color:#0f172a;flex:1}
      .pft-badge{font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
      .pft-badge.local{background:#eef2ff;color:#3730a3;border-color:#c7d2fe}
      .pft-badge.loading{background:#fef3c7;color:#92400e;border-color:#fde68a}
      .pft-close{background:none;border:none;font-size:22px;cursor:pointer;color:#64748b;padding:0 4px}

      .pft-body{padding:18px 22px;overflow:auto;display:flex;flex-direction:column;gap:14px}
      .pft-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .pft-sel{padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;background:#fff;color:#0f172a;font-family:inherit}
      .pft-sel:focus{outline:2px solid #6366f1;outline-offset:1px}
      .pft-go{background:#0b1220;color:#fff;border:none;border-radius:8px;padding:9px 18px;font-weight:600;font-size:13px;cursor:pointer}
      .pft-go:hover{background:#1e293b}
      .pft-go:disabled{opacity:.5;cursor:not-allowed}
      .pft-secondary{background:#fff;color:#0f172a;border:1px solid #cbd5e1;border-radius:8px;padding:8px 14px;font-weight:500;font-size:13px;cursor:pointer}
      .pft-secondary:hover{background:#f8fafc}

      .pft-toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:13px;color:#0f172a}
      .pft-toggle input{appearance:none;width:36px;height:20px;background:#cbd5e1;border-radius:999px;position:relative;cursor:pointer;transition:background .15s}
      .pft-toggle input::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
      .pft-toggle input:checked{background:#0b1220}
      .pft-toggle input:checked::after{left:18px}

      .pft-results{display:grid;grid-template-columns:1fr 1fr;gap:14px;min-height:200px}
      .pft-col{border:1px solid #e5e7eb;border-radius:10px;padding:12px;background:#f8fafc;display:flex;flex-direction:column;gap:8px;max-height:340px;overflow:auto}
      .pft-col h4{margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#64748b}
      .pft-line{font-size:13px;line-height:1.5;color:#0f172a;padding:6px 8px;border-radius:6px;background:#fff;border:1px solid #f1f5f9}

      .pft-foot{padding:14px 22px;border-top:1px solid #e5e7eb;display:flex;gap:10px;justify-content:flex-end;align-items:center;flex-wrap:wrap}
      .pft-provider{font-size:11px;color:#64748b;margin-right:auto}

      .pft-empty{color:#94a3b8;font-size:13px;text-align:center;padding:24px 0}
      .pft-spin{display:inline-block;width:14px;height:14px;border:2px solid #e5e7eb;border-top-color:#0b1220;border-radius:50%;animation:pftspin .8s linear infinite;vertical-align:-2px;margin-right:6px}
      @keyframes pftspin{to{transform:rotate(360deg)}}

      /* inline-overlay layer atop existing #pdf-canvas */
      .pft-overlay{position:absolute;inset:0;pointer-events:none;z-index:5}
      .pft-overlay-item{position:absolute;background:#fff;color:#0f172a;font-family:Inter,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 1px;line-height:1;border-radius:1px;box-shadow:0 0 0 1px rgba(99,102,241,.18) inset}
      .pft-overlay.wrap .pft-overlay-item{white-space:normal}

      .pft-auth-prompt{background:#fef3c7;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;font-size:13px;color:#78350f;display:flex;gap:10px;align-items:center;justify-content:space-between}
      .pft-auth-prompt button{background:#0b1220;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-weight:600;font-size:12px;cursor:pointer}

      @media (max-width:640px){.pft-results{grid-template-columns:1fr}}
    `;
    const s = document.createElement('style');
    s.id = 'pft-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // --------------------------------------------------------------
  // 4. AUTH HELPERS
  // --------------------------------------------------------------
  function isLoggedIn() {
    try {
      if (typeof window.pfGetSession === 'function') {
        const s = window.pfGetSession();
        return !!(s && s.user);
      }
    } catch (_) { /* no session */ }
    return !!window.pfUser;
  }
  function guestUsed() { return parseInt(localStorage.getItem(LS_GUEST_KEY) || '0', 10); }
  function incGuestUsed() { localStorage.setItem(LS_GUEST_KEY, String(guestUsed() + 1)); }
  function canTranslate() {
    if (isLoggedIn()) return { ok: true };
    if (guestUsed() < GUEST_LIMIT) return { ok: true, guestRemaining: GUEST_LIMIT - guestUsed() - 1 };
    return { ok: false };
  }

  // --------------------------------------------------------------
  // 5. UI INJECTION
  // --------------------------------------------------------------
  function buildModal() {
    const bg = document.createElement('div');
    bg.className = 'pft-bg';
    bg.id = 'pft-modal';
    bg.innerHTML = `
      <div class="pft-modal" data-testid="translate-modal">
        <div class="pft-head">
          <h3>🌍 Translate this page</h3>
          <span class="pft-badge" id="pft-badge" data-testid="translate-mode-badge">⚡ Server-Mode</span>
          <button class="pft-close" id="pft-close" aria-label="Close">×</button>
        </div>
        <div class="pft-body">
          <div class="pft-row">
            <label style="font-size:12px;color:#64748b;font-weight:600">From</label>
            <select class="pft-sel" id="pft-src" data-testid="translate-src"></select>
            <label style="font-size:12px;color:#64748b;font-weight:600">To</label>
            <select class="pft-sel" id="pft-tgt" data-testid="translate-tgt"></select>
            <button class="pft-go" id="pft-run" data-testid="translate-run-btn">Translate page</button>
          </div>
          <div class="pft-row" style="gap:18px">
            <label class="pft-toggle" data-testid="translate-inline-toggle">
              <input type="checkbox" id="pft-inline"/>
              <span>Show translation directly on PDF (inline-overlay)</span>
            </label>
            <label class="pft-toggle" data-testid="translate-autofit-toggle">
              <input type="checkbox" id="pft-autofit" checked/>
              <span>Auto-fit font to box</span>
            </label>
          </div>
          <div id="pft-auth-prompt" style="display:none"></div>
          <div class="pft-results" id="pft-results">
            <div class="pft-empty" style="grid-column:1 / -1">Choose a target language and click "Translate page".</div>
          </div>
        </div>
        <div class="pft-foot">
          <span class="pft-provider" id="pft-provider" data-testid="translate-provider"></span>
          <button class="pft-secondary" id="pft-copy" data-testid="translate-copy">Copy translation</button>
          <button class="pft-secondary" id="pft-restore" data-testid="translate-restore">Restore original</button>
        </div>
      </div>`;
    document.body.appendChild(bg);

    // populate language selects
    const srcSel = bg.querySelector('#pft-src');
    const tgtSel = bg.querySelector('#pft-tgt');
    LANGS.forEach(([code, name]) => {
      srcSel.appendChild(new Option(name, code));
      if (code !== 'auto') tgtSel.appendChild(new Option(name, code));
    });
    srcSel.value = 'auto';
    tgtSel.value = (navigator.language || 'en').slice(0, 2);
    if (!LANGS.some(([c]) => c === tgtSel.value)) tgtSel.value = 'de';

    // listeners
    bg.querySelector('#pft-close').onclick = () => closeModal();
    bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
    bg.querySelector('#pft-run').onclick = runTranslate;
    bg.querySelector('#pft-inline').onchange = (e) => {
      state.overlayOn = e.target.checked;
      renderOverlay();
    };
    bg.querySelector('#pft-autofit').onchange = (e) => {
      state.autoFit = e.target.checked;
      renderOverlay();
    };
    bg.querySelector('#pft-copy').onclick = copyTranslation;
    bg.querySelector('#pft-restore').onclick = () => {
      state.overlayOn = false;
      bg.querySelector('#pft-inline').checked = false;
      removeOverlay();
      toast('Original restored');
    };
  }

  function buildFab() {
    const btn = document.createElement('button');
    btn.className = 'pft-fab';
    btn.id = 'pft-fab';
    btn.setAttribute('data-testid', 'translate-fab');
    btn.innerHTML = `<span class="pft-dot"></span><span>🌍 Translate</span>`;
    btn.title = 'Translate this PDF page';
    btn.style.display = 'none';
    btn.onclick = openModal;
    document.body.appendChild(btn);
    refreshBadge();
    // Show FAB only when editor is visible and a PDF is loaded
    const updateFabVisibility = () => {
      const editorVisible = document.getElementById('page-editor') &&
                            !document.getElementById('page-editor').classList.contains('out');
      btn.style.display = (editorVisible && window.currentPDF) ? 'flex' : 'none';
    };
    new MutationObserver(updateFabVisibility).observe(document.body, {
      attributes: true, subtree: true, attributeFilter: ['class']
    });
    // Also poll for currentPDF becoming available
    setInterval(updateFabVisibility, 800);
  }

  function refreshBadge() {
    const fab = document.getElementById('pft-fab');
    const badge = document.getElementById('pft-badge');
    if (!fab) return;
    fab.classList.remove('local', 'loading');
    if (state.localLoading) {
      fab.classList.add('loading');
      if (badge) { badge.className = 'pft-badge loading'; badge.textContent = '⏳ Loading local model…'; }
    } else if (state.localReady) {
      fab.classList.add('local');
      if (badge) { badge.className = 'pft-badge local'; badge.textContent = '🔒   Privacy-Mode (local)'; }
    } else {
      if (badge) { badge.className = 'pft-badge'; badge.textContent = '⚡ Server-Mode'; }
    }
  }

  function openModal() {
    const editorVisible = document.getElementById('page-editor') &&
                          !document.getElementById('page-editor').classList.contains('out');
    if (!editorVisible || !window.currentPDF) {
      toast('Open a PDF first');
      return;
    }
    document.getElementById('pft-modal').classList.add('open');
    refreshAuthPrompt();
  }
  function closeModal() {
    document.getElementById('pft-modal').classList.remove('open');
  }

  function refreshAuthPrompt() {
    const box = document.getElementById('pft-auth-prompt');
    if (!box) return;
    if (isLoggedIn()) { box.style.display = 'none'; return; }
    const used = guestUsed();
    if (used >= GUEST_LIMIT) {
      box.style.display = 'block';
      box.className = 'pft-auth-prompt';
      box.innerHTML = `
        <span>🌍 You've used your free translation. <strong>Sign in for unlimited translations</strong> — free.</span>
        <button data-testid="translate-signin-btn">Sign in</button>`;
      box.querySelector('button').onclick = () => {
        closeModal();
        if (typeof window.openAuthModal === 'function') window.openAuthModal();
        else document.getElementById('auth-modal')?.classList.remove('hidden');
      };
    } else {
      box.style.display = 'block';
      box.className = 'pft-auth-prompt';
      box.style.background = '#eef2ff'; box.style.borderColor = '#c7d2fe'; box.style.color = '#3730a3';
      box.innerHTML = `<span>👋 ${GUEST_LIMIT - used} free translation as guest. Sign in for unlimited.</span>`;
    }
  }

// --------------------------------------------------------------
  // 6. TRANSLATION FLOW (OPTIMIERT MIT TIMEOUTS & PROGRESS)
  // --------------------------------------------------------------
  async function fetchWithTimeout(url, options = {}) {
    const { timeout = 20000 } = options; // 20 Sekunden Timeout
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (e) {
      clearTimeout(id);
      if (e.name === 'AbortError') throw new Error('Server timeout');
      throw e;
    }
  }

  async function runTranslate() {
    const gate = canTranslate();
    if (!gate.ok) {
      refreshAuthPrompt();
      toast('Guest limit reached — sign in for unlimited');
      return;
    }
    const src = document.getElementById('pft-src').value;
    const tgt = document.getElementById('pft-tgt').value;
    const btn = document.getElementById('pft-run');
    btn.disabled = true;
    btn.innerHTML = `<span class="pft-spin"></span>Working…`;
    
    const resultsBox = document.getElementById('pft-results');
    resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1"><span class="pft-spin"></span>Extracting & translating…</div>`;

    try {
      // 1. Text extrahieren (mit Timeout)
      const extracted = await extractCurrentPage();
      const items = extracted.items || [];
      if (!items.length) {
        resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1">No selectable text found on this page.</div>`;
        return;
      }
      const texts = items.map(i => i.text);

      // 2. Engine auswählen
      let translated = null, provider = '';
      if (state.localReady) {
        translated = await translateLocal(texts, src, tgt);
        provider = 'local';
      } else {
        try {
          const r = await translateServer(texts, src, tgt);
          translated = r.translated;
          provider = r.provider + ' (server)';
        } catch (e) {
          console.warn('[pft] Server failed or timeout, loading local mode:', e);
          resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1"><span class="pft-spin"></span>Server quota reached — loading local model (one-time, ~250MB)…</div>`;
          await ensureLocal();
          translated = await translateLocal(texts, src, tgt);
          provider = 'local';
        }
      }

      if (!isLoggedIn()) incGuestUsed();

      state.lastResult = {
        page: window.currentPageNum || 1,
        pageWidth: extracted.pageWidth,
        pageHeight: extracted.pageHeight,
        items: items.map((it, idx) => ({ ...it, trans: translated[idx] || '' })),
        source: src, target: tgt, provider,
      };

      renderResults();
      renderOverlay();
      document.getElementById('pft-provider').textContent = `via ${provider} · ${translated.length} segments`;
    } catch (e) {
      console.error('[pft] Übersetzung fehlgeschlagen', e);
      resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1;color:#b91c1c">Translation failed: ${escapeHtml(e.message || String(e))}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Translate page';
      refreshAuthPrompt();
    }
  }

function renderResults() {
    if (!state.lastResult) return;
    
    // FIX: Die Box muss auch in dieser Funktion kurz gegriffen werden
    const resultsBox = document.getElementById('pft-results');
    if (!resultsBox) return;

    const items = state.lastResult.items;
    const html = `
      <div class="pft-col"><h4>Original</h4>${items.map(i => `<div class="pft-line">${escapeHtml(i.text)}</div>`).join('')}</div>
      <div class="pft-col"><h4>Translation</h4>${items.map(i => `<div class="pft-line">${escapeHtml(i.trans)}</div>`).join('')}</div>`;
    resultsBox.innerHTML = html;
  }

  async function extractCurrentPage() {
    const fd = new FormData();
    const file = new Blob([window.currentPDF], { type: 'application/pdf' });
    fd.append('pdf', file, 'doc.pdf');
    fd.append('page', String((window.currentPageNum || 1) - 1));
    const r = await fetchWithTimeout(`${API_BASE}/extract`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`Extract failed (${r.status})`);
    return await r.json();
  }

  async function translateServer(texts, source, target) {
    const fd = new FormData();
    fd.append('texts', JSON.stringify(texts));
    fd.append('source', source);
    fd.append('target', target);
    const r = await fetchWithTimeout(`${API_BASE}/translate`, { method: 'POST', body: fd });
    if (r.status === 503) throw new Error('all_server_exhausted');
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    return await r.json();
  }

  // --------------------------------------------------------------
  // 7. LOCAL ENGINE (STABILE BATCH-VERARBEITUNG)
  // --------------------------------------------------------------
async function ensureLocal() {
    if (state.localReady) return;
    if (state.localLoading) {
      while (state.localLoading) await new Promise(r => setTimeout(r, 300));
      if (state.localReady) return;
      throw new Error(state.localError || 'Local model failed');
    }
    state.localLoading = true;
    refreshBadge();
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
      mod.env.allowLocalModels = false;

      // PERFORMANCE-BOOST: Nutze die echten CPU-Kerne des Nutzers (max. 4 parallel)
      // Das beschleunigt die eigentliche Übersetzung nach dem Laden massiv!
      if (navigator.hardwareConcurrency) {
        mod.env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency);
      }

      state.translator = await mod.pipeline('translation', 'Xenova/m2m100_418M', {
        quantized: true,
        progress_callback: (p) => {
          const badge = document.getElementById('pft-badge');
          if (p.status === 'downloading' || p.status === 'progress') {
            const pct = p.total ? ` (${((p.loaded / p.total) * 100).toFixed(0)}%)` : '';
            if (badge) badge.textContent = `⏳ Loading model… ${pct}%`;
          }
        },
      });
      state.localReady = true;
    } catch (e) {
      state.localError = e.message || String(e);
      console.error('[pft] Lokaler Ladefehler', e);
      throw e;
    } finally {
      state.localLoading = false;
      refreshBadge();
    }
  }

  async function translateLocal(texts, src, tgt) {
    await ensureLocal();
    if (!texts.length) return [];
    const srcLang = (src && src !== 'auto') ? src : 'en';

    // Wir teilen in kleine Chunks (z.B. 5 Texte auf einmal), damit das UI nicht einfriert
    const chunkSize = 5;
    const out = [];
    const resultsBox = document.getElementById('pft-results');

    for (let i = 0; i < texts.length; i += chunkSize) {
      const chunk = texts.slice(i, i + chunkSize);
      
      // UI updaten, damit der User sieht, dass gearbeitet wird
      if (resultsBox) {
        resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1"><span class="pft-spin"></span>Extracting & translating…</div>`;
;
      }
      
      // Kurz dem UI Zeit geben zum Rendern (verhindert das Einfrieren des Tabs)
      await new Promise(r => setTimeout(r, 20));

      const results = await state.translator(chunk, { src_lang: srcLang, tgt_lang: tgt });
      
      const mapped = results.map(r => {
        if (Array.isArray(r)) return r[0]?.translation_text || '';
        return r?.translation_text || '';
      });
      out.push(...mapped);
    }
    return out;
  }

  // Smart-Preload: schedule background load after first idle moment
  function schedulePreload() {
    const start = () => {
      if (state.localReady || state.localLoading) return;
      ensureLocal().catch(() => {/* silent — server still works */});
    };
    // Wait until user is in editor and idle for 4s, then preload silently
    let triggered = false;
    const tryStart = () => {
      if (triggered) return;
      const ed = document.getElementById('page-editor');
      if (ed && !ed.classList.contains('out')) {
        triggered = true;
        setTimeout(start, 4000);
      }
    };
    new MutationObserver(tryStart).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    setTimeout(tryStart, 8000);
  }

  // --------------------------------------------------------------
  // 8. INLINE OVERLAY
  // --------------------------------------------------------------
  function removeOverlay() {
    document.querySelectorAll('.pft-overlay').forEach(el => el.remove());
  }

  function renderOverlay() {
    removeOverlay();
    if (!state.overlayOn || !state.lastResult) return;
    if (state.lastResult.page !== (window.currentPageNum || 1)) return;

    const canvas = document.getElementById('pdf-canvas');
    const wrap = document.getElementById('canvas-wrap');
    if (!canvas || !wrap) return;

    const overlay = document.createElement('div');
    overlay.className = 'pft-overlay' + (state.autoFit ? '' : ' wrap');
    overlay.setAttribute('data-testid', 'translate-inline-overlay');
    overlay.style.width = canvas.offsetWidth + 'px';
    overlay.style.height = canvas.offsetHeight + 'px';
    overlay.style.left = canvas.offsetLeft + 'px';
    overlay.style.top = canvas.offsetTop + 'px';

    const scaleX = canvas.offsetWidth / state.lastResult.pageWidth;
    const scaleY = canvas.offsetHeight / state.lastResult.pageHeight;

    state.lastResult.items.forEach(it => {
      if (!it.trans) return;
      const el = document.createElement('div');
      el.className = 'pft-overlay-item';
      const w = (it.x1 - it.x) * scaleX;
      const h = (it.y1 - it.y) * scaleY;
      el.style.left = (it.x * scaleX) + 'px';
      el.style.top  = (it.y * scaleY) + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      // base font size proportional to original
      let fs = it.size * scaleY * 0.95;
      if (state.autoFit) {
        // shrink if translated text is much longer than original
        const ratio = (it.text.length || 1) / Math.max(it.trans.length, 1);
        if (ratio < 1) fs *= Math.max(0.65, ratio * 1.05);
      }
      el.style.fontSize = Math.max(6, fs) + 'px';
      // colour from original (PDF stores 0xRRGGBB int)
      const c = it.color | 0;
      el.style.color = `rgb(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255})`;
      el.textContent = it.trans;
      overlay.appendChild(el);
    });

    wrap.appendChild(overlay);
  }

  // re-position overlay if window resizes / canvas re-renders
  window.addEventListener('resize', () => renderOverlay());
  // when user changes page, drop overlay (it belongs to old page)
  const pageWatcher = setInterval(() => {
    if (!state.lastResult) return;
    if (state.lastResult.page !== (window.currentPageNum || 1)) {
      removeOverlay();
    } else if (state.overlayOn && !document.querySelector('.pft-overlay')) {
      renderOverlay();
    }
  }, 600);

  // --------------------------------------------------------------
  // 9. UTILS
  // --------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function toast(msg) {
    const t = document.getElementById('toast') || (() => {
      const x = document.createElement('div'); x.className = 'toast'; x.id = 'toast';
      document.body.appendChild(x); return x;
    })();
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
  }
  function copyTranslation() {
    if (!state.lastResult) return;
    const txt = state.lastResult.items.map(i => i.trans).join('\n');
    navigator.clipboard.writeText(txt).then(() => toast('Copied'));
  }

  // --------------------------------------------------------------
  // 10. INIT
  // --------------------------------------------------------------
  function init() {
    if (document.getElementById('pft-fab')) return;
    injectStyles();
    buildModal();
    buildFab();
    schedulePreload();
    // expose API for power users / tests
    window.PFTranslate = {
      open: openModal,
      run: runTranslate,
      state,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
