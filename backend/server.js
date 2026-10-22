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

const titleCase = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
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

// Purane setup me login = hub tha. Ek baar: har purane agent-login se hub bana do aur purane audits me agentId bhar do.
async function migrateHubs() {
  const meta = db.collection('meta').doc('hubs-migration');
  if ((await meta.get()).exists) return;
  const users = await db.collection('users').where('role', '==', 'agent').get();
  for (const u of users.docs) {
    const ref = db.collection('hubs').doc(u.id);
    if (!(await ref.get()).exists) await ref.set({ name: u.data().name || u.id, active: true, createdAt: Date.now() });
  }
  const snap = await db.collection('audits').select('hubId', 'agentId').get();
  const todo = snap.docs.filter((d) => !d.data().agentId);
  for (let i = 0; i < todo.length; i += 400) {
    const b = db.batch();
    todo.slice(i, i + 400).forEach((d) => b.update(d.ref, { agentId: d.data().hubId }));
    await b.commit();
  }
  await meta.set({ done: true, at: Date.now() });
  console.log('Hubs migrated:', users.size, 'audits updated:', todo.length);
}

app.post('/api/login', wrap(async (req, res) => {
  const id = String(req.body.id || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const d = await db.collection('users').doc(id).get();
  if (!d.exists || !bcrypt.compareSync(pw, d.data().hash)) return res.status(401).json({ error: 'Login ID / password galat hai' });
  const u = d.data();
  if (u.active === false) return res.status(403).json({ error: 'Ye login disabled hai' });
  const user = { id, role: u.role, name: u.name };
  res.json({ token: jwt.sign(user, SECRET, { expiresIn: '12h' }), user });
}));

// ---------- hubs (sirf naam; login nahi) ----------
const slug = (x) => String(x || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
app.get('/api/hubs', auth(), wrap(async (req, res) => {
  const s = await db.collection('hubs').get();
  let list = s.docs.map((d) => ({ hubId: d.id, name: d.data().name, active: d.data().active !== false }));
  if (req.user.role !== 'admin') list = list.filter((h) => h.active); // agent ko sirf active hubs
  res.json(list.sort((a, b) => a.name.localeCompare(b.name)));
}));
app.post('/api/hubs', auth(['admin']), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const hubId = slug(req.body.hubId || name);
  if (!name || hubId.length < 2) return res.status(400).json({ error: 'Hub ka naam do (min 2 letters)' });
  const ref = db.collection('hubs').doc(hubId);
  if ((await ref.get()).exists) return res.status(409).json({ error: 'Ye hub pehle se hai' });
  await ref.set({ name, active: true, createdAt: Date.now() });
  res.json({ ok: true, hubId });
}));
app.put('/api/hubs/:id', auth(['admin']), wrap(async (req, res) => {
  const upd = {};
  if (req.body.name) upd.name = String(req.body.name).trim().slice(0, 60);
  if (typeof req.body.active === 'boolean') upd.active = req.body.active;
  await db.collection('hubs').doc(req.params.id).update(upd);
  res.json({ ok: true });
}));

// ---------- agent logins (admin) ----------
app.get('/api/users', auth(['admin']), wrap(async (req, res) => {
  const s = await db.collection('users').where('role', '==', 'agent').get();
  res.json(s.docs.map((d) => ({ userId: d.id, name: d.data().name, active: d.data().active !== false })).sort((a, b) => a.userId.localeCompare(b.userId)));
}));
app.post('/api/users', auth(['admin']), wrap(async (req, res) => {
  const userId = String(req.body.userId || '').trim().toLowerCase();
  const { name, password } = req.body;
  if (!/^[a-z0-9_-]{2,30}$/.test(userId) || !password || password.length < 4) return res.status(400).json({ error: 'Login ID (2-30 letters/numbers) aur password (min 4) do' });
  if (!titleCase(name)) return res.status(400).json({ error: 'Agent ka naam do' });
  const ref = db.collection('users').doc(userId);
  if ((await ref.get()).exists) return res.status(409).json({ error: 'Ye Login ID pehle se hai' });
  await ref.set({ role: 'agent', name: titleCase(name), hash: bcrypt.hashSync(password, 10), active: true, createdAt: Date.now() });
  res.json({ ok: true });
}));
app.put('/api/users/:id', auth(['admin']), wrap(async (req, res) => {
  const ref = db.collection('users').doc(req.params.id); const d = await ref.get();
  if (!d.exists || d.data().role !== 'agent') return res.status(404).json({ error: 'Agent nahi mila' });
  const upd = {};
  if (req.body.name) upd.name = titleCase(req.body.name);
  if (req.body.password) upd.hash = bcrypt.hashSync(req.body.password, 10);
  if (typeof req.body.active === 'boolean') upd.active = req.body.active;
  await ref.update(upd);
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
const BATTERIES = ['Sun', 'Yuma', 'BS', 'Moving', 'Home Charging'];
const CATS = ['None', 'Minor Repair', 'Major Repair'];
const CONDS = ['Good', 'Bad', 'Poor'];

// ---------- draft: agent parts add karta jaye aur backend me save hota rahe (page reset ho to bhi wapas milega) ----------
function cleanForm(b) {
  const parts = [];
  const seen = new Set();
  (b.parts || []).forEach((p) => {
    const id = String(p.id || ''); if (!id || seen.has(id)) return; seen.add(id);
    parts.push({ id, qty: Math.max(1, Math.min(999, parseInt(p.qty) || 1)) });
  });
  return {
    vehicleNo: String(b.vehicleNo || '').toUpperCase().replace(/\s+/g, '').slice(0, 20),
    hubId: String(b.hubId || '').toLowerCase().slice(0, 30),
    batteryType: BATTERIES.includes(b.batteryType) ? b.batteryType : BATTERIES[0],
    batteryPresent: b.batteryPresent !== false,
    category: CATS.includes(b.category) ? b.category : CATS[0],
    condition: CONDS.includes(b.condition) ? b.condition : CONDS[0],
    notes: String(b.notes || '').slice(0, 500),
    parts,
  };
}
app.get('/api/draft', auth(['agent']), wrap(async (req, res) => {
  const d = await db.collection('drafts').doc(req.user.id).get();
  res.json(d.exists ? d.data() : null);
}));
app.put('/api/draft', auth(['agent']), wrap(async (req, res) => {
  await db.collection('drafts').doc(req.user.id).set({ ...cleanForm(req.body), updatedAt: Date.now() });
  res.json({ ok: true });
}));
app.delete('/api/draft', auth(['agent']), wrap(async (req, res) => {
  await db.collection('drafts').doc(req.user.id).delete();
  res.json({ ok: true });
}));

app.post('/api/audits', auth(['agent']), wrap(async (req, res) => {
  const b = req.body;
  const f = cleanForm(b);
  if (!f.vehicleNo) return res.status(400).json({ error: 'Vehicle number do' });
  const hub = f.hubId && await db.collection('hubs').doc(f.hubId).get();
  if (!hub || !hub.exists || hub.data().active === false) return res.status(400).json({ error: 'Hub chuno' });
  if (!BATTERIES.includes(b.batteryType) || !CATS.includes(b.category) || !CONDS.includes(b.condition))
    return res.status(400).json({ error: 'Form adhura hai' });
  // price server par partsList se lo, client par bharosa nahi
  const ids = f.parts.map((p) => p.id);
  const docs = await Promise.all(ids.map((id) => db.collection('parts').doc(id).get()));
  const priceMap = {}; docs.forEach((d) => d.exists && (priceMap[d.id] = d.data()));
  const parts = f.parts.filter((p) => priceMap[p.id]).map((p) => ({ id: p.id, name: priceMap[p.id].name, price: priceMap[p.id].price, qty: p.qty }));
  const rfdCost = parts.reduce((s, p) => s + p.price * p.qty, 0);
  const doc = {
    vehicleNo: f.vehicleNo, hubId: f.hubId, agentId: req.user.id, agentName: req.user.name,
    batteryType: f.batteryType, batteryPresent: f.batteryPresent,
    category: f.category, condition: f.condition, parts, rfdCost,
    notes: f.notes,
    photos: (b.photos || []).slice(0, 4).filter((p) => typeof p === 'string' && p.startsWith('data:image/') && p.length < 250000),
    createdAt: Date.now(),
  };
  const r = await db.collection('audits').add(doc);
  await db.collection('drafts').doc(req.user.id).delete();
  res.json({ id: r.id, rfdCost });
}));

const LIST_FIELDS = ['vehicleNo', 'hubId', 'agentName', 'batteryType', 'batteryPresent', 'category', 'condition', 'parts', 'rfdCost', 'createdAt'];
async function queryAudits(user, p) {
  let q = db.collection('audits');
  const hub = String(p.hubId || '').toLowerCase();
  if (user.role === 'agent') q = q.where('agentId', '==', user.id); // agent sirf apne audits dekhega
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
  if (req.user.role === 'agent' && a.agentId !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  res.json({ id: d.id, ...a });
}));
app.delete('/api/audits/:id', auth(['admin']), wrap(async (req, res) => {
  await db.collection('audits').doc(req.params.id).delete();
  res.json({ ok: true });
}));


// ---------- email: Google Apps Script (Gmail) relay ----------
// Backend -> Apps Script Web App (HTTPS POST, secret body me) -> Gmail. Brevo hata diya.
// Env: GOOGLE_SCRIPT_URL (.../exec), GOOGLE_SCRIPT_SECRET (Apps Script ke SCRIPT_SECRET jaisa)
class MailError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }
const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/(?:a\/)?macros\/(?:[^/]+\/)?s\/[\w-]+\/exec$/;
const E = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => '\u20b9' + Number(n || 0).toLocaleString('en-IN');
const ist = (t) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Success tabhi return hota hai jab Apps Script khud bole {ok:true, sent:true} (yani Gmail ne mail bhej di).
async function sendMail({ to, subject, html, text, csv, filename, report }) {
  const url = process.env.GOOGLE_SCRIPT_URL, secret = process.env.GOOGLE_SCRIPT_SECRET;
  if (!url || !secret) throw new MailError('Email setup baki hai (GOOGLE_SCRIPT_URL / GOOGLE_SCRIPT_SECRET backend env me nahi hain)', 503);
  if (!SCRIPT_URL_RE.test(url)) throw new MailError('GOOGLE_SCRIPT_URL galat hai (https://script.google.com/macros/s/.../exec hona chahiye)', 503);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);
  let resp, raw;
  try {
    // Ek hi baar bhejte hain (retry nahi) taaki duplicate email na jaye. Node fetch Apps Script ka 302 redirect khud follow karta hai.
    resp = await fetch(url, {
      method: 'POST', redirect: 'follow', signal: ac.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, to, subject, html, text, csv, filename, report, fromName: process.env.MAIL_FROM_NAME || 'EV Hub Audit' }),
    });
    raw = await resp.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new MailError('Email service ne time par jawab nahi diya. Email gaya ho sakta hai - dobara bhejne se pehle inbox check karo.', 504);
    console.error('Apps Script unreachable:', e.message);
    throw new MailError('Email service tak pahunch nahi paye. Thodi der baad try karo.', 502);
  } finally { clearTimeout(timer); }

  let j;
  try { j = JSON.parse(raw); } catch {
    console.error('Apps Script non-JSON reply, HTTP', resp.status);
    throw new MailError('Apps Script se galat reply aaya. Deployment me "Who has access = Anyone" aur sahi /exec URL check karo.', 502);
  }
  if (!resp.ok || j.ok !== true || j.sent !== true) {
    console.error('Apps Script mail fail:', j.code || resp.status, String(j.error || '').slice(0, 200));
    const why = j.code === 'UNAUTHORIZED' ? 'GOOGLE_SCRIPT_SECRET Apps Script ke SCRIPT_SECRET se match nahi karta' : String(j.error || 'Apps Script error').slice(0, 200);
    throw new MailError('Email nahi gaya: ' + why, 502);
  }
  return j; // { ok, sent, sentAt, sender, senderNote, recipients, attachment, ... }
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
  const missing = rows.filter((r) => !r.batteryPresent).length;
  const parts = {};
  rows.forEach((r) => (r.parts || []).forEach((p) => { parts[p.name] = parts[p.name] || { q: 0, c: 0 }; parts[p.name].q += p.qty; parts[p.name].c += p.qty * p.price; }));
  const hubWise = countBy(rows, (r) => r.hubId);
  const agentWise = countBy(rows, (r) => r.agentName || '-').slice(0, 15);
  const condWise = countBy(rows, (r) => r.condition);
  const topParts = Object.entries(parts).sort((a, b) => b[1].c - a[1].c).slice(0, 10);
  const filt = [f.hubId && 'Hub: ' + f.hubId, f.agent && 'Agent: ' + f.agent, f.condition && 'Condition: ' + f.condition, f.category && 'Category: ' + f.category,
    f.battery && 'Battery: ' + f.battery, f.from && 'From: ' + ist(+f.from).slice(0, 11), f.to && 'To: ' + ist(+f.to).slice(0, 11), f.q && 'Vehicle: ' + f.q].filter(Boolean).join(' | ') || 'All data';
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  const card = (label, val, bg) => `<td width="50%" style="background:${bg};border-radius:12px;padding:16px 18px;color:#ffffff"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.6px">${label}</div><div style="font-size:26px;font-weight:bold;margin-top:6px">${val}</div></td>`;
  const box = (t, c, inner) => `<div style="background:#ffffff;border-radius:12px;padding:4px 18px 16px;margin-top:14px"><div style="font-size:16px;font-weight:bold;color:${c};margin:14px 0 8px">${t}</div>${inner}</div>`;
  const bars = (items, color) => {
    const max = Math.max(...items.map((i) => i.cost), 1);
    return `<table width="100%" style="border-collapse:collapse;font:13px Arial,sans-serif;color:#17211f">${items.map((i) => `<tr><td style="padding:8px 0;width:28%;font-weight:bold">${E(i.name)}</td><td style="padding:8px"><div style="background:#e8ecea;border-radius:6px"><div style="background:${color};height:10px;border-radius:6px;width:${Math.max(4, Math.round((i.cost / max) * 100))}%"></div></div></td><td style="padding:8px 0;text-align:right;white-space:nowrap">${i.n} veh &middot; <b>${inr(i.cost)}</b></td></tr>`).join('')}</table>`;
  };
  const chipColor = { Good: '#1f9d63', Bad: '#f08a24', Poor: '#d64545' };
  const chips = condWise.map(([k, v]) => `<span style="display:inline-block;background:${chipColor[k] || '#64748b'};color:#ffffff;border-radius:20px;padding:7px 16px;margin:0 8px 8px 0;font:bold 13px Arial,sans-serif">${E(k)}: ${v.n}</span>`).join('');
  const partsRows = topParts.map(([k, v], i) => `<tr style="background:${i % 2 ? '#ffffff' : '#f3f0ff'}"><td style="padding:8px 10px">${E(k)}</td><td style="padding:8px 10px;text-align:center">${v.q}</td><td style="padding:8px 10px;text-align:right"><b>${inr(v.c)}</b></td></tr>`).join('');
  const partsTable = `<table width="100%" style="border-collapse:collapse;font:13px Arial,sans-serif;color:#17211f"><tr style="background:#8b5cf6;color:#ffffff"><th style="padding:8px 10px;text-align:left">Part</th><th style="padding:8px 10px">Qty</th><th style="padding:8px 10px;text-align:right">Cost</th></tr>${partsRows}</table>`;
  const html = `<div style="background:#f1f4f3;padding:16px;font:14px Arial,sans-serif;color:#17211f"><div style="max-width:640px;margin:0 auto">
  <div style="background:#0f766e;background-image:linear-gradient(135deg,#0f766e,#2563eb);border-radius:14px;padding:22px 24px;color:#ffffff"><div style="font-size:22px;font-weight:bold">EV Hub Audit Report</div><div style="margin-top:6px;font-size:13px">${today} &nbsp;&middot;&nbsp; ${E(filt)}</div></div>
  ${req.body.note ? `<div style="background:#fff8e1;border-left:5px solid #f5b301;border-radius:8px;padding:12px 14px;margin-top:14px">${E(req.body.note)}</div>` : ''}
  <table width="100%" style="border-collapse:separate;border-spacing:8px"><tr>${card('Vehicles', rows.length, '#0f9d74')}${card('Total RFD cost', inr(Math.round(total)), '#2563eb')}</tr><tr>${card('Avg RFD / vehicle', inr(Math.round(total / rows.length)), '#f08a24')}${card('Hubs', hubWise.length, '#8b5cf6')}</tr></table>
  ${box('Hub-wise RFD cost', '#0f9d74', bars(hubWise.map(([k, v]) => ({ name: k, n: v.n, cost: v.cost })), '#0f9d74'))}
  ${box('Agent-wise RFD cost', '#2563eb', bars(agentWise.map(([k, v]) => ({ name: k, n: v.n, cost: v.cost })), '#2563eb'))}
  ${box('Vehicle condition', '#d64545', chips)}
  ${box('Top parts (by cost)', '#8b5cf6', partsTable)}
  <p style="color:#5d6b67;font-size:12px;text-align:center;margin:16px 0 0">Poori vehicle-wise detail (RFD cost + parts) attached Excel/CSV me hai.</p></div></div>`;
  const text = `EV Hub Audit Report - ${today}\n${filt}\nVehicles: ${rows.length}\nTotal RFD cost: ${inr(total)}\nAvg per vehicle: ${inr(total / rows.length)}\nVehicle-wise data Excel/CSV attachment me hai.`;
  const report = {
    filters: filt, note: String(req.body.note || '').slice(0, 300), vehicles: rows.length, totalRfd: total, avgRfd: Math.round(total / rows.length), batteryMissing: missing,
    hubWise: hubWise.map(([k, v]) => ({ hub: k, vehicles: v.n, rfd: v.cost })), agentWise: agentWise.map(([k, v]) => ({ agent: k, vehicles: v.n, rfd: v.cost })),
    condition: condWise.map(([k, v]) => ({ condition: k, vehicles: v.n })), topParts: topParts.map(([k, v]) => ({ part: k, qty: v.q, cost: v.c })),
  };
  try {
    const r = await sendMail({ to, subject: `EV Audit Report - ${today}`, html, text, csv: csvOf(rows), filename: 'audit-report.csv', report });
    // Yaha tak sirf tab pahunchte hain jab Apps Script/Gmail ne mail bhej di.
    res.json({ ok: true, sent: rows.length, vehicles: rows.length, totalRfd: total, recipients: r.recipients, sender: r.sender, sentAt: r.sentAt, attachment: r.attachment });
  } catch (e) {
    if (e instanceof MailError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

app.get('/api/health', (_, res) => res.json({ ok: true }));
Promise.all([seedAdmin(), seedParts()]).then(migrateHubs).then(() => app.listen(process.env.PORT || 8080, () => console.log('API running')));
