'use strict';
// Nirmal Claims - zero-dependency Node server: REST API + SQLite + live updates (SSE) + static frontend.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const R = require('./rules');
const { CLAIMS, USERS } = require('./seed');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'nirmal.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- database
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, limit_inr INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claims (
  claim_id INTEGER PRIMARY KEY, asc_name TEXT, asc_city TEXT, product TEXT, model TEXT, serial TEXT,
  purchase_date TEXT, job_date TEXT, claim_date TEXT, fault TEXT, component TEXT, labour_code TEXT,
  labour_inr INTEGER, parts_inr INTEGER, travel_km INTEGER, travel_inr INTEGER, total_inr INTEGER,
  docs TEXT, duplicate_of INTEGER, notes TEXT,
  ai_recommendation TEXT, ai_confidence REAL, ai_policy_ref TEXT, ai_reason TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  claim_id INTEGER PRIMARY KEY REFERENCES claims(claim_id), action TEXT NOT NULL, reason TEXT,
  user_name TEXT, role TEXT, time TEXT, override INTEGER
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT, claim_id INTEGER, action TEXT, ai_recommendation TEXT,
  ai_confidence REAL, amount_inr INTEGER, reason TEXT, user_name TEXT, role TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const insertClaimStmt = db.prepare(`INSERT INTO claims (claim_id, asc_name, asc_city, product, model, serial, purchase_date, job_date,
  claim_date, fault, component, labour_code, labour_inr, parts_inr, travel_km, travel_inr, total_inr, docs, duplicate_of, notes,
  ai_recommendation, ai_confidence, ai_policy_ref, ai_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

function insertClaim(c) {
  insertClaimStmt.run(c.claim_id, c.asc_name, c.asc_city, c.product, c.model, c.serial, c.purchase_date, c.job_date, c.claim_date,
    c.fault, c.component, c.labour_code, c.labour_inr, c.parts_inr, c.travel_km, c.travel_inr, c.total_inr, JSON.stringify(c.docs),
    c.duplicate_of ?? null, c.notes || '', c.ai.recommendation, c.ai.confidence, c.ai.policy_ref, c.ai.reason);
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seed() {
  tx(() => {
    db.exec('DELETE FROM audit; DELETE FROM decisions; DELETE FROM claims; DELETE FROM users; DELETE FROM settings;');
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'audit';");
    const u = db.prepare('INSERT INTO users (id, name, role, limit_inr) VALUES (?,?,?,?)');
    USERS.forEach((x) => u.run(x.id, x.name, x.role, x.limit));
    CLAIMS.forEach(insertClaim);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('threshold', '0.85');
  });
}
if (db.prepare('SELECT COUNT(*) AS n FROM claims').get().n === 0) seed();

// ---------------------------------------------------------------- data access
const hydrate = (r) => ({
  claim_id: r.claim_id, asc_name: r.asc_name, asc_city: r.asc_city, product: r.product, model: r.model, serial: r.serial,
  purchase_date: r.purchase_date, job_date: r.job_date, claim_date: r.claim_date, fault: r.fault, component: r.component,
  labour_code: r.labour_code, labour_inr: r.labour_inr, parts_inr: r.parts_inr, travel_km: r.travel_km, travel_inr: r.travel_inr,
  total_inr: r.total_inr, docs: JSON.parse(r.docs), duplicate_of: r.duplicate_of, notes: r.notes,
  ai: { recommendation: r.ai_recommendation, confidence: r.ai_confidence, policy_ref: r.ai_policy_ref, reason: r.ai_reason },
});
const getThreshold = () => Number(db.prepare("SELECT value FROM settings WHERE key = 'threshold'").get().value);
const allUsers = () => db.prepare('SELECT id, name, role, limit_inr AS "limit" FROM users ORDER BY id').all().map((u) => ({ ...u }));
const decisionMap = () => {
  const m = new Map();
  db.prepare('SELECT * FROM decisions').all().forEach((d) => {
    m.set(d.claim_id, { action: d.action, reason: d.reason, user: d.user_name, role: d.role, time: d.time, override: !!d.override });
  });
  return m;
};
const loadClaims = () => db.prepare('SELECT * FROM claims ORDER BY claim_id').all().map(hydrate);

function enrich(c, dmap, th) {
  const r = R.routeClaim(c, th);
  const d = dmap.get(c.claim_id) || null;
  return {
    ...c, queue: r.queue, why: r.why, approver: R.approverFor(c.total_inr), decision: d,
    display_queue: d ? 'Decided' : r.queue,
    days_waiting: d ? null : R.daysBetween(c.claim_date, R.DEMO_DATE),
  };
}

function snapshot() {
  const th = getThreshold();
  const dmap = decisionMap();
  const claims = loadClaims().map((c) => enrich(c, dmap, th));
  const queueCounts = { All: claims.length, Decided: 0 };
  R.QUEUES.forEach((q) => (queueCounts[q] = 0));
  claims.forEach((c) => (queueCounts[c.display_queue] += 1));
  return { threshold: th, demo_date: R.DEMO_DATE, claims, queueCounts };
}

function dashboard() {
  const { claims, queueCounts, threshold } = snapshot();
  const waiting = claims.filter((c) => !c.decision);
  const decided = claims.filter((c) => c.decision);
  const approved = decided.filter((c) => c.decision.action === 'Approved');
  const overrides = decided.filter((c) => c.decision.override).length;
  const days = waiting.map((c) => c.days_waiting);
  const products = ['Air conditioner', 'Washing machine', 'Refrigerator'];
  const buckets = [
    { label: '< 60%', min: 0, max: 0.6 }, { label: '60-70%', min: 0.6, max: 0.7 }, { label: '70-80%', min: 0.7, max: 0.8 },
    { label: '80-90%', min: 0.8, max: 0.9 }, { label: '90%+', min: 0.9, max: 1.01 },
  ];
  return {
    threshold,
    tiles: {
      waiting: waiting.length,
      fastWaiting: waiting.filter((c) => c.queue === 'Fast lane').length,
      detailedWaiting: waiting.filter((c) => c.queue === 'Detailed review').length,
      approvedValue: approved.reduce((s, c) => s + c.total_inr, 0),
      overrideRate: decided.length ? Math.round((overrides / decided.length) * 100) : null,
      avgDaysWaiting: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
    },
    queueCounts,
    valueWaiting: waiting.reduce((s, c) => s + c.total_inr, 0),
    byProduct: products.map((p) => ({
      product: p,
      waiting: waiting.filter((c) => c.product === p).reduce((s, c) => s + c.total_inr, 0),
      approved: approved.filter((c) => c.product === p).reduce((s, c) => s + c.total_inr, 0),
    })),
    decisionCounts: {
      Approved: decided.filter((c) => c.decision.action === 'Approved').length,
      'Sent back': decided.filter((c) => c.decision.action === 'Sent back').length,
      Rejected: decided.filter((c) => c.decision.action === 'Rejected').length,
    },
    decidedTotal: decided.length,
    overrides,
    aiBuckets: buckets.map((b) => ({ label: b.label, count: claims.filter((c) => c.ai.confidence >= b.min && c.ai.confidence < b.max).length })),
  };
}

const auditRows = () => db.prepare('SELECT * FROM audit ORDER BY id DESC').all().map((a) => ({
  id: a.id, time: a.time, claim_id: a.claim_id, action: a.action, ai_recommendation: a.ai_recommendation,
  ai_confidence: a.ai_confidence, amount_inr: a.amount_inr, reason: a.reason, user: a.user_name, role: a.role,
}));

function auditCsv() {
  const cols = ['time', 'claim_id', 'action', 'ai_recommendation', 'ai_confidence', 'amount_inr', 'reason', 'user', 'role'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = auditRows().reverse(); // oldest first in the export
  return [cols.map(q).join(',')].concat(rows.map((r) => cols.map((c) => q(r[c])).join(','))).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- business actions
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function decide(claimId, body) {
  const action = body.action;
  if (!['Approved', 'Sent back', 'Rejected'].includes(action)) throw new HttpError(400, 'Action must be Approved, Sent back or Rejected.');
  const user = allUsers().find((u) => u.id === Number(body.user_id));
  if (!user) throw new HttpError(400, 'Unknown user.');
  const row = db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId);
  if (!row) throw new HttpError(404, `Claim ${claimId} not found.`);
  const claim = hydrate(row);
  if (db.prepare('SELECT 1 AS x FROM decisions WHERE claim_id = ?').get(claimId)) throw new HttpError(409, `Claim ${claimId} already has a decision.`);

  const reason = String(body.reason || '').trim();
  const reasonOptional = action === 'Approved' && claim.ai.recommendation === 'APPROVE';
  if (!reason && !reasonOptional) {
    throw new HttpError(422, `A reason is required for this decision. Only approving a claim the AI recommends approving can skip it.`, { field: 'reason' });
  }
  if (action === 'Approved' && claim.total_inr > user.limit) {
    throw new HttpError(403, `${R.inr(claim.total_inr)} is above your approval limit of ${R.inr(user.limit)}. This claim needs the ${R.approverFor(claim.total_inr)}.`, { field: 'limit' });
  }
  const override = (claim.ai.recommendation === 'APPROVE' && action !== 'Approved') || (claim.ai.recommendation === 'REJECT' && action === 'Approved');
  const time = new Date().toISOString();
  tx(() => {
    db.prepare('INSERT INTO decisions (claim_id, action, reason, user_name, role, time, override) VALUES (?,?,?,?,?,?,?)')
      .run(claimId, action, reason, user.name, user.role, time, override ? 1 : 0);
    db.prepare('INSERT INTO audit (time, claim_id, action, ai_recommendation, ai_confidence, amount_inr, reason, user_name, role) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(time, claimId, action, claim.ai.recommendation, claim.ai.confidence, claim.total_inr, reason, user.name, user.role);
  });
  return { decision: { action, reason, user: user.name, role: user.role, time, override } };
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const PRODUCTS = ['Air conditioner', 'Washing machine', 'Refrigerator'];
const COMPONENTS = ['compressor', 'motor', 'pcb', 'thermostat', 'pump', 'bearing', 'gas', 'none'];

function prescreen(c) {
  // Stand-in for the AI service: deterministic, no live AI calls.
  if (c.duplicate_of) return { recommendation: 'REJECT', confidence: 0.9, policy_ref: 'Policy 4.5', reason: `Same serial and job date as claim ${c.duplicate_of}. (auto pre-screen)` };
  if (R.missingDocs(c).length) return { recommendation: 'REVIEW', confidence: 0.55, policy_ref: 'Policy 2.2', reason: 'Required documents are missing. (auto pre-screen)' };
  const r = R.routeClaim({ ...c, ai: { recommendation: 'REVIEW', confidence: 0 } }, 1);
  if (r.queue === 'Out of warranty') return { recommendation: 'REJECT', confidence: 0.88, policy_ref: 'Policy 4.1', reason: 'Job date is after the cover period. (auto pre-screen)' };
  if (R.daysBetween(c.job_date, c.claim_date) > R.LATE_DAYS) return { recommendation: 'REVIEW', confidence: 0.7, policy_ref: 'Policy 2.4', reason: 'Claim was filed late. (auto pre-screen)' };
  if (c.total_inr <= R.FAST_LIMIT) return { recommendation: 'APPROVE', confidence: 0.9, policy_ref: 'Policy 2.1, 5.1', reason: 'In warranty, documents complete, within the fast-lane amount. (auto pre-screen)' };
  return { recommendation: 'REVIEW', confidence: 0.7, policy_ref: 'Policy 8.1', reason: 'Amount is above the fast-lane limit. (auto pre-screen)' };
}

function createClaim(b) {
  const errors = {};
  const need = (k, label) => { if (!String(b[k] ?? '').trim()) errors[k] = `${label} is required.`; };
  need('asc_name', 'Service centre'); need('asc_city', 'City'); need('model', 'Model'); need('serial', 'Serial number'); need('fault', 'Fault');
  if (!PRODUCTS.includes(b.product)) errors.product = 'Choose a product.';
  if (!COMPONENTS.includes(b.component)) errors.component = 'Choose a component.';
  ['purchase_date', 'job_date', 'claim_date'].forEach((k) => { if (!isDate(b[k])) errors[k] = 'Use a valid date (YYYY-MM-DD).'; });
  const num = (k, label) => {
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < 0) errors[k] = `${label} must be 0 or more.`;
    return Math.round(v) || 0;
  };
  const labour = num('labour_inr', 'Labour'); const parts = num('parts_inr', 'Parts'); const km = num('travel_km', 'Travel km');
  if (!errors.purchase_date && !errors.job_date && b.job_date < b.purchase_date) errors.job_date = 'Job date cannot be before the purchase date.';
  if (!errors.job_date && !errors.claim_date && b.claim_date < b.job_date) errors.claim_date = 'Claim date cannot be before the job date.';
  if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields.', { errors });

  const docs = { job_sheet: !!b.docs?.job_sheet, invoice: !!b.docs?.invoice, serial_photo: !!b.docs?.serial_photo, part_photo: !!b.docs?.part_photo };
  const serial = String(b.serial).trim();
  const dup = db.prepare('SELECT MIN(claim_id) AS id FROM claims WHERE serial = ? AND job_date = ?').get(serial, b.job_date);
  const prefix = { 'Air conditioner': 'AC', 'Washing machine': 'WM', Refrigerator: 'RF' }[b.product];
  const claim = {
    claim_id: db.prepare('SELECT COALESCE(MAX(claim_id), 5000) + 1 AS n FROM claims').get().n,
    asc_name: String(b.asc_name).trim(), asc_city: String(b.asc_city).trim(), product: b.product, model: String(b.model).trim(), serial,
    purchase_date: b.purchase_date, job_date: b.job_date, claim_date: b.claim_date, fault: String(b.fault).trim(), component: b.component,
    labour_code: `L-${prefix}-01`, labour_inr: labour, parts_inr: parts, travel_km: km, travel_inr: km * 10, total_inr: labour + parts + km * 10,
    docs, duplicate_of: dup && dup.id ? dup.id : null, notes: String(b.notes || '').trim().slice(0, 500),
  };
  claim.ai = prescreen(claim);
  insertClaim(claim);
  return claim;
}

function resetDemo() {
  tx(() => {
    db.exec('DELETE FROM audit; DELETE FROM decisions;');
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'audit';");
    db.exec('DELETE FROM claims WHERE claim_id > 5020;');
    db.prepare("UPDATE settings SET value = '0.85' WHERE key = 'threshold'").run();
  });
}

// ---------------------------------------------------------------- live updates (SSE)
const sseClients = new Set();
function broadcast(type, cid) {
  const msg = `data: ${JSON.stringify({ type, cid })}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  const cid = String(req.headers['x-client'] || '');
  let mt;

  if (m === 'GET' && p === '/api/health') return json(res, 200, { ok: true, time: new Date().toISOString() });
  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return undefined;
  }
  if (m === 'GET' && p === '/api/users') return json(res, 200, { users: allUsers() });
  if (m === 'GET' && p === '/api/claims') return json(res, 200, snapshot());
  if (m === 'POST' && p === '/api/claims') {
    const claim = createClaim(await readBody(req));
    broadcast('claim', cid);
    const th = getThreshold();
    return json(res, 201, { claim: enrich(claim, decisionMap(), th) });
  }
  if ((mt = p.match(/^\/api\/claims\/(\d+)$/)) && m === 'GET') {
    const row = db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(Number(mt[1]));
    if (!row) throw new HttpError(404, 'Claim not found.');
    return json(res, 200, { claim: enrich(hydrate(row), decisionMap(), getThreshold()) });
  }
  if ((mt = p.match(/^\/api\/claims\/(\d+)\/decision$/)) && m === 'POST') {
    const out = decide(Number(mt[1]), await readBody(req));
    broadcast('decision', cid);
    return json(res, 201, out);
  }
  if (m === 'PUT' && p === '/api/settings') {
    const b = await readBody(req);
    const t = Math.round(Number(b.threshold) * 100) / 100;
    if (!Number.isFinite(t) || t < 0.7 || t > 0.95) throw new HttpError(422, 'Threshold must be between 0.70 and 0.95.');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'threshold'").run(String(t));
    broadcast('settings', cid);
    return json(res, 200, { threshold: t });
  }
  if (m === 'GET' && p === '/api/dashboard') return json(res, 200, dashboard());
  if (m === 'GET' && p === '/api/audit') return json(res, 200, { audit: auditRows() });
  if (m === 'GET' && p === '/api/audit.csv') {
    return send(res, 200, auditCsv(), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="nirmal_audit_log.csv"' });
  }
  if (m === 'POST' && p === '/api/reset') {
    resetDemo();
    broadcast('reset', cid);
    return json(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found.');
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    send(res, 200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
  return undefined;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...e.extra });
    console.error(e);
    return json(res, 500, { error: 'Something went wrong on the server.' });
  }
  return undefined;
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Nirmal Claims running at http://localhost:${PORT}  (database: ${DB_FILE})`));
}
module.exports = { server, db };
