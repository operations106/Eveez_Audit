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
const BATTERIES = ['Sun', 'Yuma', 'BS', 'Moving', 'Home Charging'];
const CATS = ['None', 'Minor Repair', 'Major Repair'];
const CONDS = ['Good', 'Bad', 'Poor'];

app.post('/api/audits', auth(['agent']), wrap(async (req, res) => {
  const b = req.body;
  const vehicleNo = String(b.vehicleNo || '').toUpperCase().replace(/\s+/g, '');
  if (!vehicleNo) return res.status(400).json({ error: 'Vehicle number do' });
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
    vehicleNo, hubId: req.user.hubId, agentName: String(b.agentName || '').slice(0, 60),
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
app.get('/api/audits', auth(), wrap(async (req, res) => {
  let q = db.collection('audits');
  const hub = req.user.role === 'agent' ? req.user.hubId : (req.query.hubId || '').toLowerCase();
  if (hub) q = q.where('hubId', '==', hub);
  const s = await q.select(...LIST_FIELDS).get();
  let rows = s.docs.map((d) => ({ id: d.id, ...d.data() }));
  const from = Number(req.query.from) || 0; const to = Number(req.query.to) || Infinity;
  const v = (req.query.q || '').toUpperCase().replace(/\s+/g, '');
  rows = rows.filter((r) => r.createdAt >= from && r.createdAt <= to && (!v || r.vehicleNo.includes(v)));
  rows.sort((a, b) => b.createdAt - a.createdAt);
  res.json(rows.slice(0, 1000));
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

app.get('/api/health', (_, res) => res.json({ ok: true }));
Promise.all([seedAdmin(), seedParts()]).then(() => app.listen(process.env.PORT || 8080, () => console.log('API running')));
