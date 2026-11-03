'use strict';
// Runs all 8 checks from the build guide (plus extras) against a real server with a throwaway database.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3917;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `nirmal-test-${process.pid}.db`);
let pass = 0;
let fail = 0;

const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};
const call = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};
const snap = async () => (await call('GET', '/api/claims')).data;
const counts = async () => (await snap()).queueCounts;
const queueOf = async (id) => (await snap()).claims.find((c) => c.claim_id === id).queue;
const setT = (t) => call('PUT', '/api/settings', { threshold: t });

async function main() {
  const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), DB_FILE: DB }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log('\nCheck 1 - routing');
    const want = { 5004: 'Out of warranty', 5011: 'Duplicate hold', 5006: 'Needs info', 5001: 'Fast lane', 5005: 'Detailed review', 5014: 'Detailed review' };
    for (const [id, q] of Object.entries(want)) ok(`${id} -> ${q}`, (await queueOf(Number(id))) === q);
    const why14 = (await snap()).claims.find((c) => c.claim_id === 5014).why;
    ok('5014 reason mentions 24 days vs limit 15', /24 days.*limit 15/.test(why14), why14);

    console.log('\nCheck 2 - queue counts at 0.85');
    const c = await counts();
    ok('Fast 7 / Detailed 6 / Needs info 3 / Duplicate 2 / OOW 2 / Decided 0 / All 20',
      c['Fast lane'] === 7 && c['Detailed review'] === 6 && c['Needs info'] === 3 && c['Duplicate hold'] === 2 && c['Out of warranty'] === 2 && c.Decided === 0 && c.All === 20, JSON.stringify(c));

    console.log('\nCheck 3 - detail');
    const s = await snap();
    const d1 = s.claims.find((x) => x.claim_id === 5001);
    ok('5001: APPROVE 95% Policy 2.1, 5.1', d1.ai.recommendation === 'APPROVE' && d1.ai.confidence === 0.95 && d1.ai.policy_ref === 'Policy 2.1, 5.1');
    const d17 = s.claims.find((x) => x.claim_id === 5017);
    ok('5017: Head of Customer Service + injection note present', d17.approver === 'Head of Customer Service' && /pre-approved|skip review/i.test(d17.notes));

    console.log('\nCheck 4 - decisions, reason rule, persistence');
    let r = await call('POST', '/api/claims/5012/decision', { action: 'Approved', reason: '', user_id: 1 });
    ok('Approve 5012 with no reason is allowed', r.status === 201, JSON.stringify(r.data));
    const c4 = await counts();
    ok('Fast lane 6, Decided 1', c4['Fast lane'] === 6 && c4.Decided === 1, JSON.stringify(c4));
    r = await call('POST', '/api/claims/5001/decision', { action: 'Rejected', reason: '', user_id: 1 });
    ok('Reject 5001 with no reason is refused (422)', r.status === 422 && /reason/i.test(r.data.error), JSON.stringify(r.data));
    r = await call('POST', '/api/claims/5012/decision', { action: 'Rejected', reason: 'again', user_id: 1 });
    ok('Deciding twice is refused (409)', r.status === 409);
    r = await call('POST', '/api/claims/5017/decision', { action: 'Approved', reason: 'Checked', user_id: 1 });
    ok('Warranty executive cannot approve 27,500 (403)', r.status === 403 && /Head of Customer Service/.test(r.data.error), JSON.stringify(r.data));

    console.log('\nCheck 5 - threshold');
    await call('POST', '/api/reset');
    await setT(0.9); let t = await counts();
    ok('0.90 -> Fast 4, Detailed 9', t['Fast lane'] === 4 && t['Detailed review'] === 9, JSON.stringify(t));
    await setT(0.8); t = await counts();
    ok('0.80 -> Fast 8, Detailed 5', t['Fast lane'] === 8 && t['Detailed review'] === 5, JSON.stringify(t));
    await setT(0.85); t = await counts();
    ok('0.85 -> Fast 7, Detailed 6', t['Fast lane'] === 7 && t['Detailed review'] === 6, JSON.stringify(t));
    r = await setT(0.5);
    ok('Threshold outside 0.70-0.95 is rejected', r.status === 422);

    console.log('\nCheck 7 - dashboard tiles (clean start)');
    await call('POST', '/api/reset');
    await call('POST', '/api/claims/5002/decision', { action: 'Approved', reason: '', user_id: 1 });
    r = await call('POST', '/api/claims/5003/decision', { action: 'Rejected', reason: 'Serial looks altered', user_id: 1 });
    ok('Reject with reason accepted, flagged as override', r.status === 201 && r.data.decision.override === true);
    const dash = (await call('GET', '/api/dashboard')).data;
    ok('Waiting 18', dash.tiles.waiting === 18, String(dash.tiles.waiting));
    ok('Approved value 1,100', dash.tiles.approvedValue === 1100, String(dash.tiles.approvedValue));
    ok('AI override rate 50%', dash.tiles.overrideRate === 50, String(dash.tiles.overrideRate));
    ok('Avg days waiting is a number', typeof dash.tiles.avgDaysWaiting === 'number');

    console.log('\nCheck 6 - audit log and CSV');
    const audit = (await call('GET', '/api/audit')).data.audit;
    ok('Two audit rows, newest first', audit.length === 2 && audit[0].claim_id === 5003, JSON.stringify(audit.map((a) => a.claim_id)));
    const csvRes = await fetch(BASE + '/api/audit.csv');
    const csv = (await csvRes.text()).trim().split(/\r\n/);
    ok('CSV has header + 2 rows, all values quoted', csv.length === 3 && csv.every((l) => /^"/.test(l) && /"$/.test(l)), csv.join(' | '));
    ok('CSV is served as an attachment', /attachment/.test(csvRes.headers.get('content-disposition') || ''));

    console.log('\nCheck 8 - reset demo');
    await call('POST', '/api/reset');
    const after = await counts();
    ok('Back to the start: Decided 0, Fast 7', after.Decided === 0 && after['Fast lane'] === 7);
    ok('Audit log empty', (await call('GET', '/api/audit')).data.audit.length === 0);

    console.log('\nExtras - new claim, duplicate detection, validation');
    r = await call('POST', '/api/claims', { asc_name: 'Test Centre', asc_city: 'Puri', product: 'Refrigerator', model: 'NX-RF260', serial: 'T-1', purchase_date: '2026-05-01',
      job_date: '2026-10-15', claim_date: '2026-10-16', fault: 'No cooling', component: 'thermostat', labour_inr: 500, parts_inr: 1000, travel_km: 10, docs: { job_sheet: true, invoice: true, serial_photo: true, part_photo: true } });
    ok('New claim created (id 5021) and routed to Fast lane', r.status === 201 && r.data.claim.claim_id === 5021 && r.data.claim.queue === 'Fast lane', JSON.stringify(r.data).slice(0, 200));
    r = await call('POST', '/api/claims', { asc_name: 'Test Centre', asc_city: 'Puri', product: 'Refrigerator', model: 'NX-RF260', serial: 'T-1', purchase_date: '2026-05-01',
      job_date: '2026-10-15', claim_date: '2026-10-17', fault: 'No cooling', component: 'thermostat', labour_inr: 500, parts_inr: 1000, travel_km: 10, docs: { job_sheet: true, invoice: true, serial_photo: true, part_photo: true } });
    ok('Same serial + job date is held as duplicate of 5021', r.data.claim.queue === 'Duplicate hold' && r.data.claim.duplicate_of === 5021);
    r = await call('POST', '/api/claims', { asc_name: '' });
    ok('Invalid new claim is refused with field errors (422)', r.status === 422 && r.data.errors && r.data.errors.asc_name);
    await call('POST', '/api/reset');
    ok('Reset removes user-added claims', (await counts()).All === 20);
    const page = await fetch(BASE + '/');
    ok('Frontend is served at /', page.status === 200 && /Nirmal/.test(await page.text()));
    r = await call('GET', '/api/nope');
    ok('Unknown API route returns 404 JSON', r.status === 404 && r.data.error);
  } finally {
    srv.kill();
    for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
