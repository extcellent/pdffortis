/* ====================================================================
 * pdfortis-translate.js
 * Self-installing PDF translation module for PDFortis
 *  - 100% Client-Side (kein Render-/Backend-Server mehr nötig)
 *  - Text-Extraktion über pdfortis-clientengine.js (extractPageLocal)
 *  - Übersetzung über Transformers.js / m2m100 (~250MB, WASM-Worker im Browser)
 *  - Inline-Overlay Toggle + Side-by-Side modal
 *  - Auth Gate (guests: 1 free, registered users: unlimited)
 * --------------------------------------------------------------------
 * Requires in index.html:
 *   <script src="/pdfortis-clientengine.js"></script>          <!-- VOR diesem Script -->
 *   <script src="/pdfortis-translate.js" defer></script>
 *
 * Hooks into existing PDFortis runtime:
 *   - window.currentPDF          (Uint8Array of current PDF — already used by editor)
 *   - window.currentPageNum      (1-based active page)
 *   - window.currentPdfDocLocal  (pdf.js document object — NEU, für lokale Extraktion)
 *   - window.pfGetSession()      (Supabase auth — already present)
 *   - #canvas-wrap , #overlay-layer , #pdf-canvas (existing IDs)
 *   - #editor-toolbar / .editor-bar (we attach our button to first found)
 * ==================================================================== */
(function () {
  'use strict';

  const LS_GUEST_KEY = 'pdfortis_guest_translations_used';
  const GUEST_LIMIT = 1;

  // --------------------------------------------------------------
  // 1. STATE
  // --------------------------------------------------------------
  const state = {
    mode: 'local',           // nur noch 'local' — kein Server mehr
    localReady: false,
    localLoading: false,
    localError: null,
    translator: null,        // Transformers.js pipeline
    resultsByPage: {},       // { [pageNum]: { items:[{orig,trans,...}], page, pageWidth, pageHeight, source, target, provider } }
    overlayOn: false,
    autoFit: true,           // pro-mode: auto-shrink + small overflow tolerance
  };
  function currentPageResult() { return state.resultsByPage[window.currentPageNum || 1] || null; }

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
      .pft-go:disabled{opacity:.6;cursor:not-allowed}
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
      .pft-overlay-item{position:absolute;padding:0 1px;line-height:1;border-radius:0;overflow:visible;white-space:nowrap;}
      .pft-overlay.wrap .pft-overlay-item{white-space:normal;}


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
          <span class="pft-badge" id="pft-badge" data-testid="translate-mode-badge">⏳ Preparing local model…</span>
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
          <div class="pft-row" data-testid="translate-scope-row" style="gap:14px">
            <label style="font-size:12px;color:#64748b;font-weight:600">Scope</label>
            <label style="font-size:13px;display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="radio" name="pft-scope" value="current" id="pft-scope-current" checked/> Current Page  
            </label>
            <label style="font-size:13px;display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="radio" name="pft-scope" value="all" id="pft-scope-all"/> All Pages
            </label>
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

    bg.addEventListener('click', (e) => {
      if (e.target !== bg) return;
      if (state.translating) {
        console.warn('[pft] Backdrop-Click ignoriert — Übersetzung läuft noch');
        return;
      }
      closeModal();
    });
    
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
      if (badge) { badge.className = 'pft-badge'; badge.textContent = '⏳ Preparing local model…'; }
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
  // 6. TRANSLATION FLOW (100% lokal — kein Server-Fetch mehr)
  // --------------------------------------------------------------
  // Übersetzt ein Array von Texten für EIN Sprachpaar (Modell-Load, Same-Language-
  // Skip, Worker-Recycling) — ausgelagert, damit sowohl "nur diese Seite" als
  // auch "alle Seiten" dieselbe Logik pro Seite wiederverwenden können.
  async function translatePageTexts(texts, src, tgt, resultsBox) {
    const srcLangForPair = (src && src !== 'auto') ? src : 'en';
    const pairKey = srcLangForPair + '-' + tgt;

    if (srcLangForPair === tgt) {
      console.warn('[pft] Quelle und Ziel identisch — Übersetzung übersprungen', pairKey);
      return { translated: texts.slice(), provider: 'skipped (same language)' };
    }

    if (lastTranslatedPair && lastTranslatedPair !== pairKey && workerPool.length) {
      resetWorkerPool();
    }
    if (!state.localReady) {
      if (resultsBox) resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1"><span class="pft-spin"></span>Loading local model (one-time, ~250MB)…</div>`;
      await ensureLocal();
    }
    const translated = await translateLocal(texts, src, tgt);
    lastTranslatedPair = pairKey;

    translationsSinceReset++;
    if (translationsSinceReset >= RECYCLE_AFTER_N_TRANSLATIONS) {
      resetWorkerPool();
    }
    return { translated, provider: 'local' };
  }

  // ────────────────────────────────────────────────────────────────
  // Absatz-Gruppierung (NEU)
  // extractPageLocal() liefert Text zeilenweise (1 Item pro visueller
  // Zeile aus dem pdf.js-Textlayer). Für Fließtext (Anschreiben etc.)
  // übersetzt das MT-Modell isolierte, mitten im Satz abgeschnittene
  // Zeilen mit teils halluzinierten Ergebnissen. Diese Funktion fasst
  // zusammengehörige Zeilen zu Absatz-Blöcken zusammen, BEVOR übersetzt
  // wird — die Original-Items werden dabei nicht verändert, nur über
  // itemIndices referenziert (Edit Text / clientengine.js bleibt unberührt).
  //
  // Kriterium "gehört zur selben Gruppe wie die Vorzeile":
  //   1. gleicher Font + gleiche Flags (Bold/Italic reißt Absatz ab)
  //   2. ähnliche Schriftgröße (Toleranz statt exakt, Rundungsfehler)
  //   3. vertikaler Sprung passt zu einem normalen Zeilenumbruch
  //      (nicht zu groß) UND passt zum bisher in der Gruppe beobachteten
  //      Zeilenabstand (referenceGap) — fängt Absatz-Leerzeilen ab, auch
  //      wenn die reine Größen-Schwelle sie noch durchlassen würde
  //   4. ähnliche linke X-Startposition (linksbündiger Fließtext)
  // ────────────────────────────────────────────────────────────────
  const PARA_LINE_GAP_MAX = 1.65;      // gap <= size * dieser Faktor
  const PARA_REF_GAP_TOLERANCE = 1.3; // gap <= referenceGap * dieser Faktor
  const PARA_X_TOLERANCE_MIN = 4;     // pt, Mindest-Toleranz für X-Start
  const PARA_COLOR_TOLERANCE = 220;     // Manhattan-Distanz RGB; Überschrift-Akzentfarbe vs. Fließtext liegt i.d.R. weit drüber

  // Farbabstand mit Toleranz (statt exaktem Vergleich) — Farbsampling pro
  // Zeile hat leichtes Rauschen (Anti-Aliasing), auch innerhalb eines
  // einfarbigen Absatzes. Grobe Manhattan-Distanz über RGB reicht.
  function _colorDelta(a, b) {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
  }

  
  function groupItemsIntoParagraphs(items) {
    const blocks = [];
    let currentIdxs = null;
    let referenceGap = null;

    const closeCurrent = () => {
      if (!currentIdxs || !currentIdxs.length) return;
      const first = items[currentIdxs[0]];
      const last = items[currentIdxs[currentIdxs.length - 1]];
      blocks.push({
        itemIndices: currentIdxs.slice(),
        text: currentIdxs.map(i => items[i].text).join(' '),
        x: Math.min(...currentIdxs.map(i => items[i].x)),
        y: first.y,
        x1: Math.max(...currentIdxs.map(i => items[i].x1)),
        y1: last.y1,
        size: first.size,
        font: first.font,
        flags: first.flags,
        color: first.color,
      });
    };

    for (let i = 0; i < items.length; i++) {
      if (!currentIdxs) { currentIdxs = [i]; continue; }

      const prev = items[currentIdxs[currentIdxs.length - 1]];
      const cur = items[i];

      const fontMatch = prev.font === cur.font && prev.flags === cur.flags;
      const sizeMatch = Math.abs(prev.size - cur.size) <= Math.max(0.4, prev.size * 0.08);
      const colorMatch = _colorDelta(prev.color, cur.color) <= PARA_COLOR_TOLERANCE;
      const gap = cur.y - prev.y;
      const gapPlausible = gap > 0 && gap <= prev.size * PARA_LINE_GAP_MAX;
      const gapConsistent = referenceGap === null || gap <= referenceGap * PARA_REF_GAP_TOLERANCE;
      const xMatch = Math.abs(prev.x - cur.x) <= Math.max(PARA_X_TOLERANCE_MIN, prev.size * 0.35);

      if (fontMatch && sizeMatch && colorMatch && gapPlausible && gapConsistent && xMatch) {
        currentIdxs.push(i);
        referenceGap = referenceGap === null ? gap : (referenceGap * 0.7 + gap * 0.3);
      } else {
        closeCurrent();
        currentIdxs = [i];
        referenceGap = null;
      }
    }
    closeCurrent();
    return blocks;
  }

  // Verteilt den übersetzten Block-Text grob proportional (nach Zeichen-
  // anteil der Original-Zeile am Gesamtblock) auf die einzelnen Original-
  // Zeilen zurück. Nur kosmetisch für die Zeilen-Ansicht (renderResults/
  // copyTranslation) — für das Overlay/Download-Rendering zählt der volle
  // Block-Text (siehe unten), nicht diese Verteilung.
  function _distributeTranslationAcrossLines(lineTexts, translatedText) {
    if (!lineTexts.length) return [];
    if (lineTexts.length === 1) return [translatedText || ''];
    const words = (translatedText || '').split(/\s+/).filter(Boolean);
    if (!words.length) return lineTexts.map(() => '');

    const totalLen = lineTexts.reduce((s, t) => s + t.length, 0) || 1;
    const counts = lineTexts.map(t => Math.max(1, Math.round(words.length * (t.length / totalLen))));
    const diff = words.length - counts.reduce((a, b) => a + b, 0);
    counts[counts.length - 1] = Math.max(0, counts[counts.length - 1] + diff);

    const out = [];
    let idx = 0;
    for (let c of counts) {
      out.push(words.slice(idx, idx + c).join(' '));
      idx += c;
    }
    if (idx < words.length) {
      out[out.length - 1] = (out[out.length - 1] + ' ' + words.slice(idx).join(' ')).trim();
    }
    return out;
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
    const scope = document.querySelector('input[name="pft-scope"]:checked')?.value || 'current';
    const btn = document.getElementById('pft-run');
    btn.disabled = true;
    btn.innerHTML = `<span class="pft-spin"></span>Working…`;

    const resultsBox = document.getElementById('pft-results');
    resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1"><span class="pft-spin"></span>Extracting & translating…</div>`;

  state.translating = true;

    // Ungespeicherte Edit-Text-Änderungen vor der Übersetzung einbetten —
    // sonst liest extractPageLocal() noch window.currentPdfDocLocal (=pdfDoc)
    // in der alten, unbearbeiteten Version (Edits werden sonst erst beim
    // Download in performDownload() Schritt 1 gebacken).
    if (typeof pendingEdits !== 'undefined' && pendingEdits.length > 0 && typeof editBatchLocal === 'function') {
      try {
        const workBytes = await editBatchLocal(pdfBytes, pendingEdits);
        pendingEdits.length = 0;
        pdfBytes = workBytes;
        pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
        pdfLibDoc = await PDFLib.PDFDocument.load(pdfBytes);
      } catch (e) {
        console.warn('[pft] konnte pendingEdits vor Übersetzung nicht einbetten', e);
      }
    }

    try {
      if (typeof extractPageLocal !== 'function') throw new Error('pdfortis-clientengine.js nicht geladen (extractPageLocal fehlt)');
      if (!window.currentPdfDocLocal) throw new Error('PDF not loaded');
      const totalPages = window.currentPdfDocLocal.numPages || 1;
      const pagesToProcess = scope === 'all'
        ? Array.from({ length: totalPages }, (_, i) => i + 1)
        : [window.currentPageNum || 1];

      let anyTranslated = false;
      for (let p = 0; p < pagesToProcess.length; p++) {
        const pageNum = pagesToProcess[p];
        if (pagesToProcess.length > 1) {
          resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1"><span class="pft-spin"></span>Page ${pageNum}/${totalPages} — extracting…</div>`;
        }

        const extracted = await extractPageLocal(window.currentPdfDocLocal, pageNum - 1);
        const items = extracted.items || [];
        console.log('[pft] extracted', { page: pageNum, items: items.length, w: extracted.pageWidth, h: extracted.pageHeight });

        if (!items.length) {
          state.resultsByPage[pageNum] = { page: pageNum, pageWidth: extracted.pageWidth, pageHeight: extracted.pageHeight, items: [], blocks: [], source: src, target: tgt, provider: 'empty' };
          continue;
        }

        // NEU: Zeilen zu Absätzen gruppieren, dann pro Absatz EIN
        // zusammenhängender Text an die Übersetzung übergeben (Kontext
        // bleibt erhalten statt einzelner, mitten im Satz abgeschnittener
        // Zeilenfragmente).
        const blocks = groupItemsIntoParagraphs(items);
        const blockTexts = blocks.map(b => b.text);
        const { translated, provider } = await translatePageTexts(blockTexts, src, tgt, resultsBox);

        // Rückmapping: jeder Block bekommt seine Übersetzung (maßgeblich
        // für Overlay/Download). Zusätzlich wird die Block-Übersetzung
        // grob auf die referenzierten Original-Zeilen zurückverteilt, damit
        // renderResults()/copyTranslation() (die weiterhin pro Zeile
        // arbeiten) sinnvolle Inhalte zeigen.
        const newItems = items.map(it => ({ ...it }));
        blocks.forEach((b, bi) => {
          b.trans = translated[bi] || '';
          const lineTexts = b.itemIndices.map(i => items[i].text);
          const distributed = _distributeTranslationAcrossLines(lineTexts, b.trans);
          b.itemIndices.forEach((itemIdx, li) => {
            newItems[itemIdx].trans = distributed[li] || '';
          });
        });

        state.resultsByPage[pageNum] = {
          page: pageNum,
          pageWidth: extracted.pageWidth,
          pageHeight: extracted.pageHeight,
          items: newItems,
          blocks,           // NEU: Absatz-Blöcke, maßgeblich für Overlay/Download
          source: src, target: tgt, provider,
        };
        anyTranslated = true;
      }

      if (anyTranslated && !isLoggedIn()) incGuestUsed();

      renderResults();
      renderOverlay();
      document.getElementById('pft-provider').textContent = `powered by PDFortis`;
    } catch (e) {
      console.error('[pft] Übersetzung fehlgeschlagen', e);
      resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1;color:#b91c1c">Translation failed: ${escapeHtml(e.message || String(e))}</div>`;
    } finally {
      state.translating = false;  
      btn.disabled = false;
      btn.textContent = 'Translate page';
      refreshAuthPrompt();
    }
  }

function renderResults() {
  const res = currentPageResult();
  if (!res) return;
  const resultsBox = document.getElementById('pft-results');
  if (!resultsBox) return;
  const items = res.items;

  const origCol = document.createElement('div');
  origCol.className = 'pft-col';
  origCol.innerHTML = '<h4>Original</h4>';

  const transCol = document.createElement('div');
  transCol.className = 'pft-col';
  transCol.innerHTML = '<h4>Translation</h4>';

  items.forEach(i => {
    const a = document.createElement('div');
    a.className = 'pft-line';
    a.textContent = i.text;
    origCol.appendChild(a);

    const b = document.createElement('div');
    b.className = 'pft-line';
    b.textContent = i.trans || i.text;
    transCol.appendChild(b);
  });

  requestAnimationFrame(() => {
    resultsBox.innerHTML = '';
    resultsBox.appendChild(origCol);
    resultsBox.appendChild(transCol);
  });
}

  // Extraktion läuft jetzt komplett lokal über pdfortis-clientengine.js
  // (extractPageLocal muss vor diesem Script geladen sein, siehe index.html)
  // — wird jetzt direkt in runTranslate() pro Seite aufgerufen (extractPageLocal
  // ist global aus clientengine.js verfügbar).

// ====================================================================
// 7. LOCAL ENGINE (ULTRA-STABILER WASM-WORKER — KEIN HÄNGEN, VOLLSTÄNDIGER TEXT)
// ====================================================================
let workerResolver = null;
let workerRejecter = null;
let workerProgressCallback = null;
const pendingChunks = new Map();
let chunkCounter = 0;

const workerCode = `
  import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';
  env.allowLocalModels = false;
  env.backends.onnx.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 1, 4);

  // Opus-MT: schnelle Modelle für häufige Sprachpaare (~10s)
  // NLLB: Fallback für alle anderen Sprachen (~2min)
  const OPUS_MODELS = {
    'en-de': 'Xenova/opus-mt-en-de',
    'de-en': 'Xenova/opus-mt-de-en',
    'en-fr': 'Xenova/opus-mt-en-fr',
    'fr-en': 'Xenova/opus-mt-fr-en',
    'en-es': 'Xenova/opus-mt-en-es',
    'es-en': 'Xenova/opus-mt-es-en',
    'en-it': 'Xenova/opus-mt-en-it',
    'it-en': 'Xenova/opus-mt-it-en',
    'en-pt': 'Xenova/opus-mt-en-pt',
    'pt-en': 'Xenova/opus-mt-ROMANCE-en',
    'en-nl': 'Xenova/opus-mt-en-nl',
    'nl-en': 'Xenova/opus-mt-nl-en',
    'en-pl': 'Xenova/opus-mt-en-pl',
    'pl-en': 'Xenova/opus-mt-pl-en',
    'en-ru': 'Xenova/opus-mt-en-ru',
    'ru-en': 'Xenova/opus-mt-ru-en',
    'en-tr': 'Xenova/opus-mt-en-tr',
    'tr-en': 'Xenova/opus-mt-tr-en',
    'en-zh': 'Xenova/opus-mt-en-zh',
    'zh-en': 'Xenova/opus-mt-zh-en',
  };

  const NLLB_MAP = {
    'en': 'eng_Latn', 'de': 'deu_Latn', 'fr': 'fra_Latn',
    'es': 'spa_Latn', 'it': 'ita_Latn', 'pt': 'por_Latn',
    'nl': 'nld_Latn', 'pl': 'pol_Latn', 'ru': 'rus_Cyrl',
    'uk': 'ukr_Cyrl', 'cs': 'ces_Latn', 'ro': 'ron_Latn',
    'sv': 'swe_Latn', 'da': 'dan_Latn', 'fi': 'fin_Latn',
    'el': 'ell_Grek', 'hu': 'hun_Latn', 'bg': 'bul_Cyrl',
    'ar': 'arb_Arab', 'he': 'heb_Hebr', 'hi': 'hin_Deva',
    'zh': 'zho_Hans', 'ja': 'jpn_Jpan', 'ko': 'kor_Hang',
    'tr': 'tur_Latn', 'hr': 'hrv_Latn', 'sk': 'slk_Latn',
    'sl': 'slv_Latn', 'no': 'nob_Latn', 'lt': 'lit_Latn',
    'lv': 'lvs_Latn', 'et': 'est_Latn', 'sr': 'srp_Cyrl',
    'sq': 'als_Latn'
  };

  let translator = null;
  let currentPair = null;
  let loadPromise = null;   // Lock gegen Race Condition: verhindert, dass mehrere
  let loadPair = null;      // gleichzeitig eintreffende Chunks je einen eigenen,
                             // parallelen pipeline()-Ladevorgang für dasselbe Modell starten.

  async function loadModel(srcLang, tgtLang) {
    const pair = srcLang + '-' + tgtLang;
    if (currentPair === pair && translator) return;

    // Lädt bereits genau dieses Paar? Dann NICHT nochmal laden, sondern
    // auf den bereits laufenden Ladevorgang warten.
    if (loadPromise && loadPair === pair) {
      await loadPromise;
      return;
    }

    loadPair = pair;
    loadPromise = (async () => {
      const opusModel = OPUS_MODELS[pair];
      const isOpus = !!opusModel;
      const modelId = opusModel || 'Xenova/nllb-200-distilled-600M';

      self.postMessage({ type: 'model_loading', isOpus, pair });
      console.log('[pft] Loading model:', modelId, 'for pair:', pair);

      const t = await pipeline('translation', modelId, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: (p) => {
          if (p.status === 'downloading' || p.status === 'progress') {
            const pct = p.total ? ((p.loaded / p.total) * 100).toFixed(0) : '';
            self.postMessage({ type: 'progress', pct });
          }
        },
      });
      translator = t;
      currentPair = pair;
    })();

    try {
      await loadPromise;
    } finally {
      loadPromise = null;
      loadPair = null;
    }
  }

  self.onmessage = async (e) => {
    const { type, data } = e.data;

    if (type === 'init') {
      try {
        // Beim Init laden wir EN→DE vor (häufigstes Paar, klein)
        await loadModel('en', 'de');
        self.postMessage({ type: 'ready', device: 'wasm' });
      } catch (err) {
        self.postMessage({ type: 'error', error: err.message || String(err) });
      }

    } else if (type === 'translate') {
      try {
        const { chunk, srcLang, tgt, chunkId } = data;
        await loadModel(srcLang, tgt);

        const pair = srcLang + '-' + tgt;
        const isOpus = !!OPUS_MODELS[pair];

        // max_new_tokens an die tatsächliche Textlänge im Chunk anpassen.
        // Vorher: fix 128 für JEDEN Text — bei kurzen, isolierten Fragmenten
        // (Jahreszahlen, Firmennamen, einzelne Wörter, wie sie in Lebensläufen
        // sehr häufig vorkommen) kann ein quantisiertes Modell gelegentlich
        // nicht sauber stoppen und generiert bis zum Maximum durch. Das
        // multipliziert sich bei vielen kurzen Fragmenten schnell zu Minuten.
        const longestWords = Math.max(...chunk.map(t => (t || '').split(/\s+/).length));
        const maxNewTokens = Math.min(128, Math.max(16, longestWords * 4 + 10));

        let results;
        if (isOpus) {
          // Opus-MT: kein src_lang/tgt_lang nötig
          // Echter Batch-Call (EIN Modell-Aufruf für den ganzen Chunk) statt
          // N einzelner sequenzieller Calls — spart Overhead pro Text erheblich.
          const out = await translator(chunk, {
            max_new_tokens: maxNewTokens,
            num_beams: 1,
            do_sample: false
          });
          results = Array.isArray(out) ? out.map(r => Array.isArray(r) ? r : [r]) : [[out]];
        } else {
          // NLLB: braucht Sprachcodes
          const safeSrc = NLLB_MAP[srcLang] || 'eng_Latn';
          const safeTgt = NLLB_MAP[tgt] || 'deu_Latn';
          const out = await translator(chunk, {
            src_lang: safeSrc,
            tgt_lang: safeTgt,
            max_new_tokens: maxNewTokens,
            num_beams: 1,
            do_sample: false
          });
          results = Array.isArray(out) ? out.map(r => Array.isArray(r) ? r : [r]) : [[out]];
        }

        self.postMessage({ type: 'translated', result: results.map(r => r[0]), chunkId });
      } catch (err) {
        self.postMessage({ type: 'translate_error', error: err.message || String(err), chunkId: data.chunkId });
      }
    }
  };
`;

// Ersetze getWorker() mit einem Worker-Pool
const workerPool = [];

// Zählt abgeschlossene Übersetzungen, um den Worker periodisch zu recyceln.
// Grund: WASM-Linear-Memory kann NICHT wieder freigegeben werden, solange
// der Worker lebt — auch nicht durch Neuzuweisen von `translator` im Worker.
// Nur ein echtes worker.terminate() + neuer Worker gibt den Speicher zurück.
let translationsSinceReset = 0;
let lastTranslatedPair = null;
const RECYCLE_AFTER_N_TRANSLATIONS = 3;

function resetWorkerPool() {
  workerPool.forEach(w => { try { w.terminate(); } catch(_) {} });
  workerPool.length = 0;
  state.localReady = false;
  translationsSinceReset = 0;
  console.log('[pft] Worker recycelt (Speicher freigegeben)');
}

function getWorkerPool() {
  const count = 1; // NUR 1 Worker — WASM-Speicher wächst nur, schrumpft nie;
                    // mehrere Worker mit je eigenem Modell (~100-600MB) summieren
                    // sich sonst auf und lassen den Tab nach ein paar Übersetzungen einfrieren.
  if (workerPool.length === count) return workerPool;
  
  const blob = new Blob([workerCode], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  
  for (let i = workerPool.length; i < count; i++) {
    const w = new Worker(url, { type: 'module' });
    w.busy = false;
    w.onmessage = (e) => {
      const { type, result, chunkId, error } = e.data;
      if (type === 'translated') {
        const cb = pendingChunks.get(chunkId);
        if (cb) cb.resolve(result);
      } else if (type === 'translate_error') {
        const cb = pendingChunks.get(chunkId);
        if (cb) cb.reject(new Error(error));
      } else if (type === 'ready') {
        w.ready = true;
      }
    };
    workerPool.push(w);
  }
  return workerPool;
}

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
    console.log('[pft] Initialisiere stabilen WASM Web Worker (Transformers.js v3)...');
  
    const pool = getWorkerPool();
    workerProgressCallback = (pct) => {
      const badge = document.getElementById('pft-badge');
      if (badge) badge.textContent = `⏳ Loading model${pct ? ` (${pct}%)` : ''}`;
    };
    await Promise.all(pool.map(w => new Promise((resolve, reject) => {
      const orig = w.onmessage;
      w.onmessage = (e) => {
        if (e.data.type === 'ready') { w.ready = true; w.onmessage = orig; resolve(); }
        else if (e.data.type === 'error') { w.onmessage = orig; reject(new Error(e.data.error)); }
        else if (e.data.type === 'progress') { if (workerProgressCallback) workerProgressCallback(e.data.pct); }
        else orig(e);
      };
      w.postMessage({ type: 'init' });
    })));
    console.log(`[pft] ${pool.length} Worker ready`);
    state.localReady = true;  // ← das fehlt!
  } catch (e) {
    state.localError = e.message || String(e);
    console.error('[pft] Lokaler Ladefehler im Worker', e);
    throw e;
  } finally {
    state.localLoading = false;
    refreshBadge();
  }
}

async function translateLocal(texts, src, tgt) {
  await ensureLocal();
  const srcLang = (src && src !== 'auto') ? src : 'en';
  const resultsBox = document.getElementById('pft-results');
  const T0 = performance.now();
  console.log('[pft] translateLocal via WASM-Worker START', { totalTexts: texts.length, src: srcLang, tgt });

// NEU — filtert Nummern, reine Satzzeichen, Daten/Zeiträume, sehr kurze Tokens die kein Modell braucht:
  const isAllCaps  = s => /[A-Z]/.test(s) && !/[a-zäöüß]/.test(s);

  // Datum / Zeitraum-Muster — deckt jetzt auch ab:
  //   "05/2015"            (Monat/Jahr, nur 2 Gruppen)
  //   "05/2015 – 09/2018"  (Zeitraum mit Halbgeviertstrich –, nicht nur "-")
  //   "2005 – 2014"        (reiner Jahres-Zeitraum)
  //   "01.01.2024"         (volles Datum, wie bisher)
  const DATE_RANGE = /^\d{1,4}([./]\d{1,4}){0,2}(\s*[-–—]\s*\d{1,4}([./]\d{1,4}){0,2})?$/;

  const isSkippable = s =>
  s.length < 2 ||
  /^[\d\s.,;:!?()%€$£\-–—/\\]+$/.test(s) ||          // reine Zahlen/Satzzeichen (jetzt inkl. – und —)
  DATE_RANGE.test(s) ||                              // Datum / Zeitraum, siehe oben
  /^§/.test(s) ||                                    // §-Zeichen
  /@/.test(s) ||                                     // E-Mail
  /^(Dr|Prof|Mr|Mrs|Ms|Herr|Frau|Ing|Mag)\.?\s+[A-Z][a-z]/.test(s); // Titel + Name
  // Hinweis: die bisherigen pauschalen "Vorname Nachname" / "Vor- Mittel- Nachname"
  // Muster wurden entfernt — sie matchten JEDE zwei-/dreiwortige Title-Case-Phrase
  // (z.B. "Handwerkliches Geschick", "Schnelle Auffassungsgabe") und verhinderten
  // so fälschlich deren Übersetzung.

  const cache = new Map();
  const jobs = [];
  texts.forEach((t, index) => {
    const cleaned = (t || '').trim();
    if (isSkippable(cleaned) || isAllCaps(cleaned)) {
      // Nummern, Daten, Satzzeichen, Abkürzungen → 1:1 übernehmen statt übersetzen.
      // WICHTIG: trotzdem in `jobs` aufnehmen, sonst bleibt der Ausgabe-Slot leer
      // (out[] ist mit '' vorbefüllt) und der Text verschwindet komplett aus
      // Vorschau UND Download, statt einfach unübersetzt sichtbar zu bleiben.
      cache.set(cleaned, cleaned);
      jobs.push({ index, key: cleaned });
      return;
    }

    const key = cleaned.length > 4000 ? cleaned.substring(0, 4000) : cleaned;
    if (!cache.has(key)) cache.set(key, null);
    jobs.push({ index, key });
  });

  const todo = [];
  cache.forEach((v, k) => { if (v === null) todo.push(k); });
  console.log('[pft] dedup', { unique: cache.size, toTranslate: todo.length });

  if (todo.length === 0) {
    const o0 = new Array(texts.length).fill('');
    jobs.forEach(j => { o0[j.index] = cache.get(j.key) || j.key; });
    return o0;
  }

  const CHUNK = 8; // hochgesetzt, da jetzt echtes Batching (ein Modell-Call/Chunk) — weniger Overhead pro Chunk
  const allChunks = [];
  for (let i = 0; i < todo.length; i += CHUNK) {
    allChunks.push(todo.slice(i, i + CHUNK));
  }
  const pool = getWorkerPool();
  let doneCount = 0;
  // Übersetzt einen einzelnen Chunk (1..N Texte) über den Worker.
  async function translateChunk(chunk, idx) {
    const worker = pool[idx % pool.length];
    const chunkId = ++chunkCounter;
    try {
      const result = await new Promise((resolve, reject) => {
        pendingChunks.set(chunkId, { resolve, reject });
        worker.postMessage({ type: 'translate', data: { chunk, srcLang, tgt, chunkId } });
      });
      return { chunk, result };
    } catch (err) {
      console.warn('[pft] Chunk-Übersetzung fehlgeschlagen, retry einzeln', chunk, err);
      // Fallback: statt den GANZEN Chunk (bis zu 8 Texte) unübersetzt zu lassen,
      // jeden Text einzeln (Batchgröße 1) neu versuchen — das umgeht das
      // Tensor-Shape-Problem, das offenbar durch gemischte Batch-Längen entsteht.
      const singleResults = [];
      for (const text of chunk) {
        const singleId = ++chunkCounter;
        try {
          const r = await new Promise((resolve, reject) => {
            pendingChunks.set(singleId, { resolve, reject });
            worker.postMessage({ type: 'translate', data: { chunk: [text], srcLang, tgt, chunkId: singleId } });
          });
          const arr = Array.isArray(r) ? r : [r];
          singleResults.push(arr[0]);
        } catch (err2) {
          console.warn('[pft] Einzel-Übersetzung ebenfalls fehlgeschlagen, behalte Original', text, err2);
          singleResults.push(null); // → fällt unten auf Original zurück
        } finally {
          pendingChunks.delete(singleId);
        }
      }
      return { chunk, result: singleResults };
    } finally {
      pendingChunks.delete(chunkId);
    }
  }

  const results = await Promise.all(allChunks.map((chunk, idx) =>
    translateChunk(chunk, idx).then(r => {
      doneCount += chunk.length;
      if (resultsBox?.isConnected) {
        const pct = Math.round((doneCount / todo.length) * 100);
        resultsBox.innerHTML = `<div class="pft-empty" style="grid-column:1 / -1"><span class="pft-spin"></span>Translating… ${pct}% (${doneCount}/${todo.length} segments)</div>`;
      }
      return r;
    })
  ));
  results.forEach(({ chunk, result }) => {
    const arr = Array.isArray(result) ? result : [result];
    chunk.forEach((srcStr, j) => {
      cache.set(srcStr, arr[j]?.translation_text || srcStr);
    });
  });


  console.log('[pft] translateLocal DONE via WASM-Worker', {
    totalSec: ((performance.now() - T0) / 1000).toFixed(1)
  });

  const out = new Array(texts.length).fill('');
  jobs.forEach(j => { out[j.index] = cache.get(j.key) || j.key; });
  return out;
}
  // Smart-Preload: schedule background load after first idle moment
  function schedulePreload() {
    const start = () => {
      if (state.localReady || state.localLoading) return;
      ensureLocal().catch(() => {/* silent — retried on demand in runTranslate() */});
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
  const res = currentPageResult();
  if (!state.overlayOn || !res) return;

  const canvas = document.getElementById('pdf-canvas');
  const wrap   = document.getElementById('canvas-wrap');
  if (!canvas || !wrap) return;

  const ctx = canvas.getContext('2d');
  const dpr = canvas.width / canvas.offsetWidth || 1;

  // EINMAL die komplette Canvas-Pixelmatrix holen statt pro Item einzeln
  // per ctx.getImageData() (das hat pro Aufruf spürbaren Overhead und blockiert
  // bei textreichen Seiten den Main-Thread über hunderte Items hinweg).
  let fullImageData = null;
  try { fullImageData = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch(_) {}
  const fw = canvas.width, fh = canvas.height;
  const getPixel = (px, py) => {
    if (!fullImageData || px < 0 || py < 0 || px >= fw || py >= fh) return null;
    const idx = (py * fw + px) * 4;
    const d = fullImageData.data;
    return [d[idx], d[idx+1], d[idx+2]];
  };

  const overlay = document.createElement('div');
  overlay.className = 'pft-overlay';
  overlay.setAttribute('data-testid', 'translate-inline-overlay');
  overlay.style.cssText = `position:absolute;pointer-events:none;z-index:5;left:${canvas.offsetLeft}px;top:${canvas.offsetTop}px;width:${canvas.offsetWidth}px;height:${canvas.offsetHeight}px;`;

  const scaleX = canvas.offsetWidth  / res.pageWidth;
  const scaleY = canvas.offsetHeight / res.pageHeight;

  // NEU: iteriert über Absatz-Blöcke (res.blocks) statt einzelner Zeilen
  // (res.items). Ein Block deckt den kompletten Bereich von der ersten
  // bis zur letzten Original-Zeile ab; der übersetzte Text bekommt einen
  // eigenen, neu berechneten Zeilenumbruch (weiß-Raum:normal + feste
  // Breite → der Browser bricht die Zeilen selbst um).
  const blocksToRender = (res.blocks && res.blocks.length) ? res.blocks : [];

  blocksToRender.forEach(b => {
    if (!b.trans) return;

    const x = b.x * scaleX;
    const y = b.y * scaleY;
    const w = Math.max((b.x1 - b.x) * scaleX, 10);
    const hCore = Math.max((b.y1 - b.y) * scaleY, 8);
    // Gleicher Puffer wie beim Text-Edit in clientengine.js (editBatchLocal:
    // bottomPad = (y1-y) * 0.12) — deckt Unterlängen wie g/q/y/p sicher ab,
    // die sonst unten aus der Overlay-Box rausschauen.
    const bottomPad = hCore * 0.12;
    const h = hCore + bottomPad;

    // === Hintergrundfarbe samplen (exakt wie Edit-Tool) ===
    let bgR = 255, bgG = 255, bgB = 255;
    try {
      const cx = Math.round(x * dpr);
      const cy = Math.round(y * dpr);
      const cw = Math.round(w * dpr);
      const ch = Math.round(h * dpr);

      const samples = [];
      const pick = (px, py, weight) => {
        const d = getPixel(px, py);
        if (!d) return;
        for (let i = 0; i < weight; i++) samples.push(d);
      };
      // Ecken außerhalb der Textbox samplen
      for (let i = 1; i <= 2; i++) {
        pick(cx - i,       cy - i,       2);
        pick(cx + cw + i,  cy - i,       2);
        pick(cx - i,       cy + ch + i,  2);
        pick(cx + cw + i,  cy + ch + i,  2);
      }
      // Rand über/unter der Box
      for (let xi = 0; xi < cw; xi += Math.max(1, Math.floor(cw / 6))) {
        pick(cx + xi, cy - 2, 1);
        pick(cx + xi, cy + ch + 2, 1);
      }

      if (samples.length) {
        const buckets = {};
        samples.forEach(s => {
          const k = (s[0] >> 5) + ',' + (s[1] >> 5) + ',' + (s[2] >> 5);
          if (!buckets[k]) buckets[k] = { n: 0, r: 0, g: 0, b: 0 };
          buckets[k].n++; buckets[k].r += s[0]; buckets[k].g += s[1]; buckets[k].b += s[2];
        });
        let best = null;
        for (const k in buckets) if (!best || buckets[k].n > best.n) best = buckets[k];
        if (best) {
          bgR = Math.round(best.r / best.n);
          bgG = Math.round(best.g / best.n);
          bgB = Math.round(best.b / best.n);
        }
      }
    } catch(_) {}

    // Textfarbe: Original-PDF-Farbe, Fallback: dunkel/hell je nach Hintergrund
    const c = b.color | 0;
    const pdfR = (c >> 16) & 255, pdfG = (c >> 8) & 255, pdfB = c & 255;
    const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
    const textColor = (pdfR === 0 && pdfG === 0 && pdfB === 0)
      ? (luminance > 120 ? 'rgb(15,23,42)' : 'rgb(240,240,240)')
      : `rgb(${pdfR},${pdfG},${pdfB})`;

    const startFs = Math.max(6, b.size * scaleY * 0.95);
    const lineHeightFactor = 1.18;

    const el = document.createElement('div');
    el.className = 'pft-overlay-item pft-overlay-block';
    el.style.cssText = `
      left:${x}px;top:${y}px;width:${w}px;height:${h}px;
      background:rgb(${bgR},${bgG},${bgB});
      color:${textColor};
      font-size:${startFs}px;
      font-family:${b.font || 'Arial,sans-serif'};
      line-height:${lineHeightFactor};
      white-space:normal;
      overflow:hidden;
    `;
    el.textContent = b.trans;
    overlay.appendChild(el);

    // Auto-Fit: Übersetzung braucht selten exakt so viele Zeilen wie das
    // Original (Englisch meist kürzer/länger als Deutsch). Statt der alten
    // Zeichen-Ratio-Heuristik jetzt echtes Messen im DOM: Schriftgröße
    // schrittweise verkleinern, bis der (mehrzeilig umgebrochene) Text in
    // die Absatzbox passt. Bei autoFit=off bleibt die Originalgröße stehen
    // und der Text darf vertikal überlaufen (overflow:visible), analog zum
    // bisherigen "wrap ohne shrink"-Verhalten.
    if (state.autoFit) {
      let size = startFs;
      let guard = 0;
      while (el.scrollHeight > h + 1 && size > 6 && guard < 30) {
        size *= 0.94;
        el.style.fontSize = size + 'px';
        guard++;
      }
    } else {
      el.style.overflow = 'visible';
    }
  });

  wrap.appendChild(overlay);
}

  // re-position overlay if window resizes / canvas re-renders
  window.addEventListener('resize', () => renderOverlay());

  // Overlay beim Klick aufs PDF (z.B. um "Edit Text" zu benutzen) kurz ausblenden.
  // pointer-events:none lässt Klicks zwar technisch durch, aber der deckende
  // Overlay-Hintergrund verdeckt visuell alles, was darunter beim Editieren passiert
  // (Cursor, Eingabe) — sieht dann aus wie "nicht mehr editierbar".
  let overlaySuppressUntil = 0;
  document.addEventListener('mousedown', (e) => {
    const canvas = document.getElementById('pdf-canvas');
    if (canvas && (e.target === canvas || canvas.contains(e.target))) {
      removeOverlay();
      overlaySuppressUntil = Date.now() + 2000; // kurze Schonfrist fürs Editieren
    }
  }, true);

const pageWatcher = setInterval(() => {
    const res = currentPageResult();
    if (!res) { removeOverlay(); return; }
    if (window.activeInlineSpan) { removeOverlay(); return; }
    if (state.overlayOn && !document.querySelector('.pft-overlay') && Date.now() > overlaySuppressUntil) {
      renderOverlay();
    }
  }, 600);

  // Wird von index.html aufgerufen, sobald ein Edit-Text auf einer bereits
  // übersetzten Seite WIRKLICH gespeichert wurde (nicht bei Abbruch/unverändert).
  // Übersetzung für diese Seite wird verworfen — Overlay bleibt seitdem weg,
  // bis die Seite neu übersetzt wird (pageWatcher rendert dann nichts mehr,
  // weil currentPageResult() für diese Seite null zurückgibt).
  window.pftNotifyPageEdited = function (pageNum) {
    if (state.resultsByPage[pageNum]) {
      delete state.resultsByPage[pageNum];
      if (pageNum === (window.currentPageNum || 1)) removeOverlay();
      toast('Page changed — please translate again');
    }
  };

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
  // Bricht `text` anhand von ctx.measureText() in Zeilen um, die innerhalb
  // von maxWidth passen (2D-Canvas-Kontext der Offscreen-Seite, kein DOM
  // nötig — funktioniert also auch außerhalb des sichtbaren Viewports).
  function _wrapTextToWidth(ctx, text, fontFamily, fontSizePx, maxWidth) {
    ctx.font = `${fontSizePx}px ${fontFamily || 'Arial'}`;
    const words = (text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Kombiniert Umbruch + Schriftgrößen-Shrink: verkleinert die Schrift
  // iterativ, bis die umgebrochenen Zeilen (inkl. Zeilenabstand) in
  // maxHeight passen. Analog zum Auto-Shrink in renderOverlay(), nur
  // ohne echtes DOM-Messen (hier per ctx.measureText geschätzt).
  function _fitBlockText(ctx, text, fontFamily, startSizePx, maxWidth, maxHeight, minSizePx = 6) {
    let size = startSizePx;
    let lines = _wrapTextToWidth(ctx, text, fontFamily, size, maxWidth);
    let guard = 0;
    while (lines.length * (size * 1.18) > maxHeight && size > minSizePx && guard < 30) {
      size *= 0.94;
      lines = _wrapTextToWidth(ctx, text, fontFamily, size, maxWidth);
      guard++;
    }
    return { lines, size };
  }

  // Baut für JEDE übersetzte Seite (state.resultsByPage) die fertigen Overlay-
  // Daten (Position, Hintergrund-/Textfarbe, Schriftgröße) — unabhängig vom
  // sichtbaren DOM/Canvas, damit der Download alle Seiten einbetten kann,
  // nicht nur die gerade angezeigte. Nutzt dieselbe Farb-Sampling-Logik wie
  // renderOverlay(), aber auf einer Offscreen-Canvas pro Seite (via
  // _getOrRenderCanvas aus clientengine.js).
  //
  // WICHTIG (Breaking Change ggü. vorher): Jedes Ergebnis-Item hat jetzt
  // `lines` (Array von bereits umgebrochenen Zeilen-Strings) statt einem
  // einzeiligen `text`. `text` bleibt als Fallback (lines.join('\n')) für
  // Abwärtskompatibilität erhalten, ist aber für mehrzeiligen Absatz-Text
  // nicht mehr ausreichend — der Draw-Code in index.html muss `it.lines`
  // zeilenweise zeichnen (y-Offset pro Zeile um it.lineHeight erhöhen).
  async function buildDownloadOverlayData() {
    const pages = Object.keys(state.resultsByPage).map(Number).sort((a, b) => a - b);
    const out = [];
    for (const pageNum of pages) {
      const res = state.resultsByPage[pageNum];
      if (!res || !res.items || !res.items.length) continue;
      if (typeof _getOrRenderCanvas !== 'function') continue; // clientengine.js nicht geladen

      let canvas, ctx;
      try {
        const entry = await _getOrRenderCanvas(window.currentPdfDocLocal, pageNum - 1);
        canvas = entry.canvas; ctx = entry.ctx;
      } catch (_) { continue; }

      const DPR = canvas.width / res.pageWidth; // Offscreen-Canvas-Skalierung ggü. Extraction-Viewport (i.d.R. 2)
      let fullImageData = null;
      try { fullImageData = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (_) {}
      const fw = canvas.width, fh = canvas.height;
      const getPixel = (px, py) => {
        if (!fullImageData || px < 0 || py < 0 || px >= fw || py >= fh) return null;
        const idx = (py * fw + px) * 4;
        const d = fullImageData.data;
        return [d[idx], d[idx + 1], d[idx + 2]];
      };

      const items = [];
      const blocksForPage = (res.blocks && res.blocks.length) ? res.blocks : [];
      blocksForPage.forEach(b => {
        if (!b.trans) return;
        const x = b.x, y = b.y;
        const w = Math.max(b.x1 - b.x, 6);
        const hCore = Math.max(b.y1 - b.y, 5);
        const bottomPad = hCore * 0.12; // gleicher Puffer wie renderOverlay()/editBatchLocal
        const h = hCore + bottomPad;

        let bgR = 255, bgG = 255, bgB = 255;
        try {
          const cx = Math.round(x * DPR), cy = Math.round(y * DPR);
          const cw = Math.round(w * DPR), ch = Math.round(h * DPR);
          const samples = [];
          const pick = (px, py, weight) => {
            const d = getPixel(px, py);
            if (!d) return;
            for (let i = 0; i < weight; i++) samples.push(d);
          };
          for (let i = 1; i <= 2; i++) {
            pick(cx - i, cy - i, 2); pick(cx + cw + i, cy - i, 2);
            pick(cx - i, cy + ch + i, 2); pick(cx + cw + i, cy + ch + i, 2);
          }
          for (let xi = 0; xi < cw; xi += Math.max(1, Math.floor(cw / 6))) {
            pick(cx + xi, cy - 2, 1); pick(cx + xi, cy + ch + 2, 1);
          }
          if (samples.length) {
            const buckets = {};
            samples.forEach(s => {
              const k = (s[0] >> 5) + ',' + (s[1] >> 5) + ',' + (s[2] >> 5);
              if (!buckets[k]) buckets[k] = { n: 0, r: 0, g: 0, b: 0 };
              buckets[k].n++; buckets[k].r += s[0]; buckets[k].g += s[1]; buckets[k].b += s[2];
            });
            let best = null;
            for (const k in buckets) if (!best || buckets[k].n > best.n) best = buckets[k];
            if (best) { bgR = Math.round(best.r / best.n); bgG = Math.round(best.g / best.n); bgB = Math.round(best.b / best.n); }
          }
        } catch (_) {}

        const c = b.color | 0;
        const pdfR = (c >> 16) & 255, pdfG = (c >> 8) & 255, pdfB = c & 255;
        const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
        const textColor = (pdfR === 0 && pdfG === 0 && pdfB === 0)
          ? (luminance > 120 ? [15, 23, 42] : [240, 240, 240])
          : [pdfR, pdfG, pdfB];

        const startFs = Math.max(6, b.size * 0.95);
        // WICHTIG: Shrink läuft für den Download IMMER, unabhängig vom
        // autoFit-Toggle (der Toggle steuert nur noch die Live-Overlay-
        // Anzeige im Editor via renderOverlay()). Grund: bei autoFit=off
        // blieb hier vorher die Originalgröße stehen und der Absatz durfte
        // "vertikal überlaufen" — index.html schneidet diesen Überlauf beim
        // Zeichnen aber ab (sonst würde er die Box des nächsten Absatzes
        // überschreiben), wodurch Sätze mitten drin abgeschnitten wurden.
        // _fitBlockText() schrumpft nur, wenn der Text bei startFs tatsächlich
        // nicht reinpasst — passt er schon, bleibt die Originalgröße erhalten.
        const fit = _fitBlockText(ctx, b.trans, b.font, startFs, w, h, 6);
        const lines = fit.lines;
        const fs = fit.size;

        items.push({
          x, y, w, h,
          lines,                        // NEU: Array bereits umgebrochener Zeilen
          text: lines.join('\n'),       // Fallback/Kompat für einzeiligen Alt-Draw-Code
          bg: [bgR, bgG, bgB], color: textColor,
          fontSize: fs,
          lineHeight: fs * 1.18,
        });
      });

      out.push({ page: pageNum, pageWidth: res.pageWidth, pageHeight: res.pageHeight, items });
    }
    return out;
  }

  function copyTranslation() {
    const res = currentPageResult();
    if (!res) return;
    const txt = res.items.map(i => i.trans).join('\n');
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
      renderOverlay,
      removeOverlay,
      buildDownloadOverlayData,
      state,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
