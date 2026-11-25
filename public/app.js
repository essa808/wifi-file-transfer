const $ = (sel) => document.querySelector(sel);

const pending = [];
let running = false;
let files = [];
let clips = [];
let online = null;
let isLocal = false;
const selected = new Set();
const view = { q: '', sort: 'new' };

const EXT_GROUPS = {
  img: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg', 'avif', 'tif', 'tiff'],
  vid: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'webm', 'm4v', '3gp', 'flv', 'ts'],
  aud: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'amr'],
  arc: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
};

// Must match INLINE_OK in server.js (formats the server will serve inline).
const PREVIEW = {
  jpg: 'img', jpeg: 'img', png: 'img', gif: 'img', webp: 'img', bmp: 'img', avif: 'img',
  mp4: 'video', webm: 'video', m4v: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio',
  pdf: 'iframe',
};

function fmtSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' بايت';
  const units = ['كيلوبايت', 'ميجابايت', 'جيجابايت', 'تيرابايت'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return v.toFixed(digits) + ' ' + units[i];
}

function fmtDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function extInfo(name) {
  const ext = extOf(name);
  const label = ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
  let group = '';
  for (const [key, list] of Object.entries(EXT_GROUPS)) {
    if (list.includes(ext)) {
      group = key;
      break;
    }
  }
  return { label, group };
}

let toastTimer;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API needs https on the phone; fall back to a temporary textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}

function init() {
  // remember the link token so reopening the bare address still works if the browser drops cookies
  try {
    const t = new URLSearchParams(location.search).get('t');
    if (t) localStorage.setItem('wft_token', t);
  } catch {}
  bindEvents();
  loadFiles();
  loadClips();
  syncInfo();
  startStatusPolling();
  startEvents();
  initPeers();
  loadHistory();
  initInstall();

  if (window.matchMedia('(pointer: coarse)').matches) {
    $('#camBtn').classList.remove('hidden');
  }
}

function startEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('files', () => loadFiles(true));
  es.addEventListener('clips', () => loadClips(true));
  es.addEventListener('history', (e) => {
    loadHistory();
    let ev = null;
    try {
      ev = JSON.parse(e.data);
    } catch {}
    if (ev && ev.kind === 'in' && isLocal) notifyArrival(ev);
  });
  es.addEventListener('pair', () => {
    loadPairRequests();
    syncOutPeers();
  });
  es.addEventListener('open', () => {
    loadFiles(true);
    loadClips(true);
  });
}

async function syncInfo() {
  try {
    const info = await fetch('/api/info', { cache: 'no-store' }).then((r) => r.json());
    isLocal = !!info.isLocal;
    if (info.isLocal) {
      initLocalExtras();
      $('#connectCard').classList.remove('hidden');
      $('#openUploadsBtn').classList.remove('hidden');
      $('#openSharedBtn').classList.remove('hidden');
      if (info.qr) $('#qr').src = info.qr;
      if (info.url) $('#url').textContent = info.url;
    }
    return true;
  } catch {
    return false;
  }
}

function setOnline(next) {
  const was = online;
  online = next;
  $('#status').classList.toggle('on', next);
  $('#status').classList.toggle('off', !next);
  $('#statusText').textContent = next ? 'متصل' : 'غير متصل';
  $('#offline').classList.toggle('hidden', next);
  if (was === false && next === true) {
    syncInfo();
    loadFiles(true);
    loadClips(true);
  }
}

async function checkStatus() {
  try {
    const res = await fetch('/api/ping', { cache: 'no-store' });
    setOnline(res.ok);
  } catch {
    setOnline(false);
  }
}

function startStatusPolling() {
  checkStatus();
  setInterval(checkStatus, 4000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkStatus();
  });
  window.addEventListener('online', checkStatus);
}

function bindDrop(el, dest) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('over');
    try {
      addFiles(await droppedItems(e.dataTransfer), dest);
    } catch {
      toast('تعذر قراءة المجلد المسحوب');
    }
  });
}

function bindEvents() {
  $('#pickBtn').addEventListener('click', () => $('#pick').click());
  $('#camBtn').addEventListener('click', () => $('#cam').click());
  $('#sharedPickBtn').addEventListener('click', () => $('#sharedPick').click());
  $('#pickDirBtn').addEventListener('click', () => $('#pickDir').click());
  $('#sharedPickDirBtn').addEventListener('click', () => $('#sharedPickDir').click());
  for (const [id, dest] of [
    ['#pick', 'uploads'],
    ['#cam', 'uploads'],
    ['#sharedPick', 'shared'],
    ['#pickDir', 'uploads'],
    ['#sharedPickDir', 'shared'],
  ]) {
    $(id).addEventListener('change', (e) => {
      addFiles(e.target.files, dest);
      e.target.value = '';
    });
  }

  bindDrop($('#drop'), 'uploads');
  bindDrop($('#sharedCard'), 'shared');
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('#copyBtn').addEventListener('click', async () => {
    toast((await copyText($('#url').textContent)) ? 'تم نسخ الرابط' : 'حدد الرابط يدويًا وانسخه');
  });

  $('#openUploadsBtn').addEventListener('click', () => openFolder('uploads'));
  $('#openSharedBtn').addEventListener('click', () => openFolder('shared'));

  $('#search').addEventListener('input', (e) => {
    view.q = e.target.value.trim().toLowerCase();
    renderFiles();
  });
  $('#sort').addEventListener('change', (e) => {
    view.sort = e.target.value;
    renderFiles();
  });
  $('#selAll').addEventListener('change', (e) => {
    for (const f of visibleFiles()) e.target.checked ? selected.add(f.rel) : selected.delete(f.rel);
    renderFiles();
  });
  $('#zipBtn').addEventListener('click', downloadZip);
  $('#delSelBtn').addEventListener('click', () => deleteFiles([...selected]));

  $('#clipSend').addEventListener('click', sendClip);
  $('#clipText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendClip();
  });

  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' || e.target.id === 'modalClose') closePreview();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePreview();
  });
}

async function openFolder(which) {
  try {
    await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ which }),
    });
  } catch {
    toast('تعذر فتح المجلد');
  }
}

/* ---------- uploads: resumable queue with speed / time left / cancel / retry ---------- */

const CHUNK = 4 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtEta(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${s} ث`;
  if (s < 3600) return `${Math.floor(s / 60)} د ${s % 60} ث`;
  return `${Math.floor(s / 3600)} س ${Math.floor((s % 3600) / 60)} د`;
}

// Speed over the last ~3 s, so the estimate follows the current Wi-Fi rate rather than the average.
function progressLabel(meter, done, total) {
  const now = performance.now();
  meter.push([now, done]);
  while (meter.length > 2 && now - meter[0][0] > 3000) meter.shift();
  const pct = total ? Math.floor((done / total) * 100) : 100;
  const [t0, b0] = meter[0];
  const bps = now - t0 > 300 ? (done - b0) / ((now - t0) / 1000) : 0;
  if (bps <= 0) return pct + '%';
  return `${pct}% • ${fmtSize(Math.round(bps))}/ث • باقي ${fmtEta(Math.round((total - done) / bps))}`;
}

// Same file + destination => same id, so a retry or a re-pick after a dropped connection resumes the .part file.
function fileId(t) {
  const s = `${t.dest}|${t.rel}|${t.file.size}|${t.file.lastModified}`;
  let h1 = 0x811c9dc5;
  let h2 = 7;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return 'f' + h1.toString(36) + h2.toString(36) + '_' + t.file.size.toString(36);
}

// Folder drops: walk directory entries so the folder structure arrives intact.
async function droppedItems(dt) {
  const entries = Array.from(dt.items || [])
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return Array.from(dt.files || []);
  const out = [];
  const walk = async (e, prefix) => {
    if (e.isFile) {
      const file = await new Promise((res, rej) => e.file(res, rej));
      out.push({ file, rel: prefix + file.name });
    } else if (e.isDirectory) {
      const reader = e.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const c of batch) await walk(c, prefix + e.name + '/');
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

function addFiles(list, dest) {
  for (const item of Array.from(list || [])) {
    const file = item.file || item;
    enqueue(file, dest, item.rel || file.webkitRelativePath || file.name);
  }
  runQueue();
}

function enqueue(file, dest, rel) {
  const t = { file, dest, rel, xhr: null, state: 'wait' };
  const li = document.createElement('li');
  li.className = 'q-item';
  li.innerHTML =
    '<div class="q-top">' +
    '<span class="q-name"></span>' +
    '<span class="q-size"></span>' +
    '<span class="q-status">بالانتظار</span>' +
    '<button type="button" class="btn ghost small q-act">إلغاء</button>' +
    '<button type="button" class="btn ghost small q-rm hidden">إزالة</button>' +
    '</div>' +
    '<div class="bar"><div class="bar-fill"></div></div>';
  li.querySelector('.q-name').textContent = rel;
  li.querySelector('.q-size').textContent = fmtSize(file.size);
  t.li = li;
  t.fill = li.querySelector('.bar-fill');
  t.status = li.querySelector('.q-status');
  t.act = li.querySelector('.q-act');
  t.rm = li.querySelector('.q-rm');

  t.act.addEventListener('click', () => {
    if (t.state === 'fail') {
      resetTask(t);
      pending.push(t);
      runQueue();
    } else if (t.state === 'run') {
      t.aborted = true;
      if (t.xhr) t.xhr.abort();
    } else if (t.state === 'wait') {
      pending.splice(pending.indexOf(t), 1);
      li.remove();
    }
  });
  t.rm.addEventListener('click', () => li.remove());

  (dest === 'shared' ? $('#queueShared') : $('#queue')).appendChild(li);
  pending.push(t);
}

function resetTask(t) {
  t.state = 'wait';
  t.li.classList.remove('fail');
  t.fill.style.width = '0%';
  t.status.textContent = 'بالانتظار';
  t.act.textContent = 'إلغاء';
  t.rm.classList.add('hidden');
}

function failTask(t, reason) {
  t.state = 'fail';
  t.li.classList.add('fail');
  t.status.textContent = reason;
  t.act.textContent = 'إعادة';
  t.rm.classList.remove('hidden');
}

async function runQueue() {
  if (running) return;
  running = true;
  while (pending.length) await send(pending.shift());
  running = false;
}

// One slice; resolves {status, body}, rejects when the connection drops.
function putChunk(t, id, offset, end, onBytes) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ id, to: t.dest, name: t.rel, size: t.file.size, offset });
    const xhr = new XMLHttpRequest();
    t.xhr = xhr;
    xhr.open('POST', '/api/chunk?' + q);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onBytes(offset + e.loaded);
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = xhr.onabort = xhr.ontimeout = () => reject(new Error('net'));
    xhr.send(t.file.slice(offset, end));
  });
}

async function send(t) {
  t.state = 'run';
  t.aborted = false;
  const id = fileId(t);
  const total = t.file.size;
  let meter = [];
  let offset = null;
  let tries = 0;
  const show = (done) => {
    t.fill.style.width = (total ? Math.min(100, (done / total) * 100) : 100) + '%';
    t.status.textContent = progressLabel(meter, done, total);
  };
  t.status.textContent = '0%';

  while (true) {
    if (t.aborted) return failTask(t, 'أُلغي — اضغط «إعادة» ليكمل من حيث وقف');
    try {
      if (offset === null) {
        const r = await fetch('/api/chunk?id=' + id, { cache: 'no-store' });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          return failTask(t, b.error || 'فشل (' + r.status + ')');
        }
        offset = (await r.json()).size || 0;
        if (offset > total) offset = 0;
        meter = [];
      }
      const r = await putChunk(t, id, offset, Math.min(total, offset + CHUNK), show);
      if (r.status === 409) {
        offset = r.body.size || 0;
        await sleep(500);
        continue;
      }
      if (r.status !== 200) return failTask(t, r.body.error || 'فشل (' + r.status + ')');
      offset = r.body.size;
      tries = 0;
      show(offset);
      if (r.body.done) {
        t.state = 'done';
        t.li.classList.add('done');
        t.fill.style.width = '100%';
        t.status.textContent = 'تم';
        t.act.classList.add('hidden');
        setTimeout(() => t.li.remove(), 4000);
        return;
      }
    } catch {
      if (t.aborted) continue;
      // Wi-Fi hiccup or the phone slept: wait and resume from what the server already has (~2 minutes of tries)
      if (++tries > 40) return failTask(t, 'انقطع الاتصال — اضغط «إعادة» ليكمل من حيث وقف');
      t.status.textContent = 'انقطع الاتصال، إعادة المحاولة…';
      await sleep(3000);
      offset = null;
    }
  }
}

/* ---------- shared files: search, sort, select, preview, delete, zip ---------- */

async function loadFiles(quiet) {
  try {
    const data = await fetch('/api/files').then((r) => r.json());
    files = Array.isArray(data.files) ? data.files : [];
    const live = new Set(files.map((f) => f.rel));
    for (const rel of [...selected]) if (!live.has(rel)) selected.delete(rel);
    renderFiles();
  } catch {
    if (!quiet) toast('تعذر تحميل قائمة الملفات');
  }
}

function visibleFiles() {
  const list = files.filter((f) => !view.q || f.rel.toLowerCase().includes(view.q));
  const by = {
    new: (a, b) => b.mtime - a.mtime,
    name: (a, b) => a.rel.localeCompare(b.rel, 'ar'),
    size: (a, b) => b.size - a.size,
  };
  return list.sort(by[view.sort] || by.new);
}

function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderFiles() {
  const list = $('#files');
  list.textContent = '';
  const shown = visibleFiles();
  $('#filesEmpty').classList.toggle('hidden', shown.length > 0);
  $('#filesEmpty').textContent = files.length ? 'لا نتائج مطابقة للبحث.' : 'لا توجد ملفات في مجلد «إلى الهاتف» بعد.';
  $('#selBar').classList.toggle('hidden', !files.length);
  $('#selAll').checked = shown.length > 0 && shown.every((f) => selected.has(f.rel));
  $('#selCount').textContent = selected.size ? `المحدد: ${selected.size}` : 'تحديد الكل';
  $('#zipBtn').disabled = $('#delSelBtn').disabled = !selected.size;

  for (const f of shown) {
    const li = document.createElement('li');
    li.className = 'file';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'chk';
    cb.checked = selected.has(f.rel);
    cb.setAttribute('aria-label', 'تحديد ' + f.rel);
    cb.addEventListener('change', () => {
      cb.checked ? selected.add(f.rel) : selected.delete(f.rel);
      renderFiles();
    });

    const { label, group } = extInfo(f.rel);
    let badge = document.createElement('span');
    badge.className = 'ext' + (group ? ' ' + group : '');
    badge.textContent = label;
    if (PREVIEW[extOf(f.rel)] === 'img') {
      // shortcut: thumbnails load the full image (lazily, browser-cached); add server-side resizing if lists get slow
      const fallback = badge;
      badge = document.createElement('img');
      badge.className = 'thumb';
      badge.loading = 'lazy';
      badge.alt = '';
      badge.src = '/api/download?inline=1&rel=' + encodeURIComponent(f.rel);
      badge.addEventListener('error', () => badge.replaceWith(fallback));
      badge.addEventListener('click', () => openPreview(f.rel));
    }

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = f.rel.split('/').pop();
    name.title = f.rel;
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    const parts = [fmtSize(f.size), fmtDate(f.mtime)];
    if (f.rel.includes('/')) parts.unshift(f.rel.slice(0, f.rel.lastIndexOf('/')));
    sub.textContent = parts.filter(Boolean).join(' • ');
    meta.append(name, sub);

    const acts = document.createElement('div');
    acts.className = 'file-actions';
    if (PREVIEW[extOf(f.rel)]) acts.append(mkBtn('معاينة', 'ghost small', () => openPreview(f.rel)));
    const dl = document.createElement('a');
    dl.className = 'btn small dl';
    dl.href = '/api/download?rel=' + encodeURIComponent(f.rel);
    dl.textContent = 'تحميل';
    acts.append(dl, mkBtn('حذف', 'ghost small danger', () => deleteFiles([f.rel])));

    li.append(cb, badge, meta, acts);
    list.appendChild(li);
  }
}

async function deleteFiles(rels) {
  if (!rels.length) return;
  const msg = rels.length === 1 ? `نقل "${rels[0].split('/').pop()}" إلى سلة المحذوفات؟` : `نقل ${rels.length} ملفات إلى سلة المحذوفات؟`;
  if (!confirm(msg + '\nتنتقل إلى مجلد المحذوفات ويمكن استرجاعها لاحقًا.')) return;
  let failed = 0;
  for (const rel of rels) {
    try {
      const r = await fetch('/api/files?rel=' + encodeURIComponent(rel), { method: 'DELETE' });
      if (!r.ok) failed++;
      else selected.delete(rel);
    } catch {
      failed++;
    }
  }
  if (failed) toast(`تعذر حذف ${failed} ملف`);
  else toast('نُقلت إلى سلة المحذوفات');
  loadFiles(true);
}

function downloadZip() {
  if (!selected.size) return;
  const a = document.createElement('a');
  a.href = '/api/zip?' + [...selected].map((r) => 'rel=' + encodeURIComponent(r)).join('&');
  a.download = 'files.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openPreview(rel) {
  const tag = PREVIEW[extOf(rel)];
  const el = document.createElement(tag);
  el.src = '/api/download?inline=1&rel=' + encodeURIComponent(rel);
  if (tag === 'video' || tag === 'audio') {
    el.controls = true;
    el.autoplay = true;
  }
  $('#modalBody').replaceChildren(el);
  $('#modalTitle').textContent = rel.split('/').pop();
  $('#modal').classList.remove('hidden');
}

function closePreview() {
  $('#modal').classList.add('hidden');
  $('#modalBody').textContent = ''; // removing the element also stops playback
}

/* ---------- text / link sharing ---------- */

async function loadClips(quiet) {
  try {
    const data = await fetch('/api/clips', { cache: 'no-store' }).then((r) => r.json());
    clips = Array.isArray(data.clips) ? data.clips : [];
    renderClips();
  } catch {
    if (!quiet) toast('تعذر تحميل النصوص');
  }
}

async function sendClip() {
  const box = $('#clipText');
  const text = box.value.trim();
  if (!text) return;
  try {
    const r = await fetch('/api/clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error();
    box.value = '';
  } catch {
    toast('تعذر إرسال النص');
  }
}

function renderClips() {
  const list = $('#clips');
  list.textContent = '';
  $('#clipsEmpty').classList.toggle('hidden', clips.length > 0);
  for (const c of clips) {
    const li = document.createElement('li');
    li.className = 'clip';

    const body = document.createElement('div');
    body.className = 'clip-text';
    body.dir = 'auto';
    if (/^https?:\/\/\S+$/.test(c.text)) {
      const a = document.createElement('a');
      a.href = c.text;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = c.text;
      body.appendChild(a);
    } else {
      body.textContent = c.text;
    }

    const acts = document.createElement('div');
    acts.className = 'file-actions';
    const when = document.createElement('span');
    when.className = 'file-sub';
    when.textContent = fmtDate(c.t);
    acts.append(
      when,
      mkBtn('نسخ', 'ghost small', async () => toast((await copyText(c.text)) ? 'تم النسخ' : 'تعذر النسخ')),
      mkBtn('حذف', 'ghost small danger', () => fetch('/api/clips?id=' + encodeURIComponent(c.id), { method: 'DELETE' })),
    );

    li.append(body, acts);
    list.appendChild(li);
  }
}

/* ---------- history, arrival notifications, clipboard sync, home-screen install ---------- */

const HISTORY_LABEL = { in: 'وصل من', shared: 'أُضيف للجوال من', download: 'نزّله' };

async function loadHistory() {
  let list;
  try {
    const r = await fetch('/api/history', { cache: 'no-store' });
    if (!r.ok) return $('#historyCard').classList.add('hidden');
    list = (await r.json()).history || [];
  } catch {
    return;
  }
  const box = $('#history');
  box.textContent = '';
  $('#historyEmpty').classList.toggle('hidden', list.length > 0);
  $('#historyClear').classList.toggle('hidden', !list.length);
  for (const ev of list.slice(0, 40)) {
    const li = document.createElement('li');
    li.className = 'file';
    const badge = document.createElement('span');
    badge.className = 'ext ' + (ev.kind === 'download' ? 'out' : 'in');
    badge.textContent = ev.kind === 'download' ? '↓' : '↑';
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = ev.name;
    name.title = ev.name;
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    sub.textContent = [`${HISTORY_LABEL[ev.kind] || ''} ${ev.by}`, fmtSize(ev.size), fmtDate(ev.t)].filter(Boolean).join(' • ');
    meta.append(name, sub);
    li.append(badge, meta);
    box.appendChild(li);
  }
}

function notifyArrival(ev) {
  toast(`وصل «${ev.name.split('/').pop()}» من ${ev.by}`);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    // same tag: a folder of 200 files replaces one notification instead of stacking 200
    new Notification('وصل ملف جديد', { body: `${ev.name} — من ${ev.by}`, tag: 'wft-arrival', icon: '/icon.svg' });
  }
}

let localExtrasReady = false;
async function initLocalExtras() {
  if (localExtrasReady) return;
  localExtrasReady = true;

  if ('Notification' in window && Notification.permission === 'default') {
    const btn = $('#notifyBtn');
    btn.classList.remove('hidden');
    btn.addEventListener('click', async () => {
      const p = await Notification.requestPermission();
      btn.classList.add('hidden');
      toast(p === 'granted' ? 'بيوصلك إشعار لما يوصل ملف من الجوال' : 'الإشعارات مرفوضة — تقدر تفعلها من إعدادات المتصفح');
    });
  }

  try {
    const s = await fetch('/api/settings', { cache: 'no-store' }).then((r) => r.json());
    if (!s.clipSupported) return;
    const box = $('#clipSync');
    box.checked = !!s.clipSync;
    $('#clipSyncWrap').classList.remove('hidden');
    box.addEventListener('change', async () => {
      try {
        const r = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clipSync: box.checked }),
        });
        if (!r.ok) throw new Error();
        toast(box.checked ? 'المزامنة شغالة — انسخ أي نص وبيظهر بالجوال' : 'أوقفت مزامنة الحافظة');
      } catch {
        box.checked = !box.checked;
        toast('تعذر تغيير الإعداد');
      }
    });
  } catch {}
}

let installPrompt = null;
function initInstall() {
  const btn = $('#installBtn');
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    btn.classList.remove('hidden');
  });
  if (window.matchMedia('(pointer: coarse)').matches) btn.classList.remove('hidden');
  btn.addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      installPrompt = null;
      return;
    }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    toast(
      ios
        ? 'من Safari اضغط زر المشاركة ⬆️ ثم «إضافة إلى الشاشة الرئيسية»'
        : 'افتح قائمة المتصفح ⋮ واختر «إضافة إلى الشاشة الرئيسية»',
      6000
    );
  });
}

$('#historyClear').addEventListener('click', async () => {
  if (!confirm('مسح سجل العمليات؟ الملفات نفسها ما تنحذف.')) return;
  await fetch('/api/history', { method: 'DELETE' }).catch(() => {});
});

/* ---------- another computer: approval-based pairing with send/receive permissions ---------- */

const PEERS_KEY = 'wft_peers';
let peerBusy = null;

function loadPeers() {
  try {
    const list = JSON.parse(localStorage.getItem(PEERS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((p) => p && p.host && p.token) : [];
  } catch {
    return [];
  }
}

function savePeers(list) {
  try {
    localStorage.setItem(PEERS_KEY, JSON.stringify(list));
  } catch {}
}

function peerBase(p) {
  return `http://${p.host}:${p.port || 3000}`;
}

function parsePeerAddress(value) {
  const v = String(value || '').trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  const m = v.match(/^([0-9.]+)(?::(\d+))?$/);
  return m ? { host: m[1], port: Number(m[2]) || 3000 } : null;
}

async function initPeers() {
  try {
    const info = await fetch('/api/peer', { cache: 'no-store' }).then((r) => r.json());
    const addrs = Array.isArray(info.addresses) ? info.addresses : [];
    $('#myAddress').textContent = addrs.length ? `${addrs[0]}:${info.port}` : 'غير متاح';
    $('#myAddress').title = addrs.map((a) => `${a}:${info.port}`).join('\n');
  } catch {}
  renderPeers();
  loadPairRequests();
  syncOutPeers();
  // safety net: an approval on the other computer must show up here even if a live event is missed
  setInterval(() => {
    if (!document.hidden) {
      loadPairRequests();
      syncOutPeers();
    }
  }, 12000);
  $('#peerAdd').addEventListener('click', addPeer);
  $('#peerScan').addEventListener('click', scanNetwork);
  $('#peerHost').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addPeer();
  });
  $('#peerPick').addEventListener('change', (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    if (peerBusy && picked.length) for (const file of picked) sendOne(peerBusy, file);
  });
}

async function addPeer() {
  const addr = parsePeerAddress($('#peerHost').value);
  if (!addr) return toast('اكتب عنوان الكمبيوتر مثل 192.168.3.15');
  await requestPair(addr);
}

async function requestPair(addr) {
  const btn = $('#peerAdd');
  btn.disabled = true;
  btn.textContent = 'جارٍ إرسال الطلب…';
  try {
    const r = await fetch('/api/pair/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: addr.host, port: addr.port }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return toast(data.error || 'تعذر إرسال الطلب');
    $('#peerHost').value = '';
    renderFound([]);
    toast(`وصل الطلب لشاشة ${addr.host} — بانتظار موافقته واختياره نوع الصلاحية`);
  } catch {
    toast('تعذر الوصول للكمبيوتر — تأكد أن التطبيق شغال عليه وأنكما على نفس الشبكة');
  } finally {
    btn.disabled = false;
    btn.textContent = 'طلب ربط';
  }
}

// Incoming pairing requests waiting for our decision (approve + permission level, or decline).
async function loadPairRequests() {
  let requests = [];
  try {
    const data = await fetch('/api/pair/inbound', { cache: 'no-store' }).then((r) => r.json());
    requests = Array.isArray(data.requests) ? data.requests : [];
  } catch {
    return;
  }
  const wrap = $('#pairReqWrap');
  const box = $('#pairRequests');
  if (!wrap || !box) return;
  wrap.classList.toggle('hidden', requests.length === 0);
  box.textContent = '';
  for (const q of requests) {
    const li = document.createElement('li');
    li.className = 'file peer req';

    const row = document.createElement('div');
    row.className = 'peer-row';
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = q.name;
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    sub.textContent = `طلب ربط من ${q.ip}`;
    meta.append(name, sub);
    row.appendChild(meta);
    li.appendChild(row);

    const acts = document.createElement('div');
    acts.className = 'peer-req-acts';
    const sel = document.createElement('select');
    sel.className = 'peer-perms';
    sel.setAttribute('aria-label', 'نوع القبول');
    for (const [value, label] of [
      ['both', 'الطرف الآخر: يرسل ويستلم'],
      ['send', 'الطرف الآخر: يرسل إليّ فقط'],
      ['recv', 'الطرف الآخر: يستلم مني فقط'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    const respond = async (decision) => {
      try {
        const r = await fetch('/api/pair/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: q.id, decision, perms: sel.value }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return toast(data.error || 'تعذر الرد على الطلب');
        toast(
          decision === 'decline'
            ? `رفضت طلب ${q.name}`
            : sel.value === 'both'
              ? `تم الربط مع ${q.name} — الإرسال والاستقبال شغال بالاتجاهين`
              : sel.value === 'send'
                ? `تم — ${q.name} يقدر يرسل لك فقط`
                : `تم — ${q.name} يقدر يستلم منك فقط`
        );
      } catch {
        toast('تعذر الرد على الطلب');
      } finally {
        loadPairRequests();
        syncOutPeers();
      }
    };
    acts.append(
      sel,
      mkBtn('قبول', 'primary small', () => respond('approve')),
      mkBtn('رفض', 'ghost small danger', () => respond('decline'))
    );
    li.appendChild(acts);
    box.appendChild(li);
  }
}

// Approved outbound links live on the server; mirror them into localStorage so the list survives.
async function syncOutPeers() {
  let serverPeers = [];
  try {
    const data = await fetch('/api/pair/out-peers', { cache: 'no-store' }).then((r) => r.json());
    serverPeers = Array.isArray(data.peers) ? data.peers : [];
  } catch {
    return;
  }
  // the server's approved list is authoritative; this also drops leftovers from the old code-based pairing
  const next = serverPeers
    .filter((sp) => sp.host && sp.token)
    .map((sp) => ({ host: sp.host, port: sp.port || 3000, token: sp.token, name: sp.name || sp.host, perms: sp.perms || 'both' }));
  savePeers(next);
  renderPeers();
}

async function disconnectPeer(p) {
  try {
    await fetch('/api/peers/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: p.host, port: p.port || 3000, token: p.token }),
    });
  } catch {}
  savePeers(loadPeers().filter((x) => !(x.host === p.host && x.port === p.port)));
  renderPeers();
  toast(`فصلت الربط مع ${p.name || p.host}`);
}

async function scanNetwork() {
  const btn = $('#peerScan');
  btn.disabled = true;
  btn.textContent = 'جارِ البحث…';
  try {
    const r = await fetch('/api/scan', { cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    renderFound(Array.isArray(data.devices) ? data.devices : []);
  } catch {
    toast('تعذر البحث — حاول مرة أخرى');
  } finally {
    btn.disabled = false;
    btn.textContent = 'البحث عن الأجهزة في الشبكة';
  }
}

function renderFound(devices) {
  const paired = loadPeers();
  const box = $('#peerFound');
  box.textContent = '';
  $('#scanEmpty').classList.toggle('hidden', devices.length > 0);
  for (const d of devices) {
    const isPaired = paired.some((p) => p.host === d.host && (p.port || 3000) === d.port);
    const li = document.createElement('li');
    li.className = 'file peer found';
    const row = document.createElement('div');
    row.className = 'peer-row';
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = d.name;
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    sub.textContent = `${d.host}:${d.port}${isPaired ? ' · مربوط حالياً' : ''}`;
    meta.append(name, sub);
    const acts = document.createElement('div');
    acts.className = 'file-actions';
    const btn = isPaired
      ? mkBtn('مربوط', 'small', () => {})
      : mkBtn('طلب ربط', 'primary small', () => requestPair({ host: d.host, port: d.port }));
    if (isPaired) btn.disabled = true;
    acts.append(btn);
    row.append(meta, acts);
    li.appendChild(row);
    box.appendChild(li);
  }
}

function renderPeers() {
  const list = loadPeers();
  const box = $('#peerList');
  box.textContent = '';
  $('#peerEmpty').classList.toggle('hidden', list.length > 0);
  for (const p of list) {
    const li = document.createElement('li');
    li.className = 'file peer';

    const row = document.createElement('div');
    row.className = 'peer-row';

    const perms = p.perms || 'both';
    const canSend = perms === 'both' || perms === 'send';

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = p.name || p.host;
    const sub = document.createElement('span');
    sub.className = 'file-sub';
    sub.textContent = `${p.host}:${p.port || 3000} · يمكنك: ${
      perms === 'both' ? 'الإرسال والاستقبال' : perms === 'send' ? 'الإرسال إليه فقط' : 'الاستقبال منه فقط'
    }`;
    meta.append(name, sub);

    const acts = document.createElement('div');
    acts.className = 'file-actions';
    const sendBtn = mkBtn('إرسال ملفات', 'primary small', () => {
      peerBusy = p;
      $('#peerPick').click();
    });
    if (!canSend) sendBtn.disabled = true;
    acts.append(
      sendBtn,
      mkBtn('فصل', 'ghost small danger', () => disconnectPeer(p))
    );

    row.append(meta, acts);
    li.appendChild(row);

    const textRow = document.createElement('div');
    textRow.className = 'peer-text';
    const input = document.createElement('input');
    input.type = 'text';
    input.dir = 'auto';
    input.placeholder = `اكتب نصًا لإرساله إلى ${p.name || p.host}`;
    input.setAttribute('aria-label', 'نص للإرسال إلى ' + (p.name || p.host));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn.click();
    });
    const btn = mkBtn('إرسال نص', 'small', () => {
      const text = input.value.trim();
      if (text) sendPeerText(p, text, input, btn);
    });
    if (!canSend) {
      input.disabled = true;
      btn.disabled = true;
      input.placeholder = `الصلاحية استقبال فقط — ${p.name || p.host} هو من يرسل إليك`;
    }
    textRow.append(input, btn);
    li.appendChild(textRow);

    box.appendChild(li);
  }
}

async function sendPeerText(peer, text, input, btn) {
  btn.disabled = true;
  try {
    const r = await fetch(`${peerBase(peer)}/api/clips?t=${encodeURIComponent(peer.token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (r.ok) {
      input.value = '';
      toast(`وصل النص إلى ${peer.name || peer.host}`);
    } else if (r.status === 401 || r.status === 403) {
      toast(`الربط مع ${peer.name || peer.host} غير صالح — اضغط «فصل» وأعد طلب الربط`);
    } else {
      toast('تعذر إرسال النص');
    }
  } catch {
    toast(`تعذر الوصول إلى ${peer.name || peer.host} — تأكد أن التطبيق شغال عليه`);
  } finally {
    btn.disabled = false;
  }
}

function sendOne(peer, file) {
  const li = document.createElement('li');
  li.className = 'q-item';
  li.innerHTML =
    '<div class="q-top">' +
    '<span class="q-name"></span>' +
    '<span class="q-size"></span>' +
    '<span class="q-status">جارٍ الإرسال</span>' +
    '</div>' +
    '<div class="bar"><div class="bar-fill"></div></div>';
  li.querySelector('.q-name').textContent = file.name;
  li.querySelector('.q-size').textContent = fmtSize(file.size);
  const fill = li.querySelector('.bar-fill');
  const status = li.querySelector('.q-status');
  $('#peerQueue').appendChild(li);

  const xhr = new XMLHttpRequest();
  const meter = [];
  xhr.open('POST', `${peerBase(peer)}/api/upload?to=uploads&t=${encodeURIComponent(peer.token)}`);
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    fill.style.width = Math.round((e.loaded / e.total) * 100) + '%';
    status.textContent = progressLabel(meter, e.loaded, e.total);
  });
  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      li.classList.add('done');
      status.textContent = 'وصل';
      toast(`وصلت «${file.name}» إلى ${peer.name || peer.host}`);
    } else {
      li.classList.add('fail');
      let msg = 'فشل الإرسال';
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {}
      if (xhr.status === 401 || xhr.status === 403) msg = 'الربط غير صالح — اضغط «فصل» وأعد طلب الربط';
      status.textContent = msg;
    }
  });
  xhr.addEventListener('error', () => {
    li.classList.add('fail');
    status.textContent = 'تعذر الوصول للكمبيوتر الآخر';
  });
  const fd = new FormData();
  fd.append('files', file, file.name);
  xhr.send(fd);
}

init();
