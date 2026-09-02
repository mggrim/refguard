/* ============================================================================
   The check page. Parse the pasted bibliography, then audit one entry per
   request so a verdict can be written the moment each registry answers.
   ========================================================================== */
(() => {
  const $ = (id) => document.getElementById(id);
  const TIER = { FABRICATED_CANDIDATE:'b', INCONSISTENT:'b', RETRACTED:'b', BENIGN_DRIFT:'r', UNVERIFIED:'r', REGISTRY_UNREACHABLE:'r', CONSISTENT:'p' };
  const LABEL = { FABRICATED_CANDIDATE:'Fabricated candidate', INCONSISTENT:'Inconsistent', RETRACTED:'Retracted', BENIGN_DRIFT:'Benign drift', UNVERIFIED:'Unverified', REGISTRY_UNREACHABLE:'Registry unreachable', CONSISTENT:'Consistent' };
  const tier = (v) => TIER[v] ?? 'r';          // fail closed: an unknown verdict goes to review
  const form = $('audit'), input = $('input'), go = $('go'), status = $('status'), bar = $('bar'), empty = $('empty'), cert = $('cert');
  const groups = { b:$('g-b'), r:$('g-r'), p:$('g-p') };
  let results = [], running = false;

  const updateCount = () => {
    const v = input.value.trim();
    const n = v ? v.split('\n').length : 0;
    $('count').textContent = `${n} line${n === 1 ? '' : 's'}`;
  };
  input.addEventListener('input', updateCount);
  updateCount();

  $('sample').addEventListener('click', async () => {
    const r = await fetch('/sample.txt');
    input.value = await r.text();
    updateCount();
    input.focus();
  });

  $('reset').addEventListener('click', () => { input.value = ''; updateCount(); clear(); input.focus(); });

  $('copy').addEventListener('click', async () => {
    const lines = results.map((r) => `${r.verdict.padEnd(20)} ${r.key}${r.notes?.length ? ' — ' + r.notes.join('; ') : ''}`);
    const c = tally();
    const head = `RefGuard report — ${results.length} entries · ${c.b} blocking · ${c.r} review · ${c.p} consistent`;
    try {
      await navigator.clipboard.writeText([head, '', ...lines].join('\n'));
      $('copy').textContent = 'Copied';
      setTimeout(() => { $('copy').textContent = 'Copy report'; }, 1600);
    } catch { /* clipboard refused; leave the button alone */ }
  });

  function clear(){
    results = [];
    cert.className = 'cert';
    empty.hidden = false;
    status.textContent = '';
    status.className = 'status';
    bar.style.width = '0';
    for (const g of Object.values(groups)) { g.hidden = true; g.querySelector('.rows').innerHTML = ''; }
    renderTally();
  }

  function tally(){ const c = { b:0, r:0, p:0 }; for (const r of results) c[tier(r.verdict)]++; return c; }

  function renderTally(){
    const c = tally(), t = $('tally');
    t.querySelector('.b b').textContent = c.b;
    t.querySelector('.r b').textContent = c.r;
    t.querySelector('.p b').textContent = c.p;
  }

  const esc = (s) => { const d = document.createElement('span'); d.textContent = String(s ?? ''); return d.innerHTML; };

  function addRow(r){
    results.push(r);
    const k = tier(r.verdict), g = groups[k];
    g.hidden = false;
    empty.hidden = true;
    const notes = (r.notes || []).filter(Boolean);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      `<div><span class="stamp ${k}">${esc(LABEL[r.verdict] ?? r.verdict)}</span></div>` +
      `<div><div class="key">${esc(r.key)}</div>` +
      (r.title ? `<div class="title">${esc(r.title)}${r.year ? `<i>${esc(r.year)}</i>` : ''}</div>` : '') +
      (r.truth_title && r.truth_title !== r.title ? `<div class="n"><span class="lbl">Registry</span>${esc(r.truth_title)}</div>` : '') +
      (notes.length ? `<div class="n"><span class="lbl">Notes</span>${esc(notes.join(' · '))}</div>` : '') +
      `</div>`;
    g.querySelector('.rows').appendChild(row);
    renderTally();
  }

  function certify(){
    const c = tally(), n = results.length;
    let k, stamp, text;
    if (c.b) {
      k = 'b'; stamp = 'Cannot certify';
      text = `<b>${c.b} of ${n} entries</b> have blocking verdicts. Fix or remove them before you submit` +
             (c.r ? `, and check the ${c.r} in review by hand.` : '.');
    } else if (c.r) {
      k = 'r'; stamp = 'Certified with reservations';
      text = `No entry has a blocking verdict, but the registry could not settle <b>${c.r} of ${n}</b>. Check those by hand.`;
    } else {
      k = 'p'; stamp = 'Certified';
      text = `All <b>${n} entries</b> match the scholarly record, and none is marked retracted.`;
    }
    cert.className = 'cert on ' + k;
    $('cert-stamp').textContent = stamp;
    $('cert-text').innerHTML = text;
  }

  const post = (url, body) => fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || running) { if (!text) input.focus(); return; }
    running = true; go.disabled = true; clear();
    status.textContent = 'Reading the bibliography…';
    try {
      const pr = await post('/api/parse', { input: text });
      const parsed = await pr.json();
      if (!pr.ok) { status.textContent = parsed.error || `Could not read that (${pr.status})`; status.className = 'status err'; return; }
      const entries = parsed.entries;
      for (let i = 0; i < entries.length; i++) {
        status.textContent = `${i + 1} of ${entries.length}: asking the registry about ${entries[i].key}…`;
        bar.style.width = `${(i / entries.length) * 100}%`;
        const ar = await post('/api/audit-entry', { entry: entries[i] });
        addRow(ar.ok ? await ar.json()
                     : { key: entries[i].key, title: entries[i].title, year: entries[i].year, verdict: 'REGISTRY_UNREACHABLE', notes: [`server error ${ar.status}`] });
      }
      bar.style.width = '100%';
      status.textContent = `${entries.length} entries checked.`;
      certify();
    } catch (err) {
      status.textContent = `The registry could not be reached, so nothing can be certified. ${err}`;
      status.className = 'status err';
    } finally {
      running = false; go.disabled = false;
    }
  });
})();
