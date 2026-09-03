/* ============================================================================
   THE FLIGHT — a scroll-scrubbed camera flight rendered on canvas.
   Scroll position → t ∈ [0,1] → camera + scene state. Fully reversible.
   Ideas borrowed from the scroll-world scrub engine: pinned stage, per-scene
   linger easing (camera settles where the copy peaks), route rail, hint,
   reduced-motion fallback. No video, no assets.
   ========================================================================== */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const flight = document.querySelector('.flight');
  const canvas = document.getElementById('world');
  const ctx = canvas.getContext('2d');
  const copies = [...document.querySelectorAll('.copy')];
  const dots = [...document.querySelectorAll('.route button')];
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  let C = {};
  const readTheme = () => { C = { paper:css('--paper'), paper2:css('--paper-2'), paper3:css('--paper-3'), ink:css('--ink'), ink2:css('--ink-2'), ink3:css('--ink-3'), rule:css('--rule'), ox:css('--ox'), pass:css('--pass'), card:css('--card') }; };
  readTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); draw(cur); });
  new MutationObserver(() => { readTheme(); draw(cur); }).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });

  // ---- scenes: [start, end] in t, with a linger (camera settles mid-scene) ----
  const SCENES = [
    { a:0.00, b:0.24, linger:.45 },   // manuscript
    { a:0.24, b:0.50, linger:.40 },   // parse
    { a:0.50, b:0.78, linger:.45 },   // registry
    { a:0.78, b:1.00, linger:.55 },   // verdict
  ];
  const clamp = (x,a=0,b=1) => Math.min(b, Math.max(a,x));
  const smooth = (x) => { x = clamp(x); return x*x*(3-2*x); };
  const lerp = (a,b,x) => a + (b-a)*x;
  const lingerEase = (x,L) => { const c = x-.5; return (1-L)*x + L*(4*c*c*c + .5); };
  // local progress inside scene i (0..1), lingered
  const local = (t,i) => { const s = SCENES[i]; return lingerEase(clamp((t-s.a)/(s.b-s.a)), s.linger); };

  // ---- world geometry (units) ----
  const PAGE = { x:0, y:0, w:620, h:820 };
  const REF_Y = 585;                       // y of the highlighted reference block on the page
  const REF = {
    line1: 'Battilana, J., & Dorado, S. (2010). Building sustainable hybrid organizations:',
    line2: 'The case of commercial microfinance organizations. Academy of Management',
    line3: 'Journal, 53(6), 1419–1440. https://doi.org/10.5465/amj.2010.57318391',
  };
  const FIELDS = [
    { k:'TITLE',   v:'Building sustainable hybrid organizations: The case of commercial microfinance organizations' },
    { k:'AUTHORS', v:'Battilana · Dorado' },
    { k:'YEAR',    v:'2010' },
    { k:'JOURNAL', v:'Academy of Management Journal' },
    { k:'DOI',     v:'10.5465/amj.2010.57318391' },
  ];
  const CHIP_X = 690, CHIP_Y0 = 300, CHIP_GAP = 74;     // parsed field chips column
  const REG = { x:1650, y:120, w:760, h:640 };            // registry archive area
  const CARD = { x:1740, y:250, w:560, h:392 };           // the matched record card

  // camera keyframes: {x,y (world centre), z (zoom)} per scene edge
  function camera(t){
    const narrow = W < 700;       // phones: the copy sits below the world, so centre it
    const keys = [
      { x:narrow?310:60, y:narrow?330:400, z:0.8 },   // t=0  whole page, right of the copy on desktop
      { x:200, y:600, z:1.45 },   // end s0  pushed into the reference line
      { x:760, y:500, z:1.0  },   // end s1  chips beside the page, page sliding out left
      { x:1800,y:450, z:0.95 },   // end s2  inside the registry, chips peeking in from the left
      { x:1810,y:440, z:1.2  },   // end s3  settled on the stamped card
    ];
    // which leg
    let i = SCENES.findIndex(s => t <= s.b); if (i < 0) i = 3;
    // the camera arrives 60% of the way through each leg and then holds, so the
    // scene's own animation (chips landing, ticks, the stamp) plays on a settled frame
    const s = SCENES[i];
    const p = smooth(clamp((t - s.a) / (s.b - s.a) / .6));
    const A = keys[i], B = keys[i+1];
    // a little vertical arc on the long registry leg so the flight reads as flying, not sliding
    const arc = (i===2) ? -Math.sin(p*Math.PI)*90 : 0;
    return { x:lerp(A.x,B.x,p), y:lerp(A.y,B.y,p)+arc, z:lerp(A.z,B.z,p) };
  }

  // ---- drawing helpers ----
  let W=0,H=0,dpr=1;
  function resize(){
    dpr = Math.min(devicePixelRatio||1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W*dpr; canvas.height = H*dpr;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    draw(cur);
  }
  function rr(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
  const mono = (s) => `${s}px "IBM Plex Mono", Menlo, monospace`;
  const serif = (s,it) => `${it?'italic ':''}${s}px "Instrument Serif", Georgia, serif`;
  const sans = (s,w) => `${w||400} ${s}px "IBM Plex Sans", Arial, sans-serif`;

  // deterministic pseudo-random for text-line widths
  const rnd = (i) => { const x = Math.sin(i*127.1+311.7)*43758.5453; return x - Math.floor(x); };

  function drawPage(t){
    const {x,y,w,h} = PAGE;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
    ctx.fillStyle = C.card; ctx.fillRect(x,y,w,h);
    ctx.restore();
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.strokeRect(x+.5,y+.5,w-1,h-1);
    // running head
    ctx.fillStyle = C.ink3; ctx.font = mono(9); ctx.textBaseline='top';
    ctx.fillText('ACADEMY OF MANAGEMENT JOURNAL · MANUSCRIPT AMJ-2026-0341', x+56, y+40);
    ctx.fillText('34', x+w-72, y+40);
    // title
    ctx.fillStyle = C.ink; ctx.font = serif(22);
    ctx.fillText('References', x+56, y+92);
    ctx.fillStyle = C.rule; ctx.fillRect(x+56, y+124, w-112, 1);
    // faux body lines (grey bars), grouped in reference-shaped blocks
    ctx.fillStyle = C.paper3;
    let yy = y+146, i=0;
    while (yy < REF_Y-30){
      const inBlock = i%4; const wl = inBlock===0 ? 0.92 : (inBlock===3 ? 0.35+rnd(i)*.4 : 0.8+rnd(i)*.15);
      const indent = inBlock===0 ? 0 : 26;
      ctx.fillRect(x+56+indent, yy, (w-112-indent)*wl, 7);
      yy += (inBlock===3) ? 26 : 15; i++;
    }
    // the reference of interest: real text, highlighted as t progresses through scene 0
    const hl = smooth(local(t,0)*1.6);
    ctx.fillStyle = C.ox; ctx.globalAlpha = .12*hl; ctx.fillRect(x+48, REF_Y-8, w-96, 62); ctx.globalAlpha = 1;
    ctx.fillStyle = C.ox; ctx.fillRect(x+48, REF_Y-8, 3*hl, 62);
    ctx.fillStyle = C.ink; ctx.font = sans(11.5);
    ctx.fillText(REF.line1, x+56, REF_Y);
    ctx.fillText(REF.line2, x+82, REF_Y+18);
    ctx.fillText(REF.line3, x+82, REF_Y+36);
    // remaining faux lines
    ctx.fillStyle = C.paper3; yy = REF_Y+70; i=40;
    while (yy < y+h-60){ const inBlock=i%4; const wl = inBlock===0?0.92:(inBlock===3?0.35+rnd(i)*.4:0.8+rnd(i)*.15); const indent=inBlock===0?0:26; ctx.fillRect(x+56+indent,yy,(w-112-indent)*wl,7); yy += inBlock===3?26:15; i++; }
  }

  function chipRect(i){ return { x:CHIP_X, y:CHIP_Y0 + i*CHIP_GAP, w:470, h:56 }; }

  function drawChips(t){
    // chips fly out of the reference line during scene 1, staggered; stay put afterwards
    const p1 = local(t,1);
    if (t < SCENES[1].a - .02) return;
    FIELDS.forEach((f,i) => {
      const s = smooth((p1 - i*.09) / .55);
      if (s <= 0) return;
      const dst = chipRect(i);
      const sx = PAGE.x+90 + i*40, sy = REF_Y + 16 + (i%3)*18;    // origin on the reference line
      const x = lerp(sx, dst.x, s), y = lerp(sy, dst.y, s) - Math.sin(s*Math.PI)*60;
      const w = lerp(120, dst.w, s), h = lerp(14, dst.h, s);
      ctx.save(); ctx.globalAlpha = Math.min(1, s*1.6);
      ctx.shadowColor='rgba(0,0,0,.16)'; ctx.shadowBlur=18; ctx.shadowOffsetY=8;
      ctx.fillStyle = C.card; rr(x,y,w,h,3); ctx.fill(); ctx.restore();
      ctx.strokeStyle = C.rule; ctx.lineWidth=1; rr(x+.5,y+.5,w-1,h-1,3); ctx.stroke();
      if (s > .7){
        ctx.globalAlpha = (s-.7)/.3;
        ctx.fillStyle = C.ox; ctx.font = mono(9); ctx.textBaseline='top';
        ctx.fillText(f.k, x+14, y+10);
        ctx.fillStyle = C.ink; ctx.font = sans(12.5);
        ctx.fillText(ellipsis(f.v, 58), x+14, y+28);
        ctx.globalAlpha = 1;
      }
    });
  }

  function ellipsis(s,n){ return s.length>n ? s.slice(0,n-1)+'…' : s; }

  function drawRegistry(t){
    if (t < SCENES[1].b - .08) return;
    const p2 = local(t,2), p3 = local(t,3);
    const appear = smooth((t - (SCENES[1].b-.08)) / .16);
    ctx.save(); ctx.globalAlpha = appear;
    // the archive: rows of receding record cards, drawn with parallax depth
    const cols = 9, rows = 7;
    for (let r=0;r<rows;r++){
      const depth = (r+1)/rows;                       // 1 = front (bottom row)
      const scale = .45 + depth*.55;
      const y = REG.y + r*82 + (1-depth)*30;
      for (let c=0;c<cols;c++){
        const jitter = rnd(r*13+c)*10;
        const x = REG.x - 200 + c*118 + (r%2)*40 + jitter;
        const w = 96*scale, h = 60*scale;
        ctx.globalAlpha = appear * (0.18 + depth*.5);
        ctx.fillStyle = C.paper3; ctx.fillRect(x,y,w,h);
        ctx.fillStyle = C.rule; ctx.fillRect(x+8, y+10, w*.6, 3); ctx.fillRect(x+8, y+18, w*.45, 3);
      }
    }
    ctx.restore();

    // one record card comes forward and settles in front (during scene 2)
    const come = smooth((p2 - .12)/.55);
    if (come <= 0) return;
    const {x,y,w,h} = CARD;
    const cx = lerp(REG.x+260, x, come), cy = lerp(REG.y+300, y, come);
    const sc = lerp(.35, 1, come);
    ctx.save();
    ctx.translate(cx,cy); ctx.scale(sc,sc);
    ctx.shadowColor='rgba(0,0,0,.28)'; ctx.shadowBlur=50; ctx.shadowOffsetY=22;
    ctx.fillStyle = C.card; ctx.fillRect(0,0,w,h);
    ctx.restore();
    ctx.save(); ctx.translate(cx,cy); ctx.scale(sc,sc);
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.strokeRect(.5,.5,w-1,h-1);
    ctx.fillStyle = C.ink3; ctx.font = mono(9); ctx.textBaseline='top';
    ctx.fillText('CROSSREF · 10.5465/AMJ.2010.57318391 · REGISTRY RECORD', 22, 20);
    ctx.fillStyle = C.rule; ctx.fillRect(22, 40, w-44, 1);
    // field rows, each ticked as scene 2 progresses (after the card arrives)
    const truth = ['Building sustainable hybrid organizations: The case of commercial microfinance organizations','Battilana · Dorado','2010','Academy of Management Journal','10.5465/amj.2010.57318391'];
    FIELDS.forEach((f,i) => {
      const ry = 58 + i*62;
      ctx.fillStyle = C.ox; ctx.font = mono(9); ctx.fillText(f.k, 22, ry);
      ctx.fillStyle = C.ink; ctx.font = sans(12.5); ctx.fillText(ellipsis(truth[i],58), 22, ry+18);
      ctx.fillStyle = C.rule; ctx.fillRect(22, ry+46, w-44, 1);
      const tick = smooth((p2 - .62 - i*.07)/.14);
      if (tick > 0){
        ctx.save(); ctx.globalAlpha = tick;
        ctx.strokeStyle = C.pass; ctx.lineWidth = 2.2; ctx.lineCap='round';
        ctx.beginPath(); ctx.moveTo(w-46, ry+22); ctx.lineTo(w-38, ry+30); ctx.lineTo(w-24, ry+12); ctx.stroke();
        ctx.restore();
      }
    });
    // the stamp (scene 3)
    const st = smooth((p3 - .08)/.5);
    if (st > 0){
      const s = lerp(2.6, 1, st);
      ctx.save();
      ctx.translate(w-150, h-84); ctx.rotate(-.2); ctx.scale(s,s);
      ctx.globalAlpha = st;
      ctx.strokeStyle = C.pass; ctx.lineWidth = 3; rr(-96,-26,192,52,4); ctx.stroke();
      ctx.fillStyle = C.pass; ctx.font = mono(15); ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('CONSISTENT', 0, 1);
      ctx.font = mono(7); ctx.fillText('5 / 5 FIELDS · NOT RETRACTED', 0, 17);
      ctx.restore();
    }
    ctx.restore();

    // connection lines: chips → card fields, drawn while comparing
    const link = smooth((p2 - .5)/.3) * (1 - smooth((p3-.3)/.4));
    if (link > 0 && come > .95){
      ctx.save(); ctx.globalAlpha = link*.7; ctx.strokeStyle = C.ox; ctx.lineWidth = 1; ctx.setLineDash([4,5]);
      FIELDS.forEach((f,i) => { const a = chipRect(i); const ay = a.y+a.h/2, by = y+58+i*62+24;
        ctx.beginPath(); ctx.moveTo(a.x+a.w, ay); ctx.bezierCurveTo(a.x+a.w+300, ay, x-300, by, x, by); ctx.stroke(); });
      ctx.restore();
    }
  }

  function draw(t){
    if (!W) return;
    ctx.clearRect(0,0,W,H);
    // atmosphere: a faint vignette + horizon line so the flight has a ground
    const g = ctx.createRadialGradient(W*.6, H*.4, 0, W*.6, H*.4, Math.max(W,H)*.9);
    g.addColorStop(0, C.paper); g.addColorStop(1, C.paper2);
    ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
    const cam = camera(t);
    const z = cam.z * Math.min(1, Math.max(.5, W/1100));   // scale down on narrow viewports, but not below half
    ctx.save();
    ctx.translate(W/2, H/2); ctx.scale(z,z); ctx.translate(-cam.x, -cam.y);
    drawRegistry(t);
    drawPage(t);
    drawChips(t);
    ctx.restore();
  }

  // ---- scroll → t ----
  let cur = 0, target = 0, raf = 0, activeScene = -1;
  function read(){
    const rect = flight.getBoundingClientRect();
    const total = flight.offsetHeight - innerHeight;
    target = clamp(-rect.top / total);
    flight.classList.toggle('past', target > .04);
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick(){
    raf = 0;
    cur += (target - cur) * .18;
    if (Math.abs(target-cur) < .0004) cur = target;
    draw(cur); setScene(cur);
    if (cur !== target) raf = requestAnimationFrame(tick);
  }
  function setScene(t){
    let i = SCENES.findIndex(s => t < s.b); if (i<0) i=3;
    // copy peaks mid-scene; show it from 12% into the scene
    const s = SCENES[i]; const lp = (t - s.a)/(s.b - s.a);
    const show = (lp > .1 || i===0) && (i===3 || lp < .96);
    copies.forEach((c,k) => c.classList.toggle('on', k===i && show));
    if (i !== activeScene){ activeScene = i; dots.forEach((d,k) => d.classList.toggle('on', k===i)); }
  }
  dots.forEach(d => d.addEventListener('click', () => {
    const i = +d.dataset.jump; const s = SCENES[i];
    const total = flight.offsetHeight - innerHeight;
    scrollTo({ top: flight.offsetTop + total*(s.a + (s.b-s.a)*.5), behavior: reduce?'auto':'smooth' });
  }));

  // test hook: draw a given t immediately (used by the verification harness)
  window.__flight = { jump(t){ const total = flight.offsetHeight - innerHeight; scrollTo({ top: flight.offsetTop + total*t, behavior:'instant' }); cur = target = clamp(t); flight.classList.toggle('past', cur > .04); draw(cur); setScene(cur); return cur; } };

  if (reduce){
    // static final frame; copy is laid out by CSS
    copies.forEach(c => c.classList.add('on'));
    addEventListener('resize', () => { resize(); draw(1); });
    document.fonts?.ready.then(() => { resize(); draw(1); });
    resize(); cur = 1; draw(1);
  } else {
    addEventListener('scroll', read, { passive:true });
    addEventListener('resize', () => { resize(); read(); });
    document.fonts?.ready.then(() => draw(cur));
    resize(); read();
  }
})();
