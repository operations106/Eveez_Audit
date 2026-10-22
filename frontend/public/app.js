const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dt = (t) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const BATT = ['Sun', 'Yuma', 'BS', 'Moving', 'Home Charging'];
const CATS = ['None', 'Minor Repair', 'Major Repair'];
const CONDS = ['Good', 'Bad', 'Poor'];
let S = { token: localStorage.getItem('tk'), user: JSON.parse(localStorage.getItem('us') || 'null'), tab: '', parts: [], form: null };

function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
async function api(path, method = 'GET', body) {
  const r = await fetch(API_URL + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token) { logout(); throw new Error('Login again'); }
  if (!r.ok) throw new Error(j.error || 'Error');
  return j;
}
function logout() { localStorage.clear(); S.token = null; S.user = null; render(); }

// ---------- image compression (max 800px, JPEG 60% ≈ 50-90KB) ----------
function compress(file, max = 800, q = 0.6) {
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(u); res(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => rej(new Error('Photo nahi khuli'));
    img.src = u;
  });
}

// ---------- views ----------
function render() {
  const app = $('#app');
  if (!S.token) return loginView(app);
  const admin = S.user.role === 'admin';
  const tabs = admin ? [['dash', 'Dashboard'], ['report', 'Report'], ['hubs', 'Hubs'], ['agents', 'Agents'], ['parts', 'Parts']] : [['new', 'New Audit'], ['report', 'My Audits']];
  if (!tabs.find((t) => t[0] === S.tab)) S.tab = tabs[0][0];
  app.innerHTML = `<header><b>EV Hub Audit</b><small>${admin ? 'Admin' : esc(S.user.name)}</small><button class="btn alt sm" id="lo">Logout</button></header>
  <nav>${tabs.map(([k, l]) => `<button data-t="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav><main id="main"></main>`;
  $('#lo').onclick = logout;
  app.querySelectorAll('nav button').forEach((b) => (b.onclick = () => { S.tab = b.dataset.t; render(); }));
  ({ new: newAuditView, dash: dashboardView, report: reportView, hubs: hubsView, agents: agentsView, parts: partsView })[S.tab]($('#main'));
}

function loginView(app) {
  app.innerHTML = `<div class="login"><h1>EV Hub Audit</h1><p class="muted">Apni Login ID se login karo.</p>
  <form id="loginForm" autocomplete="on">
    <label for="i">Login ID</label><input id="i" name="username" autocapitalize="none" autocomplete="username" required>
    <label for="p">Password</label><div class="pw"><input id="p" name="password" type="password" autocomplete="current-password" required><button type="button" class="eye" id="eye" aria-label="Password dikhao">Dikhao</button></div>
    <p class="err" id="e" role="alert" aria-live="polite"></p><button class="btn" id="go" type="submit" style="width:100%;margin-top:8px">Login</button>
  </form></div>`;

  const form = $('#loginForm');
  const idInput = $('#i', form);
  const passwordInput = $('#p', form);
  const error = $('#e', form);
  const button = $('#go', form);
  let loginInProgress = false;

  const go = async (event) => {
    if (event) event.preventDefault();
    if (loginInProgress) return;

    const id = idInput.value.trim();
    const password = passwordInput.value;
    if (!id || !password) {
      error.textContent = 'Login ID aur password dono bharein';
      if (!id) idInput.focus(); else passwordInput.focus();
      return;
    }

    loginInProgress = true;
    button.disabled = true;
    button.textContent = 'Logging in...';
    error.textContent = '';

    try {
      const r = await api('/login', 'POST', { id, password });
      S.token = r.token;
      S.user = r.user;
      localStorage.setItem('tk', r.token);
      localStorage.setItem('us', JSON.stringify(r.user));
      S.tab = '';
      render();
    } catch (e) {
      error.textContent = e.message || 'Login failed';
    } finally {
      loginInProgress = false;
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = 'Login';
      }
    }
  };

  $('#eye').onclick = () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    $('#eye').textContent = show ? 'Chhupao' : 'Dikhao';
    passwordInput.focus();
  };
  form.addEventListener('submit', go);
}

async function newAuditView(m) {
  if (!S.parts.length) S.parts = await api('/parts').catch(() => []);
  const hubs = await api('/hubs').catch(() => []);
  // Pehle se save draft (page refresh / app band hone par bhi wapas aa jayega)
  const dr = await api('/draft').catch(() => null);
  const f = { parts: [], photos: [] };
  const partById = (id) => S.parts.find((x) => x.id === id);
  if (dr) (dr.parts || []).forEach((p) => { const x = partById(p.id); if (x) f.parts.push({ id: x.id, name: x.name, price: x.price, qty: p.qty }); });
  const D = dr || {};
  const lastHub = localStorage.getItem('hub') || '';
  const hubSel = D.hubId || (hubs.some((h) => h.hubId === lastHub) ? lastHub : '');
  const chk = (cur, val, def) => ((cur || def) === val ? 'checked' : '');
  m.innerHTML = `<div class="card"><h2>Vehicle audit</h2>
  <div class="row"><div><label>Hub *</label><select id="hub"><option value="">— hub chuno —</option>${hubs.map((h) => `<option value="${esc(h.hubId)}" ${h.hubId === hubSel ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select></div>
  <div><label>Vehicle number *</label><input id="vn" placeholder="DL1SXX1234" autocapitalize="characters" value="${esc(D.vehicleNo || '')}"></div></div>
  <label>Battery type</label><div class="seg">${BATT.map((b) => `<label><input type="radio" name="bt" value="${b}" ${chk(D.batteryType, b, BATT[0])}><span>${b}</span></label>`).join('')}</div>
  <label>Battery vehicle me hai?</label><div class="seg"><label><input type="radio" name="bp" value="1" ${D.batteryPresent === false ? '' : 'checked'}><span>Haan</span></label><label><input type="radio" name="bp" value="0" ${D.batteryPresent === false ? 'checked' : ''}><span>Nahi</span></label></div>
  <div class="row"><div><label>Category</label><select id="cat">${CATS.map((c) => `<option ${c === (D.category || CATS[0]) ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
  <div><label>Condition</label><select id="cond">${CONDS.map((c) => `<option ${c === (D.condition || CONDS[0]) ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div></div>
  <div class="card"><div class="flex" style="align-items:center"><h2 style="margin:0;flex:3">Parts needed</h2><small class="muted" id="sst" style="flex:2;text-align:right"></small></div>
  <input id="psq" type="search" placeholder="Part search karo…" autocomplete="off" style="margin-top:10px">
  <div class="plist" id="pl"></div>
  <h2 style="margin:14px 0 4px;font-size:15px">Add kiye hue parts</h2>
  <div class="tw"><table id="pt"></table></div></div>
  <div class="card"><h2>Photos</h2><p class="muted" style="margin:0">Auto compress hoti hain (~60KB). Max 4. (Photos draft me save nahi hoti, Save se pehle page band na karein.)</p>
  <input id="ph" type="file" accept="image/*" capture="environment" multiple style="margin-top:8px"><div class="thumbs" id="th"></div></div>
  <div class="card"><label style="margin-top:0">Notes (optional)</label><textarea id="nt" rows="2">${esc(D.notes || '')}</textarea>
  <p>RFD cost: <span class="total" id="tot">₹0</span></p><div class="flex"><button class="btn" id="sv" style="flex:3">Save audit</button><button class="btn alt" id="rs" style="flex:1">Reset</button></div></div>`;

  // ----- draft autosave: ek ke baad ek, hamesha latest state bhejta hai -----
  let closed = false, timer = null, chain = Promise.resolve();
  const snap = () => ({
    vehicleNo: $('#vn').value, hubId: $('#hub').value, batteryType: $('input[name=bt]:checked').value,
    batteryPresent: $('input[name=bp]:checked').value === '1', category: $('#cat').value, condition: $('#cond').value,
    notes: $('#nt').value, parts: f.parts.map((p) => ({ id: p.id, qty: p.qty })),
  });
  const setSt = (t, bad) => { const e = $('#sst'); if (e) { e.textContent = t; e.className = bad ? 'no' : 'muted'; } };
  const persist = () => {
    clearTimeout(timer);
    if (closed) return chain;
    chain = chain.then(async () => {
      if (closed) return;
      try { setSt('Saving…'); await api('/draft', 'PUT', snap()); setSt('✓ Saved'); } catch { setSt('Save nahi hua — net check karo', true); }
    });
    return chain;
  };
  const later = () => { clearTimeout(timer); setSt('…'); timer = setTimeout(persist, 700); };
  ['#vn', '#nt'].forEach((id) => ($(id).oninput = later));
  ['#hub', '#cat', '#cond'].forEach((id) => ($(id).onchange = () => { if (id === '#hub') localStorage.setItem('hub', $('#hub').value); persist(); }));
  m.querySelectorAll('input[name=bt],input[name=bp]').forEach((r) => (r.onchange = persist));

  // ----- parts picker: poori list khuli hai, scroll karo, qty daalo, Add dabao -----
  const qty = {}; // part id -> abhi picker me chuni hui qty
  const q = (id) => Math.max(1, parseInt(qty[id]) || 1);
  const added = (id) => (f.parts.find((x) => x.id === id) || {}).qty || 0;
  const drawList = () => {
    const t = $('#psq').value.trim().toLowerCase();
    const words = t.split(/\s+/).filter(Boolean);
    const list = S.parts.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)));
    $('#pl').innerHTML = list.map((p) => `<div class="prow" data-id="${p.id}"><div class="pn"><b>${esc(p.name)}</b><small>${money(p.price)}${added(p.id) ? ` · <span class="yes">✓ ${added(p.id)} added</span>` : ''}</small></div>
      <div class="qty"><button type="button" class="qb" data-m aria-label="Kam">−</button><input type="number" inputmode="numeric" min="1" value="${q(p.id)}" aria-label="Quantity"><button type="button" class="qb" data-p aria-label="Zyada">+</button></div>
      <button type="button" class="btn sm" data-a>Add</button></div>`).join('') || '<p class="muted" style="padding:10px">Koi part nahi mila</p>';
  };
  $('#psq').oninput = drawList;
  $('#pl').addEventListener('click', (e) => {
    const row = e.target.closest('.prow'); if (!row) return;
    const id = row.dataset.id; const inp = $('input', row);
    if (e.target.closest('[data-m]')) { qty[id] = Math.max(1, q(id) - 1); inp.value = qty[id]; return; }
    if (e.target.closest('[data-p]')) { qty[id] = q(id) + 1; inp.value = qty[id]; return; }
    if (e.target.closest('[data-a]')) {
      if (!$('#vn').value.trim()) return toast('Pehle vehicle number daalo');
      const p = partById(id); const n = Math.max(1, parseInt(inp.value) || 1);
      const ex = f.parts.find((x) => x.id === id); ex ? (ex.qty += n) : f.parts.push({ id: p.id, name: p.name, price: p.price, qty: n });
      qty[id] = 1; draw(); toast(p.name + ' ×' + n + ' add hua'); persist();
    }
  });
  $('#pl').addEventListener('input', (e) => { const row = e.target.closest('.prow'); if (row && e.target.matches('input')) qty[row.dataset.id] = e.target.value; });

  const draw = () => {
    $('#pt').innerHTML = f.parts.length ? `<tr><th>Part</th><th class="num">Qty</th><th class="num">Price</th><th></th></tr>` + f.parts.map((p, i) =>
      `<tr><td>${esc(p.name)}</td><td class="num"><div class="qty sm"><button type="button" class="qb" data-dn="${i}">−</button><span>${p.qty}</span><button type="button" class="qb" data-up="${i}">+</button></div></td><td class="num">${money(p.price * p.qty)}</td><td><button class="btn red sm" data-r="${i}">✕</button></td></tr>`).join('') : '<tr><td class="muted">Abhi koi part nahi — upar list se Add karo</td></tr>';
    $('#pt').querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => { f.parts.splice(+b.dataset.r, 1); draw(); persist(); }));
    $('#pt').querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => { f.parts[+b.dataset.up].qty++; draw(); persist(); }));
    $('#pt').querySelectorAll('[data-dn]').forEach((b) => (b.onclick = () => { const p = f.parts[+b.dataset.dn]; if (p.qty > 1) { p.qty--; draw(); persist(); } }));
    $('#tot').textContent = money(f.parts.reduce((s, p) => s + p.price * p.qty, 0));
    $('#th').innerHTML = f.photos.map((p, i) => `<div><img src="${p}" alt="photo ${i + 1}"><button data-x="${i}" aria-label="Remove">✕</button></div>`).join('');
    $('#th').querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => { f.photos.splice(+b.dataset.x, 1); draw(); }));
    drawList();
  };
  draw();
  $('#ph').onchange = async (e) => {
    for (const file of [...e.target.files]) { if (f.photos.length >= 4) break; try { f.photos.push(await compress(file)); } catch (x) { toast(x.message); } }
    e.target.value = ''; draw();
  };
  $('#rs').onclick = async () => {
    if (!confirm('Ye vehicle ka draft hata kar naya form shuru karein?')) return;
    closed = true; clearTimeout(timer); await chain;
    await api('/draft', 'DELETE').catch(() => {}); newAuditView(m);
  };
  $('#sv').onclick = async () => {
    const vn = $('#vn').value.trim(); if (!vn) return toast('Vehicle number daalo');
    if (!$('#hub').value) return toast('Hub chuno');
    $('#sv').disabled = true;
    clearTimeout(timer); await chain; // pending draft save khatam hone do
    try {
      const r = await api('/audits', 'POST', { ...snap(), photos: f.photos });
      closed = true; localStorage.setItem('hub', $('#hub').value);
      toast('Saved — RFD ' + money(r.rfdCost)); newAuditView(m);
    } catch (e) { toast(e.message); $('#sv').disabled = false; }
  };
}

// ---------- shared: filters, charts, email ----------
const ymd = (d) => d.toLocaleDateString('en-CA');
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const groupBy = (a, f) => { const m = {}; a.forEach((x) => (m[f(x)] = m[f(x)] || []).push(x)); return m; };

async function filterBar(el, onApply) {
  const admin = S.user.role === 'admin';
  const hubs = await api('/hubs').catch(() => []);
  const opt = (arr, all) => `<option value="">${all}</option>` + arr.map((x) => `<option>${esc(x)}</option>`).join('');
  el.innerHTML = `<div class="card noprint"><div class="chips">${[['Aaj', 0], ['7 din', 6], ['30 din', 29], ['Sab', -1]].map(([l, d]) => `<button class="chip" data-d="${d}">${l}</button>`).join('')}</div><div class="flex">
  <div><label>Hub</label><select id="fh"><option value="">All hubs</option>${hubs.map((h) => `<option value="${esc(h.hubId)}">${esc(h.name)}</option>`).join('')}</select></div>
  ${admin ? `<div><label>Agent</label><select id="fa"></select></div><div><label>Condition</label><select id="fc">${opt(CONDS, 'All')}</select></div>
  <div><label>Category</label><select id="fk">${opt(CATS, 'All')}</select></div><div><label>Battery</label><select id="fb">${opt(BATT, 'All')}</select></div>` : ''}
  <div><label>From</label><input id="ff" type="date"></div><div><label>To</label><input id="ft" type="date"></div>
  <div><label>Vehicle no.</label><input id="fq"></div><button class="btn" id="fg">Show</button></div></div>`;
  const setRange = (d) => {
    if (d < 0) { $('#ff').value = ''; $('#ft').value = ''; return; }
    const a = new Date(); a.setDate(a.getDate() - d); $('#ff').value = ymd(a); $('#ft').value = ymd(new Date());
  };
  const loadAgents = async () => {
    if (!admin) return;
    const a = await api('/agents?hubId=' + encodeURIComponent($('#fh').value)).catch(() => []);
    // Agent filter must contain agent names only; tolerate either string or object API responses.
    const names = [...new Set((Array.isArray(a) ? a : []).map((x) => typeof x === 'string' ? x : (x && (x.agentName || x.name)) || '').map((x) => String(x).trim()).filter(Boolean))].sort((x, y) => x.localeCompare(y));
    const cur = $('#fa').value; $('#fa').innerHTML = opt(names, 'All agents'); $('#fa').value = names.includes(cur) ? cur : '';
  };
  if (admin) { $('#fh').onchange = loadAgents; await loadAgents(); }
  el.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { setRange(+c.dataset.d); onApply(); }));
  $('#fg').onclick = () => onApply();
  setRange(29);
  return () => {
    const g = (id) => ($(id) ? $(id).value : '');
    const p = { hubId: g('#fh'), agent: g('#fa'), condition: g('#fc'), category: g('#fk'), battery: g('#fb'), q: g('#fq') };
    if ($('#ff').value) p.from = new Date($('#ff').value + 'T00:00:00').getTime();
    if ($('#ft').value) p.to = new Date($('#ft').value + 'T23:59:59.999').getTime();
    Object.keys(p).forEach((k) => !p[k] && delete p[k]);
    return p;
  };
}

function emailBox(el, getP) {
  el.innerHTML = `<div class="card noprint"><h2>Report email karo</h2><div class="flex"><div style="flex:2"><label>To (comma se alag)</label><input id="et" value="${esc(localStorage.getItem('em') || '')}" placeholder="name@company.com"></div>
  <div style="flex:2"><label>Note (optional)</label><input id="en"></div><button class="btn" id="es">Send</button></div>
  <p class="muted" style="margin:8px 0 0">Upar ke filters ka summary + CSV attachment jayega.</p></div>`;
  $('#es').onclick = async () => {
    const b = $('#es'); b.disabled = true;
    try { localStorage.setItem('em', $('#et').value); const r = await api('/email-report', 'POST', { to: $('#et').value, note: $('#en').value, filters: getP() }); toast(r.sent + ' vehicles ka report bhej diya'); }
    catch (e) { toast(e.message); }
    b.disabled = false;
  };
}

function bars(items, fmt) {
  if (!items.length) return '<p class="muted">Data nahi</p>';
  const max = Math.max(1, ...items.map((i) => i.value));
  return '<div class="bars">' + items.map((i) => `<div class="bar"><span class="bl" title="${esc(i.label)}">${esc(i.label)}</span><div class="bt"><i style="width:${(i.value / max * 100).toFixed(1)}%;background:${i.color || 'var(--acc)'}"></i></div><span class="bv">${fmt(i.value)}${i.sub ? ` <small>${esc(i.sub)}</small>` : ''}</span></div>`).join('') + '</div>';
}
function stack(items) {
  const t = sum(items, (i) => i.value);
  if (!t) return '<p class="muted">Data nahi</p>';
  return `<div class="stack">${items.filter((i) => i.value).map((i) => `<i style="width:${i.value / t * 100}%;background:${i.color}" title="${esc(i.label)}: ${i.value}"></i>`).join('')}</div>
  <div class="legend">${items.map((i) => `<span><b style="background:${i.color}"></b>${esc(i.label)} <b class="n">${i.value}</b> <small>${Math.round(i.value / t * 100)}%</small></span>`).join('')}</div>`;
}
function trend(rows) {
  const days = {}; rows.forEach((r) => { const k = ymd(new Date(r.createdAt)); days[k] = (days[k] || 0) + 1; });
  const keys = Object.keys(days).sort(); if (!keys.length) return '<p class="muted">Data nahi</p>';
  const out = []; const d = new Date(keys[0] + 'T00:00:00'); const end = new Date(keys[keys.length - 1] + 'T00:00:00');
  while (d <= end && out.length < 62) { const k = ymd(d); out.push([k, days[k] || 0]); d.setDate(d.getDate() + 1); }
  const mx = Math.max(...out.map((o) => o[1])); const w = 600 / out.length;
  return `<svg viewBox="0 0 600 150" class="trend" role="img" aria-label="Daily audits">${out.map(([k, n], i) => { const h = n / mx * 105; return `<rect x="${(i * w + 1).toFixed(1)}" y="${(125 - h).toFixed(1)}" width="${Math.max(1, w - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--acc)"><title>${k}: ${n} vehicles</title></rect>`; }).join('')}
  <text x="0" y="146" class="tl">${out[0][0]}</text><text x="600" y="146" text-anchor="end" class="tl">${out[out.length - 1][0]}</text><text x="0" y="10" class="tl">max ${mx}/din</text></svg>`;
}

async function dashboardView(m) {
  m.innerHTML = '<div id="fb0"></div><div id="dash"></div><div id="em"></div>';
  let rows = [], metric = 'cost';
  const getP = await filterBar($('#fb0'), () => load());
  emailBox($('#em'), getP);
  const draw = () => {
    const cost = metric === 'cost';
    const mv = (v) => (cost ? sum(v, (r) => r.rfdCost) : v.length);
    const fmt = cost ? money : (n) => n;
    const sub = (v) => (cost ? v.length + ' veh' : money(sum(v, (r) => r.rfdCost)));
    const top = (keyf, n = 12) => Object.entries(groupBy(rows, keyf)).map(([k, v]) => ({ label: k, value: mv(v), sub: sub(v) })).sort((a, b) => b.value - a.value).slice(0, n);
    const total = sum(rows, (r) => r.rfdCost);
    const poor = rows.filter((r) => r.condition === 'Poor').length;
    const parts = {}; rows.forEach((r) => (r.parts || []).forEach((p) => { const x = parts[p.name] = parts[p.name] || { q: 0, c: 0 }; x.q += p.qty; x.c += p.qty * p.price; }));
    const cc = { Good: 'var(--good)', Bad: 'var(--warn)', Poor: 'var(--bad)' };
    const kc = { None: 'var(--good)', 'Minor Repair': 'var(--warn)', 'Major Repair': 'var(--bad)' };
    $('#dash').innerHTML = !rows.length ? '<div class="card muted">Is filter me koi audit nahi mila.</div>' : `
    <div class="kpis"><div class="kpi"><small>Vehicles audited</small><b>${rows.length}</b></div><div class="kpi"><small>Total RFD cost</small><b>${money(total)}</b></div>
    <div class="kpi"><small>Avg / vehicle</small><b>${money(total / rows.length)}</b></div><div class="kpi"><small>Battery missing</small><b class="no">${rows.filter((r) => !r.batteryPresent).length}</b></div>
    <div class="kpi"><small>Poor condition</small><b class="no">${poor} <small>(${Math.round(poor / rows.length * 100)}%)</small></b></div></div>
    <div class="card"><div class="flex" style="align-items:center"><h2 style="margin:0;flex:3">Hub-wise / Agent-wise</h2><div class="seg" style="flex:2"><label><input type="radio" name="mt" value="cost" ${cost ? 'checked' : ''}><span>RFD cost</span></label><label><input type="radio" name="mt" value="n" ${cost ? '' : 'checked'}><span>Vehicles</span></label></div></div></div>
    <div class="grid2"><div class="card"><h2>Hub-wise</h2>${bars(top((r) => r.hubId), fmt)}</div>
    <div class="card"><h2>Agent-wise</h2>${bars(top((r) => (r.agentName || '-') + ' (' + r.hubId + ')'), fmt)}</div>
    <div class="card"><h2>Condition</h2>${stack(CONDS.map((c) => ({ label: c, value: rows.filter((r) => r.condition === c).length, color: cc[c] })))}</div>
    <div class="card"><h2>Repair category</h2>${stack(CATS.map((c) => ({ label: c, value: rows.filter((r) => r.category === c).length, color: kc[c] })))}</div>
    <div class="card"><h2>Battery type</h2>${bars(top((r) => r.batteryType, 6), fmt)}</div>
    <div class="card"><h2>Top parts (cost)</h2>${bars(Object.entries(parts).sort((a, b) => b[1].c - a[1].c).slice(0, 10).map(([k, v]) => ({ label: k, value: v.c, sub: '×' + v.q })), money)}</div></div>
    <div class="card"><h2>Daily audits</h2>${trend(rows)}</div>
    <div class="card"><h2>Sabse zyada RFD cost (top 5)</h2><div class="tw"><table><tr><th>Vehicle</th><th>Hub</th><th>Agent</th><th>Condition</th><th class="num">RFD cost</th></tr>${[...rows].sort((a, b) => b.rfdCost - a.rfdCost).slice(0, 5).map((r) => `<tr><td><b>${esc(r.vehicleNo)}</b></td><td>${esc(r.hubId)}</td><td>${esc(r.agentName)}</td><td><span class="tag ${esc(r.condition)}">${esc(r.condition)}</span></td><td class="num"><b>${money(r.rfdCost)}</b></td></tr>`).join('')}</table></div></div>`;
    document.querySelectorAll('input[name=mt]').forEach((i) => (i.onchange = () => { metric = i.value; draw(); }));
  };
  const load = async () => { rows = await api('/audits?' + new URLSearchParams(getP())); draw(); };
  load();
}

async function reportView(m) {
  const admin = S.user.role === 'admin';
  m.innerHTML = `<div id="fb0"></div><div class="card"><div id="sum"></div><div class="tw"><table id="rt"></table></div>
  <div class="flex noprint" style="margin-top:12px"><button class="btn alt" id="csv">Download CSV</button><button class="btn alt" id="pr">Print</button></div></div><div id="det"></div>${admin ? '<div id="em"></div>' : ''}`;
  let rows = [];
  const getP = await filterBar($('#fb0'), () => load());
  if (admin) emailBox($('#em'), getP);
  const load = async () => {
    rows = await api('/audits?' + new URLSearchParams(getP()));
    const tot = sum(rows, (r) => r.rfdCost);
    $('#sum').innerHTML = `<p style="margin:0">${rows.length} vehicles audited · Total RFD cost <span class="total">${money(tot)}</span></p>`;
    $('#rt').innerHTML = `<tr><th>Vehicle</th><th>Hub</th>${admin ? '<th>Agent</th>' : ''}<th>Battery</th><th>Repair</th><th>Condition</th><th>Parts</th><th class="num">RFD cost</th><th>Date</th></tr>` +
      (rows.map((r) => `<tr data-id="${r.id}" style="cursor:pointer"><td><b>${esc(r.vehicleNo)}</b></td><td>${esc(r.hubId)}</td>${admin ? `<td>${esc(r.agentName)}</td>` : ''}
      <td>${esc(r.batteryType)} <span class="${r.batteryPresent ? 'yes' : 'no'}">${r.batteryPresent ? '✓' : 'missing'}</span></td><td>${esc(r.category)}</td>
      <td><span class="tag ${esc(r.condition)}">${esc(r.condition)}</span></td><td>${(r.parts || []).length}</td><td class="num"><b>${money(r.rfdCost)}</b></td><td>${dt(r.createdAt)}</td></tr>`).join('') || '<tr><td class="muted">Koi audit nahi mila</td></tr>');
    $('#rt').querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => detail(tr.dataset.id)));
  };
  const detail = async (id) => {
    const a = await api('/audits/' + id);
    $('#det').innerHTML = `<div class="card"><h2>${esc(a.vehicleNo)} — ${money(a.rfdCost)} to RFD</h2>
    <p>Hub <b>${esc(a.hubId)}</b> · Agent ${esc(a.agentName || '-')} · ${dt(a.createdAt)}<br>Battery: ${esc(a.batteryType)} (${a.batteryPresent ? 'present' : 'missing'}) · ${esc(a.category)} · <span class="tag ${esc(a.condition)}">${esc(a.condition)}</span></p>
    <div class="tw"><table><tr><th>Part</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr>${a.parts.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.qty}</td><td class="num">${money(p.price)}</td><td class="num">${money(p.price * p.qty)}</td></tr>`).join('') || '<tr><td class="muted">No parts</td></tr>'}</table></div>
    ${a.notes ? `<p>Notes: ${esc(a.notes)}</p>` : ''}<div class="thumbs">${(a.photos || []).map((p) => `<img src="${p}" alt="vehicle photo">`).join('')}</div>
    ${admin ? '<button class="btn red sm noprint" id="del" style="margin-top:10px">Delete audit</button>' : ''}</div>`;
    $('#det').scrollIntoView({ behavior: 'smooth' });
    if (admin) $('#del').onclick = async () => { if (confirm('Delete karein?')) { await api('/audits/' + id, 'DELETE'); $('#det').innerHTML = ''; load(); } };
  };
  $('#pr').onclick = () => print();
  $('#csv').onclick = () => {
    const h = ['Vehicle', 'Hub', 'Agent', 'Battery', 'Battery present', 'Category', 'Condition', 'Parts', 'RFD cost', 'Date'];
    const c = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const csv = [h, ...rows.map((r) => [r.vehicleNo, r.hubId, r.agentName, r.batteryType, r.batteryPresent ? 'Yes' : 'No', r.category, r.condition, (r.parts || []).map((p) => p.name + ' x' + p.qty).join('; '), r.rfdCost, new Date(r.createdAt).toISOString()])].map((r) => r.map(c).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' })); a.download = 'audit-report.csv'; a.click();
  };
  load();
}

async function hubsView(m) {
  const hubs = await api('/hubs');
  m.innerHTML = `<div class="card"><h2>Naya hub add karo</h2><div class="flex"><div style="flex:3"><label>Hub name</label><input id="hn" placeholder="Dwarka Hub"></div><button class="btn" id="ha">Add hub</button></div>
  <p class="muted" style="margin:8px 0 0">Hub ka login nahi hota — agent audit karte time hub select karega.</p></div>
  <div class="card"><h2>Hubs (${hubs.length})</h2><div class="tw"><table><tr><th>Hub ID</th><th>Name</th><th>Status</th><th></th></tr>${hubs.map((h) => `<tr><td><b>${esc(h.hubId)}</b></td><td>${esc(h.name)}</td><td>${h.active ? 'Active' : 'Disabled'}</td>
  <td><button class="btn alt sm" data-rn="${esc(h.hubId)}" data-n="${esc(h.name)}">Rename</button> <button class="btn alt sm" data-tg="${esc(h.hubId)}" data-a="${h.active}">${h.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('') || '<tr><td class="muted">Abhi koi hub nahi</td></tr>'}</table></div></div>`;
  $('#ha').onclick = async () => { try { await api('/hubs', 'POST', { name: $('#hn').value }); toast('Hub add ho gaya'); hubsView(m); } catch (e) { toast(e.message); } };
  m.querySelectorAll('[data-rn]').forEach((b) => (b.onclick = async () => { const n = prompt('Hub ka naya naam', b.dataset.n); if (n && n.trim()) { await api('/hubs/' + b.dataset.rn, 'PUT', { name: n }); hubsView(m); } }));
  m.querySelectorAll('[data-tg]').forEach((b) => (b.onclick = async () => { await api('/hubs/' + b.dataset.tg, 'PUT', { active: b.dataset.a !== 'true' }); hubsView(m); }));
}

async function agentsView(m) {
  const users = await api('/users');
  m.innerHTML = `<div class="card"><h2>Naya agent login</h2><div class="flex"><div><label>Login ID</label><input id="ui" autocapitalize="none"></div>
  <div><label>Agent name</label><input id="un"></div><div><label>Password</label><input id="up"></div><button class="btn" id="ua">Create</button></div></div>
  <div class="card"><h2>Agents (${users.length})</h2><div class="tw"><table><tr><th>Login ID</th><th>Name</th><th>Status</th><th></th></tr>${users.map((u) => `<tr><td><b>${esc(u.userId)}</b></td><td>${esc(u.name)}</td><td>${u.active ? 'Active' : 'Disabled'}</td>
  <td><button class="btn alt sm" data-pw="${esc(u.userId)}">Reset password</button> <button class="btn alt sm" data-tg="${esc(u.userId)}" data-a="${u.active}">${u.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('') || '<tr><td class="muted">Abhi koi agent nahi</td></tr>'}</table></div></div>`;
  $('#ua').onclick = async () => { try { await api('/users', 'POST', { userId: $('#ui').value, name: $('#un').value, password: $('#up').value }); toast('Agent ban gaya'); agentsView(m); } catch (e) { toast(e.message); } };
  m.querySelectorAll('[data-pw]').forEach((b) => (b.onclick = async () => { const p = prompt('Naya password'); if (p) { await api('/users/' + b.dataset.pw, 'PUT', { password: p }); toast('Updated'); } }));
  m.querySelectorAll('[data-tg]').forEach((b) => (b.onclick = async () => { await api('/users/' + b.dataset.tg, 'PUT', { active: b.dataset.a !== 'true' }); agentsView(m); }));
}

async function partsView(m) {
  S.parts = await api('/parts');
  m.innerHTML = `<div class="card"><h2>Add part</h2><div class="flex"><div><label>Part name</label><input id="pn"></div><div><label>Price (₹)</label><input id="pp" type="number" min="0"></div><button class="btn" id="pa">Add</button></div></div>
  <div class="card"><h2>Bulk import</h2><p class="muted" style="margin:0">Har line me: <code>Part name, price</code></p><textarea id="bk" rows="4" placeholder="Front brake pad, 250&#10;Controller, 3200"></textarea><button class="btn alt" id="bb" style="margin-top:8px">Import</button></div>
  <div class="card"><h2>Parts list (${S.parts.length})</h2><div class="tw"><table><tr><th>Part</th><th class="num">Price</th><th></th></tr>${S.parts.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${money(p.price)}</td>
  <td><button class="btn alt sm" data-e="${p.id}">Edit</button> <button class="btn red sm" data-d="${p.id}">✕</button></td></tr>`).join('')}</table></div></div>`;
  $('#pa').onclick = async () => { try { await api('/parts', 'POST', { name: $('#pn').value, price: $('#pp').value }); partsView(m); } catch (e) { toast(e.message); } };
  $('#bb').onclick = async () => { const r = await api('/parts/bulk', 'POST', { text: $('#bk').value }); toast(r.added + ' parts add hue'); partsView(m); };
  m.querySelectorAll('[data-d]').forEach((b) => (b.onclick = async () => { if (confirm('Delete part?')) { await api('/parts/' + b.dataset.d, 'DELETE'); partsView(m); } }));
  m.querySelectorAll('[data-e]').forEach((b) => (b.onclick = async () => {
    const p = S.parts.find((x) => x.id === b.dataset.e); const name = prompt('Part name', p.name); if (name === null) return;
    const price = prompt('Price', p.price); if (price === null) return;
    await api('/parts/' + p.id, 'PUT', { name, price }); partsView(m);
  }));
}
render();
