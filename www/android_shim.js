/* Skoulas Fishing — Android: αντικαθιστά τον Python server μέσα στο κινητό.
   Υλοποιεί τα ίδια /api/* με το PC (ίδιες απαντήσεις, ίδιοι έλεγχοι), με δεδομένα στο IndexedDB.
   Η πρόγνωση (Open-Meteo), τα βάθη (EMODnet) και ο χάρτης ακτών έρχονται απευθείας· η πρόγνωση είναι μοντέλο, όχι μέτρηση. */
(function () {
  'use strict';
  const origFetch = window.fetch.bind(window);
  const enc = new TextEncoder();
  const J = (v) => JSON.stringify(v);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const now = () => Date.now() / 1000;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  class Err extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const bad = (m) => new Err(400, m);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /* ---------- IndexedDB ---------- */
  const STORES = ['spots', 'gear', 'sessions', 'catches', 'kv'];
  let idb = null;
  const mem = { spots: [], gear: [], sessions: [], catches: [], kv: {} };
  let seqN = 0;
  function openDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('skoulas-fishing', 1);
      r.onupgradeneeded = () => { for (const s of STORES) r.result.createObjectStore(s, { keyPath: s === 'kv' ? 'k' : 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  function tx(ops) {                       // ops: [[store,'put'|'delete',value|key]] — μία ατομική συναλλαγή
    return new Promise((res, rej) => {
      if (!ops.length) return res();
      const t = idb.transaction([...new Set(ops.map((o) => o[0]))], 'readwrite');
      for (const [s, op, v] of ops) t.objectStore(s)[op](v);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  function readAll(store) {
    return new Promise((res, rej) => { const q = idb.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  }
  async function init() {
    idb = await openDb();
    for (const s of ['spots', 'gear', 'sessions', 'catches']) mem[s] = (await readAll(s)).sort((a, b) => a.seq - b.seq);
    for (const r of await readAll('kv')) mem.kv[r.k] = r.v;
    seqN = Math.max(0, ...['spots', 'gear', 'sessions', 'catches'].flatMap((s) => mem[s].map((r) => r.seq)));
    if (!mem.kv.seeded) {
      const seed = await (await origFetch('/seed.json')).json();
      const ops = [];
      for (const s of seed.spots) { const r = { id: s.id, legacy: s.legacy, name: s.name, lat: s.lat, lng: s.lng, raw: J(s.raw), created: s.created, seq: ++seqN }; mem.spots.push(r); ops.push(['spots', 'put', r]); }
      for (const g of seed.gear) { const r = { id: g.id, legacy: g.legacy, tech: g.raw.tech, raw: J(g.raw), seq: ++seqN }; mem.gear.push(r); ops.push(['gear', 'put', r]); }
      mem.kv.seeded = true; ops.push(['kv', 'put', { k: 'seeded', v: true }]);
      await tx(ops);
    }
    SEED = await (await origFetch('/seed.json')).json();
  }
  let SEED = null;
  const setKv = (k, v) => { mem.kv[k] = v; return tx([['kv', 'put', { k, v }]]); };

  /* ---------- ψαρότοποι ---------- */
  const ALT_MAX = 2000;
  function distM(a1, o1, a2, o2) {
    const p = Math.PI / 180, a = Math.sin((a2 - a1) * p / 2) ** 2 + Math.cos(a1 * p) * Math.cos(a2 * p) * Math.sin((o2 - o1) * p / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function validAlt(value, lat, lng) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || value.length > 2) throw bad('Μη έγκυρες διορθώσεις A1/A2');
    const out = [];
    for (const it of value) {
      if (it === null) { out.push(null); continue; }
      if (!isObj(it)) throw bad('Μη έγκυρη διόρθωση A1/A2');
      if (!isNum(it.lat) || !isNum(it.lng) || Math.abs(it.lat) > 90 || Math.abs(it.lng) > 180) throw bad('Μη έγκυρες συντεταγμένες A1/A2');
      if (distM(lat, lng, it.lat, it.lng) > ALT_MAX) throw bad('Το A' + (out.length + 1) + ' απέχει πάνω από ' + ALT_MAX + ' m από το Κύριο στίγμα');
      out.push({ lat: it.lat, lng: it.lng, savedAt: typeof it.savedAt === 'string' && it.savedAt.length <= 40 ? it.savedAt : null });
    }
    return out;
  }
  function validSpot(d) {
    if (!isObj(d)) throw bad('Αναμένονται στοιχεία ψαρότοπου');
    const name = d.name;
    if (typeof name !== 'string' || !(name.trim().length > 0 && name.trim().length <= 150)) throw bad('Συμπλήρωσε όνομα έως 150 χαρακτήρες');
    const lat = d.lat !== undefined ? d.lat : d.latitude, lng = d.lng !== undefined ? d.lng : d.longitude;
    if (!isNum(lat) || !isNum(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw bad('Μη έγκυρες συντεταγμένες');
    const r = Object.assign({}, d, { name: name.trim(), lat, lng }); delete r.latitude; delete r.longitude;
    if ('alternativeOverrides' in r) r.alternativeOverrides = validAlt(r.alternativeOverrides, lat, lng);
    return r;
  }
  const digits = (v) => v !== null && v !== undefined && /^[0-9]+$/.test(String(v));
  function spotApi(r) {
    let item; try { item = JSON.parse(r.raw); if (!isObj(item)) item = {}; } catch (e) { item = {}; }
    return Object.assign(item, { id: digits(r.legacy) ? parseInt(r.legacy, 10) : r.id, name: r.name, lat: r.lat, lng: r.lng });
  }
  const spotSorted = () => mem.spots.slice().sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
  const findSpot = (key) => mem.spots.find((s) => s.id === key || s.legacy === key);
  async function spotsRoute(method, path, body) {
    const key = path.length > '/api/spots/'.length ? decodeURIComponent(path.slice('/api/spots/'.length)) : null;
    if (method === 'GET' && !key) return [200, spotSorted().map(spotApi)];
    if (method === 'POST' && !key) {
      const data = validSpot(body), used = new Set(mem.spots.filter((s) => digits(s.legacy)).map((s) => parseInt(s.legacy, 10)));
      let legacy = Math.max(0, ...used) + 1; while (used.has(legacy)) legacy++;
      data.id = legacy;
      const r = { id: uuid(), legacy: String(legacy), name: data.name, lat: data.lat, lng: data.lng, raw: J(data), created: new Date().toISOString(), seq: ++seqN };
      await tx([['spots', 'put', r]]); mem.spots.push(r); return [201, data];
    }
    if (method === 'PUT' && key) {
      const data = validSpot(body), row = findSpot(key);
      if (!row) throw new Err(404, 'Δεν βρέθηκε ο ψαρότοπος');
      data.id = digits(row.legacy) ? parseInt(row.legacy, 10) : row.id;
      const nr = Object.assign({}, row, { name: data.name, lat: data.lat, lng: data.lng, raw: J(data) });
      await tx([['spots', 'put', nr]]); mem.spots[mem.spots.indexOf(row)] = nr; return [200, data];
    }
    if (method === 'DELETE' && key) {
      const row = findSpot(key);
      if (!row) return [404, { deleted: false }];
      if (mem.sessions.some((s) => s.spotId === row.id)) throw new Err(409, 'Ο ψαρότοπος χρησιμοποιείται σε εξόρμηση');
      await tx([['spots', 'delete', row.id]]); mem.spots.splice(mem.spots.indexOf(row), 1); return [200, { deleted: true }];
    }
    throw new Err(404, 'Δεν βρέθηκε η διαδρομή');
  }

  /* ---------- εξοπλισμός ---------- */
  async function gearRoute(method, path, body) {
    const key = path.startsWith('/api/gear/') ? decodeURIComponent(path.slice('/api/gear/'.length)) : null;
    if (method === 'GET' && path === '/api/gear') return [200, mem.gear.map((g) => JSON.parse(g.raw))];
    if (!((method === 'POST' && path === '/api/gear') || ((method === 'PUT' || method === 'DELETE') && key))) throw new Err(404, 'Δεν βρέθηκε η διαδρομή');
    let data = null;
    if (method !== 'DELETE') {
      data = body;
      if (!isObj(data) || ['tech', 'combo', 'lures', 'targets'].some((k) => typeof data[k] !== 'string') || !data.tech.trim() || !data.combo.trim()) throw bad('Μη έγκυρα στοιχεία εξοπλισμού');
    }
    if (method === 'POST') {
      const sid = uuid(); data.id = 'g-' + sid;
      const r = { id: sid, legacy: data.id, tech: data.tech, raw: J(data), seq: ++seqN };
      await tx([['gear', 'put', r]]); mem.gear.push(r); return [201, data];
    }
    const row = mem.gear.find((g) => g.id === key || g.legacy === key);
    if (!row) throw new Err(404, 'Δεν βρέθηκε το σετ');
    if (method === 'DELETE') { await tx([['gear', 'delete', row.id]]); mem.gear.splice(mem.gear.indexOf(row), 1); return [200, { deleted: true }]; }
    const merged = Object.assign(JSON.parse(row.raw), data); merged.id = row.legacy || row.id;
    const nr = Object.assign({}, row, { tech: merged.tech, raw: J(merged) });
    await tx([['gear', 'put', nr]]); mem.gear[mem.gear.indexOf(row)] = nr; return [200, merged];
  }

  /* ---------- ημερολόγιο (ίδιοι έλεγχοι με diary_api.py) ---------- */
  const ident = (v) => { if (!(typeof v === 'string' || typeof v === 'number') || !/^[A-Za-z0-9_-]{1,128}$/.test(String(v))) throw bad('Μη έγκυρο ID'); return String(v); };
  function num(v, lo, hi, name, integer) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || v !== v || !(lo <= v && v <= hi) || (integer && Math.trunc(v) !== v)) throw bad('Μη έγκυρο πεδίο αλιεύματος: ' + name);
    return v;
  }
  function checkCatch(x) {
    const qty = num(x.qty, 1, 999, 'qty', true), length = num(x.lengthCm, 0.1, 300, 'lengthCm');
    num(x.depthM, 0, 200, 'depthM'); num(x.distM, 0, 500, 'distM');
    if (x.released !== undefined && x.released !== null && x.released !== 'kept' && x.released !== 'released') throw bad('Μη έγκυρο πεδίο αλιεύματος: released');
    if (x.zone !== undefined && x.zone !== null && typeof x.zone !== 'string') throw bad('Μη έγκυρο πεδίο αλιεύματος: zone');
    for (const k of ['obs', 'lureObj']) if (x[k] !== undefined && x[k] !== null && !isObj(x[k])) throw bad('Μη έγκυρο πεδίο αλιεύματος: ' + k);
    const env = x.env;
    if (env !== undefined && env !== null && (!isObj(env) || (env.items !== undefined && !isObj(env.items)))) throw bad('Μη έγκυρο στιγμιότυπο συνθηκών');
    return [qty === null ? 1 : qty, length];
  }
  const optNum = (v) => v === undefined || v === null || (typeof v === 'number');
  function checkSession(s) {
    for (const e of s.efforts || []) {
      if (!isObj(e) || (e.lure !== undefined && !isObj(e.lure))) throw bad('Μη έγκυρη προσπάθεια');
      for (const k of ['start', 'end']) if (!optNum(e[k])) throw bad('Μη έγκυρη προσπάθεια');
    }
    if (s.obs !== undefined && s.obs !== null && !isObj(s.obs)) throw bad('Μη έγκυρες παρατηρήσεις');
    for (const p of s.pauses || []) {
      if (!isObj(p) || s.pauses.length > 500) throw bad('Μη έγκυρη παύση');
      for (const k of ['start', 'end']) if (!optNum(p[k])) throw bad('Μη έγκυρη παύση');
      if (p.reason !== undefined && p.reason !== null && typeof p.reason !== 'string') throw bad('Μη έγκυρη παύση');
    }
    const evs = s.events || [];
    if (!Array.isArray(evs) || evs.length > 2000) throw bad('Μη έγκυρα γεγονότα');
    for (const e of evs) {
      if (!isObj(e) || (e.type !== 'bite' && e.type !== 'lost') || typeof e.t !== 'number') throw bad('Μη έγκυρο γεγονός');
      for (const k of ['size', 'cause']) if (e[k] !== undefined && e[k] !== null && typeof e[k] !== 'string') throw bad('Μη έγκυρο γεγονός');
      if (e.sn !== undefined && e.sn !== null && !isObj(e.sn)) throw bad('Μη έγκυρο γεγονός');
    }
    const smp = s.samples || [];
    if (!Array.isArray(smp) || smp.length > 400) throw bad('Μη έγκυρα δείγματα συνθηκών');
    for (const x of smp) if (!isObj(x) || typeof x.t !== 'number' || (x.v !== undefined && !isObj(x.v))) throw bad('Μη έγκυρο δείγμα συνθηκών');
    const env = s.env0;
    if (env !== undefined && env !== null && (!isObj(env) || (env.items !== undefined && !isObj(env.items)))) throw bad('Μη έγκυρο στιγμιότυπο συνθηκών');
  }
  function hash(str) {                      // cyrb53 — αρκεί για αλλαγή κατάστασης (revision)
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  function diaryState() {
    const cmp = (a, b) => { const x = a.started, y = b.started; if (x !== y) { if (x == null) return 1; if (y == null) return -1; return x < y ? 1 : -1; } return b.seq - a.seq; };
    const sessions = mem.sessions.slice().sort(cmp).map((r) => JSON.parse(r.raw));
    const catches = mem.catches.slice().sort((a, b) => b.seq - a.seq).map((r) => JSON.parse(r.raw));
    for (const s of sessions) s.catches = catches.filter((x) => String(x.sessionId) === String(s.id));
    const active = sessions.filter((s) => !s.endTime);
    const result = { activeSession: active[0] || null, completedSessions: sessions.filter((s) => s.endTime), catchLog: catches };
    result.revision = hash(J(result));
    return result;
  }
  function diaryWrite(d) {                  // επιστρέφει λίστα ops για tx + εφαρμογή στη μνήμη μετά την επιτυχία
    if (!isObj(d) || !Array.isArray(d.completedSessions) || !Array.isArray(d.catchLog)) throw bad('Μη έγκυρο ημερολόγιο');
    const active = d.activeSession === undefined ? null : d.activeSession;
    const sessions = d.completedSessions.concat(active !== null ? [active] : []);
    const ss = new Map(), cc = new Map();
    for (const s of sessions) {
      if (!isObj(s)) throw bad('Μη έγκυρη εξόρμηση');
      const k = ident(s.id);
      if (ss.has(k) || (s.catches !== undefined && !Array.isArray(s.catches)) || (s !== active && !s.endTime) || (s === active && s.endTime)) throw bad('Μη έγκυρη εξόρμηση');
      checkSession(s); ss.set(k, s);
      for (const x of s.catches || []) { const y = Object.assign({}, x, { sessionId: s.id }); cc.set(ident(y.id), y); }
    }
    for (const x of d.catchLog.slice().reverse()) {
      const k = ident(x.id), old = cc.get(k);
      if (old && String(old.sessionId) !== String(x.sessionId)) throw bad('Αντικρουόμενα αλιεύματα');
      cc.set(k, x);
    }
    const ops = [], nSess = mem.sessions.slice(), nCat = mem.catches.slice();
    let seq = seqN;
    for (const [k, s] of ss) {
      const spot = findSpot(String(s.spotId));
      const started = typeof s.startTimestamp === 'number' ? new Date(s.startTimestamp).toISOString() : (s.date || null);
      const ended = s.endTimestamp || (s.endTime ? (s.date || '') + 'T' + s.endTime : null);
      const raw = J(Object.assign({}, s, { catches: [] }));
      const i = nSess.findIndex((r) => r.id === k);
      const rec = i >= 0 ? Object.assign({}, nSess[i], { ended, status: s === active ? 'active' : 'completed', raw })
        : { id: k, started, ended, status: s === active ? 'active' : 'completed', spotId: spot ? spot.id : null, raw, seq: ++seq };
      if (i >= 0) nSess[i] = rec; else nSess.push(rec);
      ops.push(['sessions', 'put', rec]);
    }
    for (const [k, x] of cc) {
      let sid = x.sessionId !== undefined && x.sessionId !== null ? String(x.sessionId) : null;
      if (sid && !ss.has(sid)) sid = null;
      const w = x.grams, species = x.species;
      if (typeof species !== 'string' || !species.trim() || (w !== undefined && w !== null && (typeof w !== 'number' || !(w >= 0 && w <= 100000)))) throw bad('Μη έγκυρο αλίευμα');
      checkCatch(x);
      const i = nCat.findIndex((r) => r.id === k), raw = J(x);
      const rec = i >= 0 ? Object.assign({}, nCat[i], { raw }) : { id: k, raw, seq: ++seq };
      if (i >= 0) nCat[i] = rec; else nCat.push(rec);
      ops.push(['catches', 'put', rec]);
    }
    const keepC = nCat.filter((r) => cc.has(r.id)), keepS = nSess.filter((r) => ss.has(r.id));
    for (const r of nCat) if (!cc.has(r.id)) ops.push(['catches', 'delete', r.id]);
    for (const r of nSess) if (!ss.has(r.id)) ops.push(['sessions', 'delete', r.id]);
    return { ops, sessions: keepS, catches: keepC, seq };
  }
  async function applyDiary(d) {
    const w = diaryWrite(d); await tx(w.ops); mem.sessions = w.sessions; mem.catches = w.catches; seqN = w.seq;
  }
  async function diaryRoute(method, path, body) {
    if (method === 'GET') { const d = diaryState(); return [200, path === '/api/diary' ? d : path === '/api/catches' ? d.catchLog : d.completedSessions.concat(d.activeSession ? [d.activeSession] : [])]; }
    if (method !== 'PUT' || path !== '/api/diary') throw new Err(405, 'Χρησιμοποιήστε PUT /api/diary');
    const old = diaryState();
    if (!isObj(body)) throw bad('Μη έγκυρο JSON');
    if (body.revision !== old.revision) throw new Err(409, 'Το ημερολόγιο άλλαξε. Ανανεώστε τη σελίδα.');
    if (old.activeSession && body.activeSession && String(old.activeSession.id) !== String(body.activeSession.id) &&
        !(body.completedSessions || []).some((s) => String(s.id) === String(old.activeSession.id))) throw new Err(409, 'Υπάρχει ήδη ενεργή εξόρμηση. Ανανεώστε τη σελίδα και ολοκληρώστε την πρώτα.');
    await applyDiary(body); return [200, diaryState()];
  }

  /* ---------- πρόγνωση Open-Meteo (μοντέλο, όχι μέτρηση) ---------- */
  const SOURCES = {
    weather: ['https://api.open-meteo.com/v1/forecast', { wind_speed_10m: 'km/h', wind_direction_10m: '°', wind_gusts_10m: 'km/h', pressure_msl: 'hPa', temperature_2m: '°C', cloud_cover: '%', precipitation: 'mm', weather_code: 'wmo code' }],
    marine: ['https://marine-api.open-meteo.com/v1/marine', { wave_height: 'm', wave_direction: '°', wave_period: 's', sea_surface_temperature: '°C', ocean_current_velocity: 'km/h', ocean_current_direction: '°', sea_level_height_msl: 'm' }],
  };
  const INTERVAL = { weather: 1800, marine: 3600 };
  const BFT = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  const beaufort = (v) => { if (!Number.isFinite(v) || v < 0) throw new Error('Invalid wind speed'); let n = 0; while (n < BFT.length && BFT[n] <= v) n++; return n; };
  function omValidate(item, fields) {
    const h = item.hourly, units = item.hourly_units, times = h.time;
    if (!Array.isArray(times) || times.length !== 168 || times.some((t) => !Number.isInteger(t)) || times.some((t, i) => i && t - times[i - 1] !== 3600) || item.utc_offset_seconds !== 0) throw new Error('Invalid UTC hourly timeline');
    if (!(Math.abs(item.latitude) <= 90 && Math.abs(item.longitude) <= 180)) throw new Error('Invalid model coordinates');
    const missing = {}, values = {}, accepted = {};
    for (const [key, unit] of Object.entries(fields)) {
      let a = h[key];
      if (!Array.isArray(a) || a.length !== times.length || units[key] !== unit) a = times.map(() => null);
      a = a.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
      values[key] = a; accepted[key] = unit; missing[key] = a.filter((v) => v === null).length;
    }
    return { grid_latitude: item.latitude, grid_longitude: item.longitude, time_utc: times, units: accepted, values, missing, status: Object.values(missing).some((n) => n) ? 'partial' : 'complete' };
  }
  async function omFetch(kind, spots) {
    const [url, fields] = SOURCES[kind];
    const p = new URLSearchParams({ latitude: spots.map((s) => s.latitude).join(','), longitude: spots.map((s) => s.longitude).join(','), hourly: Object.keys(fields).join(','), forecast_days: '7', timezone: 'GMT', timeformat: 'unixtime', wind_speed_unit: 'kmh' });
    if (kind === 'marine') { p.set('cell_selection', 'sea'); p.set('length_unit', 'metric'); }
    const r = await origFetch(url + '?' + p, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let data = await r.json(); if (!Array.isArray(data)) data = [data];
    if (data.length !== spots.length) throw new Error('Unexpected location count');
    return data.map((it) => omValidate(it, fields));
  }
  function omCheck(kind, rows, spots, t) {
    if (rows.length !== spots.length) throw new Error('Location count mismatch');
    const fields = SOURCES[kind][1];
    for (const r of rows) {
      const ts = r.time_utc;
      if (ts.length !== 168 || !(ts[0] <= t && t < ts[ts.length - 1] + 3600)) throw new Error('Invalid or expired timeline');
      if (J(ts) !== J(rows[0].time_utc) || J(r.units) !== J(fields) || r.status !== 'complete' || Object.values(r.missing).some((n) => n)) throw new Error('Incomplete forecast');
      for (const k of Object.keys(fields)) {
        const a = r.values[k];
        if (a.length !== 168 || a.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('Invalid values: ' + k);
        if ((k.includes('direction') && a.some((v) => v < 0 || v > 360)) || (k === 'cloud_cover' && a.some((v) => v < 0 || v > 100)) ||
            (['wind_speed_10m', 'wind_gusts_10m', 'wave_height', 'wave_period', 'ocean_current_velocity', 'precipitation'].includes(k) && Math.min(...a) < 0)) throw new Error('Out of range: ' + k);
      }
      if (kind === 'weather') r.derived = { wind_speed_bft: r.values.wind_speed_10m.map(beaufort), wind_gust_equivalent_bft: r.values.wind_gusts_10m.map(beaufort) };
    }
  }
  const envSpots = () => mem.spots.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => ({ id: s.id, name: s.name, latitude: s.lat, longitude: s.lng }));
  const sig = (sp) => J(sp.map((s) => [s.id, s.latitude, s.longitude]));
  let refreshing = null;
  async function envRefresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const spots = envSpots(); if (!spots.length) return;
      let data = mem.kv.env;
      const changed = !data || sig(data.spots) !== sig(spots);
      if (changed) data = { schema_version: 2, source: 'Open-Meteo', data_type: 'model_forecast', spots, datasets: {} };
      const t = now(), stamp = (e) => new Date(e * 1000).toISOString();
      await Promise.all(Object.keys(INTERVAL).map(async (kind) => {
        const prev = data.datasets[kind], age = prev ? t - prev.fetched_at_epoch : null;
        if (prev && age >= 0 && age < INTERVAL[kind]) return;
        try {
          const rows = await omFetch(kind, spots); omCheck(kind, rows, spots, now());
          const f = now(); data.datasets[kind] = { fetched_at_epoch: f, fetched_at_utc: stamp(f), rows, last_attempt_utc: stamp(f), last_error: null };
        } catch (e) { if (prev) { prev.last_error = String(e && e.message || e); prev.last_attempt_utc = stamp(now()); } }
      }));
      data.spots = spots; await setKv('env', data);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function envRoute() {
    await envRefresh().catch(() => {});
    const data = mem.kv.env;
    if (!data) throw new Err(503, 'Περιβαλλοντικά δεδομένα προσωρινά μη διαθέσιμα');
    const current = new Map(mem.spots.map((s) => [s.id, s])), t = now();
    const result = { schema_version: data.schema_version, source: data.source, data_type: data.data_type, spots: [], datasets: {} };
    data.spots.forEach((spot, i) => {
      const row = current.get(spot.id);
      if (!row || row.lat !== spot.latitude || row.lng !== spot.longitude) return;
      result.spots.push(Object.assign({}, spot, { name: row.name, api_id: digits(row.legacy) ? parseInt(row.legacy, 10) : row.id, cache_index: i }));
    });
    for (const kind of Object.keys(INTERVAL)) {
      const ds = data.datasets[kind];
      if (!ds) { result.datasets[kind] = { status: 'UNAVAILABLE', rows: {} }; continue; }
      const age = t - ds.fetched_at_epoch, mapped = {};
      for (const s of result.spots) mapped[s.id] = ds.rows[s.cache_index];
      const valid = ds.rows.length > 0 && ds.rows.every((r) => r.time_utc[0] <= t && t < r.time_utc[r.time_utc.length - 1] + 3600);
      const status = !valid ? 'EXPIRED' : (age < 0 || age >= INTERVAL[kind] || ds.last_error) ? 'STALE' : 'FRESH';
      result.datasets[kind] = Object.assign({}, ds, { rows: mapped, status, age_seconds: Math.round(age * 10) / 10, refresh_failed: !!ds.last_error, forecast_valid_now: valid, refresh_interval_seconds: INTERVAL[kind] });
    }
    for (const s of result.spots) delete s.cache_index;
    const have = new Set(result.spots.map((s) => s.id));
    result.missing_spot_ids = mem.spots.map((s) => s.id).filter((id) => !have.has(id)).sort();
    return [200, result];
  }

  /* ---------- βάθη EMODnet (κελί 1/16 arcmin, cache 30 ημερών) ---------- */
  const CELL = 1 / 960, TTL_OK = 30 * 86400, TTL_FAIL = 60;
  async function bathyRemote(lat, lng) {
    let last = null;
    for (let i = 0; i < 3; i++) {
      try {
        const p = new URLSearchParams({ geom: 'POINT(' + lng.toFixed(6) + ' ' + lat.toFixed(6) + ')' });
        const r = await origFetch('https://rest.emodnet-bathymetry.eu/depth_sample?' + p, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        if (!isObj(d) || !('avg' in d)) throw new Error('bad response');
        const v = d.avg;
        return v === null ? null : (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 11000 ? v : null);
      } catch (e) { last = e; if (i < 2) await new Promise((r) => setTimeout(r, 300 * 2 ** i)); }
    }
    throw new Error(String(last));
  }
  let bathySave = null;
  async function bathyRoute(q) {
    const lat = parseFloat(q.get('lat')), lng = parseFloat(q.get('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) throw bad('Invalid coordinates or response');
    const cache = mem.kv.bathy || (mem.kv.bathy = {}), c0 = Math.floor(lat / CELL), c1 = Math.floor(lng / CELL), key = c0 + ',' + c1, t = now();
    const entry = cache[key], base = { source: 'EMODnet DTM 2024', cell: key, cellSizeM: 115 };
    if (entry && entry.ok && t - entry.t < TTL_OK) return [200, Object.assign(base, { depth: entry.d, status: 'cached', fetchedAt: entry.t })];
    if (entry && !entry.ok && t - entry.t < TTL_FAIL) return [200, Object.assign(base, { depth: null, status: 'unavailable', fetchedAt: null })];
    try {
      const depth = await bathyRemote((c0 + 0.5) * CELL, (c1 + 0.5) * CELL);
      cache[key] = { ok: true, d: depth, t };
      const keys = Object.keys(cache);
      if (keys.length > 20000) keys.sort((a, b) => cache[a].t - cache[b].t).slice(0, 2000).forEach((k) => delete cache[k]);
      clearTimeout(bathySave); bathySave = setTimeout(() => setKv('bathy', cache).catch(() => {}), 1500);
      return [200, Object.assign(base, { depth, status: 'live', fetchedAt: t })];
    } catch (e) {
      if (entry && entry.ok) return [200, Object.assign(base, { depth: entry.d, status: 'stale', fetchedAt: entry.t })];
      cache[key] = { ok: false, t };
      return [200, Object.assign(base, { depth: null, status: 'unavailable', fetchedAt: null })];
    }
  }

  /* ---------- ακτογραμμή OSM (τοπικό αρχείο coast.json) ---------- */
  let ways = null;
  async function coastRoute(q) {
    const lat = parseFloat(q.get('lat')), lng = parseFloat(q.get('lng')), radius = parseFloat(q.get('radius'));
    if (![lat, lng, radius].every(Number.isFinite) || !(Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && radius >= 1 && radius <= 1000)) throw new Err(503, 'Local coastline unavailable');
    if (!ways) ways = await (await origFetch('/coast.json')).json();
    const sx = 111195 * Math.cos(lat * Math.PI / 180), sy = 111195, out = [];
    for (const [man, pts] of ways) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = pts[i], [c, d] = pts[i + 1];
        if ((Math.min(a, c) - lat) * sy > radius || (lat - Math.max(a, c)) * sy > radius || (Math.min(b, d) - lng) * sx > radius || (lng - Math.max(b, d)) * sx > radius) continue;   // γρήγορο φιλτράρισμα (πλαίσιο τμήματος)
        const x = (b - lng) * sx, y = (a - lat) * sy, u = (d - b) * sx, v = (c - a) * sy, len = Math.hypot(u, v);
        if (!len) continue;
        const t = Math.max(0, Math.min(1, -(x * u + y * v) / (len * len)));
        if (Math.hypot(x + t * u, y + t * v) > radius) continue;
        const lo = Math.max(0, t - radius / len), hi = Math.min(1, t + radius / len), n = Math.max(1, Math.ceil((hi - lo) * len / 12));
        for (let k = 0; k <= n; k++) {
          const qq = lo + (hi - lo) * k / n;
          if (Math.hypot(x + qq * u, y + qq * v) <= radius) out.push({ lat: a + qq * (c - a), lng: b + qq * (d - b), isManMade: !!man, seaFacingDeg: man ? null : ((Math.atan2(v, -u) * 180 / Math.PI) + 360) % 360, geometrySource: 'OSM local' });
        }
      }
    }
    return [200, { nodes: out, source: 'OpenStreetMap local' }];
  }

  /* ---------- αντίγραφο ασφαλείας / επαναφορά ---------- */
  async function replaceAll(data) {
    const ops = [];
    for (const s of mem.spots) ops.push(['spots', 'delete', s.id]);
    for (const g of mem.gear) ops.push(['gear', 'delete', g.id]);
    for (const s of mem.sessions) ops.push(['sessions', 'delete', s.id]);
    for (const c of mem.catches) ops.push(['catches', 'delete', c.id]);
    const spots = [], gear = [];
    for (const s of data.spots) {
      const v = validSpot(Object.assign({}, s)), isNumId = digits(s.id);
      const r = { id: isNumId ? uuid() : String(s.id), legacy: isNumId ? String(s.id) : null, name: v.name, lat: v.lat, lng: v.lng, raw: J(v), created: new Date(Date.now() + spots.length).toISOString(), seq: ++seqN };
      spots.push(r); ops.push(['spots', 'put', r]);
    }
    for (const g of data.gearArsenal) {
      const id = uuid(), legacy = g.id !== undefined && g.id !== null ? String(g.id) : 'g-' + id;
      const raw = Object.assign({}, g, { id: legacy }); if (typeof raw.tech !== 'string') throw bad('Μη έγκυρα στοιχεία εξοπλισμού');
      const r = { id, legacy, tech: raw.tech, raw: J(raw), seq: ++seqN }; gear.push(r); ops.push(['gear', 'put', r]);
    }
    const savedSpots = mem.spots, savedGear = mem.gear, savedS = mem.sessions, savedC = mem.catches;
    mem.spots = spots; mem.gear = gear; mem.sessions = []; mem.catches = [];
    try {
      const w = diaryWrite({ completedSessions: data.completedSessions, catchLog: data.catchLog, activeSession: data.activeSession || null });
      await tx(ops.concat(w.ops)); mem.sessions = w.sessions; mem.catches = w.catches; seqN = w.seq;
    } catch (e) { mem.spots = savedSpots; mem.gear = savedGear; mem.sessions = savedS; mem.catches = savedC; throw e; }
    mem.kv.env = undefined; await tx([['kv', 'delete', 'env']]);
  }

  /* ---------- αποθήκευση/κοινοποίηση αρχείου (CSV, αντίγραφο) ---------- */
  async function save(name, mime, text) {
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (P && P.Filesystem && P.Share) {
      try {
        const r = await P.Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
        await P.Share.share({ title: name, url: r.uri, dialogTitle: 'Αποθήκευση / αποστολή αρχείου' });
        return true;
      } catch (e) { if (e && /cancel/i.test(String(e.message || e))) return false; console.warn('Share failed, fallback', e); }
    }
    const blob = new Blob([text], { type: mime }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000); return true;
  }

  /* ---------- Wake Lock μέσω Capacitor KeepAwake, όταν υπάρχει ---------- */
  try {
    const K = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KeepAwake;
    if (K && K.keepAwake) {
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { await K.keepAwake(); const l = { release: async () => { try { await K.allowSleep(); } catch (e) {} }, addEventListener() {} }; return l; } } });
    }
  } catch (e) { /* κανονική Wake Lock του WebView */ }

  /* ---------- δρομολόγηση fetch ---------- */
  const ready = init();
  const respond = (status, payload) => new Response(J(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  window.fetch = async function (input, init) {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); } catch (e) { return origFetch(input, init); }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return origFetch(input, init);
    const method = ((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase(), path = url.pathname;
    try {
      await ready;
      let body; if (init && typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch (e) { throw bad('Μη έγκυρο JSON'); } }
      let out;
      if (path === '/api/spots' || path.startsWith('/api/spots/')) out = await spotsRoute(method, path, body);
      else if (path === '/api/gear' || path.startsWith('/api/gear/')) out = await gearRoute(method, path, body);
      else if (path === '/api/diary' || path === '/api/sessions' || path === '/api/catches') out = await diaryRoute(method, path, body);
      else if (method === 'GET' && path === '/api/environment') out = await envRoute();
      else if (method === 'GET' && path === '/api/bathy') out = await bathyRoute(url.searchParams);
      else if (method === 'GET' && path === '/api/coastline') out = await coastRoute(url.searchParams);
      else if (method === 'GET' && path === '/api/species') out = [200, SEED.species];
      else if (method === 'GET' && path === '/api/species-literature') out = [200, SEED.literature];
      else throw new Err(404, 'Δεν βρέθηκε η διαδρομή');
      return respond(out[0], out[1]);
    } catch (e) {
      if (e instanceof Err) return respond(e.status, { error: e.message });
      console.error('[Android shim]', e); return respond(500, { error: 'Σφάλμα αποθήκευσης στο κινητό' });
    }
  };

  window.SkoulasAndroid = { replaceAll: async (d) => { await ready; return replaceAll(d); }, save, ready, _mem: mem };
  window.skoulasSave = save;
})();
