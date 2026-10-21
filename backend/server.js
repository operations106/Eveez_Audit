const express = require('express'), cors = require('cors'), jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs');
const db = require('./db'); const parts = require('./parts.json');
const SECRET = process.env.JWT_SECRET || 'change-me';
const app = express(); app.use(cors()); app.use(express.json({ limit: '1mb' }));

const auth = (roles) => (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'login required' }); }
  if (roles && !roles.includes(req.user.role)) return res.status(403).json({ error: 'not allowed' });
  next();
};

// Login: admin uses id "admin"; agents use hub id (+ agent name stored per audit)
app.post('/api/login', async (req, res) => {
  const { id, password } = req.body;
  const u = (await db.collection('users').doc(String(id || '').toLowerCase()).get()).data();
  if (!u || !bcrypt.compareSync(password || '', u.hash)) return res.status(401).json({ error: 'wrong id/password' });
  res.json({ token: jwt.sign({ id: u.id, role: u.role, hubId: u.role === 'agent' ? u.id : null }, SECRET, { expiresIn: '12h' }), role: u.role, id: u.id });
});

app.get('/api/parts', auth(), (_, res) => res.json(parts));

// Agent: submit audit. Total is recomputed on server (price from price list, not trusted from client)
app.post('/api/audits', auth(['agent']), async (req, res) => {
  const b = req.body, price = new Map(parts.map(p => [p.name, p.price]));
  const items = (b.parts || []).filter(p => price.has(p.name)).map(p => ({ name: p.name, qty: Math.max(1, +p.qty || 1), price: price.get(p.name) }));
  const a = {
    hubId: req.user.hubId, agentName: String(b.agentName || '').slice(0, 50),
    vehicleNo: String(b.vehicleNo || '').toUpperCase().trim(),
    batteryType: b.batteryType, batteryPresent: !!b.batteryPresent,
    category: b.category, condition: b.condition, parts: items,
    rfdCost: items.reduce((s, p) => s + p.price * p.qty, 0),
    photos: (b.photos || []).slice(0, 3), createdAt: Date.now()
  };
  if (!a.vehicleNo) return res.status(400).json({ error: 'vehicle number required' });
  const ref = await db.collection('audits').add(a); res.json({ id: ref.id, rfdCost: a.rfdCost });
});

// Agent sees own hub, admin sees all (optional ?hubId=). Photos excluded from list for speed.
app.get('/api/audits', auth(), async (req, res) => {
  let q = db.collection('audits');
  const hub = req.user.role === 'agent' ? req.user.hubId : req.query.hubId;
  if (hub) q = q.where('hubId', '==', hub);
  const snap = await q.orderBy('createdAt', 'desc').limit(500).get();
  res.json(snap.docs.map(d => { const { photos, ...r } = d.data(); return { id: d.id, ...r, photoCount: (photos || []).length }; }));
});
app.get('/api/audits/:id/photos', auth(), async (req, res) => {
  const a = (await db.collection('audits').doc(req.params.id).get()).data();
  if (!a || (req.user.role === 'agent' && a.hubId !== req.user.hubId)) return res.status(404).end();
  res.json(a.photos || []);
});

// Admin: create hub login
app.post('/api/hubs', auth(['admin']), async (req, res) => {
  const id = String(req.body.hubId || '').toLowerCase().trim();
  if (!id || !req.body.password) return res.status(400).json({ error: 'hubId and password required' });
  await db.collection('users').doc(id).set({ id, role: 'agent', name: req.body.name || id, hash: bcrypt.hashSync(req.body.password, 10) });
  res.json({ ok: true });
});
app.get('/api/hubs', auth(['admin']), async (_, res) => {
  const s = await db.collection('users').where('role', '==', 'agent').get(); res.json(s.docs.map(d => d.id));
});

// Auto-create admin on first start (no shell needed). Set ADMIN_PASSWORD env var on Render.
(async () => {
  const ref = db.collection('users').doc('admin');
  if (!(await ref.get()).exists) {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) return console.log('Set ADMIN_PASSWORD env var to create the admin login');
    await ref.set({ id: 'admin', role: 'admin', name: 'Admin', hash: bcrypt.hashSync(pw, 10) });
    console.log('admin created');
  }
})().catch(console.error);

app.listen(process.env.PORT || 3000, () => console.log('API up'));
