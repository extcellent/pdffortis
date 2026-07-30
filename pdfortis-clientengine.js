// ═══════════════════════════════════════
// PDFORTIS CLIENT ENGINE — ersetzt Render-Endpoints
// Schritt 1: /render → renderPageLocal()
// ═══════════════════════════════════════

async function renderPageLocal(pdfDocLocal, pageIndex /* 0-basiert, wie /render bisher */){
  const page = await pdfDocLocal.getPage(pageIndex + 1); // pdf.js ist 1-basiert
  const viewport = page.getViewport({ scale: 2 }); // entspricht fitz.Matrix(2,2)

  const off = document.createElement('canvas');
  off.width = viewport.width;
  off.height = viewport.height;
  const offCtx = off.getContext('2d');

  await page.render({ canvasContext: offCtx, viewport }).promise;

  // Gleiche Rückgabeform wie bisher: ein Image-Objekt mit .width/.height,
  // damit renderPage() in index.html unverändert bleibt
  const img = new Image();
  img.width = off.width;
  img.height = off.height;
  img.src = off.toDataURL('image/png');
  await new Promise(res => { img.onload = res; });
  return img;
}
// ═══════════════════════════════════════
// Schritt 2 (verbessert): Pixel-genauer Bbox- + Farb-Scan
// ═══════════════════════════════════════
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

  // Hintergrund knapp AUSSERHALB der (jetzt vertrauenswürdigen) Box sampeln
  const bgPts=[[cx-3,cy+ch*0.5],[cx+cw+3,cy+ch*0.5],[cx+cw*0.5,cy-3],[cx+cw*0.5,cy+ch+3]];
  let bg=[255,255,255];
  for(const [sx,sy] of bgPts){
    if(sx<0||sy<0||sx>=W||sy>=H) continue;
    try{ const p=ctx.getImageData(sx|0,sy|0,1,1).data; bg=[p[0],p[1],p[2]]; break; }catch(e){}
  }

  // Innerhalb der Box: Punkt am weitesten weg von der Hintergrundfarbe = echte Textfarbe
  let best=[0,0,0], bestDist=-1;
  const cols=6, rows=3;
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const sx = cx + cw*(0.15+0.7*c/(cols-1));
      const sy = cy + ch*(0.25+0.5*r/(rows-1));
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
      // Vektor-exakte Position/Größe direkt aus der PDF-Struktur — wie PyMuPDF
      const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const x  = tx[4];
      const y  = tx[5] - fontHeight*0.85;   // Ascent
      const x1 = tx[4] + (it.width || fontHeight*0.5*it.str.length) + fontHeight*0.17;;
      const y1 = tx[5] + fontHeight*0.19;   // Descent

      // Nur die Farbe braucht Pixel-Sampling (einzige Info, die pdf.js nicht rausgibt)
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
// Schritt 3: /edit-batch → editBatchLocal()
// ═══════════════════════════════════════

function _rgbStringToFloats(str){
  if(!str) return [1,1,1]; // Fallback: weiß
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
  const isBold   = !!(flags & 16) || fn.includes('bold');
  const isItalic = !!(flags & 2)  || fn.includes('italic') || fn.includes('oblique');
  const isMono   = !!(flags & 8)  || fn.includes('mono') || fn.includes('courier');
  const isSerif  = !!(flags & 4)  || fn.includes('times') || fn.includes('serif') || fn.includes('roman');

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

async function editBatchLocal(pdfBytes, edits){
  // Edits nach Seite gruppieren
  const editsByPage = {};
  for(const edit of edits){
    (editsByPage[edit.page] = editsByPage[edit.page] || []).push(edit);
  }

  const srcDoc   = await PDFLib.PDFDocument.load(pdfBytes);
  const srcJsDoc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
  const pageCount = srcDoc.getPageCount();
  const outDoc = await PDFLib.PDFDocument.create();

  for(let i = 0; i < pageCount; i++){
    const pageNum = i + 1;
    const pageEdits = editsByPage[pageNum];

    if(!pageEdits){
      // Unveränderte Seite: 1:1 kopieren → Text bleibt echt (kopierbar/durchsuchbar)
      const [copied] = await outDoc.copyPages(srcDoc, [i]);
      outDoc.addPage(copied);
      continue;
    }

    // Seite MIT Edits: komplett als Rasterbild neu aufbauen.
    // Dadurch bleibt KEIN alter Text-Vektor im Content-Stream übrig,
    // der später wieder "auftauchen" / klickbar sein könnte.
    const srcPage = srcDoc.getPage(i);
    const { width: pdfW, height: pdfH } = srcPage.getSize();

    const jsPage = await srcJsDoc.getPage(pageNum);
    const scale = 2;
    const viewport = jsPage.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = viewport.width;
    off.height = viewport.height;
    const ctx = off.getContext('2d');
    await jsPage.render({ canvasContext: ctx, viewport }).promise;

    for(const edit of pageEdits){
      const bottomPad = (edit.y1 - edit.y) * 0.12;
      const rx = edit.x * scale;
      const ry = edit.y * scale;
      const rw = (edit.x1 - edit.x) * scale;
      const rh = (edit.y1 - edit.y + bottomPad) * scale;

      const [bgR,bgG,bgB] = _rgbStringToFloats(edit.bgColor).map(v=>Math.round(v*255));
      ctx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
      ctx.fillRect(rx, ry, rw, rh);

      if(edit.newText && edit.newText.trim()){
        const [tr,tg,tb] = _intColorToFloats(edit.color || 0).map(v=>Math.round(v*255));
        const fl = edit.flags || 0;
        const fn = (edit.font || '').toLowerCase();
        const isBold   = !!(fl & 16) || fn.includes('bold');
        const isItalic = !!(fl & 2)  || fn.includes('italic') || fn.includes('oblique');
        const isMono   = !!(fl & 8)  || fn.includes('mono') || fn.includes('courier');
        const isSerif  = !!(fl & 4)  || fn.includes('times') || fn.includes('serif') || fn.includes('roman');
        const family = isMono ? '"Courier New",monospace' : isSerif ? '"Times New Roman",serif' : 'Arial,Helvetica,sans-serif';

        ctx.fillStyle = `rgb(${tr},${tg},${tb})`;
        ctx.font = `${isItalic?'italic ':''}${isBold?'bold ':''}${(edit.size||12)*scale}px ${family}`;
        ctx.textBaseline = 'alphabetic';
        const baselineY = (edit.y1 - (edit.y1 - edit.y) * 0.19) * scale;
        ctx.fillText(edit.newText, edit.x * scale, baselineY);
      }
    }

    const pngBytes = await new Promise((resolve, reject) => {
      off.toBlob(blob => {
        if(!blob) return reject(new Error('toBlob failed'));
        const fr = new FileReader();
        fr.onload = () => resolve(new Uint8Array(fr.result));
        fr.onerror = reject;
        fr.readAsArrayBuffer(blob);
      }, 'image/png');
    });

    const pngImage = await outDoc.embedPng(pngBytes);
    const newPage = outDoc.addPage([pdfW, pdfH]);
    newPage.drawImage(pngImage, { x: 0, y: 0, width: pdfW, height: pdfH });
  }

  return await outDoc.save();
}
