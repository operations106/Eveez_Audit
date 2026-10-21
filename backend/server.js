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
// Admin query: optional hubId + date range (from/to = ms timestamps). hubId + createdAt uses the same composite index as before.
const adminQuery = (o, lim) => {
  let q = db.collection('audits');
  if (o.hubId) q = q.where('hubId', '==', o.hubId);
  if (+o.from) q = q.where('createdAt', '>=', +o.from);
  if (+o.to) q = q.where('createdAt', '<=', +o.to);
  return q.orderBy('createdAt', 'desc').limit(lim);
};
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
  const snap = await adminQuery(req.query, 500).get();
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

// ---------- Email report (Brevo HTTP API; works on Render free since it is not SMTP) ----------
// Env: BREVO_API_KEY, MAIL_FROM (a sender email verified in Brevo)
const E = x => String(x ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const TZ = { timeZone: 'Asia/Kolkata' };
const fmtDT = ms => new Date(ms).toLocaleString('en-GB', { ...TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const csvDT = ms => new Date(ms).toLocaleString('sv-SE', TZ).slice(0, 16);
const dayStr = ms => new Date(ms).toLocaleDateString('en-CA', TZ);
const MAX_BYTES = 3.2 * 1024 * 1024, MAX_MAILS = 15;

async function sendMail(to, subject, html, attachment) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: process.env.MAIL_FROM, name: 'Vehicle Audit' }, to: to.map(email => ({ email })), subject, htmlContent: html, attachment: attachment && attachment.length ? attachment : undefined })
  });
  if (!r.ok) throw Error('mail failed: ' + (await r.text()).slice(0, 200));
}
const csvOf = rows => [['Date', 'Vehicle', 'Hub', 'Agent', 'Battery', 'Battery present', 'Category', 'Condition', 'Parts', 'RFD cost'],
  ...rows.map(a => [csvDT(a.createdAt), a.vehicleNo, a.hubName || a.hubId, a.agentName, a.batteryType, a.batteryPresent ? 'Yes' : 'No', a.category, a.condition, (a.parts || []).map(p => p.name + ' x' + p.qty).join('; '), a.rfdCost])]
  .map(r => r.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
const tableOf = rows => '<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font:13px Arial"><tr style="background:#14532d;color:#fff"><th>Date</th><th>Vehicle</th><th>Hub</th><th>Agent</th><th>Battery</th><th>Category</th><th>Cond.</th><th>RFD ₹</th></tr>' +
  rows.map(a => `<tr><td>${E(fmtDT(a.createdAt))}</td><td>${E(a.vehicleNo)}</td><td>${E(a.hubName || a.hubId)}</td><td>${E(a.agentName)}</td><td>${E(a.batteryType)}${a.batteryPresent ? '' : ' (missing)'}</td><td>${E(a.category)}</td><td>${E(a.condition)}</td><td align="right">${Math.round(a.rfdCost).toLocaleString('en-IN')}</td></tr>`).join('') + '</table>';

app.post('/api/email-report', auth(['admin']), async (req, res) => {
  try {
    if (!process.env.BREVO_API_KEY || !process.env.MAIL_FROM) return res.status(500).json({ error: 'email not set up: add BREVO_API_KEY and MAIL_FROM env vars on the server' });
    const to = String(req.body.emails || '').split(/[,;\s]+/).filter(Boolean);
    if (!to.length || to.length > 5 || !to.every(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) return res.status(400).json({ error: 'enter valid email (max 5, comma separated)' });
    const snap = await adminQuery(req.body, 1000).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!rows.length) return res.status(400).json({ error: 'no audits in this filter' });
    const total = rows.reduce((s, a) => s + a.rfdCost, 0);
    const range = (+req.body.from ? dayStr(+req.body.from) : 'start') + ' to ' + (+req.body.to ? dayStr(+req.body.to) : 'today');
    const head = `<p><b>Vehicle Audit report</b> · ${E(req.body.hubName || 'All hubs')} · ${E(range)}<br>${rows.length} vehicles · total RFD ₹${Math.round(total).toLocaleString('en-IN')}</p>`;
    const csv = { name: 'audit-report.csv', content: Buffer.from('\ufeff' + csvOf(rows)).toString('base64') };
    let mails = 1;
    // Mail 1: summary table + CSV
    const chunks = [];
    if (req.body.withPics) {
      let cur = { rows: [], att: [], size: 0 };
      rows.forEach((a, i) => {
        const att = (a.photos || []).map((p, n) => {
          const m = /^data:image\/(\w+);base64,(.+)$/.exec(p || ''); if (!m) return null;
          return { name: `${a.vehicleNo}_${dayStr(a.createdAt)}_a${i + 1}_${n + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`, content: m[2], size: m[2].length };
        }).filter(Boolean);
        if (!att.length) return;
        const sz = att.reduce((s, x) => s + x.size, 0);
        if (cur.size + sz > MAX_BYTES && cur.rows.length) { chunks.push(cur); cur = { rows: [], att: [], size: 0 }; }
        cur.rows.push(a); cur.att.push(...att.map(({ name, content }) => ({ name, content }))); cur.size += sz;
      });
      if (cur.rows.length) chunks.push(cur);
      if (chunks.length + 1 > MAX_MAILS) return res.status(400).json({ error: 'too many photos for one go, choose a shorter date range' });
    }
    await sendMail(to, `Vehicle Audit report · ${range}`, head + tableOf(rows) + (req.body.withPics ? `<p>Photos come in ${chunks.length} separate email(s).</p>` : ''), [csv]);
    for (let i = 0; i < chunks.length; i++) {
      await sendMail(to, `Vehicle Audit photos ${i + 1}/${chunks.length} · ${range}`, `<p>Photos ${i + 1}/${chunks.length} · file names start with vehicle number</p>` + tableOf(chunks[i].rows), chunks[i].att); mails++;
    }
    res.json({ ok: true, audits: rows.length, mails });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
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
