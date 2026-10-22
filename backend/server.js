require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

admin.initializeApp({
  credential: process.env.FIREBASE_SERVICE_ACCOUNT
    ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    : admin.credential.applicationDefault(),
});
const db = admin.firestore();
const SECRET = process.env.JWT_SECRET || 'dev-secret';
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' })); // photos pehle se compress hoti hain

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });

// ---------- auth ----------
function auth(roles) {
  return (req, res, next) => {
    try {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      req.user = jwt.verify(t, SECRET);
      if (roles && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
      next();
    } catch { res.status(401).json({ error: 'Login again' }); }
  };
}

async function seedAdmin() {
  const s = await db.collection('users').where('role', '==', 'admin').limit(1).get();
  if (!s.empty) return;
  const id = (process.env.ADMIN_USER || 'admin').toLowerCase();
  await db.collection('users').doc(id).set({
    role: 'admin', name: 'Admin', hash: bcrypt.hashSync(process.env.ADMIN_PASS || 'ChangeMe123', 10),
    createdAt: Date.now(),
  });
  console.log('Admin created:', id);
}

// Pehli baar parts list khali ho to seed-parts.json se bhar do
async function seedParts() {
  const s = await db.collection('parts').limit(1).get();
  if (!s.empty) return;
  const list = require('./seed-parts.json');
  for (let i = 0; i < list.length; i += 400) {
    const b = db.batch();
    list.slice(i, i + 400).forEach((p) => b.set(db.collection('parts').doc(), p));
    await b.commit();
  }
  console.log('Parts seeded:', list.length);
}

app.post('/api/login', wrap(async (req, res) => {
  const id = String(req.body.id || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
    if (!id || !pw) {
    return res.status(400).json({ error: 'Hub ID aur password dono bharein' });
  }
  const d = await db.collection('users').doc(id).get();
  if (!d.exists || !bcrypt.compareSync(pw, d.data().hash)) return res.status(401).json({ error: 'Hub ID / password galat hai' });
  const u = d.data();
  if (u.active === false) return res.status(403).json({ error: 'Ye hub disabled hai' });
  const user = { id, role: u.role, name: u.name, hubId: u.role === 'agent' ? id : null };
  res.json({ token: jwt.sign(user, SECRET, { expiresIn: '12h' }), user });
}));

// ---------- hubs (admin) ----------
app.get('/api/hubs', auth(['admin']), wrap(async (req, res) => {
  const s = await db.collection('users').where('role', '==', 'agent').get();
  res.json(s.docs.map((d) => ({ hubId: d.id, name: d.data().name, active: d.data().active !== false })));
}));
app.post('/api/hubs', auth(['admin']), wrap(async (req, res) => {
  const hubId = String(req.body.hubId || '').trim().toLowerCase();
  const { name, password } = req.body;
  if (!/^[a-z0-9_-]{2,30}$/.test(hubId) || !password || password.length < 4) return res.status(400).json({ error: 'Hub ID (2-30 letters/numbers) aur password (min 4) do' });
  const ref = db.collection('users').doc(hubId);
  if ((await ref.get()).exists) return res.status(409).json({ error: 'Ye Hub ID pehle se hai' });
  await ref.set({ role: 'agent', name: name || hubId, hash: bcrypt.hashSync(password, 10), active: true, createdAt: Date.now() });
  res.json({ ok: true });
}));
app.put('/api/hubs/:id', auth(['admin']), wrap(async (req, res) => {
  const upd = {};
  if (req.body.name) upd.name = req.body.name;
  if (req.body.password) upd.hash = bcrypt.hashSync(req.body.password, 10);
  if (typeof req.body.active === 'boolean') upd.active = req.body.active;
  await db.collection('users').doc(req.params.id).update(upd);
  res.json({ ok: true });
}));

// ---------- parts ----------
app.get('/api/parts', auth(), wrap(async (req, res) => {
  const s = await db.collection('parts').get();
  res.json(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name)));
}));
app.post('/api/parts', auth(['admin']), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim(); const price = Number(req.body.price);
  if (!name || !(price >= 0)) return res.status(400).json({ error: 'Part name aur price do' });
  const r = await db.collection('parts').add({ name, price });
  res.json({ id: r.id });
}));
// Bulk: har line "Part name, price"
app.post('/api/parts/bulk', auth(['admin']), wrap(async (req, res) => {
  const lines = String(req.body.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const batch = db.batch(); let n = 0;
  for (const l of lines) {
    const i = Math.max(l.lastIndexOf(','), l.lastIndexOf('\t')); // comma ya Excel tab dono chalenge
    if (i < 1) continue;
    const name = l.slice(0, i).trim(); const price = Number(l.slice(i + 1).replace(/[^\d.]/g, ''));
    if (!name || isNaN(price)) continue;
    batch.set(db.collection('parts').doc(), { name, price }); n++;
  }
  await batch.commit();
  res.json({ added: n });
}));
app.put('/api/parts/:id', auth(['admin']), wrap(async (req, res) => {
  await db.collection('parts').doc(req.params.id).update({ name: req.body.name, price: Number(req.body.price) });
  res.json({ ok: true });
}));
app.delete('/api/parts/:id', auth(['admin']), wrap(async (req, res) => {
  await db.collection('parts').doc(req.params.id).delete();
  res.json({ ok: true });
}));

// ---------- audits ----------
const titleCase = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
const BATTERIES = ['Sun', 'Yuma', 'BS', 'Moving', 'Home Charging'];
const CATS = ['None', 'Minor Repair', 'Major Repair'];
const CONDS = ['Good', 'Bad', 'Poor'];

app.post('/api/audits', auth(['agent']), wrap(async (req, res) => {
  const b = req.body;
  const vehicleNo = String(b.vehicleNo || '').toUpperCase().replace(/\s+/g, '');
  if (!vehicleNo) return res.status(400).json({ error: 'Vehicle number do' });
  if (!titleCase(b.agentName)) return res.status(400).json({ error: 'Agent name do' });
  if (!BATTERIES.includes(b.batteryType) || !CATS.includes(b.category) || !CONDS.includes(b.condition))
    return res.status(400).json({ error: 'Form adhura hai' });
  // price server par partsList se lo, client par bharosa nahi
  const ids = [...new Set((b.parts || []).map((p) => p.id))];
  const docs = await Promise.all(ids.map((id) => db.collection('parts').doc(id).get()));
  const priceMap = {}; docs.forEach((d) => d.exists && (priceMap[d.id] = d.data()));
  const parts = (b.parts || []).filter((p) => priceMap[p.id]).map((p) => {
    const qty = Math.max(1, parseInt(p.qty) || 1);
    return { id: p.id, name: priceMap[p.id].name, price: priceMap[p.id].price, qty };
  });
  const rfdCost = parts.reduce((s, p) => s + p.price * p.qty, 0);
  const doc = {
    vehicleNo, hubId: req.user.hubId, agentName: titleCase(b.agentName),
    batteryType: b.batteryType, batteryPresent: !!b.batteryPresent,
    category: b.category, condition: b.condition, parts, rfdCost,
    notes: String(b.notes || '').slice(0, 500),
    photos: (b.photos || []).slice(0, 4).filter((p) => typeof p === 'string' && p.startsWith('data:image/') && p.length < 250000),
    createdAt: Date.now(),
  };
  const r = await db.collection('audits').add(doc);
  res.json({ id: r.id, rfdCost });
}));

const LIST_FIELDS = ['vehicleNo', 'hubId', 'agentName', 'batteryType', 'batteryPresent', 'category', 'condition', 'parts', 'rfdCost', 'createdAt'];
async function queryAudits(user, p) {
  let q = db.collection('audits');
  const hub = user.role === 'agent' ? user.hubId : String(p.hubId || '').toLowerCase();
  if (hub) q = q.where('hubId', '==', hub);
  const snap = await q.select(...LIST_FIELDS).get();
  const from = Number(p.from) || 0; const to = Number(p.to) || Infinity;
  const v = String(p.q || '').toUpperCase().replace(/\s+/g, '');
  const ag = titleCase(p.agent || '');
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) =>
    r.createdAt >= from && r.createdAt <= to && (!v || r.vehicleNo.includes(v)) && (!ag || r.agentName === ag) &&
    (!p.condition || r.condition === p.condition) && (!p.category || r.category === p.category) && (!p.battery || r.batteryType === p.battery));
  rows.sort((x, y) => y.createdAt - x.createdAt);
  return rows.slice(0, 2000);
}
app.get('/api/audits', auth(), wrap(async (req, res) => res.json(await queryAudits(req.user, req.query))));
app.get('/api/agents', auth(['admin']), wrap(async (req, res) => {
  let q = db.collection('audits'); const hub = String(req.query.hubId || '').toLowerCase();
  if (hub) q = q.where('hubId', '==', hub);
  const snap = await q.select('agentName').get();
  res.json([...new Set(snap.docs.map((d) => d.data().agentName).filter(Boolean))].sort());
}));
app.get('/api/audits/:id', auth(), wrap(async (req, res) => {
  const d = await db.collection('audits').doc(req.params.id).get();
  if (!d.exists) return res.status(404).json({ error: 'Not found' });
  const a = d.data();
  if (req.user.role === 'agent' && a.hubId !== req.user.hubId) return res.status(403).json({ error: 'Not allowed' });
  res.json({ id: d.id, ...a });
}));
app.delete('/api/audits/:id', auth(['admin']), wrap(async (req, res) => {
  await db.collection('audits').doc(req.params.id).delete();
  res.json({ ok: true });
}));


// ---------- email: Brevo API (HTTPS). Render free plan par SMTP block hai, isliye API use ki ----------
const E = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => '\u20b9' + Number(n || 0).toLocaleString('en-IN');
const ist = (t) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
async function sendMail({ to, subject, html, csv, filename }) {
  const key = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) throw new Error('Email setup baki hai (BREVO_API_KEY / MAIL_FROM Render me nahi hain)');
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: process.env.MAIL_FROM_NAME || 'EV Hub Audit', email: from },
      to: to.map((email) => ({ email })), subject, htmlContent: html,
      attachment: [{ name: filename, content: Buffer.from(csv).toString('base64') }],
    }),
  });
  if (!r.ok) throw new Error('Brevo send fail: ' + ((await r.json().catch(() => ({}))).message || r.status));
}
function csvOf(rows) {
  const c = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['Vehicle', 'Hub', 'Agent', 'Battery', 'Battery present', 'Category', 'Condition', 'Parts', 'RFD cost', 'Date (IST)'];
  return '\ufeff' + [head, ...rows.map((r) => [r.vehicleNo, r.hubId, r.agentName, r.batteryType, r.batteryPresent ? 'Yes' : 'No', r.category, r.condition,
    (r.parts || []).map((p) => `${p.name} x${p.qty}`).join('; '), r.rfdCost, ist(r.createdAt)])].map((r) => r.map(c).join(',')).join('\r\n');
}
const TD = 'padding:6px 10px;border-bottom:1px solid #ddd;text-align:left';
const table = (head, body) => `<table style="border-collapse:collapse;font:13px Arial,sans-serif;margin:6px 0 18px"><tr>${head.map((h) => `<th style="${TD};background:#eef1ee">${E(h)}</th>`).join('')}</tr>${body.map((r) => `<tr>${r.map((c) => `<td style="${TD}">${E(c)}</td>`).join('')}</tr>`).join('')}</table>`;
const countBy = (rows, f) => { const m = {}; rows.forEach((r) => { const k = f(r); m[k] = m[k] || { n: 0, cost: 0 }; m[k].n++; m[k].cost += r.rfdCost; }); return Object.entries(m).sort((a, b) => b[1].cost - a[1].cost); };

app.post('/api/email-report', auth(['admin']), wrap(async (req, res) => {
  const to = String(req.body.to || '').split(/[,;\s]+/).filter(Boolean);
  const dom = (process.env.MAIL_ALLOWED_DOMAIN || '').toLowerCase();
  if (!to.length || to.length > 10 || to.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) return res.status(400).json({ error: 'Sahi email daalo (max 10)' });
  if (dom && to.some((x) => !x.toLowerCase().endsWith('@' + dom))) return res.status(400).json({ error: 'Sirf @' + dom + ' emails allowed hain' });
  const f = req.body.filters || {};
  const rows = await queryAudits(req.user, f);
  if (!rows.length) return res.status(400).json({ error: 'Is filter me koi audit nahi hai' });
  const total = rows.reduce((s, r) => s + r.rfdCost, 0);
  const parts = {};
  rows.forEach((r) => (r.parts || []).forEach((p) => { parts[p.name] = parts[p.name] || { q: 0, c: 0 }; parts[p.name].q += p.qty; parts[p.name].c += p.qty * p.price; }));
  const filt = [f.hubId && 'Hub: ' + f.hubId, f.agent && 'Agent: ' + f.agent, f.condition && 'Condition: ' + f.condition, f.category && 'Category: ' + f.category,
    f.battery && 'Battery: ' + f.battery, f.from && 'From: ' + ist(+f.from).slice(0, 11), f.to && 'To: ' + ist(+f.to).slice(0, 11), f.q && 'Vehicle: ' + f.q].filter(Boolean).join(' | ') || 'All data';
  const html = `<div style="font:14px Arial,sans-serif;color:#17211f"><h2 style="margin:0 0 4px">EV Hub Audit Report</h2><p style="color:#5d6b67;margin:0 0 12px">${E(filt)}</p>
  ${req.body.note ? `<p>${E(req.body.note)}</p>` : ''}
  <p style="font-size:16px"><b>${rows.length}</b> vehicles &middot; Total RFD cost <b>${inr(total)}</b> &middot; Avg ${inr(total / rows.length)} per vehicle<br>Battery missing: <b>${rows.filter((r) => !r.batteryPresent).length}</b></p>
  <h3>Hub-wise</h3>${table(['Hub', 'Vehicles', 'RFD cost'], countBy(rows, (r) => r.hubId).map(([k, v]) => [k, v.n, inr(v.cost)]))}
  <h3>Agent-wise</h3>${table(['Agent', 'Vehicles', 'RFD cost'], countBy(rows, (r) => r.agentName || '-').slice(0, 15).map(([k, v]) => [k, v.n, inr(v.cost)]))}
  <h3>Condition</h3>${table(['Condition', 'Vehicles'], countBy(rows, (r) => r.condition).map(([k, v]) => [k, v.n]))}
  <h3>Top parts (by cost)</h3>${table(['Part', 'Qty', 'Cost'], Object.entries(parts).sort((a, b) => b[1].c - a[1].c).slice(0, 10).map(([k, v]) => [k, v.q, inr(v.c)]))}
  <h3>Vehicles${rows.length > 100 ? ' (first 100, poori list CSV me)' : ''}</h3>${table(['Vehicle', 'Hub', 'Battery', 'Repair', 'Condition', 'RFD cost'], rows.slice(0, 100).map((r) => [r.vehicleNo, r.hubId, r.batteryType + (r.batteryPresent ? '' : ' (missing)'), r.category, r.condition, inr(r.rfdCost)]))}
  <p style="color:#5d6b67">Poori detail CSV attachment me hai.</p></div>`;
  await sendMail({ to, subject: `EV Audit Report - ${rows.length} vehicles, ${inr(total)} RFD`, html, csv: csvOf(rows), filename: 'audit-report.csv' });
  res.json({ ok: true, sent: rows.length });
}));

app.get('/api/health', (_, res) => res.json({ ok: true }));
Promise.all([seedAdmin(), seedParts()]).then(() => app.listen(process.env.PORT || 8080, () => console.log('API running')));
