/* ============================================================================
   The check page. Parse the pasted bibliography, then audit one entry per
   request so a verdict can be written the moment each registry answers.
   ========================================================================== */
(() => {
  const $ = (id) => document.getElementById(id);
  const TIER = { FABRICATED_CANDIDATE:'b', INCONSISTENT:'b', RETRACTED:'b', BENIGN_DRIFT:'r', UNVERIFIED:'r', AMBIGUOUS_MATCH:'r', REGISTRY_UNREACHABLE:'r', CONSISTENT:'p' };
  const LABEL = { FABRICATED_CANDIDATE:'Fabricated candidate', INCONSISTENT:'Inconsistent', RETRACTED:'Retracted', BENIGN_DRIFT:'Benign drift', UNVERIFIED:'Unverified', AMBIGUOUS_MATCH:'Ambiguous match', REGISTRY_UNREACHABLE:'Registry unreachable', CONSISTENT:'Consistent' };
  const KIND = { journal:'journal article', chapter:'book chapter', book:'book', thesis:'thesis or dissertation', report:'report or working paper', web:'web page or trade press', unknown:'unrecognised type' };
  const KIND_PLURAL = { journal:'journal articles', chapter:'book chapters', book:'books', thesis:'theses and dissertations', report:'reports and working papers', web:'web pages and trade press', unknown:'unrecognised types' };
  const COVERED = { journal:true, chapter:false, book:false, thesis:false, report:false, web:false, unknown:true };
  const BASIS = { doi: 'Matched by DOI', search: 'Matched by title search', local: 'Matched in your local library' };
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
    $('coverage').hidden = true;
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
    // Show HOW the record was found and WHAT it is. A DOI anchor and a title guess
    // used to look identical here, so a reader could not tell a wrong reference
    // from a wrong match.
    const how = r.match_basis ? (BASIS[r.match_basis] ?? r.match_basis) : '';
    const conf = (r.match_confidence != null && r.match_basis === 'search')
      ? ` · confidence ${r.match_confidence.toFixed(2)}` : '';
    const who = [
      r.truth_authors && r.truth_authors.length
        ? esc(r.truth_authors.slice(0, 4).join(', ')) + (r.truth_authors.length > 4 ? ' et al.' : '')
        : '',
      r.truth_year ? esc(r.truth_year) : '',
    ].filter(Boolean).join(', ');
    const ident = r.truth_doi
      ? `<a href="https://doi.org/${encodeURIComponent(r.truth_doi)}" target="_blank" rel="noopener">${esc(r.truth_doi)}</a>`
      : (r.truth_id ? `<a href="${esc(r.truth_id)}" target="_blank" rel="noopener">registry record</a>` : '');
    row.innerHTML =
      `<div><span class="stamp ${k}">${esc(LABEL[r.verdict] ?? r.verdict)}</span></div>` +
      `<div><div class="key">${esc(r.key)}</div>` +
      (r.title ? `<div class="title">${esc(r.title)}${r.year ? `<i>${esc(r.year)}</i>` : ''}</div>` : '') +
      (r.truth_title
        ? `<div class="matched"><span class="how">${esc(how)}${esc(conf)}</span>` +
          `<span class="rec">${esc(r.truth_title)}</span>` +
          (who || ident ? `<span class="who">${who}${who && ident ? ' · ' : ''}${ident}</span>` : '') +
          `</div>`
        : '') +
      (notes.length ? `<div class="n"><span class="lbl">Notes</span>${esc(notes.join(' · '))}</div>` : '') +
      `</div>`;
    g.querySelector('.rows').appendChild(row);
    renderTally();
  }

  // Name what the registry does not index, instead of repeating "could be
  // fabricated" over a pile of books and reports.
  function renderCoverage(){
    const out = results.filter((r) => r.verdict === 'UNVERIFIED' && COVERED[r.kind] === false);
    const box = $('coverage');
    if (!out.length) { box.hidden = true; return; }
    const counts = {};
    for (const r of out) counts[r.kind] = (counts[r.kind] || 0) + 1;
    const parts = Object.entries(counts).map(([k, n]) => `${n} ${n === 1 ? (KIND[k] || k) : (KIND_PLURAL[k] || k)}`);
    box.innerHTML = `<b>${out.length} of these are outside the registry:</b> ${esc(parts.join(', '))}. ` +
      `The registries index journal articles and books, so a miss here says nothing about the reference itself. Check them by hand.`;
    box.hidden = false;
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
      renderCoverage();
      certify();
    } catch (err) {
      status.textContent = `The registry could not be reached, so nothing can be certified. ${err}`;
      status.className = 'status err';
    } finally {
      running = false; go.disabled = false;
    }
  });
})();
