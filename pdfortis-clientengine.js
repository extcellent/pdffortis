// ═══════════════════════════════════════
// PDFORTIS CLIENT ENGINE — mit Content-Stream-Surgery (Ghost-Text-Fix)
// ═══════════════════════════════════════

async function renderPageLocal(pdfDocLocal, pageIndex){
  const page = await pdfDocLocal.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 2 });
  const off = document.createElement('canvas');
  off.width = viewport.width;
  off.height = viewport.height;
  const offCtx = off.getContext('2d');
  await page.render({ canvasContext: offCtx, viewport }).promise;
  const img = new Image();
  img.width = off.width;
  img.height = off.height;
  img.src = off.toDataURL('image/png');
  await new Promise(res => { img.onload = res; });
  return img;
}

const _pageCanvasCache = {};

async function _getOrRenderCanvas(pdfDocLocal, pageIndex){
  if(_pageCanvasCache[pageIndex]) return _pageCanvasCache[pageIndex];
  const page = await pdfDocLocal.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 2 });
  const off = document.createElement('canvas');
  off.width = viewport.width;
  off.height = viewport.height;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  const entry = { canvas: off, ctx };
  _pageCanvasCache[pageIndex] = entry;
  return entry;
}

function _sampleColorInBox(ctx, cx, cy, cw, ch){
  const W=ctx.canvas.width, H=ctx.canvas.height;
  if(cw<=0||ch<=0) return 0x000000;
  const bgPts=[[cx-3,cy+ch*0.5],[cx+cw+3,cy+ch*0.5],[cx+cw*0.5,cy-3],[cx+cw*0.5,cy+ch+3]];
  let bg=[255,255,255];
  for(const [sx,sy] of bgPts){
    if(sx<0||sy<0||sx>=W||sy>=H) continue;
    try{ const p=ctx.getImageData(sx|0,sy|0,1,1).data; bg=[p[0],p[1],p[2]]; break; }catch(e){}
  }
  let best=[0,0,0], bestDist=-1;
  const cols=6, rows=3;
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const sx=cx+cw*(c+0.5)/cols;
      const sy=cy+ch*(r+0.5)/rows;
      if(sx<0||sy<0||sx>=W||sy>=H) continue;
      try{
        const p=ctx.getImageData(sx|0,sy|0,1,1).data;
        const dist=(p[0]-bg[0])**2+(p[1]-bg[1])**2+(p[2]-bg[2])**2;
        if(dist>bestDist){ bestDist=dist; best=[p[0],p[1],p[2]]; }
      }catch(e){}
    }
  }
  return (best[0]<<16)|(best[1]<<8)|best[2];
}

function _deriveFlags(fontFamily){
  const fn=(fontFamily||'').toLowerCase();
  let flags=0;
  if(/bold/.test(fn)) flags|=16;
  if(/italic|oblique/.test(fn)) flags|=2;
  if(/mono|courier/.test(fn)) flags|=8;
  if(/times|serif|roman/.test(fn)) flags|=4;
  return flags;
}

async function extractPageLocal(pdfDocLocal, pageIndex){
  const page = await pdfDocLocal.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const { ctx } = await _getOrRenderCanvas(pdfDocLocal, pageIndex);
  const items = [];
  for(const it of textContent.items){
    if(!it.str || !it.str.trim()) continue;
    try{
      const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const x = tx[4];
      const y = tx[5] - fontHeight*0.85;
      const x1 = tx[4] + (it.width || fontHeight*0.5*it.str.length) + fontHeight*0.17;
      const y1 = tx[5] + fontHeight*0.19;
      const color = _sampleColorInBox(ctx, x*2, y*2, (x1-x)*2, (y1-y)*2);
      const styleInfo = textContent.styles[it.fontName] || {};
      items.push({
        text: it.str, x, y, x1, y1,
        size: fontHeight, color,
        font: styleInfo.fontFamily || '',
        flags: _deriveFlags(styleInfo.fontFamily)
      });
    }catch(e){ console.warn('extractPageLocal: item übersprungen', it.str, e); }
  }
  return { items, pageWidth: viewport.width, pageHeight: viewport.height };
}

// ═══════════════════════════════════════
// editBatchLocal-Helpers (unverändert)
// ═══════════════════════════════════════

function _rgbStringToFloats(str){
  if(!str) return [1,1,1];
  const m = str.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if(!m) return [1,1,1];
  return [parseInt(m[1])/255, parseInt(m[2])/255, parseInt(m[3])/255];
}

function _intColorToFloats(colorInt){
  const r=(colorInt>>16)&255, g=(colorInt>>8)&255, b=colorInt&255;
  return [r/255, g/255, b/255];
}

function _pickStandardFont(flags, fontName){
  const fn=(fontName||'').toLowerCase();
  const isBold = !!(flags & 16) || fn.includes('bold');
  const isItalic = !!(flags & 2) || fn.includes('italic') || fn.includes('oblique');
  const isMono = !!(flags & 8) || fn.includes('mono') || fn.includes('courier');
  const isSerif = !!(flags & 4) || fn.includes('times') || fn.includes('serif') || fn.includes('roman');
  const { StandardFonts } = PDFLib;
  if(isMono){
    if(isBold && isItalic) return StandardFonts.CourierBoldOblique;
    if(isItalic) return StandardFonts.CourierOblique;
    if(isBold) return StandardFonts.CourierBold;
    return StandardFonts.Courier;
  }
  if(isSerif){
    if(isBold && isItalic) return StandardFonts.TimesRomanBoldItalic;
    if(isItalic) return StandardFonts.TimesRomanItalic;
    if(isBold) return StandardFonts.TimesRomanBold;
    return StandardFonts.TimesRoman;
  }
  if(isBold && isItalic) return StandardFonts.HelveticaBoldOblique;
  if(isItalic) return StandardFonts.HelveticaOblique;
  if(isBold) return StandardFonts.HelveticaBold;
  return StandardFonts.Helvetica;
}

// ═══════════════════════════════════════
// NEU: Byte-Level Content-Stream-Surgery
// ═══════════════════════════════════════

function _isWs(b){ return b===0x20||b===0x09||b===0x0A||b===0x0D||b===0x0C||b===0x00; }
function _isDelim(b){
  return _isWs(b)||b===0x28||b===0x29||b===0x3C||b===0x3E||b===0x5B||b===0x5D||b===0x7B||b===0x7D||b===0x2F||b===0x25;
}
function _latin1(bytes,s,e){ let r=''; for(let i=s;i<e;i++) r+=String.fromCharCode(bytes[i]); return r; }
function _latin1ToBytes(str){
  const out = new Uint8Array(str.length);
  for(let i=0;i<str.length;i++) out[i] = str.charCodeAt(i) & 0xFF;
  return out;
}

// Tokenizer für PDF-Content-Streams (byte-basiert, robust gegen Escapes/Balanced-Parens)
function _tokenizeContentStream(bytes){
  const tokens = [];
  const n = bytes.length;
  let i = 0;
  while(i < n){
    const b = bytes[i];
    if(_isWs(b)){ i++; continue; }
    // Kommentar
    if(b === 0x25){
      while(i<n && bytes[i]!==0x0A && bytes[i]!==0x0D) i++;
      continue;
    }
    // Literal-String (...)
    if(b === 0x28){
      const start = i; let depth = 1; i++;
      while(i<n && depth>0){
        const c = bytes[i];
        if(c === 0x5C){ i += 2; continue; }
        if(c === 0x28) depth++;
        else if(c === 0x29){ depth--; if(depth===0){ i++; break; } }
        i++;
      }
      tokens.push({ type:'string', start, end:i });
      continue;
    }
    // < ... > Hex-String  ODER  << Dict-Öffner
    if(b === 0x3C){
      if(i+1<n && bytes[i+1]===0x3C){
        tokens.push({ type:'dictOpen', start:i, end:i+2 });
        i += 2; continue;
      }
      const start = i; i++;
      while(i<n && bytes[i]!==0x3E) i++;
      if(i<n) i++;
      tokens.push({ type:'hexString', start, end:i });
      continue;
    }
    // >> Dict-Schließer
    if(b === 0x3E && i+1<n && bytes[i+1]===0x3E){
      tokens.push({ type:'dictClose', start:i, end:i+2 });
      i += 2; continue;
    }
    // Array [...]
    if(b === 0x5B){
      const start = i; let depth = 1; i++;
      while(i<n && depth>0){
        const c = bytes[i];
        if(c === 0x28){
          let d = 1; i++;
          while(i<n && d>0){
            const cc = bytes[i];
            if(cc===0x5C){ i+=2; continue; }
            if(cc===0x28) d++;
            else if(cc===0x29) d--;
            i++;
          }
          continue;
        }
        if(c === 0x3C){
          i++;
          while(i<n && bytes[i]!==0x3E) i++;
          if(i<n) i++;
          continue;
        }
        if(c === 0x5B) depth++;
        else if(c === 0x5D){ depth--; if(depth===0){ i++; break; } }
        i++;
      }
      tokens.push({ type:'array', start, end:i });
      continue;
    }
    // Name /...
    if(b === 0x2F){
      const start = i; i++;
      while(i<n && !_isDelim(bytes[i])) i++;
      tokens.push({ type:'name', start, end:i });
      continue;
    }
    // Zahl oder Keyword/Operator
    const start = i;
    while(i<n && !_isDelim(bytes[i])) i++;
    const s = _latin1(bytes, start, i);
    if(/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)){
      tokens.push({ type:'number', start, end:i, value: parseFloat(s) });
    } else {
      tokens.push({ type:'op', start, end:i, name: s });
    }
  }
  return tokens;
}

// Finde alle Text-Show-Operatoren mit ihren Argumenten
function _findTextShowOps(tokens){
  const ops = [];
  for(let i=0;i<tokens.length;i++){
    const t = tokens[i];
    if(t.type !== 'op') continue;
    if(t.name === 'Tj' || t.name === "'"){
      if(i>0 && tokens[i-1].type==='string'){
        ops.push({ opName:t.name, opToken:t, argToken:tokens[i-1], replaceWith:'()' });
      }
    } else if(t.name === '"'){
      if(i>0 && tokens[i-1].type==='string'){
        ops.push({ opName:t.name, opToken:t, argToken:tokens[i-1], replaceWith:'()' });
      }
    } else if(t.name === 'TJ'){
      if(i>0 && tokens[i-1].type==='array'){
        ops.push({ opName:t.name, opToken:t, argToken:tokens[i-1], replaceWith:'[]' });
      }
    }
  }
  return ops;
}

// Dekodiere den String-Inhalt eines Show-Op-Arguments (best-effort, Latin1)
function _decodeShowOpText(bytes, op){
  const a = op.argToken;
  if(op.opName === 'TJ'){
    // Array: strings + numbers
    let r = '';
    let i = a.start + 1; // skip [
    while(i < a.end - 1){
      const b = bytes[i];
      if(b === 0x28){
        let depth = 1; i++;
        while(i < a.end && depth > 0){
          const c = bytes[i];
          if(c === 0x5C){ if(i+1<a.end) r += String.fromCharCode(bytes[i+1]); i += 2; continue; }
          if(c === 0x28){ depth++; r += '('; i++; continue; }
          if(c === 0x29){ depth--; if(depth>0) r += ')'; i++; continue; }
          r += String.fromCharCode(c); i++;
        }
      } else if(b === 0x3C){
        i++;
        let hex = '';
        while(i < a.end && bytes[i] !== 0x3E){
          const c = bytes[i];
          if(!_isWs(c)) hex += String.fromCharCode(c);
          i++;
        }
        i++;
        for(let h=0; h<hex.length; h+=2){
          r += String.fromCharCode(parseInt(hex.substr(h,2)||'0',16));
        }
      } else {
        i++;
      }
    }
    return r;
  } else {
    // (string) Tj/'/"
    let r = '';
    for(let i = a.start+1; i < a.end-1; i++){
      const c = bytes[i];
      if(c === 0x5C){
        if(i+1 < a.end-1){
          const n = bytes[i+1];
          if(n>=0x30 && n<=0x37){
            let oct = String.fromCharCode(n);
            let j = i+2;
            if(j<a.end-1 && bytes[j]>=0x30 && bytes[j]<=0x37){ oct += String.fromCharCode(bytes[j]); j++; }
            if(j<a.end-1 && bytes[j]>=0x30 && bytes[j]<=0x37){ oct += String.fromCharCode(bytes[j]); j++; }
            r += String.fromCharCode(parseInt(oct,8));
            i = j-1;
          } else {
            r += String.fromCharCode(n);
            i++;
          }
        }
      } else {
        r += String.fromCharCode(c);
      }
    }
    return r;
  }
}

// Führe die Byte-Splices durch (deskend. Reihenfolge, damit Offsets stabil bleiben)
function _spliceRemoveOps(bytes, showOps, indices){
  const idxs = [...new Set(indices)].filter(i => i>=0 && i<showOps.length).sort((a,b)=>b-a);
  let result = bytes;
  for(const idx of idxs){
    const op = showOps[idx];
    const a = op.argToken;
    const rep = _latin1ToBytes(op.replaceWith);
    const newBytes = new Uint8Array(result.length - (a.end - a.start) + rep.length);
    newBytes.set(result.subarray(0, a.start), 0);
    newBytes.set(rep, a.start);
    newBytes.set(result.subarray(a.end), a.start + rep.length);
    result = newBytes;
  }
  return result;
}

// Hole den kombinierten, dekodierten Content-Stream einer Seite
function _getPageContentBytes(pdfDoc, page){
  const contentsKey = PDFLib.PDFName.of('Contents');
  const raw = page.node.get(contentsKey);
  if(!raw) return null;
  const ctx = pdfDoc.context;
  const resolve = (o) => (o instanceof PDFLib.PDFRef) ? ctx.lookup(o) : o;

  let streamList = [];
  if(raw instanceof PDFLib.PDFArray){
    for(let i=0;i<raw.size();i++) streamList.push(resolve(raw.get(i)));
  } else {
    streamList.push(resolve(raw));
  }
  const parts = [];
  for(const s of streamList){
    if(!(s instanceof PDFLib.PDFRawStream)) return null;
    parts.push(PDFLib.decodePDFRawStream(s).decode());
  }
  let total = 0;
  for(const p of parts) total += p.length + 1;
  const combined = new Uint8Array(total > 0 ? total - 1 : 0);
  let off = 0;
  for(let i=0;i<parts.length;i++){
    combined.set(parts[i], off);
    off += parts[i].length;
    if(i < parts.length-1){ combined[off] = 0x0A; off++; }
  }
  return combined;
}

// Schreibe neuen Content-Stream zurück (unkomprimiert, ersetzt alle vorhandenen)
function _setPageContentBytes(pdfDoc, page, newBytes){
  const contentsKey = PDFLib.PDFName.of('Contents');
  const ctx = pdfDoc.context;
  const dict = ctx.obj({});
  const newStream = PDFLib.PDFRawStream.of(dict, newBytes);
  const newRef = ctx.register(newStream);
  page.node.set(contentsKey, newRef);
}

// Fallback: index-basiertes Mapping schlägt fehl → versuche per Originaltext-Match
function _findOpIndexByText(bytes, showOps, targetText){
  if(!targetText) return -1;
  const norm = (s) => s.replace(/\s+/g,'').trim();
  const target = norm(targetText);
  if(!target) return -1;
  // exact match zuerst
  for(let i=0;i<showOps.length;i++){
    const t = norm(_decodeShowOpText(bytes, showOps[i]));
    if(t === target) return i;
  }
  // substring (falls Ligaturen/kleine Unterschiede)
  for(let i=0;i<showOps.length;i++){
    const t = norm(_decodeShowOpText(bytes, showOps[i]));
    if(t && (t.includes(target) || target.includes(t))) return i;
  }
  return -1;
}

// Haupt-Surgery pro Seite
function _surgeryForPage(pdfDoc, pageIndex, pageEdits){
  try{
    const page = pdfDoc.getPages()[pageIndex];
    if(!page) return { ok:false, reason:'no-page' };

    const bytes = _getPageContentBytes(pdfDoc, page);
    if(!bytes) return { ok:false, reason:'no-content' };

    const tokens = _tokenizeContentStream(bytes);
    const showOps = _findTextShowOps(tokens);
    if(showOps.length === 0) return { ok:false, reason:'no-text-ops' };

    // Sammle Indices — bevorzugt aus originalItemIndices, sonst fallback via spanOrigText
    const expectedTotal = pageEdits[0].pdfJsTotalItemsCount || 0;
    const useIndexMapping = expectedTotal > 0 && showOps.length === expectedTotal;

    const indicesToRemove = [];
    for(const e of pageEdits){
      if(useIndexMapping && Array.isArray(e.originalItemIndices)){
        for(const idx of e.originalItemIndices){
          if(idx>=0 && idx<showOps.length) indicesToRemove.push(idx);
        }
      } else {
        // Fallback per Text-Suche
        const found = _findOpIndexByText(bytes, showOps, e.spanOrigText);
        if(found >= 0) indicesToRemove.push(found);
      }
    }

    if(indicesToRemove.length === 0){
      return { ok:false, reason:'no-matches', useIndexMapping, expectedTotal, actualOps: showOps.length };
    }

    const newBytes = _spliceRemoveOps(bytes, showOps, indicesToRemove);
    _setPageContentBytes(pdfDoc, page, newBytes);
    return { ok:true, removed: indicesToRemove.length, useIndexMapping };
  }catch(err){
    console.warn('[PDFortis Surgery] Fehler auf Seite', pageIndex+1, err);
    return { ok:false, reason:'exception', error: err.message };
  }
}

// ═══════════════════════════════════════
// editBatchLocal — mit Surgery + Fallback auf Overlay
// ═══════════════════════════════════════

async function editBatchLocal(pdfBytes, edits){
  const doc = await PDFLib.PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  const fontCache = {};

  // 1) Edits nach Seite gruppieren und Surgery pro Seite versuchen
  const editsByPage = {};
  for(const e of edits){
    const p = e.page;
    (editsByPage[p] = editsByPage[p] || []).push(e);
  }

  const surgeryResults = {}; // { pageNum: { ok, ... } }
  for(const [pageNumStr, pageEdits] of Object.entries(editsByPage)){
    const pageIndex = parseInt(pageNumStr,10) - 1;
    if(pageIndex < 0 || pageIndex >= pages.length) continue;
    const result = _surgeryForPage(doc, pageIndex, pageEdits);
    surgeryResults[pageNumStr] = result;
    if(!result.ok){
      console.warn(`[PDFortis Surgery] Seite ${pageNumStr}: fallback auf Overlay (${result.reason})`);
    } else {
      console.log(`[PDFortis Surgery] Seite ${pageNumStr}: ${result.removed} Text-Op(s) chirurgisch entfernt`);
    }
  }

  // 2) Neuen Text zeichnen (+ Deck-Rechteck, wenn Surgery für die Seite fehlgeschlagen ist)
  for(const edit of edits){
    const page = pages[edit.page - 1];
    if(!page) continue;
    const pageHeight = page.getHeight();
    const surgeryOk = surgeryResults[edit.page] && surgeryResults[edit.page].ok;

    // Deck-Rechteck immer zeichnen (verhindert visuelle Reste, ist billig)
    const bottomPad = (edit.y1 - edit.y) * 0.12;
    const rectX = edit.x;
    const rectY = pageHeight - (edit.y1 + bottomPad);
    const rectW = edit.x1 - edit.x;
    const rectH = (edit.y1 + bottomPad) - edit.y;
    const [bgR,bgG,bgB] = _rgbStringToFloats(edit.bgColor);
    page.drawRectangle({
      x: rectX, y: rectY, width: rectW, height: rectH,
      color: PDFLib.rgb(bgR,bgG,bgB),
    });

    if(edit.newText && edit.newText.trim()){
      const stdFont = _pickStandardFont(edit.flags, edit.font);
      if(!fontCache[stdFont]) fontCache[stdFont] = await doc.embedFont(stdFont);
      const font = fontCache[stdFont];
      const [tr,tg,tb] = _intColorToFloats(edit.color || 0);
      const baselineY = pageHeight - edit.y1 + (edit.y1 - edit.y) * 0.15;
      page.drawText(edit.newText, {
        x: edit.x, y: baselineY,
        size: edit.size || 12,
        font, color: PDFLib.rgb(tr,tg,tb),
      });
    }
  }

  return await doc.save();
}
