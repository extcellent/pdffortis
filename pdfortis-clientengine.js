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
// Schritt 2: /extract → extractPageLocal()
// ═══════════════════════════════════════

// Cache der Roh-Canvases (2x-Skalierung, wie fitz.Matrix(2,2)) für Farb-Sampling
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

function _deriveFlags(fontFamily){
  const fn=(fontFamily||'').toLowerCase();
  let flags=0;
  if(/bold/.test(fn)) flags|=16;
  if(/italic|oblique/.test(fn)) flags|=2;
  if(/mono|courier/.test(fn)) flags|=8;
  if(/times|serif|roman/.test(fn)) flags|=4;
  return flags;
}

function _sampleTextColor(ctx, cx, cy, cw, ch){
  let best=[0,0,0], bestDist=-1;
  const steps=6;
  for(let i=0;i<steps;i++){
    const sx = cx + cw*(0.1+0.8*i/(steps-1));
    const sy = cy + ch*0.5;
    if(sx<0||sy<0||sx>=ctx.canvas.width||sy>=ctx.canvas.height) continue;
    try{
      const px = ctx.getImageData(sx|0, sy|0, 1, 1).data;
      const dist = (255-px[0])**2+(255-px[1])**2+(255-px[2])**2;
      if(dist>bestDist){ bestDist=dist; best=[px[0],px[1],px[2]]; }
    }catch(e){}
  }
  return best;
}

async function extractPageLocal(pdfDocLocal, pageIndex){
  const page = await pdfDocLocal.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 }); // Top-Left-Origin, y runter — wie PyMuPDF
  const textContent = await page.getTextContent();
  const { canvas, ctx } = await _getOrRenderCanvas(pdfDocLocal, pageIndex);

  const items = [];
  for(const it of textContent.items){
    if(!it.str || !it.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const x = tx[4];
    const y = tx[5] - fontHeight; // top
    const x1 = x + (it.width || fontHeight*0.5*it.str.length);
    const y1 = tx[5]; // baseline ≈ unten

    const styleInfo = textContent.styles[it.fontName] || {};
    const flags = _deriveFlags(styleInfo.fontFamily);

    // Sampling auf 2x-Canvas → Koordinaten *2
    const [r,g,b] = _sampleTextColor(ctx, x*2, y*2, (x1-x)*2, (y1-y)*2);
    const colorInt = (r<<16)|(g<<8)|b;

    items.push({
      text: it.str,
      x, y, x1, y1,
      size: fontHeight,
      color: colorInt,
      font: styleInfo.fontFamily || '',
      flags
    });
  }

  return { items, pageWidth: viewport.width, pageHeight: viewport.height };
}
