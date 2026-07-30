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
function _scanTextBox(ctx, cx, cy, cw, ch){
  const W = ctx.canvas.width, H = ctx.canvas.height;
  cx = Math.max(0, cx); cy = Math.max(0, cy);
  cw = Math.min(cw, W - cx); ch = Math.min(ch, H - cy);
  if(cw<=0 || ch<=0) return null;

  // --- Hintergrundfarbe: Cluster-Sampling an den Rändern (wie deine Maske) ---
  const samples=[];
  const pick=(sx,sy)=>{
    if(sx<0||sy<0||sx>=W||sy>=H) return;
    try{ const p=ctx.getImageData(sx|0,sy|0,1,1).data; samples.push([p[0],p[1],p[2]]); }catch(e){}
  };
  for(let i=1;i<=3;i++){
    pick(cx-i, cy+ch*0.5); pick(cx+cw-1+i, cy+ch*0.5);
    pick(cx+cw*0.5, cy-i); pick(cx+cw*0.5, cy+ch-1+i);
  }
  let bgR=255,bgG=255,bgB=255;
  if(samples.length){
    const buckets={};
    samples.forEach(s=>{
      const k=(s[0]>>5)+','+(s[1]>>5)+','+(s[2]>>5);
      if(!buckets[k]) buckets[k]={n:0,r:0,g:0,b:0};
      buckets[k].n++; buckets[k].r+=s[0]; buckets[k].g+=s[1]; buckets[k].b+=s[2];
    });
    let best=null;
    for(const k in buckets) if(!best||buckets[k].n>best.n) best=buckets[k];
    bgR=Math.round(best.r/best.n); bgG=Math.round(best.g/best.n); bgB=Math.round(best.b/best.n);
  }

  // --- Tight Bbox der echten Glyphen-Pixel + Text-Farbe sammeln ---
  const imgData = ctx.getImageData(cx|0, cy|0, cw|0, ch|0);
  const d = imgData.data;
  const TH2 = 18*18;
  let yMin=ch, yMax=-1, xMin=cw, xMax=-1;
  let fgSum=[0,0,0], fgN=0;
  for(let y=0; y<ch; y++){
    for(let x=0; x<cw; x++){
      const i=(y*cw+x)*4;
      const dr=d[i]-bgR, dg=d[i+1]-bgG, db=d[i+2]-bgB;
      if(dr*dr+dg*dg+db*db > TH2){
        if(y<yMin)yMin=y; if(y>yMax)yMax=y;
        if(x<xMin)xMin=x; if(x>xMax)xMax=x;
        fgSum[0]+=d[i]; fgSum[1]+=d[i+1]; fgSum[2]+=d[i+2]; fgN++;
      }
    }
  }
  if(fgN===0 || xMin>xMax || yMin>yMax) return null; // keine Glyphen gefunden (Whitespace etc.)

  return {
    x: cx+xMin, y: cy+yMin, w: xMax-xMin+1, h: yMax-yMin+1,
    bg: [bgR,bgG,bgB],
    fg: [Math.round(fgSum[0]/fgN), Math.round(fgSum[1]/fgN), Math.round(fgSum[2]/fgN)]
  };
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
    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const roughX = tx[4] - fontHeight*0.2;
    const roughY = tx[5] - fontHeight*1.5;   // deutlich mehr Platz nach oben (Umlaute, Akzente)
    const roughW = (it.width || fontHeight*0.5*it.str.length) + fontHeight*0.5;
    const roughH = fontHeight*2.2;           // deutlich mehr Platz für Ober-/Unterlängen

    // Scan auf 2x-Canvas → Region *2
    const box = _scanTextBox(ctx, roughX*2, roughY*2, roughW*2, roughH*2);

    let x,y,x1,y1,color;
    if(box){
      x = box.x/2; y = box.y/2; x1 = (box.x+box.w)/2; y1 = (box.y+box.h)/2;
      color = (box.fg[0]<<16)|(box.fg[1]<<8)|box.fg[2];
    }else{
      // Fallback: engere Metrik-Schätzung statt des überbreiten Suchfensters
      x=tx[4]; y=tx[5]-fontHeight*1.0; x1=tx[4]+(it.width||fontHeight*0.5*it.str.length); y1=tx[5]+fontHeight*0.3;
      color=0x000000;
    }

    const styleInfo = textContent.styles[it.fontName] || {};
    items.push({
      text: it.str,
      x, y, x1, y1,
      size: fontHeight,
      color,
      font: styleInfo.fontFamily || '',
      flags: _deriveFlags(styleInfo.fontFamily)
    });
  }
  

  return { items, pageWidth: viewport.width, pageHeight: viewport.height };
}
