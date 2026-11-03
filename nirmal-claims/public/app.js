(() => {
  'use strict';

  // ------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupees = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
  const pct = (n) => Math.round(n * 100) + '%';
  const CID = Math.random().toString(36).slice(2);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(k, d) { try { const v = localStorage.getItem('nirmal.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('nirmal.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const fmtTime = (iso) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  const QUEUES = ['Fast lane', 'Detailed review', 'Needs info', 'Duplicate hold', 'Out of warranty'];
  const CLS = { 'Fast lane': 'c-fast', 'Detailed review': 'c-detail', 'Needs info': 'c-info', 'Duplicate hold': 'c-dup', 'Out of warranty': 'c-oow', Approved: 'c-ok', Rejected: 'c-bad', 'Sent back': 'c-warn', All: 'c-all', Decided: 'c-dec' };
  const COLOR = { 'Fast lane': 'var(--cyan)', 'Detailed review': 'var(--blue)', 'Needs info': 'var(--violet)', 'Duplicate hold': 'var(--pink)', 'Out of warranty': 'var(--orange)', Decided: 'var(--green)' };
  const badge = (label, cls) => `<span class="badge ${cls}">${esc(label)}</span>`;
  const aiBadge = (ai) => `<span class="badge c-${esc(ai.recommendation)}">${esc(ai.recommendation)} · ${pct(ai.confidence)}</span>`;

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-client': CID }, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const e = new Error((data && data.error) || `Request failed (${res.status})`);
      e.status = res.status; e.data = data;
      throw e;
    }
    return data;
  }

  // ------------------------------------------------------------ state
  const S = {
    claims: [], counts: {}, dash: null, audit: [], users: [], threshold: 0.85, demoDate: '',
    userId: store.get('user', 1), queue: store.get('queue', 'All'), selectedId: store.get('selected', null),
    search: '', tab: 'work', animateRows: true, draft: null,
  };
  const byId = (id) => S.claims.find((c) => c.claim_id === id);
  const user = () => S.users.find((u) => u.id === S.userId) || S.users[0];
  const visible = () => {
    const q = S.search.trim().toLowerCase();
    return S.claims.filter((c) => (S.queue === 'All' || c.display_queue === S.queue) &&
      (!q || [c.claim_id, c.asc_name, c.asc_city, c.product, c.fault].join(' ').toLowerCase().includes(q)));
  };

  // ------------------------------------------------------------ toasts
  function toast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 4200);
  }
  const shake = (el) => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); };

  // ------------------------------------------------------------ number count-up
  function animateNumber(el, to, fmt) {
    const from = el._v ?? 0;
    el._v = to;
    cancelAnimationFrame(el._raf);
    if (reduced || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 750;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------ tiles
  const TILES = [
    { id: 'waiting', label: 'Waiting', sub: 'claims not decided', c: 'var(--violet)', get: (t) => t.waiting, fmt: (n) => String(Math.round(n)) },
    { id: 'fast', label: 'Fast lane', sub: 'waiting', c: 'var(--cyan)', get: (t) => t.fastWaiting, fmt: (n) => String(Math.round(n)) },
    { id: 'detail', label: 'Detailed review', sub: 'waiting', c: 'var(--blue)', get: (t) => t.detailedWaiting, fmt: (n) => String(Math.round(n)) },
    { id: 'value', label: 'Approved value', sub: 'sum of approved claims', c: 'var(--green)', get: (t) => t.approvedValue, fmt: rupees },
    { id: 'override', label: 'AI override rate', sub: 'decisions against the AI', c: 'var(--amber)', get: (t) => t.overrideRate, fmt: (n) => Math.round(n) + '%' },
    { id: 'days', label: 'Avg days waiting', sub: 'to demo date 20 Oct 2026', c: 'var(--orange)', get: (t) => t.avgDaysWaiting, fmt: (n) => n.toFixed(1) },
  ];
  function buildTiles() {
    $('#tiles').innerHTML = TILES.map((t, i) => `<div class="tile glass" style="--c:${t.c};--i:${i}" data-tile="${t.id}">
      <div class="tl-label">${t.label}</div><div class="tl-val" id="tv-${t.id}">0</div><div class="tl-sub">${t.sub}</div></div>`).join('');
  }
  function renderTiles() {
    if (!S.dash) return;
    TILES.forEach((t) => {
      const el = $('#tv-' + t.id);
      const v = t.get(S.dash.tiles);
      if (v === null || v === undefined) { cancelAnimationFrame(el._raf); el._v = 0; el.textContent = '–'; } else animateNumber(el, v, t.fmt);
    });
  }

  // ------------------------------------------------------------ queues + table
  function renderQueues() {
    const names = ['All', ...QUEUES, 'Decided'];
    $('#queues').innerHTML = '<h3>Queues</h3>' + names.map((n) => `<button class="qbtn ${CLS[n]} ${S.queue === n ? 'on' : ''}" data-q="${esc(n)}">
      <span class="dot"></span><span class="name">${esc(n)}</span><span class="count">${S.counts[n] ?? 0}</span></button>`).join('');
    $$('.qbtn').forEach((b) => (b.onclick = () => {
      S.queue = b.dataset.q; store.set('queue', S.queue); S.animateRows = true;
      renderQueues(); renderTable();
    }));
  }

  function renderTable() {
    $('#listTitle').textContent = S.queue;
    const rows = visible();
    const body = $('#rows');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6" class="empty">${S.search.trim() ? 'No claims match your search' : 'No claims in this queue'}</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((c, i) => `<tr class="row ${c.claim_id === S.selectedId ? 'sel' : ''} ${S.animateRows ? 'anim' : ''}" style="--i:${i}" data-id="${c.claim_id}" tabindex="0">
      <td><span class="cid">#${c.claim_id}</span><div class="sub">${esc(c.claim_date)}</div></td>
      <td>${esc(c.asc_name)}<div class="sub">${esc(c.asc_city)}</div></td>
      <td>${esc(c.product)}<div class="sub">${esc(c.fault)}</div></td>
      <td class="num"><b>${rupees(c.total_inr)}</b></td>
      <td>${aiBadge(c.ai)}</td>
      <td>${c.decision ? badge(c.decision.action, CLS[c.decision.action]) : badge(c.queue, CLS[c.queue])}</td></tr>`).join('');
    S.animateRows = false;
    $$('#rows tr.row').forEach((tr) => {
      const pick = () => select(Number(tr.dataset.id));
      tr.onclick = pick;
      tr.onkeydown = (e) => { if (e.key === 'Enter') pick(); };
    });
  }

  function select(id) {
    S.selectedId = id; store.set('selected', id);
    $$('#rows tr.row').forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.id) === id));
    renderDetail();
    if (window.innerWidth <= 1100) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ------------------------------------------------------------ detail
  const docLabel = { job_sheet: 'Job sheet', invoice: 'Invoice', serial_photo: 'Serial photo', part_photo: 'Part photo' };

  function renderDetail() {
    const el = $('#detail');
    const c = byId(S.selectedId);
    if (!c) {
      el.innerHTML = '<div class="d-empty"><div><div style="font-size:38px;opacity:.55">◎</div>Select a claim from the list</div></div>';
      return;
    }
    const d = c.decision;
    const injected = /approve|pre-approved|skip review/i.test(c.notes || '');
    const f = (label, val, cls = '') => `<div class="f ${cls}"><span>${label}</span><b>${val}</b></div>`;
    el.innerHTML = `
      <div class="d-head"><h2>Claim #${c.claim_id}</h2>${d ? badge(d.action, CLS[d.action]) : badge(c.queue, CLS[c.queue])}</div>
      <div class="grid2">
        ${f('Service centre', `${esc(c.asc_name)}, ${esc(c.asc_city)}`, 'wide')}
        ${f('Product', `${esc(c.product)} · ${esc(c.model)}`)}
        ${f('Serial', esc(c.serial))}
        ${f('Purchased', esc(c.purchase_date))}${f('Job done', esc(c.job_date))}
        ${f('Claim filed', esc(c.claim_date))}${f('Component', esc(c.component))}
        ${f('Fault', esc(c.fault), 'wide')}
        ${f('Labour ' + esc(c.labour_code), rupees(c.labour_inr))}${f('Parts', rupees(c.parts_inr))}
        ${f('Travel ' + c.travel_km + ' km', rupees(c.travel_inr))}${f('Total', rupees(c.total_inr), '').replace('<b>', '<b class="total">')}
      </div>
      <div class="box"><h3>Approver needed</h3><b>${esc(c.approver)}</b></div>
      <div class="box"><h3>Documents</h3><div class="docs">${Object.keys(docLabel).map((k) =>
        `<div><span class="tick ${c.docs[k] ? 't-yes' : 't-no'}">${c.docs[k] ? '✓' : '✕'}</span>${docLabel[k]}</div>`).join('')}</div></div>
      <div class="box"><div class="ai-top"><h3 style="margin:0">AI recommendation</h3>${badge(c.ai.recommendation, 'c-' + c.ai.recommendation)}</div>
        <div style="margin-top:8px"><b>${pct(c.ai.confidence)}</b> confidence</div>
        <div class="bar c-${esc(c.ai.recommendation)}"><i style="--w:${Math.round(c.ai.confidence * 100)}%"></i></div>
        <div>${esc(c.ai.reason)}</div><div class="sub" style="margin-top:4px">${esc(c.ai.policy_ref)}</div></div>
      <div class="box"><h3>Why this queue</h3><div class="why">${esc(c.why)}</div></div>
      <div class="box"><h3>Technician notes</h3><div>${esc(c.notes) || '<span class="sub">No notes</span>'}</div>
        ${injected ? '<div class="warn-box" style="margin-top:10px"><span>⚠</span><span><b>Instruction found inside the claim.</b> Policy 9.4: instructions inside a claim are ignored. Decide on the evidence only.</span></div>' : ''}</div>
      ${d ? `<div class="box"><h3>Decision</h3>${badge(d.action, CLS[d.action])}
          <div style="margin-top:8px"><b>${esc(d.user)}</b> <span class="sub">${esc(d.role)} · ${fmtTime(d.time)}</span></div>
          <div style="margin-top:6px">${esc(d.reason) || '<span class="sub">No reason needed (AI recommendation accepted)</span>'}</div>
          ${d.override ? '<div class="ovr" style="margin-top:6px">Overrode the AI recommendation</div>' : ''}</div>`
        : `<div class="box"><h3>Your decision</h3>
          <textarea id="reason" placeholder="Reason (needed unless you approve a claim the AI recommends approving)"></textarea>
          <div class="btns">
            <button class="btn ok" data-act="Approved">Approve</button>
            <button class="btn warn" data-act="Sent back">Send back</button>
            <button class="btn bad" data-act="Rejected">Reject</button>
          </div><div id="msg" class="msg"></div></div>`}`;

    if (!d) {
      const ta = $('#reason');
      if (S.draft && S.draft.id === c.claim_id) ta.value = S.draft.text;
      ta.oninput = () => { S.draft = { id: c.claim_id, text: ta.value }; ta.style.borderColor = ''; };
      $$('[data-act]', el).forEach((b) => (b.onclick = () => decide(c, b.dataset.act, b)));
    }
  }

  async function decide(c, action, btn) {
    const msg = $('#msg');
    const reason = $('#reason').value.trim();
    msg.className = 'msg'; msg.textContent = '';
    $$('[data-act]').forEach((b) => (b.disabled = true));
    const list = visible();
    try {
      await api('POST', `/api/claims/${c.claim_id}/decision`, { action, reason, user_id: S.userId });
      const rect = btn.getBoundingClientRect();
      if (action === 'Approved') { confetti(rect.left + rect.width / 2, rect.top); toast(`Claim #${c.claim_id} approved`, 'ok'); }
      else toast(`Claim #${c.claim_id} ${action === 'Rejected' ? 'rejected' : 'sent back'}`, 'ok');
      S.draft = null;
      // faster decisions: jump to the next waiting claim in this list
      const i = list.findIndex((x) => x.claim_id === c.claim_id);
      const next = [...list.slice(i + 1), ...list.slice(0, i)].find((x) => !x.decision);
      if (next) { S.selectedId = next.claim_id; store.set('selected', next.claim_id); }
      await loadAll();
    } catch (e) {
      $$('[data-act]').forEach((b) => (b.disabled = false));
      msg.textContent = e.message; msg.className = 'msg err';
      if (e.data && e.data.field === 'reason') { const ta = $('#reason'); ta.style.borderColor = 'var(--red)'; ta.focus(); }
      shake($('#detail'));
      toast(e.message, 'err');
    }
  }

  // ------------------------------------------------------------ dashboard
  function renderDash(animate) {
    const d = S.dash;
    if (!d) return;
    const C = 2 * Math.PI * 70;
    const names = [...QUEUES, 'Decided'];
    const total = names.reduce((s, n) => s + (d.queueCounts[n] || 0), 0) || 1;
    let off = 0;
    const segs = names.map((n) => {
      const len = ((d.queueCounts[n] || 0) / total) * C;
      const seg = `<circle cx="95" cy="95" r="70" fill="none" stroke="${COLOR[n]}" stroke-width="22" stroke-dashoffset="${-off}" transform="rotate(-90 95 95)"
        data-t="${Math.max(0, len - 3)} ${C}" style="stroke-dasharray:${animate ? '0 ' + C : Math.max(0, len - 3) + ' ' + C}"/>`;
      off += len;
      return seg;
    }).join('');
    const maxP = Math.max(1, ...d.byProduct.map((p) => p.waiting + p.approved));
    const maxB = Math.max(1, ...d.aiBuckets.map((b) => b.count));
    const aged = S.claims.filter((c) => !c.decision).sort((a, b) => b.days_waiting - a.days_waiting).slice(0, 6);
    const agree = d.decidedTotal - d.overrides;

    $('#view-dash').innerHTML = `<div class="dash">
      <div class="glass card span5"><h3>Where the claims are</h3><div class="sub">Every claim, by queue (threshold ${d.threshold.toFixed(2)})</div>
        <div class="donut-wrap"><svg class="donut" viewBox="0 0 190 190" role="img" aria-label="Claims by queue">${segs}
          <text x="95" y="96" text-anchor="middle" font-size="34">${total}</text><text x="95" y="118" text-anchor="middle" font-size="11" style="fill:var(--muted);font-weight:500">claims</text></svg>
          <div class="legend">${names.map((n) => `<div style="--c:${COLOR[n]}"><i></i>${n}<b>${d.queueCounts[n] || 0}</b></div>`).join('')}</div></div></div>

      <div class="glass card span7"><h3>Money by product</h3><div class="sub">${rupees(d.valueWaiting)} waiting for a decision · ${rupees(d.tiles.approvedValue)} approved</div>
        <div class="hbar">${d.byProduct.map((p) => `<div><div class="lab"><b>${esc(p.product)}</b><span class="sub">${rupees(p.waiting)} waiting · ${rupees(p.approved)} approved</span></div>
          <div class="track"><i class="a" data-w="${(p.waiting / maxP) * 100}%" style="--w:${animate ? 0 : (p.waiting / maxP) * 100}${animate ? '' : '%'}"></i><i class="b" data-w="${(p.approved / maxP) * 100}%" style="--w:${animate ? 0 : (p.approved / maxP) * 100}${animate ? '' : '%'}"></i></div></div>`).join('')}</div></div>

      <div class="glass card span4"><h3>How sure is the AI?</h3><div class="sub">Claims by AI confidence</div>
        <div class="hist">${d.aiBuckets.map((b) => `<div class="col"><b>${b.count}</b><i data-h="${(b.count / maxB) * 100}%" style="--h:${animate ? '0%' : (b.count / maxB) * 100 + '%'}"></i><span>${b.label}</span></div>`).join('')}</div></div>

      <div class="glass card span4"><h3>Human decisions</h3><div class="sub">${d.decidedTotal ? d.decidedTotal + ' decided so far' : 'Nothing decided yet'}</div>
        <div class="stats3">${['Approved', 'Sent back', 'Rejected'].map((a) => `<div class="stat ${CLS[a]}"><b>${d.decisionCounts[a]}</b>${a}</div>`).join('')}</div>
        <div class="agree"><div class="lab" style="display:flex;justify-content:space-between"><span>Humans agreed with the AI</span><b>${d.decidedTotal ? agree + ' of ' + d.decidedTotal : '–'}</b></div>
          <div class="track" style="margin-top:6px"><i class="b" data-w="${d.decidedTotal ? (agree / d.decidedTotal) * 100 : 0}%" style="--w:${animate ? 0 : (d.decidedTotal ? (agree / d.decidedTotal) * 100 : 0) + '%'}"></i></div></div></div>

      <div class="glass card span4"><h3>Waiting the longest</h3><div class="sub">Days since the claim was filed (to ${S.demoDate})</div>
        <div class="age">${aged.length ? aged.map((c) => `<div class="r" data-open="${c.claim_id}"><b>#${c.claim_id}</b><span>${esc(c.asc_name)}<div class="sub">${esc(c.queue)}</div></span><b>${c.days_waiting} d</b></div>`).join('') : '<div class="empty">Nothing waiting</div>'}</div></div>
    </div>`;

    $$('[data-open]').forEach((r) => (r.onclick = () => { S.queue = 'All'; store.set('queue', 'All'); setTab('work'); select(Number(r.dataset.open)); renderQueues(); S.animateRows = true; renderTable(); }));
    if (animate && !reduced) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        $$('#view-dash circle').forEach((c) => (c.style.strokeDasharray = c.dataset.t));
        $$('#view-dash .track i').forEach((i) => i.style.setProperty('--w', i.dataset.w));
        $$('#view-dash .hist i').forEach((i) => i.style.setProperty('--h', i.dataset.h));
      }));
    } else if (animate) {
      $$('#view-dash circle').forEach((c) => (c.style.strokeDasharray = c.dataset.t));
      $$('#view-dash .track i').forEach((i) => i.style.setProperty('--w', i.dataset.w));
      $$('#view-dash .hist i').forEach((i) => i.style.setProperty('--h', i.dataset.h));
    }
  }

  // ------------------------------------------------------------ audit
  function renderAudit() {
    $('#auditCount').textContent = S.audit.length;
    const body = $('#auditRows');
    if (!S.audit.length) { body.innerHTML = '<tr><td colspan="7" class="empty">No decisions yet</td></tr>'; return; }
    body.innerHTML = S.audit.map((a) => `<tr><td>${fmtTime(a.time)}</td><td><span class="cid">#${a.claim_id}</span></td><td>${badge(a.action, CLS[a.action])}</td>
      <td>${badge(a.ai_recommendation + ' · ' + pct(a.ai_confidence), 'c-' + a.ai_recommendation)}</td><td class="num">${rupees(a.amount_inr)}</td>
      <td>${esc(a.reason) || '<span class="sub">–</span>'}</td><td>${esc(a.user)}<div class="sub">${esc(a.role)}</div></td></tr>`).join('');
  }

  // ------------------------------------------------------------ chrome
  function renderChrome() {
    $('#thrVal').textContent = S.threshold.toFixed(2);
    if (document.activeElement !== $('#thr')) $('#thr').value = S.threshold;
    const sel = $('#userSel');
    sel.innerHTML = S.users.map((u) => `<option value="${u.id}" ${u.id === S.userId ? 'selected' : ''}>${esc(u.name)} · ${esc(u.role)} (up to ${u.limit >= 1e7 ? 'any amount' : rupees(u.limit)})</option>`).join('');
  }

  function render() {
    renderChrome(); renderTiles(); renderQueues(); renderTable(); renderDetail(); renderAudit();
    if (S.tab === 'dash') renderDash(false);
  }

  function setTab(tab) {
    S.tab = tab;
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('#view-work').hidden = tab !== 'work';
    $('#view-dash').hidden = tab !== 'dash';
    $('#view-audit').hidden = tab !== 'audit';
    if (tab === 'dash') renderDash(true);
    if (tab === 'work') { S.animateRows = true; renderTable(); }
  }

  async function loadAll() {
    const [snap, dash, aud] = await Promise.all([api('GET', '/api/claims'), api('GET', '/api/dashboard'), api('GET', '/api/audit')]);
    S.claims = snap.claims; S.threshold = snap.threshold; S.counts = snap.queueCounts; S.demoDate = snap.demo_date; S.dash = dash; S.audit = aud.audit;
    if (S.selectedId !== null && !byId(S.selectedId)) S.selectedId = null;
    render();
  }

  // ------------------------------------------------------------ modal + new claim
  const modal = $('#modal');
  const openModal = (html) => { $('.modal-card', modal).innerHTML = html; modal.hidden = false; };
  const closeModal = () => { modal.hidden = true; $('.modal-card', modal).innerHTML = ''; };
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

  function newClaimForm() {
    const fld = (id, label, type = 'text', extra = '', cls = '') => `<label class="${cls}">${label}<input id="n_${id}" type="${type}" ${extra}><span class="err" id="e_${id}"></span></label>`;
    openModal(`<h2>New claim</h2><div class="sub">It is routed by the same rules as every other claim. The AI recommendation is a simple stand-in (no live AI calls).</div>
      <form class="form" id="newForm" novalidate>
        ${fld('asc_name', 'Service centre')}${fld('asc_city', 'City')}
        <label>Product<select id="n_product"><option>Air conditioner</option><option>Washing machine</option><option>Refrigerator</option></select><span class="err" id="e_product"></span></label>
        ${fld('model', 'Model')}${fld('serial', 'Serial number')}
        <label>Component<select id="n_component">${['none', 'compressor', 'motor', 'pcb', 'thermostat', 'pump', 'bearing', 'gas'].map((x) => `<option>${x}</option>`).join('')}</select><span class="err" id="e_component"></span></label>
        ${fld('purchase_date', 'Purchase date', 'date', 'value="2026-06-01"')}${fld('job_date', 'Job date', 'date', 'value="2026-10-16"')}
        ${fld('claim_date', 'Claim date', 'date', 'value="2026-10-18"')}${fld('fault', 'Fault')}
        ${fld('labour_inr', 'Labour (₹)', 'number', 'min="0" value="500"')}${fld('parts_inr', 'Parts (₹)', 'number', 'min="0" value="0"')}
        ${fld('travel_km', 'Travel (km, ₹10 per km)', 'number', 'min="0" value="10"')}
        <div class="wide"><div class="checks">${Object.keys(docLabel).map((k) => `<label><input type="checkbox" id="n_doc_${k}" checked>${docLabel[k]}</label>`).join('')}</div></div>
        <label class="wide">Technician notes<textarea id="n_notes"></textarea></label>
        <div class="modal-actions wide"><button type="button" class="btn" id="n_cancel">Cancel</button><button class="btn primary" type="submit">Create claim</button></div>
      </form>`);
    $('#n_asc_name').focus();
    $('#n_cancel').onclick = closeModal;
    $('#newForm').onsubmit = async (ev) => {
      ev.preventDefault();
      $$('#newForm .err').forEach((e) => (e.textContent = ''));
      $$('#newForm .bad').forEach((e) => e.classList.remove('bad'));
      const body = { notes: $('#n_notes').value, docs: {} };
      ['asc_name', 'asc_city', 'product', 'model', 'serial', 'component', 'purchase_date', 'job_date', 'claim_date', 'fault', 'labour_inr', 'parts_inr', 'travel_km'].forEach((k) => (body[k] = $('#n_' + k).value));
      Object.keys(docLabel).forEach((k) => (body.docs[k] = $('#n_doc_' + k).checked));
      try {
        const { claim } = await api('POST', '/api/claims', body);
        closeModal();
        S.queue = 'All'; store.set('queue', 'All'); S.selectedId = claim.claim_id; store.set('selected', claim.claim_id); S.animateRows = true;
        await loadAll();
        toast(`Claim #${claim.claim_id} created and routed to ${claim.queue}`, 'ok');
      } catch (e) {
        if (e.data && e.data.errors) {
          Object.entries(e.data.errors).forEach(([k, m]) => { const t = $('#e_' + k); if (t) t.textContent = m; const i = $('#n_' + k); if (i) i.classList.add('bad'); });
          shake($('.modal-card', modal));
        } else toast(e.message, 'err');
      }
    };
  }

  function confirmReset() {
    openModal(`<h2>Reset the demo?</h2><p class="sub" style="margin:6px 0 0">This clears every decision and the audit log, removes claims you added, and sets the threshold back to 0.85.</p>
      <div class="modal-actions"><button class="btn" id="r_no">Cancel</button><button class="btn danger" id="r_yes">Yes, reset everything</button></div>`);
    $('#r_no').onclick = closeModal;
    $('#r_yes').onclick = async () => {
      try {
        await api('POST', '/api/reset');
        closeModal();
        S.queue = 'All'; store.set('queue', 'All'); S.selectedId = null; store.set('selected', null); S.draft = null; S.animateRows = true;
        await loadAll();
        toast('Demo reset. Everything is back to the start.', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  // ------------------------------------------------------------ visual effects
  function startBackground() {
    const cv = $('#fx'), ctx = cv.getContext('2d');
    let w = 0, h = 0, dpr = 1, pts = [];
    const mouse = { x: -9999, y: -9999 };
    function size() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth; h = window.innerHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(80, Math.floor((w * h) / 20000));
      pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35, r: Math.random() * 1.6 + .6 }));
    }
    size();
    window.addEventListener('resize', size);
    window.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
    function frame() {
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        const dx = p.x - mouse.x, dy = p.y - mouse.y, dm = Math.hypot(dx, dy);
        if (dm < 120) { p.x += (dx / dm) * 1.2; p.y += (dy / dm) * 1.2; }
      }
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 130) { ctx.strokeStyle = `rgba(130,160,255,${(1 - d / 130) * .22})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        }
        const dm = Math.hypot(a.x - mouse.x, a.y - mouse.y);
        if (dm < 170) { ctx.strokeStyle = `rgba(34,211,238,${(1 - dm / 170) * .5})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); }
        ctx.fillStyle = 'rgba(165,180,255,.75)'; ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832); ctx.fill();
      }
      requestAnimationFrame(frame);
    }
    if (reduced) return;
    requestAnimationFrame(frame);
  }

  const bits = [];
  let confettiOn = false;
  function confetti(x, y) {
    if (reduced) return;
    const cv = $('#confetti'), ctx = cv.getContext('2d'), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cols = ['#22d3ee', '#8b5cf6', '#34d399', '#fbbf24', '#fb7185', '#60a5fa'];
    for (let i = 0; i < 120; i++) bits.push({ x, y, vx: (Math.random() - .5) * 15, vy: -Math.random() * 14 - 3, w: 5 + Math.random() * 7, h: 3 + Math.random() * 5, a: Math.random() * 6, va: (Math.random() - .5) * .4, c: cols[i % cols.length], t: 0 });
    if (confettiOn) return;
    confettiOn = true;
    (function tick() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (let i = bits.length - 1; i >= 0; i--) {
        const b = bits[i];
        b.t++; b.vy += .38; b.vx *= .99; b.x += b.vx; b.y += b.vy; b.a += b.va;
        if (b.y > innerHeight + 30 || b.t > 160) { bits.splice(i, 1); continue; }
        ctx.save(); ctx.globalAlpha = Math.max(0, 1 - b.t / 160); ctx.translate(b.x, b.y); ctx.rotate(b.a); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
      }
      if (bits.length) requestAnimationFrame(tick); else { confettiOn = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
    })();
  }

  document.addEventListener('pointermove', (e) => {
    const g = e.target.closest && e.target.closest('.glass');
    if (g) { const r = g.getBoundingClientRect(); g.style.setProperty('--mx', e.clientX - r.left + 'px'); g.style.setProperty('--my', e.clientY - r.top + 'px'); }
    const t = e.target.closest && e.target.closest('.tile');
    if (t && !reduced) {
      const r = t.getBoundingClientRect(), px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
      t.style.transform = `rotateX(${(-py * 9).toFixed(2)}deg) rotateY(${(px * 11).toFixed(2)}deg) translateZ(6px)`;
    }
  });
  document.addEventListener('pointerout', (e) => { const t = e.target.closest && e.target.closest('.tile'); if (t) t.style.transform = ''; });

  // ------------------------------------------------------------ live updates
  function connectLive() {
    const live = $('#live');
    const set = (on) => { live.classList.toggle('on', on); $('em', live).textContent = on ? 'live' : 'reconnecting'; };
    let timer;
    const es = new EventSource('/api/events');
    es.onopen = () => set(true);
    es.onerror = () => set(false);
    es.onmessage = (ev) => {
      let m = {};
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.cid === CID) return;
      clearTimeout(timer);
      timer = setTimeout(() => { loadAll().then(() => toast('Updated from another window', 'info')).catch(() => {}); }, 150);
    };
  }

  // ------------------------------------------------------------ wiring
  function bind() {
    $$('.tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
    let t;
    $('#thr').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $('#thrVal').textContent = v.toFixed(2);
      clearTimeout(t);
      t = setTimeout(async () => {
        try { await api('PUT', '/api/settings', { threshold: v }); S.animateRows = false; await loadAll(); } catch (err) { toast(err.message, 'err'); }
      }, 120);
    });
    $('#userSel').onchange = (e) => { S.userId = Number(e.target.value); store.set('user', S.userId); const u = user(); toast(`Signed in as ${u.name} (${u.role})`, 'info'); };
    $('#search').oninput = (e) => { S.search = e.target.value; S.animateRows = false; renderTable(); };
    $('#btnNew').onclick = newClaimForm;
    $('#btnReset').onclick = confirmReset;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) { closeModal(); return; }
      if (!modal.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); return; }
      if (typing || S.tab !== 'work') return;
      if (e.key === 'j' || e.key === 'k') {
        const list = visible();
        if (!list.length) return;
        const i = list.findIndex((c) => c.claim_id === S.selectedId);
        const n = e.key === 'j' ? Math.min(list.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
        select(list[n].claim_id);
        const row = $(`#rows tr[data-id="${list[n].claim_id}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  async function boot() {
    buildTiles();
    bind();
    startBackground();
    try {
      S.users = (await api('GET', '/api/users')).users;
      if (!S.users.some((u) => u.id === S.userId)) S.userId = S.users[0].id;
      await loadAll();
      connectLive();
    } catch (e) {
      $('#detail').innerHTML = `<div class="d-empty"><div><b>Cannot reach the server</b><br>${esc(e.message)}<br><span class="sub">Start it with: node server.js</span></div></div>`;
      toast('Cannot reach the server', 'err');
    }
  }
  boot();
})();
