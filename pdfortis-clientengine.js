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

// Bestehende Signatur, ergänzt um die neuen Daten aus der UI
export async function editBatchLocal(pdfDoc, pageIndex, edits, pdfJsTotalItemsCount) {
    const pages = pdfDoc.getPages();
    const page = pages[pageIndex];

    // 1. Sammle alle Indices, die auf dieser Seite gelöscht werden sollen
    let allIndicesToRemove = [];
    edits.forEach(edit => {
        if (edit.originalItemIndices && Array.isArray(edit.originalItemIndices)) {
            allIndicesToRemove.push(...edit.originalItemIndices);
        }
    });

    // 2. Führe die Surgery durch (alter Text wird gelöscht)
    let surgerySuccessful = false;
    if (allIndicesToRemove.length > 0) {
        surgerySuccessful = surgicallyRemoveTextOperators(
            pdfDoc, 
            page, 
            allIndicesToRemove, 
            pdfJsTotalItemsCount // WICHTIG: Die Gesamtzahl der Items aus dem extractPageLocal Aufruf
        );
    }

    // 3. Neuen Text zeichnen
    for (const edit of edits) {
        // Wenn Surgery fehlgeschlagen ist ODER paranoidCover an ist, male das Rechteck
        const needsCoverRect = !surgerySuccessful || edit.paranoidCover;

        if (needsCoverRect) {
            // DEINE BESTEHENDE LOGIK FÜR DAS ABDECK-RECHTECK
            page.drawRectangle({
                x: edit.rect.x,
                y: edit.rect.y,
                width: edit.rect.width,
                height: edit.rect.height,
                color: edit.backgroundColor || rgb(1, 1, 1), // Weiß oder Hintergrund
            });
        }

        // DEINE BESTEHENDE LOGIK FÜR DEN NEUEN TEXT
        page.drawText(edit.newText, {
            x: edit.rect.x,
            y: edit.rect.y,
            font: edit.font,
            size: edit.fontSize,
            color: edit.textColor || rgb(0, 0, 0),
        });
    }

    return pdfDoc;
}

import { PDFName, decodePDFRawStream, PDFArray, PDFRawStream } from 'pdf-lib';

/**
 * Holt den dekodierten Content-Stream als String.
 */
function getDecodedContentStream(page) {
    const contents = page.node.get(PDFName.of('Contents'));
    if (!contents) return '';

    let streams = [];
    if (contents instanceof PDFArray) {
        for (let idx = 0; idx < contents.size(); idx++) {
            streams.push(contents.lookup(idx));
        }
    } else {
        streams.push(contents);
    }

    let fullText = '';
    for (const stream of streams) {
        if (stream instanceof PDFRawStream) {
            const decoded = decodePDFRawStream(stream).decode();
            fullText += new TextDecoder('utf-8').decode(decoded) + '\n';
        }
    }
    return fullText;
}

/**
 * Zählt Text-Operatoren (Tj, TJ, ', ") im Stream und gibt deren Start/End-Positionen im String zurück.
 * So matchen wir die Indizes aus pdf.js.
 */
function mapPdfJsItemsToOps(streamString) {
    const textOpsPositions = [];
    // Regex findet PostScript Text-Operatoren: (Text) Tj, [ (Text) 120 (Text) ] TJ, etc.
    // Dies ist eine Näherung, die für 99% der von pdf.js extrahierten standard Texte funktioniert.
    const textOpRegex = /(?:<[\dA-Fa-f]*>|\([^()]*\)|\[.*?\])\s*(Tj|TJ|'|")/g;
    
    let match;
    while ((match = textOpRegex.exec(streamString)) !== null) {
        textOpsPositions.push({
            start: match.index,
            end: match.index + match[0].length,
            matchStr: match[0],
            operator: match[1]
        });
    }
    return textOpsPositions;
}

/**
 * Operiert am Herzen des PDF-Streams: Ersetzt die Text-Operatoren an den gegebenen Indizes durch leere Strings.
 */
function surgicallyRemoveTextOperators(pdfDoc, page, itemIndicesToRemove, expectedTotalItems) {
    const streamString = getDecodedContentStream(page);
    if (!streamString) return false; // Fallback

    const textOps = mapPdfJsItemsToOps(streamString);

    // Alignment-Check (Safety Net)
    if (textOps.length !== expectedTotalItems) {
        console.warn(`[PDFortis Surgery] Alignment Check fehlgeschlagen! pdf.js Items: ${expectedTotalItems}, gefundene Ops: ${textOps.length}. Falle auf Overlay-Methode zurück.`);
        return false;
    }

    // Sortiere Indizes absteigend, damit sich die String-Offsets beim Ersetzen nicht verschieben!
    const sortedIndices = [...itemIndicesToRemove].sort((a, b) => b - a);
    
    let newStreamString = streamString;
    for (const index of sortedIndices) {
        if (index < 0 || index >= textOps.length) continue;
        
        const op = textOps[index];
        // Ersetze den Operator durch Whitespace (no-op), damit Font-States etc. intakt bleiben
        const blankSpace = ' '.repeat(op.end - op.start);
        newStreamString = newStreamString.substring(0, op.start) + blankSpace + newStreamString.substring(op.end);
    }

    // Neuen Stream in die Seite schreiben
    const newStream = pdfDoc.context.flateStream(new TextEncoder().encode(newStreamString));
    const newStreamRef = pdfDoc.context.register(newStream);
    
    page.node.set(PDFName.of('Contents'), newStreamRef);
    return true; // Surgery erfolgreich
}
