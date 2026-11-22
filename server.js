const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { once } = require('events');
const { exec } = require('child_process');
const http = require('http');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.WFT_DATA ? path.resolve(process.env.WFT_DATA) : path.join(ROOT, 'data');
// The two folders the user actually browses live in their own profile, not in data\.
const HOME = os.homedir();
const DOWNLOADS_DIR = path.join(HOME, 'Downloads');
const DOCUMENTS_DIR = path.join(HOME, 'Documents');
const UPLOAD_DIR = process.env.WFT_UPLOADS
  ? path.resolve(process.env.WFT_UPLOADS)
  : path.join(fs.existsSync(DOWNLOADS_DIR) ? DOWNLOADS_DIR : DOCUMENTS_DIR, 'WiFi File Transfer', 'من الهاتف');
const SHARED_DIR = process.env.WFT_SHARED
  ? path.resolve(process.env.WFT_SHARED)
  : path.join(DOCUMENTS_DIR, 'WiFi File Transfer', 'إلى الهاتف');
const RECYCLE_DIR = path.join(DATA_DIR, '_deleted');
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
const CRASH_LOG = path.join(DATA_DIR, 'crash.log');
const CLIPS_FILE = path.join(DATA_DIR, 'clips.json');
const PORT_FILE = path.join(DATA_DIR, 'port.txt');
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const START_PORT = Number(process.env.PORT) || 3000;

// Older builds kept the data next to the program; move anything still there into data\.
// Runs on every start, but only moves an item when data\ has no copy of it yet.
if (!process.env.WFT_DATA) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const name of ['uploads', 'shared', 'token.txt', 'clips.json', 'port.txt', 'server.pid', 'crash.log', 'server.log', 'server.err.log']) {
    const from = path.join(ROOT, name);
    const to = path.join(DATA_DIR, name);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) {
      try {
        // an empty data\shared or data\uploads created by start.bat can be replaced by the real one
        if (!fs.statSync(from).isDirectory() || !fs.statSync(to).isDirectory() || fs.readdirSync(to).length) continue;
        fs.rmdirSync(to);
      } catch {
        continue;
      }
    }
    try {
      fs.renameSync(from, to);
    } catch {}
  }
}

function loadToken() {
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved;
  } catch {}
  const fresh = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, fresh + '\n');
  return fresh;
}

const TOKEN = loadToken();
// Short human code shown next to this computer's IP; proves the two devices belong to the same owner.
// Approval-based pairing between computers on the home network.
// links: tokens WE issued and enforce ({token, name, ip, perms, createdAt})
// outPeers: tokens the other side issued for our browser ({token, name, host, port, perms, createdAt})
const PEERS_FILE = path.join(DATA_DIR, 'peers.json');
let links = [];
let outPeers = [];
try {
  const saved = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8'));
  if (Array.isArray(saved.links)) links = saved.links;
  if (Array.isArray(saved.outPeers)) outPeers = saved.outPeers;
} catch {}
function savePeers() {
  fsp.writeFile(PEERS_FILE, JSON.stringify({ links, outPeers })).catch(() => {});
}

function logCrash(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : err}\n`;
  try {
    fs.appendFileSync(CRASH_LOG, line);
  } catch {}
  console.error(line);
}

process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (err) => logCrash('unhandledRejection', err));

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(SHARED_DIR, { recursive: true });
fs.mkdirSync(RECYCLE_DIR, { recursive: true });

// Earlier builds kept both visible folders inside data\; move their contents to the
// user's own folders once, without overwriting anything already there.
function moveEntries(from, to) {
  if (path.resolve(from) === path.resolve(to)) return;
  let names;
  try {
    names = fs.readdirSync(from);
  } catch {
    return;
  }
  try {
    fs.mkdirSync(to, { recursive: true });
  } catch {
    return;
  }
  for (const name of names) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    try {
      if (fs.statSync(src).isDirectory()) moveEntries(src, dst);
      else if (!fs.existsSync(dst)) fs.renameSync(src, dst);
    } catch {}
  }
}
moveEntries(path.join(DATA_DIR, 'uploads'), UPLOAD_DIR);
moveEntries(path.join(DATA_DIR, 'shared'), SHARED_DIR);

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json());

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1';
}

function localIPs() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) candidates.push({ name, address: n.address });
    }
  }
  const isPrivate = (a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  const physical = (c) => !/virtual|vmware|vbox|vethernet|loopback|bluetooth|docker|wsl/i.test(c.name);
  const rank = (c) => (isPrivate(c.address) && physical(c) ? 0 : isPrivate(c.address) ? 1 : 2);
  const seen = new Set();
  return candidates
    .sort((a, b) => rank(a) - rank(b))
    .map((c) => c.address)
    .filter((a) => (seen.has(a) ? false : seen.add(a)));
}

function getLocalIP() {
  return localIPs()[0] || '127.0.0.1';
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const UNAUTHORIZED_HTML = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>رابط غير صالح</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070b16;color:#e8eef9;font-family:'Segoe UI',Tahoma,sans-serif;text-align:center;">
<div style="padding:32px;max-width:420px;">
<div style="font-size:44px;margin-bottom:16px;">🔒</div>
<h1 style="font-size:20px;margin:0 0 12px;">الرابط غير صالح</h1>
<p style="color:#8fa0c0;line-height:1.8;margin:0;">افتح الرابط من الباركود الظاهر على شاشة الكمبيوتر، وتأكد أن الجوال على نفس شبكة الواي فاي.</p>
</div>
<script>
// browsers that drop cookies on exit still keep localStorage: retry with the remembered token
try {
  var t = localStorage.getItem('wft_token');
  if (t && !/[?&]t=/.test(location.search)) location.replace('/?t=' + encodeURIComponent(t));
} catch (e) {}
</script>
</body></html>`;

// Another computer's browser calls these endpoints directly.
app.use('/api', (req, res, next) => {
  if (req.path === '/upload' || req.path === '/clips') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.sendStatus(204);
  }
  next();
});

const pendingIn = new Map(); // requests others sent us: {id, originId, back, name, ip, port, createdAt, decision?, token?, perms?}
const pendingOut = new Map(); // requests we sent: {id, host, port, createdAt, status, perms}
const PAIR_TTL = 10 * 60 * 1000;
function sweepPending() {
  const now = Date.now();
  for (const m of [pendingIn, pendingOut]) {
    for (const [k, v] of m) if (now - v.createdAt > PAIR_TTL) m.delete(k);
  }
}
// grant the other side a token without another prompt: used when the approver picked "both" (the owner
// already initiated this pairing, so the reverse link needs no second confirmation)
function approveBack(p, perms) {
  p.decision = 'approved';
  p.perms = perms;
  p.token = crypto.randomBytes(18).toString('base64url');
  links = links.filter((l) => l.ip !== p.ip);
  links.push({ token: p.token, name: p.name, ip: p.ip, perms, createdAt: Date.now() });
  savePeers();
  broadcast('pair');
}
function autoApproveBackFrom(ip) {
  for (const p of pendingIn.values()) {
    if (p.back && !p.decision && p.ip === ip) approveBack(p, 'both');
  }
}
setInterval(sweepPending, 60 * 1000).unref();

function ownerOnly(req) {
  return isLoopback(req) || req.query.t === TOKEN || readCookie(req.headers.cookie, 'ft_token') === TOKEN;
}
function lanOnly(req, res) {
  if (!isPrivateLanReq(req)) {
    res.status(403).json({ error: 'للشبكة المحلية فقط' });
    return false;
  }
  return true;
}
function lanRequest(host, port, path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = http.request(
      {
        host,
        port,
        path,
        method,
        timeout: 5000,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch {
            resolve({});
          }
        });
      }
    );
    rq.on('timeout', () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}
const lanPost = (host, port, path, body) => lanRequest(host, port, path, 'POST', body).catch(() => {});
// pairing steps are order-sensitive and fire-and-forget, so repeat once in case the first shot raced the listener
const lanPostRetry = (host, port, path, body) => {
  lanPost(host, port, path, body);
  setTimeout(() => lanPost(host, port, path, body), 3000).unref();
};

// Our browser asks to pair with another computer; the request lands on its screen for approval.
app.post('/api/pair/request', (req, res) => {
  if (!ownerOnly(req)) return res.status(401).end();
  const host = String((req.body && req.body.host) || '').trim();
  const port = Number((req.body && req.body.port) || 3000);
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return res.status(400).json({ error: 'عنوان غير صالح' });
  const existing = [...pendingOut.values()].find((o) => o.host === host && o.status === 'sent');
  if (existing) return res.json({ ok: true, id: existing.id, reused: true });
  const id = crypto.randomBytes(6).toString('hex');
  pendingOut.set(id, { id, host, port, createdAt: Date.now(), status: 'sent' });
  lanPostRetry(host, port, '/api/pair/inbound', { name: os.hostname(), originId: id, port: req.socket.localPort, back: false });
  res.json({ ok: true, id });
});

// Another computer asks to pair with us (server-to-server, local network only).
app.post('/api/pair/inbound', (req, res) => {
  if (!lanOnly(req, res)) return;
  const b = req.body || {};
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!ip || !b.name) return res.status(400).json({ error: 'بيانات ناقصة' });
  // repeats from the same device (the sender retries after 3s) must not stack duplicate prompts
  const same = [...pendingIn.values()].filter((x) => x.ip === ip && x.back === !!b.back);
  const live = same.find((x) => !x.decision);
  if (live) return res.json({ ok: true, id: live.id, reused: true });
  const answered = b.originId ? same.find((x) => x.decision === 'approved' && x.originId === String(b.originId)) : null;
  if (answered) {
    lanPost(ip, answered.port, '/api/pair/notify', { requestId: answered.originId, status: 'approved', token: answered.token, name: os.hostname(), perms: answered.perms });
    return res.json({ ok: true, id: answered.id, reused: true });
  }
  const id = crypto.randomBytes(6).toString('hex');
  const p = {
    id,
    originId: String(b.originId || ''),
    back: !!b.back,
    name: String(b.name).slice(0, 60),
    ip,
    port: Number(b.port) || 3000,
    createdAt: Date.now(),
  };
  pendingIn.set(id, p);
  // a back request that follows our own just-approved "both" pairing needs no second prompt
  const bothApproved = [...pendingOut.values()].some((o) => o.host === ip && o.status === 'approved' && o.perms === 'both');
  if (p.back && bothApproved) approveBack(p, 'both');
  else broadcast('pair');
  res.json({ ok: true, id });
});

// Our browser answers a pairing request: approve (with a permission level) or decline.
app.post('/api/pair/respond', (req, res) => {
  if (!ownerOnly(req)) return res.status(401).end();
  const b = req.body || {};
  const p = pendingIn.get(String(b.id || ''));
  if (!p || p.decision) return res.status(404).json({ error: 'الطلب منتهي — اطلب من الطرف الآخر إعادة الربط' });
  const perms = ['both', 'send', 'recv'].includes(b.perms) ? b.perms : 'both';
  p.decision = b.decision === 'decline' ? 'declined' : 'approved';
  p.perms = perms;
  if (p.decision === 'approved') {
    p.token = crypto.randomBytes(18).toString('base64url');
    // one live link per device: a re-pair must replace (not add to) the old permission level
    links = links.filter((l) => l.ip !== p.ip);
    links.push({ token: p.token, name: p.name, ip: p.ip, perms, createdAt: Date.now() });
    savePeers();
    lanPostRetry(p.ip, p.port, '/api/pair/notify', {
      requestId: p.originId,
      status: 'approved',
      token: p.token,
      name: os.hostname(),
      perms,
    });
    if (perms === 'both' && !p.back) {
      lanPost(p.ip, p.port, '/api/pair/inbound', { name: os.hostname(), port: req.socket.localPort, back: true }).then((r) => {
        const rid = r && r.id;
        if (!rid) return;
        const deadline = Date.now() + 5 * 60 * 1000;
        const poll = () => {
          lanRequest(p.ip, p.port, `/api/pair/inbound-status?id=${rid}`, 'GET')
            .then((st) => {
              if (st && st.status === 'approved' && st.token) {
                outPeers = outPeers.filter((o) => o.host !== p.ip);
                outPeers.push({ token: st.token, name: st.name || p.name, host: p.ip, port: p.port, perms: st.perms || 'both', createdAt: Date.now() });
                savePeers();
                broadcast('pair');
              } else if (st && st.status === 'pending' && Date.now() < deadline) {
                setTimeout(poll, 2000);
              }
            })
            .catch(() => {});
        };
        poll();
      });
    }
  } else {
    lanPost(p.ip, p.port, '/api/pair/notify', { requestId: p.originId, status: 'declined' });
  }
  broadcast('pair');
  res.json({ ok: true });
});

// The other side learns the result of a request it sent us (server-to-server).
app.post('/api/pair/notify', (req, res) => {
  if (!lanOnly(req, res)) return;
  const b = req.body || {};
  const p = pendingOut.get(String(b.requestId || ''));
  if (p && p.status === 'sent') {
    p.status = b.status === 'approved' ? 'approved' : 'declined';
    p.perms = ['both', 'send', 'recv'].includes(b.perms) ? b.perms : 'both';
    if (p.status === 'approved' && b.token) {
      outPeers = outPeers.filter((o) => o.host !== p.host);
      outPeers.push({ token: b.token, name: b.name || p.host, host: p.host, port: p.port, perms: p.perms, createdAt: Date.now() });
      savePeers();
      // the other side may already have sent its back request before this notify landed
      if (p.perms === 'both') autoApproveBackFrom(p.host);
    }
    broadcast('pair');
  }
  res.json({ ok: true });
});

// The requester polls this after asking us back, to learn the token we issued (server-to-server).
app.get('/api/pair/inbound-status', (req, res) => {
  if (!lanOnly(req, res)) return;
  const p = pendingIn.get(String(req.query.id || ''));
  if (!p) return res.json({ status: 'gone' });
  res.json({ status: p.decision || 'pending', token: p.token, name: p.name, perms: p.perms });
});

app.get('/api/pair/inbound', (req, res) => {
  if (!ownerOnly(req)) return res.status(401).end();
  sweepPending();
  res.json({
    requests: [...pendingIn.values()]
      .filter((p) => !p.decision)
      .map(({ id, name, ip, createdAt }) => ({ id, name, ip, createdAt })),
  });
});

// Our browser's list of approved outbound peers (synced into its localStorage).
app.get('/api/pair/out-peers', (req, res) => {
  if (!ownerOnly(req)) return res.status(401).end();
  res.json({ peers: outPeers });
});

// Our browser disconnected a peer: drop our token for it and tell it to drop ours.
app.post('/api/peers/disconnect', (req, res) => {
  if (!ownerOnly(req)) return res.status(401).end();
  const b = req.body || {};
  const host = String(b.host || '');
  const token = String(b.token || '');
  links = links.filter((l) => l.ip !== host);
  outPeers = outPeers.filter((p) => p.host !== host);
  savePeers();
  broadcast('pair');
  lanPost(host, Number(b.port) || 3000, '/api/pair/revoke', { token });
  res.json({ ok: true });
});

// The other side asks us to forget a token it no longer wants (server-to-server).
app.post('/api/pair/revoke', (req, res) => {
  if (!lanOnly(req, res)) return;
  const token = String((req.body && req.body.token) || '');
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  links = links.filter((l) => l.token !== token);
  // the revoker also gave us a token we still hold — drop our outbound entry back to it
  outPeers = outPeers.filter((p) => p.token !== token && p.host !== ip);
  savePeers();
  broadcast('pair');
  res.json({ ok: true });
});

function isPrivateLanReq(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

function identityOf(req) {
  if (isLoopback(req)) return { kind: 'owner' };
  const t = req.query.t || readCookie(req.headers.cookie, 'ft_token');
  if (t && t === TOKEN) return { kind: 'owner' };
  if (t) {
    const link = links.find((l) => l.token === t);
    if (link) return { kind: 'peer', link };
  }
  return null;
}

// What a paired peer may do here: 'send' = upload/post texts to us, 'recv' = view/download our shared files.
function can(req, perm) {
  if (!req.user || req.user.kind === 'owner') return true;
  const p = req.user.link.perms;
  return p === 'both' || p === perm;
}

const PEER_ALLOWED = new Set(['GET:/api/files', 'GET:/api/download', 'GET:/api/clips', 'POST:/api/upload', 'POST:/api/clips', 'GET:/api/events', 'GET:/api/ping']);

app.use((req, res, next) => {
  if (isLoopback(req)) {
    req.user = { kind: 'owner' };
    return next();
  }
  // devices on the home network may read this computer's name so the page can list it
  if (req.path === '/api/peer' && req.method === 'GET' && isPrivateLanReq(req)) return next();
  const id = identityOf(req);
  if (!id) return res.status(401).type('html').send(UNAUTHORIZED_HTML);
  if (id.kind === 'owner' && req.query.t === TOKEN) {
    res.setHeader('Set-Cookie', `ft_token=${TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  if (id.kind === 'peer' && req.path.startsWith('/api/') && !PEER_ALLOWED.has(req.method + ':' + req.path)) {
    return res.status(403).json({ ok: false, error: 'هذه العملية تحتاج صلاحية المالك' });
  }
  req.user = id;
  next();
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

function decodeName(name) {
  if (!name) return 'file';
  if (/[^\u0000-\u00FF]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

function safeName(name) {
  const base = path.basename(String(name).replace(/\\/g, '/'));
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001F]/g, '_').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 180) : 'file';
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${base} (${i++})${ext}`;
  return candidate;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir =
      req.query.to === 'shared'
        ? SHARED_DIR
        : path.join(UPLOAD_DIR, new Date().toISOString().slice(0, 10));
    req._dir = dir;
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename(req, file, cb) {
    cb(null, uniqueName(req._dir, safeName(decodeName(file.originalname))));
  },
});

const upload = multer({ storage, limits: { files: 100 } });

function uploadError(err) {
  if (err.code === 'ENOSPC') return 'امتلأ قرص الكمبيوتر';
  if (err.code === 'EACCES' || err.code === 'EPERM') return 'لا توجد صلاحية للكتابة في المجلد';
  if (err.code === 'LIMIT_FILE_COUNT') return 'عدد الملفات أكبر من المسموح';
  return 'تعذر حفظ الملف (' + (err.code || err.message) + ')';
}

let qrCache = { url: '', data: '' };

app.get('/api/info', async (req, res) => {
  try {
    const port = req.socket.localPort;
    const url = `http://${getLocalIP()}:${port}/?t=${TOKEN}`;
    if (qrCache.url !== url) {
      qrCache = {
        url,
        data: await QRCode.toDataURL(url, {
          margin: 1,
          width: 520,
          errorCorrectionLevel: 'M',
          color: { dark: '#0b1020', light: '#ffffff' },
        }),
      };
    }
    res.set('Cache-Control', 'no-store');
    res.json({ url, qr: qrCache.data, isLocal: isLoopback(req) });
  } catch (err) {
    res.status(500).json({ error: 'تعذر إنشاء رابط الاتصال' });
  }
});

app.get('/api/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.get('/api/peer', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ name: os.hostname(), port: req.socket.localPort, addresses: localIPs() });
});

// Probes the home subnet for other copies of the app so the page can list them.
app.get('/api/scan', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const self = localIPs()[0];
  if (!self) return res.json({ devices: [] });
  const prefix = self.replace(/\.\d+$/, '.');
  const mine = new Set(localIPs());
  const jobs = [];
  for (let h = 1; h <= 254; h++) {
    const host = prefix + h;
    if (mine.has(host)) continue;
    for (const port of [3000, 3001, 3002, 3003]) jobs.push({ host, port });
  }
  const found = new Map();
  let i = 0;
  const probe = (host, port) =>
    new Promise((resolve) => {
      const rq = http.get({ host, port, path: '/api/peer', timeout: 400 }, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j && j.name && Array.isArray(j.addresses) && !found.has(host)) found.set(host, { host, port, name: j.name });
          } catch {}
          resolve();
        });
      });
      rq.on('timeout', () => rq.destroy());
      rq.on('error', () => resolve());
      rq.on('close', () => resolve());
    });
  const worker = async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      await probe(j.host, j.port);
    }
  };
  await Promise.all(Array.from({ length: 96 }, worker));
  res.json({ devices: [...found.values()] });
});

app.post('/api/upload', (req, res) => {
  if (!can(req, 'send')) return res.status(403).json({ ok: false, error: 'الصلاحية الممنوحة لا تسمح بالإرسال إليك' });
  upload.array('files', 100)(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: uploadError(err) });
    if (!req.files || !req.files.length) {
      return res.status(400).json({ ok: false, error: 'لم تصل أي ملفات' });
    }
    if (req.query.to === 'shared') broadcast('files');
    res.json({
      ok: true,
      files: req.files.map((f) => ({ name: path.basename(f.filename), size: f.size })),
    });
  });
});

async function listDir(dir, max = 500) {
  const out = [];
  async function walk(current, prefix) {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (prefix.split('/').length < 4) await walk(full, prefix ? `${prefix}/${e.name}` : e.name);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      out.push({ rel: prefix ? `${prefix}/${e.name}` : e.name, size: st.size, mtime: st.mtimeMs });
    }
  }
  await walk(dir, '');
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

app.get('/api/files', async (req, res) => {
  if (!can(req, 'recv')) return res.status(403).json({ ok: false, error: 'الصلاحية الممنوحة لا تسمح باستعراض الملفات' });
  const files = await listDir(SHARED_DIR);
  res.json({ files });
});

function sharedPath(rel) {
  const base = path.resolve(SHARED_DIR);
  const target = path.resolve(base, String(rel || ''));
  return target.startsWith(base + path.sep) ? target : null;
}

// Only formats that cannot run scripts are served inline (no html/svg).
const INLINE_OK = /\.(jpe?g|png|gif|webp|bmp|avif|mp4|webm|m4v|mov|mp3|wav|m4a|ogg|opus|pdf)$/i;

app.get('/api/download', (req, res) => {
  if (!can(req, 'recv')) return res.status(403).json({ ok: false, error: 'الصلاحية الممنوحة لا تسمح بالتحميل' });
  const target = sharedPath(req.query.rel);
  if (!target) return res.status(400).json({ error: 'مسار غير صالح' });
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ error: 'الملف غير موجود' });
    if (req.query.inline && INLINE_OK.test(target)) {
      return res.sendFile(target, { dotfiles: 'allow', headers: { 'Content-Disposition': 'inline' } });
    }
    res.download(target, path.basename(target), { dotfiles: 'allow' });
  });
});

app.delete('/api/files', async (req, res) => {
  const target = sharedPath(req.query.rel);
  if (!target) return res.status(400).json({ ok: false, error: 'مسار غير صالح' });
  const day = path.join(RECYCLE_DIR, new Date().toISOString().slice(0, 10));
  try {
    await fsp.mkdir(day, { recursive: true });
    await fsp.rename(target, path.join(day, uniqueName(day, path.basename(target))));
    broadcast('files');
    res.json({ ok: true });
  } catch {
    res.status(404).json({ ok: false, error: 'تعذر نقل الملف إلى المحذوفات' });
  }
});

// Store-only ZIP, streamed. shortcut: no zip64, so files >= 4 GB are skipped; upgrade if that matters.
const CRC_T = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crcOf(file) {
  return new Promise((resolve, reject) => {
    let c = 0xffffffff;
    fs.createReadStream(file)
      .on('data', (b) => {
        for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
      })
      .on('end', () => resolve((c ^ 0xffffffff) >>> 0))
      .on('error', reject);
  });
}

// fields: [byteWidth, value] pairs in zip-spec order, written after the 4-byte signature.
function zipRecord(sig, fields, name) {
  const buf = Buffer.alloc(4 + fields.reduce((n, f) => n + f[0], 0) + name.length);
  buf.writeUInt32LE(sig, 0);
  let o = 4;
  for (const [n, v] of fields) {
    if (n === 2) buf.writeUInt16LE(v, o);
    else buf.writeUInt32LE(v >>> 0, o);
    o += n;
  }
  name.copy(buf, o);
  return buf;
}

app.get('/api/zip', async (req, res) => {
  if (!can(req, 'recv')) return res.status(403).json({ ok: false, error: 'الصلاحية الممنوحة لا تسمح بالتحميل' });
  const items = [];
  for (const rel of [].concat(req.query.rel || []).slice(0, 500)) {
    const p = sharedPath(rel);
    const st = p && (await fsp.stat(p).catch(() => null));
    if (st && st.isFile() && st.size < 0xffffffff) items.push({ rel: String(rel), p, st });
  }
  if (!items.length) return res.status(404).json({ error: 'لا توجد ملفات' });

  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="files.zip"' });
  let offset = 0;
  const central = [];
  const out = async (buf) => {
    offset += buf.length;
    if (!res.write(buf)) await once(res, 'drain');
  };
  try {
    for (const { rel, p, st } of items) {
      const name = Buffer.from(rel.replace(/\\/g, '/'), 'utf8');
      const d = st.mtime;
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const crc = await crcOf(p);
      // version, flags (utf-8 names), method (store), time, date, crc, sizes, name length, extra length
      const common = [[2, 20], [2, 0x0800], [2, 0], [2, time], [2, date], [4, crc], [4, st.size], [4, st.size], [2, name.length], [2, 0]];
      central.push(zipRecord(0x02014b50, [[2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]], name));
      await out(zipRecord(0x04034b50, common, name));
      for await (const chunk of fs.createReadStream(p)) {
        if (res.destroyed) return;
        await out(chunk);
      }
    }
    const cdStart = offset;
    for (const c of central) await out(c);
    const end = [[2, 0], [2, 0], [2, central.length], [2, central.length], [4, offset - cdStart], [4, cdStart], [2, 0]];
    await out(zipRecord(0x06054b50, end, Buffer.alloc(0)));
    res.end();
  } catch {
    res.destroy();
  }
});

// Text / link / clipboard sharing between the devices.
let clips = [];
try {
  clips = JSON.parse(fs.readFileSync(CLIPS_FILE, 'utf8'));
} catch {}

function addClip(text) {
  clips.unshift({ id: crypto.randomBytes(6).toString('hex'), text: String(text).slice(0, 20000), t: Date.now() });
  clips = clips.slice(0, 50);
  fsp.writeFile(CLIPS_FILE, JSON.stringify(clips)).catch(() => {});
  broadcast('clips');
}

app.get('/api/clips', (req, res) => {
  if (!can(req, 'recv')) return res.status(403).json({ ok: false, error: 'الصلاحية الممنوحة لا تسمح بقراءة النصوص' });
  res.set('Cache-Control', 'no-store');
  res.json({ clips });
});

app.post('/api/clips', (req, res) => {
  if (!can(req, 'send')) return res.status(403).json({ ok: false, error: 'الصلاحية الممنوحة لا تسمح بالإرسال إليك' });
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'النص فارغ' });
  addClip(text);
  res.json({ ok: true });
});

app.delete('/api/clips', (req, res) => {
  clips = clips.filter((c) => c.id !== req.query.id);
  fsp.writeFile(CLIPS_FILE, JSON.stringify(clips)).catch(() => {});
  broadcast('clips');
  res.json({ ok: true });
});

// Server-sent events: the page refreshes its lists without polling.
const sseClients = new Set();

function broadcast(event) {
  for (const r of sseClients) r.write(`event: ${event}\ndata: 1\n\n`);
}

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

setInterval(() => {
  for (const r of sseClients) r.write(': ping\n\n');
}, 25000).unref();

try {
  let timer;
  fs.watch(SHARED_DIR, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => broadcast('files'), 300);
  }).on('error', () => {});
} catch {}

app.post('/api/open-folder', (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ ok: false });
  const dir = req.body && req.body.which === 'shared' ? SHARED_DIR : UPLOAD_DIR;
  const cmd =
    process.platform === 'win32'
      ? `explorer "${dir}"`
      : process.platform === 'darwin'
        ? `open "${dir}"`
        : `xdg-open "${dir}"`;
  // windowsHide must stay false: the server itself runs hidden, and a hidden
  // explorer.exe opens the folder without a visible window.
  exec(cmd, { windowsHide: false });
  res.json({ ok: true });
});

function start(port, attempt = 0) {
  const server = app.listen(port);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) return start(port + 1, attempt + 1);
    console.error('Server error:', err.message);
    process.exit(1);
  });
  server.on('listening', () => onListening(port));
}

async function onListening(port) {
  const url = `http://${getLocalIP()}:${port}/?t=${TOKEN}`;
  try {
    fs.writeFileSync(PORT_FILE, String(port) + '\n');
    fs.writeFileSync(PID_FILE, String(process.pid) + '\n');
  } catch {}
  console.log('');
  console.log('  WiFi File Transfer is running');
  console.log('  ------------------------------------');
  console.log(`  Link: ${url}`);
  console.log('  The server runs in the background until stop.bat or reboot.');
  console.log('');
  try {
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  } catch {}
}

start(START_PORT);
