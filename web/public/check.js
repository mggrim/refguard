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
  const MEANING = {
    FABRICATED_CANDIDATE: 'the DOI is registered nowhere; 404 at both Crossref and doi.org',
    INCONSISTENT: 'the paper exists but a field does not belong to it',
    RETRACTED: 'the registry marks this work retracted',
    BENIGN_DRIFT: 'the online-first year cited where a print year exists, a year one off that neither date explains, a changed subtitle, or an incomplete author list',
    UNVERIFIED: 'no registry confirmed it; not proof of fabrication',
    AMBIGUOUS_MATCH: 'a record was found but may be a different work or edition; the reference may be fine',
    REGISTRY_UNREACHABLE: 'a registry could not be reached, so nothing can be certified',
    CONSISTENT: 'every field matches the registry record',
  };
  const BASIS = { doi: 'Matched by DOI', search: 'Matched by reference search', book: 'Matched in Open Library', local: 'Matched in your local library' };
  const tier = (v) => TIER[v] ?? 'r';          // fail closed: an unknown verdict goes to review
  const form = $('audit'), input = $('input'), go = $('go'), status = $('status'), bar = $('bar'), empty = $('empty'), cert = $('cert');
  // Results are grouped by whether they deserve the author's time, not by verdict.
  // The two quiet groups start folded and show only their counts.
  const groups = { fix:$('g-fix'), look:$('g-look'), fine:$('g-fine'), cant:$('g-cant'), ok:$('g-p') };
  const levelOf = (r) => r.verdict === 'CONSISTENT' ? 'ok' : (r.attention && r.attention.level) || (tier(r.verdict) === 'b' ? 'fix' : 'fine');
  let results = [], running = false, reading = null;

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

  // Opens in place. Sending the reader to the landing page wiped their results.
  $('explain').addEventListener('click', () => {
    const box = $('glossary'), btn = $('explain');
    box.hidden = !box.hidden;
    btn.setAttribute('aria-expanded', String(!box.hidden));
    btn.textContent = box.hidden ? 'What the verdicts mean' : 'Hide the verdicts';
    if (!box.hidden) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $('reset').addEventListener('click', () => { input.value = ''; updateCount(); clear(); input.focus(); });

  /**
   * The clipboard report is what someone pastes into an email to a co-author or
   * keeps beside a submission checklist, so it carries the evidence, not just the
   * verdict: what was claimed, what record was matched, how it was found, and why
   * the verdict came out that way.
   */
  function reportText(){
    const c = tally();
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const lines = [
      `RefGuard reference report`,
      `${stamp} UTC · ${location.origin}`,
      `${results.length} entries · ${c.fix} fix this · ${c.look} worth a look · ${c.fine} probably fine · ${c.cant} can't check here · ${c.ok} consistent`,
      `Checked against Crossref, Open Library and the doi.org handle registry. No AI is used in this audit.`,
      '',
    ];
    const notes = readingNotes();
    if (notes.length) {
      const heading = 'READING THE LIST: a reference may have been merged into another or missed';
      lines.push(heading, '-'.repeat(heading.length), ...notes.map((n) => `  ${n}`), '');
    }
    const groupsOut = [
      ['fix', 'FIX THIS: likely a real error in the reference'],
      ['look', 'WORTH A LOOK: a real difference you may want to change'],
      ['fine', 'PROBABLY FINE: a difference of record, not of reference'],
      ['cant', "CAN'T CHECK HERE: outside the registries or not found, which is not evidence of a problem"],
      ['ok', 'CONSISTENT: every field matches the registry record'],
    ];
    for (const [k, heading] of groupsOut) {
      const rows = results.filter((r) => levelOf(r) === k);
      if (!rows.length) continue;
      lines.push(heading, '-'.repeat(heading.length), '');
      for (const r of rows) {
        lines.push(`[${LABEL[r.verdict] ?? r.verdict}]  ${r.key}`);
        if (r.attention && r.attention.reason) lines.push(`  in short : ${r.attention.reason}`);
        if (r.title) lines.push(`  cited as : ${r.title}${r.year ? ` (${r.year})` : ''}`);
        if (r.truth_title) {
          const who = (r.truth_authors || []).slice(0, 4).join(', ') + ((r.truth_authors || []).length > 4 ? ' et al.' : '');
          lines.push(`  record   : ${r.truth_title}${who ? ` — ${who}` : ''}${r.truth_year ? `, ${r.truth_year}` : ''}`);
          const how = BASIS[r.match_basis] || r.match_basis || '';
          const conf = (r.match_confidence != null && r.match_basis === 'search') ? ` (confidence ${r.match_confidence.toFixed(2)})` : '';
          if (how) lines.push(`  found by : ${how}${conf}`);
          if (r.truth_doi) lines.push(`  doi      : https://doi.org/${r.truth_doi}`);
          else if (r.truth_id) lines.push(`  record id: ${r.truth_id}`);
        }
        for (const n of (r.notes || []).filter(Boolean)) lines.push(`  why      : ${n}`);
        lines.push('');
      }
    }
    lines.push('What the verdicts mean:');
    for (const [v, l] of Object.entries(LABEL)) lines.push(`  ${l} — ${MEANING[v]}`);
    return lines.join('\n');
  }

  $('copy').addEventListener('click', async () => {
    if (!results.length) return;
    // Built OUTSIDE the try: with it inside, a bug in report generation was
    // swallowed by the clipboard's catch and looked like a browser refusal.
    const text = reportText();
    const say = (msg) => { $('copy').textContent = msg; setTimeout(() => { $('copy').textContent = 'Copy report'; }, 2200); };
    try {
      await navigator.clipboard.writeText(text);
      say('Copied');
    } catch {
      // Some browsers refuse the clipboard outside a trusted gesture. Put the
      // report on screen so the reader can still select it rather than lose it.
      $('report-out').value = text;
      $('report-out').hidden = false;
      $('report-out').select();
      say('Select and copy');
    }
  });

  function clear(){
    results = [];
    cert.className = 'cert';
    empty.hidden = false;
    status.textContent = '';
    status.className = 'status';
    bar.style.width = '0';
    for (const g of Object.values(groups)) { g.hidden = true; g.open = false; g.querySelector('.rows').innerHTML = ''; }
    $('summary').hidden = true;
    $('reading').hidden = true;
    reading = null;
    renderTally();
  }

  // What the reader made of the paste. Every reference the text appears to hold is
  // either checked or named here, so a missed one is never certified by silence.
  function readingNotes(){
    if (!reading) return [];
    const out = [];
    if (reading.truncated) out.push(`Only the first ${reading.checked} of ${reading.truncated} entries are checked here. Split the list to check the rest.`);
    for (const w of reading.warnings || []) out.push(w.message);
    return out;
  }
  function renderReading(){
    const box = $('reading');
    const notes = readingNotes();
    if (!notes.length) { box.hidden = true; return; }
    const n = reading.parsed, m = reading.expected;
    const lead = m > n
      ? `<b>The reader found ${n} references, but the text appears to hold ${m}.</b> `
      : `<b>The reader may have joined two references into one.</b> `;
    box.innerHTML = lead + 'Check these places in your list before relying on the result:' +
      '<ul>' + notes.map((t) => `<li>${esc(t)}</li>`).join('') + '</ul>';
    box.hidden = false;
  }

  function tally(){ const c = { fix:0, look:0, fine:0, cant:0, ok:0 }; for (const r of results) c[levelOf(r)]++; return c; }

  function renderTally(){
    const c = tally(), t = $('tally');
    t.querySelector('.b b').textContent = c.fix;
    t.querySelector('.r b').textContent = c.look;
    t.querySelector('.p b').textContent = c.ok;
    for (const k of ['fine', 'cant', 'ok']) {
      const count = groups[k].querySelector('.count');
      if (count) count.textContent = c[k] ? `(${c[k]})` : '';
    }
    const need = c.fix + c.look, sum = $('summary');
    if (results.length) {
      sum.innerHTML = `<b>${need ? `${need} of ${results.length} ${need === 1 ? 'needs' : 'need'} your attention.` : 'Nothing needs your attention.'}</b> ` +
        `${c.fine} probably fine, ${c.cant} could not be checked here, ${c.ok} consistent.`;
      sum.hidden = false;
    }
  }

  const esc = (s) => { const d = document.createElement('span'); d.textContent = String(s ?? ''); return d.innerHTML; };

  function addRow(r){
    results.push(r);
    const k = tier(r.verdict), g = groups[levelOf(r)];
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
      (r.attention && r.attention.reason ? `<div class="why">${esc(r.attention.reason)}</div>` : '') +
      (notes.length ? `<div class="n"><span class="lbl">Notes</span>${esc(notes.join(' · '))}</div>` : '') +
      `</div>`;
    g.querySelector('.rows').appendChild(row);
    renderTally();
  }

  function certify(){
    const c = tally(), n = results.length;
    let k, stamp, text;
    if (c.fix) {
      k = 'b'; stamp = 'Cannot certify';
      text = `<b>${c.fix} of ${n} entries</b> ${c.fix === 1 ? "looks like a real error" : "look like real errors"}. Fix or remove ${c.fix === 1 ? "it" : "them"} before you submit` +
             (c.look ? `, and look at the ${c.look} marked worth a look.` : '.');
    } else if (c.look || c.fine || c.cant) {
      k = 'r'; stamp = 'Certified with reservations';
      text = `Nothing looks like an error. ` +
        (c.look ? `<b>${c.look} ${c.look === 1 ? "is" : "are"} worth a look</b>, ` : '') +
        `${c.fine} ${c.fine === 1 ? "is" : "are"} probably fine, and ${c.cant} could not be checked here.`;
    } else if (readingNotes().length) {
      k = 'r'; stamp = 'Certified with reservations';
      text = `Every entry that was read matches the scholarly record, but the reader may have missed a reference. Check the places named above.`;
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
      if (parsed.reading) {
        reading = { ...parsed.reading, parsed: parsed.reading.parsed ?? entries.length, checked: entries.length };
        renderReading();
      }
      for (let i = 0; i < entries.length; i++) {
        status.textContent = `${i + 1} of ${entries.length}: asking the registry about ${entries[i].key}…`;
        bar.style.width = `${(i / entries.length) * 100}%`;
        const ar = await post('/api/audit-entry', { entry: entries[i] });
        addRow(ar.ok ? await ar.json()
                     : { key: entries[i].key, title: entries[i].title, year: entries[i].year, verdict: 'REGISTRY_UNREACHABLE', notes: [`server error ${ar.status}`] });
      }
      bar.style.width = '100%';
      const set = reading && reading.skipped ? ` ${reading.skipped} ${reading.skipped === 1 ? 'passage that is' : 'passages that are'} not a reference ${reading.skipped === 1 ? 'was' : 'were'} set aside.` : '';
      status.textContent = `${entries.length} entries checked.${set}`;
      certify();
    } catch (err) {
      status.textContent = `The registry could not be reached, so nothing can be certified. ${err}`;
      status.className = 'status err';
    } finally {
      running = false; go.disabled = false;
    }
  });
  // exposed for verification only; harmless and read-only
  window.__reportText = () => reportText();
})();
