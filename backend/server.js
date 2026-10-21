const express = require('express'), cors = require('cors'), jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs');
const db = require('./db'); const parts = require('./parts.json');
const SECRET = process.env.JWT_SECRET || 'change-me';
const app = express(); app.use(cors()); app.use(express.json({ limit: '1mb' }));

const auth = (roles) => (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').slice(7), SECRET); } catch { return res.status(401).json({ error: 'login required' }); }
  if (roles && !roles.includes(req.user.role)) return res.status(403).json({ error: 'not allowed' });
  next();
};
const slug = s => String(s || '').toLowerCase().trim().replace(/[\/\s]+/g, '-');

// Login: admin uses id "admin"; agents use their own login id
app.post('/api/login', async (req, res) => {
  const { id, password } = req.body;
  const u = (await db.collection('users').doc(slug(id) || '-').get()).data();
  if (!u || !bcrypt.compareSync(password || '', u.hash)) return res.status(401).json({ error: 'wrong id/password' });
  res.json({ token: jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '12h' }), role: u.role, id: u.id });
});

app.get('/api/parts', auth(), (_, res) => res.json(parts));

// Agent: submit audit. Agent name = login id (from token). Hub chosen from hubs list. Total recomputed on server.
app.post('/api/audits', auth(['agent']), async (req, res) => {
  const b = req.body, price = new Map(parts.map(p => [p.name, p.price]));
  const hub = (await db.collection('hubs').doc(slug(b.hubId) || '-').get()).data();
  if (!hub) return res.status(400).json({ error: 'select a hub' });
  const items = (b.parts || []).filter(p => price.has(p.name)).map(p => ({ name: p.name, qty: Math.max(1, +p.qty || 1), price: price.get(p.name) }));
  const a = {
    hubId: hub.id, hubName: hub.name, agentId: req.user.id, agentName: req.user.id,
    vehicleNo: String(b.vehicleNo || '').toUpperCase().trim(),
    batteryType: b.batteryType, batteryPresent: !!b.batteryPresent,
    category: b.category, condition: b.condition, parts: items,
    rfdCost: items.reduce((s, p) => s + p.price * p.qty, 0),
    photos: (b.photos || []).slice(0, 3), createdAt: Date.now()
  };
  if (!a.vehicleNo) return res.status(400).json({ error: 'vehicle number required' });
  const ref = await db.collection('audits').add(a); res.json({ id: ref.id, rfdCost: a.rfdCost });
});

// Agent sees own audits (incl. old audits made under their old hub-login), admin sees all (optional ?hubId=). Photos excluded for speed.
const strip = d => { const { photos, ...r } = d.data(); return { id: d.id, ...r, photoCount: (photos || []).length }; };
app.get('/api/audits', auth(), async (req, res) => {
  if (req.user.role === 'agent') {
    const [a, b] = await Promise.all([
      db.collection('audits').where('agentId', '==', req.user.id).get(),
      db.collection('audits').where('hubId', '==', req.user.id).get()
    ]);
    const m = new Map(); a.docs.forEach(d => m.set(d.id, d)); b.docs.forEach(d => { if (!d.data().agentId) m.set(d.id, d); });
    return res.json([...m.values()].map(strip).sort((x, y) => y.createdAt - x.createdAt).slice(0, 500));
  }
  let q = db.collection('audits');
  if (req.query.hubId) q = q.where('hubId', '==', req.query.hubId);
  const snap = await q.orderBy('createdAt', 'desc').limit(500).get();
  res.json(snap.docs.map(strip));
});
app.get('/api/audits/:id/photos', auth(), async (req, res) => {
  const a = (await db.collection('audits').doc(req.params.id).get()).data();
  if (!a || (req.user.role === 'agent' && a.agentId !== req.user.id && a.hubId !== req.user.id)) return res.status(404).end();
  res.json(a.photos || []);
});

// Hubs: admin adds/removes, everyone logged in can list (for dropdown)
app.get('/api/hubs', auth(), async (_, res) => {
  const s = await db.collection('hubs').get();
  res.json(s.docs.map(d => ({ id: d.id, name: d.data().name || d.id })).sort((a, b) => a.name.localeCompare(b.name)));
});
app.post('/api/hubs', auth(['admin']), async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60), id = slug(name);
  if (!id) return res.status(400).json({ error: 'hub name required' });
  await db.collection('hubs').doc(id).set({ id, name }); res.json({ ok: true, id });
});
app.delete('/api/hubs/:id', auth(['admin']), async (req, res) => { await db.collection('hubs').doc(req.params.id).delete(); res.json({ ok: true }); });

// Agents: admin creates login (re-posting same id resets password)
app.get('/api/agents', auth(['admin']), async (_, res) => {
  const s = await db.collection('users').where('role', '==', 'agent').get(); res.json(s.docs.map(d => d.id).sort());
});
app.post('/api/agents', auth(['admin']), async (req, res) => {
  const id = slug(req.body.id);
  if (!id || !req.body.password) return res.status(400).json({ error: 'id and password required' });
  if (id === 'admin') return res.status(400).json({ error: 'id not allowed' });
  await db.collection('users').doc(id).set({ id, role: 'agent', name: id, hash: bcrypt.hashSync(req.body.password, 10) });
  res.json({ ok: true });
});
app.delete('/api/agents/:id', auth(['admin']), async (req, res) => {
  if (req.params.id === 'admin') return res.status(400).json({ error: 'not allowed' });
  await db.collection('users').doc(req.params.id).delete(); res.json({ ok: true });
});

// Startup: auto-create admin; one-time migration of old hub-logins into the hubs list
(async () => {
  const ref = db.collection('users').doc('admin');
  if (!(await ref.get()).exists) {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) console.log('Set ADMIN_PASSWORD env var to create the admin login');
    else { await ref.set({ id: 'admin', role: 'admin', name: 'Admin', hash: bcrypt.hashSync(pw, 10) }); console.log('admin created'); }
  }
  const flag = db.collection('meta').doc('hubs_migrated');
  if (!(await flag.get()).exists) {
    const s = await db.collection('users').where('role', '==', 'agent').get();
    for (const d of s.docs) await db.collection('hubs').doc(d.id).set({ id: d.id, name: d.id });
    await flag.set({ at: Date.now() }); console.log('old hub logins migrated to hubs');
  }
})().catch(console.error);

app.listen(process.env.PORT || 3000, () => console.log('API up'));
