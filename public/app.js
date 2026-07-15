/* ==========================================================================
 * Sahne Setlist - on yuz mantigi
 * Veriler tarayicida (localStorage) saklanir -> internet kesilse bile
 * kayitli sarkilar acilir. Arama/ekleme icin internet gerekir.
 * ========================================================================== */

'use strict';

const STORE_KEY = 'sahne_setlist_v1';
const $ = (id) => document.getElementById(id);

/* ---------- Durum ---------- */
let state = loadState();
let currentSong = null;   // acik olan sarki nesnesi
const sync = {
  room: localStorage.getItem('sync_room') || '',
  rev: parseInt(localStorage.getItem('sync_rev') || '0', 10),
  connected: false,
  applyingRemote: false,
  pushTimer: null,
  pollTimer: null,
};
let scrollRAF = null;
let scrolling = false;
let lastFrameTs = 0;

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.setlists)) return s;
    }
  } catch (_) {}
  const id = uid();
  return { setlists: [{ id, name: 'Setlist 1', songs: [] }], currentId: id };
}

function saveLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
}
function saveState() {
  saveLocal();
  if (sync.connected && !sync.applyingRemote) schedulePush();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function currentSetlist() {
  return state.setlists.find((s) => s.id === state.currentId) || state.setlists[0];
}

/* ==========================================================================
 * AKOR / TRANSPOZE
 * ========================================================================== */
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const CHORD_RE = /^[A-G](##?|bb?)?(maj|min|dim|aug|sus|add|m)*[0-9]*(?:[#b][0-9]+)?(?:sus[0-9]+)?(?:add[0-9]+)?(?:\/[A-G](##?|bb?)?)?$/;

function noteIndex(n) {
  let i = SHARP.indexOf(n);
  if (i >= 0) return i;
  return FLAT.indexOf(n);
}

function transposePart(part, semi, preferFlat) {
  const m = part.match(/^([A-G])(##?|bb?)?(.*)$/);
  if (!m) return part;
  const root = m[1] + (m[2] || '');
  let idx = noteIndex(root);
  if (idx < 0) return part;
  idx = (((idx + semi) % 12) + 12) % 12;
  const flat = preferFlat || (m[2] && m[2][0] === 'b');
  return (flat ? FLAT[idx] : SHARP[idx]) + m[3];
}

function transposeToken(tok, semi, preferFlat) {
  return tok.split('/').map((p) => transposePart(p, semi, preferFlat)).join('/');
}

function isChordToken(tok) {
  return CHORD_RE.test(tok);
}

// Bir satirin akor satiri olup olmadigi: bosluk disi tum token'lar akor mu?
function isChordLine(line) {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return false;
  return toks.every(isChordToken);
}

// Sutun hizasini koruyarak akor satirini transpoze eder.
function transposeChordLine(line, semi, preferFlat) {
  const re = /\S+/g;
  let out = '';
  let last = 0;
  let carry = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    let gap = line.slice(last, m.index);
    if (carry > 0) gap += ' '.repeat(carry);
    else if (carry < 0) gap = gap.slice(0, Math.max(gap.length ? 1 : 0, gap.length + carry));
    carry = 0;
    const nt = transposeToken(m[0], semi, preferFlat);
    out += gap + nt;
    carry += m[0].length - nt.length;
    last = m.index + m[0].length;
  }
  out += line.slice(last);
  return out;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Türkçe karakterleri sadeleştir (arama/filtre için)
function trSimplify(s) {
  return String(s || '')
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/ş/g, 's').replace(/Ş/g, 's')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .replace(/ç/g, 'c').replace(/Ç/g, 'c')
    .replace(/ö/g, 'o').replace(/Ö/g, 'o')
    .replace(/ü/g, 'u').replace(/Ü/g, 'u');
}

// Govdeyi transpoze edip renkli HTML uretir. mode: 'both'|'lyrics'|'chords'
function renderBody(body, semi, preferFlat, mode) {
  mode = mode || 'both';
  const out = [];
  body.split('\n').forEach((line) => {
    const chord = isChordLine(line);
    const blank = line.trim() === '';
    const label = /:/.test(line); // Intro:, Nakarat: gibi etiketler
    if (mode === 'lyrics' && chord && !label) return;        // akor satırını gizle
    if (mode === 'chords' && !chord && !blank && !label) return; // söz satırını gizle
    if (chord) {
      const t = semi ? transposeChordLine(line, semi, preferFlat) : line;
      out.push('<span class="chordline">' + escapeHtml(t) + '</span>');
    } else {
      out.push(escapeHtml(line));
    }
  });
  return out.join('\n')
}

/* ==========================================================================
 * GORUNUM: SETLIST LISTESI
 * ========================================================================== */
// Setlist'in gosterim sirasi (secili siralama moduna gore)
function orderedSongs(sl) {
  const mode = sl.sortMode || 'manual';
  if (mode === 'manual') return sl.songs;
  const arr = [...sl.songs];
  const keyFn = mode === 'artist'
    ? (s) => (s.artist || 'zzz') + ' — ' + (s.song || s.title || '')
    : (s) => (s.song || s.title || '');
  arr.sort((a, b) => keyFn(a).localeCompare(keyFn(b), 'tr', { sensitivity: 'base' }));
  return arr;
}

function setSortMode(mode) {
  const sl = currentSetlist();
  sl.sortMode = mode;
  saveState();
  renderList();
}

// Etiket renkleri (renk = kategori)
const COLORS = [
  { key: 'blue', name: 'Slow', css: '#4c8dff' },
  { key: 'red', name: 'Hızlı', css: '#ff5a5a' },
  { key: 'green', name: 'Cover', css: '#35d07f' },
  { key: 'purple', name: 'Bizim', css: '#a066ff' },
  { key: 'orange', name: 'Isınma', css: '#ff9f43' },
  { key: 'gray', name: 'Diğer', css: '#8a94a6' },
];
function colorCss(key) { const c = COLORS.find((x) => x.key === key); return c ? c.css : ''; }
function colorName(key) { const c = COLORS.find((x) => x.key === key); return c ? c.name : ''; }

let filterText = '';

function renderList() {
  const sl = currentSetlist();
  const mode = sl.sortMode || 'manual';
  $('current-setlist-name').textContent = sl.name;
  const totalSec = sl.songs.reduce((a, s) => a + (s.duration || 0), 0);
  $('current-setlist-count').textContent =
    (sl.songs.length ? sl.songs.length + ' şarkı' : '') +
    (totalSec ? ' · ~' + Math.round(totalSec / 60) + ' dk' : '');

  // aktif siralama cipini isaretle
  document.querySelectorAll('.sortchip').forEach((c) =>
    c.classList.toggle('active', c.dataset.sort === mode));

  const list = $('song-list');
  list.className = 'song-list' + (mode === 'manual' ? '' : ' nodrag');
  list.innerHTML = '';
  $('empty-list').classList.toggle('hidden', sl.songs.length > 0);

  const q = trSimplify(filterText).toLowerCase().trim();
  let shown = 0;
  orderedSongs(sl).forEach((song, i) => {
    if (q) {
      const hay = trSimplify((song.artist || '') + ' ' + (song.song || song.title || '')).toLowerCase();
      if (!hay.includes(q)) return;
    }
    shown++;
    const card = document.createElement('div');
    card.className = 'song-card';
    card.dataset.id = song.id;
    const pending = !song.body && song.source ? '<span class="badge">indirilmedi ⬇</span>' : '';
    const dur = song.duration ? `<div class="badge">${fmtDuration(song.duration)}</div>` : '';
    const cbar = song.color ? `<div class="color-bar" style="background:${colorCss(song.color)}"></div>` : '';
    const tag = song.color ? `<span class="badge" style="color:${colorCss(song.color)}">${escapeHtml(colorName(song.color))}</span>` : '';
    const segue = song.segue ? '<span class="segue-mark" title="Sonrakine bağlı">🔗</span>' : '';
    card.innerHTML =
      `${cbar}
       <div class="song-num">${i + 1}</div>
       <div class="info">
         <div class="t">${escapeHtml(song.song || song.title || 'Şarkı')} ${segue}</div>
         <div class="a">${escapeHtml(song.artist || '')}</div>
       </div>
       ${tag}
       ${dur}
       ${song.transpose ? `<div class="badge">${song.transpose > 0 ? '+' : ''}${song.transpose}</div>` : ''}
       ${pending}
       <button class="tag-btn" data-tag title="Etiket/renk/segue">🏷</button>
       <div class="drag" data-handle>⠿</div>`;
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-tag]')) { openLabel(song.id); return; }
      if (!card._dragged) openSong(song.id);
    });
    if (mode === 'manual') attachDrag(card, card.querySelector('[data-handle]'));
    list.appendChild(card);
  });
  $('empty-list').classList.toggle('hidden', shown > 0);
}

/* ---------- Etiket & renk & segue (listeden) ---------- */
let labelSongId = null;
function openLabel(songId) {
  labelSongId = songId;
  const song = currentSetlist().songs.find((s) => s.id === songId);
  if (!song) return;
  $('label-song-name').textContent = (song.song || song.title || 'Şarkı');
  const box = $('color-swatches');
  box.innerHTML = '';
  // "Yok" (renksiz) + renkler
  const none = document.createElement('div');
  none.className = 'swatch' + (!song.color ? ' sel' : '');
  none.style.background = 'transparent';
  none.textContent = '∅';
  none.style.color = 'var(--muted)';
  none.addEventListener('click', () => setColor(''));
  box.appendChild(none);
  COLORS.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'swatch' + (song.color === c.key ? ' sel' : '');
    el.style.background = c.css;
    el.title = c.name;
    el.textContent = c.name;
    el.addEventListener('click', () => setColor(c.key));
    box.appendChild(el);
  });
  $('label-segue').classList.toggle('on', !!song.segue);
  $('label-segue').textContent = (song.segue ? '🔗 Bağlı ✓ — kaldırmak için dokun' : '🔗 Sonraki şarkıya bağla (segue/medley)');
  $('sheet-label').classList.remove('hidden');
}
function closeLabel() { $('sheet-label').classList.add('hidden'); }
function setColor(key) {
  const song = currentSetlist().songs.find((s) => s.id === labelSongId);
  if (!song) return;
  song.color = key;
  saveState();
  renderList();
  openLabel(labelSongId); // seçimi güncelle, açık kalsın
}
function toggleSegue() {
  const song = currentSetlist().songs.find((s) => s.id === labelSongId);
  if (!song) return;
  song.segue = !song.segue;
  saveState();
  renderList();
  openLabel(labelSongId);
}

/* ---------- Sürükle-bırak ile sıralama (yalnızca "Kendi sıram" modunda) ---------- */
function attachDrag(card, handle) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const list = $('song-list');
    card._dragged = false;
    let startY = e.clientY;
    const startY0 = e.clientY;
    handle.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
    stopScroll();

    const onMove = (ev) => {
      if (Math.abs(ev.clientY - startY0) > 4) card._dragged = true;
      // kartı parmağa yapıştır
      card.style.transform = `translateY(${ev.clientY - startY}px)`;

      // hedef komşuyu bul ve DOM'da yer değiştir
      const after = getDragAfter(list, ev.clientY);
      const oldTop = card.offsetTop;
      if (after == null) {
        if (list.lastElementChild !== card) list.appendChild(card);
      } else if (after !== card && card.nextElementSibling !== after) {
        list.insertBefore(card, after);
      }
      // yer değiştiyse, kartın layout konumu kaydı -> transform tabanını düzelt
      const newTop = card.offsetTop;
      if (newTop !== oldTop) {
        startY += newTop - oldTop;
        card.style.transform = `translateY(${ev.clientY - startY}px)`;
      }

      // kenarlarda otomatik kaydır
      autoScrollEdge(list, ev.clientY);
    };
    const onUp = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      stopAutoScroll();
      card.style.transform = '';
      card.classList.remove('dragging');
      if (card._dragged) commitOrder();
      setTimeout(() => { card._dragged = false; }, 60);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

function getDragAfter(list, y) {
  const cards = [...list.querySelectorAll('.song-card:not(.dragging)')];
  let closest = { offset: -Infinity, el: null };
  for (const c of cards) {
    const box = c.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: c };
  }
  return closest.el;
}

let edgeTimer = null;
function autoScrollEdge(list, y) {
  const r = list.getBoundingClientRect();
  const margin = 60;
  let dir = 0;
  if (y < r.top + margin) dir = -1;
  else if (y > r.bottom - margin) dir = 1;
  stopAutoScroll();
  if (dir) edgeTimer = setInterval(() => { list.scrollTop += dir * 8; }, 16);
}
function stopAutoScroll() { if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; } }

function commitOrder() {
  const ids = [...$('song-list').querySelectorAll('.song-card')].map((c) => c.dataset.id);
  const sl = currentSetlist();
  sl.songs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  saveState();
  renderList();
}

/* ==========================================================================
 * GORUNUM: SARKI
 * ========================================================================== */
async function openSong(songId) {
  const sl = currentSetlist();
  const song = sl.songs.find((s) => s.id === songId);
  if (!song) return;
  currentSong = song;

  $('song-title').textContent = song.song || song.title || 'Şarkı';
  $('song-artist').textContent = song.artist || '';
  updateKeyDisplay();
  applyFont();
  updateNav();

  $('view-list').classList.add('hidden');
  $('view-song').classList.remove('hidden');
  $('view-song').scrollTop = 0;
  stopScroll();
  document.querySelectorAll('.viewchip').forEach((c) =>
    c.classList.toggle('active', c.dataset.view === viewMode));
  startSongTimer();
  requestWakeLock();
  stopMetro();
  updateMediaMetadata();

  // Tembel yukleme: govde bos ama kaynak varsa internetten cek
  if (!song.body && song.source) {
    $('song-body').innerHTML = '';
    $('song-loading').classList.remove('hidden');
    try {
      const res = await fetch('/api/song?url=' + encodeURIComponent(song.source));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Hata');
      song.body = data.body;
      if (data.key) song.key = data.key;
      saveState();
      $('key-label').textContent = song.key ? '(orijinal: ' + song.key + ')' : '';
    } catch (err) {
      $('song-loading').classList.add('hidden');
      $('song-body').textContent = 'Şarkı yüklenemedi (internet gerekli): ' + err.message;
      return;
    }
    $('song-loading').classList.add('hidden');
  }
  paintSong();
  fitToWidth();   // akorlar/sözler ekrana sığsın
}

// Setlist icinde (gosterim sirasina gore) onceki/sonraki sarkiya gec
function gotoRelative(offset) {
  const list = orderedSongs(currentSetlist());
  const i = list.findIndex((s) => s.id === (currentSong && currentSong.id));
  const j = i + offset;
  if (j < 0 || j >= list.length) return;
  openSong(list[j].id);
}

function updateNav() {
  const list = orderedSongs(currentSetlist());
  const i = list.findIndex((s) => s.id === (currentSong && currentSong.id));
  const prev = i > 0 ? list[i - 1] : null;
  const next = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  $('nav-prev').disabled = !prev;
  $('nav-next').disabled = !next;
  $('nav-prev-name').textContent = prev ? (prev.song || prev.title || 'Şarkı') : '—';
  $('nav-next-name').textContent = next ? (next.song || next.title || 'Şarkı') : '—';
}

let viewMode = localStorage.getItem('sahne_viewmode') || 'both';
function paintSong() {
  if (!currentSong) return;
  const semi = currentSong.transpose || 0;
  const preferFlat = /b/.test(currentSong.key || '');
  $('song-body').innerHTML = renderBody(currentSong.body || '', semi, preferFlat, viewMode);
  $('tr-value').textContent = semi;
}
function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('sahne_viewmode', mode);
  document.querySelectorAll('.viewchip').forEach((c) =>
    c.classList.toggle('active', c.dataset.view === mode));
  paintSong();
  fitToWidth();
}

/* ---------- Çalma süresi sayacı (şimdi çalınıyor) ---------- */
let timerStart = 0;
let timerInterval = null;
function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function startSongTimer() {
  timerStart = Date.now();
  updateTimerDisplay();
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);
  $('timer-pill').classList.add('on');
}
function stopSongTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  $('timer-pill').classList.remove('on');
}
function updateTimerDisplay() {
  const s = Math.max(0, Math.floor((Date.now() - timerStart) / 1000));
  $('timer-pill').textContent = '⏱ ' + fmtClock(s);
}

/* ---------- Süre yardımcıları ---------- */
function parseDuration(str) {
  str = String(str || '').trim();
  if (!str) return 0;
  if (str.includes(':')) {
    const p = str.split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }
  const n = parseFloat(str.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 60) : 0; // sadece sayı -> dakika
}
function fmtDuration(sec) {
  if (!sec) return '';
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function setTranspose(delta) {
  if (!currentSong) return;
  let t = (currentSong.transpose || 0) + delta;
  if (t > 11) t = 11;
  if (t < -11) t = -11;
  currentSong.transpose = t;
  saveState();
  paintSong();
  updateKeyDisplay();
}

// Ton göstergesi: repertuarim gibi o anki GERÇEK tonu (nota) gösterir.
// Orijinal ton biliniyorsa transpoze edilmiş halini (ör. Dm +2 -> Em),
// bilinmiyorsa sadece kaydırma sayısını (+2) gösterir.
function updateKeyDisplay() {
  if (!currentSong) return;
  const orig = (currentSong.key || '').trim();
  const semi = currentSong.transpose || 0;
  const el = $('tr-value');
  if (orig) {
    const preferFlat = /b/.test(orig);
    el.textContent = transposeToken(orig, semi, preferFlat);
    el.classList.add('is-key');
    $('key-label').textContent = 'orijinal: ' + orig + (semi ? ' (' + (semi > 0 ? '+' : '') + semi + ')' : '');
  } else {
    el.textContent = (semi > 0 ? '+' : '') + semi;
    el.classList.remove('is-key');
    $('key-label').textContent = semi ? 'ton bilinmiyor' : '';
  }
}

let fontSize = parseInt(localStorage.getItem('sahne_font') || '18', 10);
function applyFont() {
  $('song-body').style.fontSize = fontSize + 'px';
}
function changeFont(delta) {
  fontSize = Math.max(9, Math.min(44, fontSize + delta));
  localStorage.setItem('sahne_font', String(fontSize));
  applyFont();
}

// En geniş satırı ekrana sığdıracak puntoyu GERÇEK ÖLÇÜMLE seçer (proportional
// fontta karakter sayısı yeterli değil). Okunabilir alt sınır 13px; daha da
// gerekiyorsa 13'te kalır ve uzun satır yatay kaydırılır.
const MIN_FIT_FONT = 13;
const MAX_FIT_FONT = 26;
function fitToWidth() {
  if (!currentSong || !currentSong.body) return;
  const box = $('song-scroll');
  const pre = $('song-body');
  const avail = box.clientWidth - 4;
  if (avail <= 0) return;
  const ref = 20;
  pre.style.fontSize = ref + 'px';
  const need = pre.scrollWidth;               // bu puntoda en geniş satırın gerçek genişliği
  let fs = ref;
  if (need > avail) fs = Math.floor(ref * avail / need);
  fs = Math.max(MIN_FIT_FONT, Math.min(fs, MAX_FIT_FONT));
  fontSize = fs;
  localStorage.setItem('sahne_font', String(fontSize));
  applyFont();
}

/* ---------- Otomatik kaydirma ---------- */
function startScroll() {
  scrolling = true;
  $('scroll-toggle').textContent = '⏸ Durdur';
  $('scroll-toggle').classList.add('on');
  lastFrameTs = 0;
  const box = $('view-song');
  const step = (ts) => {
    if (!scrolling) return;
    if (!lastFrameTs) lastFrameTs = ts;
    const dt = (ts - lastFrameTs) / 1000;
    lastFrameTs = ts;
    const speed = parseInt($('scroll-speed').value, 10); // 1..10
    box.scrollTop += speed * 14 * dt; // px/sn
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) {
      stopScroll();
      return;
    }
    scrollRAF = requestAnimationFrame(step);
  };
  scrollRAF = requestAnimationFrame(step);
}
function stopScroll() {
  scrolling = false;
  if (scrollRAF) cancelAnimationFrame(scrollRAF);
  scrollRAF = null;
  $('scroll-toggle').textContent = '▶ Kaydır';
  $('scroll-toggle').classList.remove('on');
}
function toggleScroll() { scrolling ? stopScroll() : startScroll(); }

/* ==========================================================================
 * ARAMA / EKLEME
 * ========================================================================== */
function openSearch() {
  $('modal-search').classList.remove('hidden');
  $('search-input').value = '';
  $('search-results').innerHTML = '';
  $('search-status').textContent = '';
  $('repertoire-preview').innerHTML = '';
  $('repertoire-status').textContent = '';
  $('repertoire-import').classList.add('hidden');
  repertoireData = null;
  switchTab('online');
  setTimeout(() => $('search-input').focus(), 50);
}
function closeSearch() { $('modal-search').classList.add('hidden'); }

function switchTab(which) {
  ['online', 'repertoire', 'manual'].forEach((t) => {
    $('tab-' + t).classList.toggle('active', t === which);
    $('pane-' + t).classList.toggle('hidden', t !== which);
  });
}

/* ---------- Repertuar içe aktarma ---------- */
let repertoireData = null;

async function fetchRepertoire(e) {
  e.preventDefault();
  const url = $('repertoire-url').value.trim();
  if (!url) return;
  const status = $('repertoire-status');
  const preview = $('repertoire-preview');
  const importBtn = $('repertoire-import');
  preview.innerHTML = '';
  importBtn.classList.add('hidden');
  repertoireData = null;
  status.innerHTML = '<span class="spinner"></span> Repertuar getiriliyor…';
  try {
    const res = await fetch('/api/repertoire?url=' + encodeURIComponent(url));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Hata');
    repertoireData = data;
    status.textContent = `“${data.title}” — ${data.songs.length} şarkı`;
    data.songs.slice(0, 60).forEach((s) => {
      const item = document.createElement('div');
      item.className = 'result-item';
      item.innerHTML =
        `<div class="info"><div class="t">${escapeHtml(s.song)}</div>
         <div class="a">${escapeHtml(s.artist || '')}</div></div>`;
      preview.appendChild(item);
    });
    if (data.songs.length > 60) {
      const more = document.createElement('div');
      more.className = 'hint muted';
      more.textContent = `…ve ${data.songs.length - 60} şarkı daha`;
      preview.appendChild(more);
    }
    importBtn.textContent = `${data.songs.length} Şarkıyı Setlist Olarak Ekle`;
    importBtn.classList.remove('hidden');
  } catch (err) {
    status.textContent = 'Alınamadı: ' + err.message;
  }
}

function importRepertoire() {
  if (!repertoireData) return;
  const sl = {
    id: uid(),
    name: repertoireData.title || 'Repertuar',
    songs: repertoireData.songs.map((s) => ({
      id: uid(),
      title: (s.artist ? s.artist + ' - ' : '') + s.song,
      artist: s.artist || '',
      song: s.song,
      key: '',
      body: '',            // tembel indirilecek
      source: s.url,
      transpose: 0,
      addedAt: Date.now(),
    })),
  };
  state.setlists.push(sl);
  state.currentId = sl.id;
  saveState();
  renderList();
  closeSearch();
  toast(`“${sl.name}” eklendi (${sl.songs.length} şarkı)`);
  // Cevrimdisi icin govdeleri arka planda indir
  cacheBodies(sl);
}

// Setlist'teki eksik govdeleri arka planda indirir (çevrimdışı için)
async function cacheBodies(sl) {
  const missing = sl.songs.filter((s) => !s.body && s.source);
  const total = missing.length;
  if (!total) return;
  const queue = [...missing];
  let done = 0;
  showProgress(done, total);
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const res = await fetch('/api/song?url=' + encodeURIComponent(s.source));
        if (res.ok) {
          const d = await res.json();
          s.body = d.body;
          if (d.key) s.key = d.key;
        }
      } catch (_) { /* atla */ }
      done++;
      if (done % 3 === 0 || done === total) saveState();
      showProgress(done, total);
    }
  };
  await Promise.all([worker(), worker(), worker()]); // 3 eszamanli
  saveState();
  hideProgress();
  if (!$('view-list').classList.contains('hidden')) renderList();
  toast('Çevrimdışı indirme tamam');
}

function showProgress(done, total) {
  const p = $('progress');
  const pct = Math.round((done / total) * 100);
  p.innerHTML = `<span>İndiriliyor ${done}/${total}</span><span class="bar"><i style="width:${pct}%"></i></span>`;
  p.classList.remove('hidden');
}
function hideProgress() { $('progress').classList.add('hidden'); }

// Elle ekleme: herhangi bir siteden yapistirilan akor+sozu kaydeder (internet gerekmez)
function manualAdd(e) {
  e.preventDefault();
  const artist = $('manual-artist').value.trim();
  const songName = $('manual-song').value.trim();
  const body = $('manual-body').value.replace(/\r/g, '').replace(/\s+$/, '');
  if (!songName) { toast('Şarkı adı gerekli'); $('manual-song').focus(); return; }
  if (!body.trim()) { toast('Akor/söz metni boş'); $('manual-body').focus(); return; }
  const song = {
    id: uid(),
    title: (artist ? artist + ' - ' : '') + songName,
    artist,
    song: songName,
    key: $('manual-key').value.trim(),
    body,
    source: '',
    transpose: 0,
    addedAt: Date.now(),
  };
  currentSetlist().songs.push(song);
  saveState();
  renderList();
  $('manual-artist').value = '';
  $('manual-song').value = '';
  $('manual-key').value = '';
  $('manual-body').value = '';
  closeSearch();
  toast('“' + songName + '” eklendi');
}

async function doSearch(e) {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (q.length < 2) return;
  const status = $('search-status');
  const box = $('search-results');
  box.innerHTML = '';
  status.innerHTML = '<span class="spinner"></span> Aranıyor…';
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Hata');
    if (!data.results.length) {
      status.textContent = 'Sonuç bulunamadı. Farklı yazmayı deneyin.';
      return;
    }
    status.textContent = data.results.length + ' sonuç';
    data.results.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'result-item';
      item.innerHTML =
        `<div class="info">
           <div class="t">${escapeHtml(r.song || r.title)}</div>
           <div class="a">${escapeHtml(r.artist || '')} <span class="src src-${r.source}">${escapeHtml(r.source || '')}</span></div>
         </div>
         <div class="add">＋</div>`;
      item.addEventListener('click', () => addSongFromUrl(r, item));
      box.appendChild(item);
    });
  } catch (err) {
    status.textContent = 'Arama başarısız: ' + err.message;
  }
}

async function addSongFromUrl(result, itemEl) {
  const add = itemEl.querySelector('.add');
  add.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch('/api/song?url=' + encodeURIComponent(result.url));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Hata');
    const song = {
      id: uid(),
      title: (data.artist ? data.artist + ' - ' : '') + data.song,
      artist: data.artist || result.artist || '',
      song: data.song || result.song || result.title,
      key: data.key || '',
      body: data.body,
      source: data.source || result.url,
      transpose: 0,
      addedAt: Date.now(),
    };
    currentSetlist().songs.push(song);
    saveState();
    renderList();
    add.textContent = '✓';
    add.style.color = 'var(--ok)';
    toast('“' + song.song + '” eklendi');
  } catch (err) {
    add.textContent = '！';
    add.style.color = 'var(--danger)';
    toast('Eklenemedi: ' + err.message);
  }
}

/* ==========================================================================
 * SETLIST YONETIMI
 * ========================================================================== */
function openSetlists() {
  renderSetlists();
  $('modal-setlists').classList.remove('hidden');
}
function closeSetlists() { $('modal-setlists').classList.add('hidden'); }

function renderSetlists() {
  const box = $('setlist-items');
  box.innerHTML = '';
  state.setlists.forEach((sl) => {
    const row = document.createElement('div');
    row.className = 'setlist-item' + (sl.id === state.currentId ? ' active' : '');
    row.innerHTML =
      `<span class="name">${escapeHtml(sl.name)}</span>
       <span class="cnt">${sl.songs.length}</span>
       <button class="mini rename" title="Yeniden adlandır">✎</button>
       <button class="mini danger del" title="Sil">🗑</button>`;
    row.querySelector('.name').addEventListener('click', () => {
      state.currentId = sl.id;
      saveState();
      renderList();
      closeSetlists();
    });
    row.querySelector('.rename').addEventListener('click', (e) => {
      e.stopPropagation();
      const name = prompt('Setlist adı:', sl.name);
      if (name && name.trim()) { sl.name = name.trim(); saveState(); renderSetlists(); renderList(); }
    });
    row.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.setlists.length === 1) { toast('Son setlist silinemez'); return; }
      if (!confirm('“' + sl.name + '” silinsin mi?')) return;
      state.setlists = state.setlists.filter((x) => x.id !== sl.id);
      if (state.currentId === sl.id) state.currentId = state.setlists[0].id;
      saveState();
      renderSetlists();
      renderList();
    });
    box.appendChild(row);
  });
}

function createSetlist(e) {
  e.preventDefault();
  const name = $('setlist-input').value.trim();
  if (!name) return;
  const sl = { id: uid(), name, songs: [] };
  state.setlists.push(sl);
  state.currentId = sl.id;
  $('setlist-input').value = '';
  saveState();
  renderSetlists();
  renderList();
  closeSetlists();
  toast('“' + name + '” oluşturuldu');
}

/* ==========================================================================
 * SARKI MENUSU (alt sayfa)
 * ========================================================================== */
function openSongSheet() {
  if (!currentSong) return;
  $('song-open-source').href = currentSong.source || '#';
  $('sheet-song').classList.remove('hidden');
}
function closeSongSheet() { $('sheet-song').classList.add('hidden'); }

/* ---------- Şarkıyı düzenle ---------- */
function openEdit() {
  if (!currentSong) return;
  closeSongSheet();
  $('edit-artist').value = currentSong.artist || '';
  $('edit-song').value = currentSong.song || currentSong.title || '';
  $('edit-key').value = currentSong.key || '';
  $('edit-duration').value = currentSong.duration ? fmtDuration(currentSong.duration) : '';
  $('edit-bpm').value = currentSong.bpm || '';
  $('edit-body').value = currentSong.body || '';
  $('modal-edit').classList.remove('hidden');
}
function closeEdit() { $('modal-edit').classList.add('hidden'); }
function saveEdit(e) {
  e.preventDefault();
  if (!currentSong) return;
  currentSong.artist = $('edit-artist').value.trim();
  currentSong.song = $('edit-song').value.trim() || currentSong.song;
  currentSong.key = $('edit-key').value.trim();
  currentSong.duration = parseDuration($('edit-duration').value);
  currentSong.bpm = parseInt($('edit-bpm').value, 10) || 0;
  currentSong.body = $('edit-body').value.replace(/\r/g, '');
  currentSong.title = (currentSong.artist ? currentSong.artist + ' - ' : '') + currentSong.song;
  saveState();
  closeEdit();
  $('song-title').textContent = currentSong.song || 'Şarkı';
  $('song-artist').textContent = currentSong.artist || '';
  updateKeyDisplay();
  paintSong();
  fitToWidth();
  toast('Kaydedildi');
}

/* ---------- Şarkıyı başka setliste ekle (kopya) ---------- */
function openCopy() {
  if (!currentSong) return;
  closeSongSheet();
  const box = $('copy-list');
  box.innerHTML = '';
  const others = state.setlists.filter((s) => s.id !== state.currentId);
  if (others.length === 0) {
    box.innerHTML = '<div class="sheet-title">Başka setlist yok. Önce ☰ menüsünden oluştur.</div>';
  } else {
    others.forEach((sl) => {
      const b = document.createElement('button');
      b.className = 'sheet-btn';
      b.textContent = sl.name + ' (' + sl.songs.length + ')';
      b.addEventListener('click', () => copyTo(sl.id));
      box.appendChild(b);
    });
  }
  $('sheet-copy').classList.remove('hidden');
}
function closeCopy() { $('sheet-copy').classList.add('hidden'); }
function copyTo(setlistId) {
  const target = state.setlists.find((s) => s.id === setlistId);
  if (!target || !currentSong) return;
  target.songs.push({ ...currentSong, id: uid(), addedAt: Date.now() });
  saveState();
  closeCopy();
  toast('“' + (currentSong.song || 'Şarkı') + '” → ' + target.name);
}

function moveSong(dir) {
  const sl = currentSetlist();
  const i = sl.songs.findIndex((s) => s.id === currentSong.id);
  const j = i + dir;
  if (j < 0 || j >= sl.songs.length) return;
  [sl.songs[i], sl.songs[j]] = [sl.songs[j], sl.songs[i]];
  saveState();
  renderList();
  toast(dir < 0 ? 'Yukarı taşındı' : 'Aşağı taşındı');
}

function deleteCurrentSong() {
  const sl = currentSetlist();
  sl.songs = sl.songs.filter((s) => s.id !== currentSong.id);
  saveState();
  closeSongSheet();
  renderList();
  showList();
  toast('Şarkı silindi');
}

async function refreshCurrentSong() {
  if (!currentSong || !currentSong.source) { toast('Kaynak adresi yok'); return; }
  closeSongSheet();
  toast('İnternetten yenileniyor…');
  try {
    const res = await fetch('/api/song?url=' + encodeURIComponent(currentSong.source));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Hata');
    currentSong.body = data.body;
    if (data.key) currentSong.key = data.key;
    saveState();
    paintSong();
    updateKeyDisplay();
    toast('Güncellendi');
  } catch (err) {
    toast('Yenilenemedi: ' + err.message);
  }
}

/* ==========================================================================
 * GEZINME + YARDIMCI
 * ========================================================================== */
function showList() {
  stopScroll();
  stopSongTimer();
  stopMetro();
  exitStage();
  releaseWakeLock();
  $('view-song').classList.add('hidden');
  $('view-list').classList.remove('hidden');
  renderList();
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ==========================================================================
 * SAHNE MODU + EKRAN UYANIK (Wake Lock)
 * ========================================================================== */
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}
}
function releaseWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (_) {}
}
// Ekran geri gelince kilidi tazele (sistem otomatik bırakır)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('view-song').classList.contains('hidden')) requestWakeLock();
});

function enterStage() {
  document.body.classList.add('stage');
  $('stage-exit').classList.remove('hidden');
  fitToWidth();
}
function exitStage() {
  document.body.classList.remove('stage');
  $('stage-exit').classList.add('hidden');
  fitToWidth();
}
function toggleStage() {
  document.body.classList.contains('stage') ? exitStage() : enterStage();
}

/* ==========================================================================
 * METRONOM (görsel flaş)
 * ========================================================================== */
let metroInterval = null;
function startMetro() {
  const bpm = currentSong && currentSong.bpm;
  if (!bpm) { toast('Önce ⋯ → Düzenle ile tempo (BPM) gir'); return; }
  stopMetro();
  $('metro-toggle').classList.add('on');
  const beat = 60000 / bpm;
  const flash = () => {
    const f = $('metro-flash');
    f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), Math.min(90, beat / 3));
  };
  flash();
  metroInterval = setInterval(flash, beat);
}
function stopMetro() {
  if (metroInterval) clearInterval(metroInterval);
  metroInterval = null;
  $('metro-toggle').classList.remove('on');
  $('metro-flash').classList.remove('on');
}
function toggleMetro() { metroInterval ? stopMetro() : startMetro(); }

// Tempoya vur (tap tempo) — düzenleme formunda
let tapTimes = [];
function tapTempo() {
  const now = Date.now();
  tapTimes = tapTimes.filter((t) => now - t < 3000);
  tapTimes.push(now);
  if (tapTimes.length >= 2) {
    let sum = 0;
    for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i - 1];
    const bpm = Math.round(60000 / (sum / (tapTimes.length - 1)));
    if (bpm >= 30 && bpm <= 300) $('edit-bpm').value = bpm;
  }
}

/* ==========================================================================
 * KULAKLIK (MediaSession) + KLAVYE / PEDAL İLE GEZİNME
 * ========================================================================== */
// Klavye: ← / → sonraki-önceki şarkı, boşluk = kaydırmayı aç/kapat
document.addEventListener('keydown', (e) => {
  if ($('view-song').classList.contains('hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); gotoRelative(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); gotoRelative(-1); }
  else if (e.key === ' ') { e.preventDefault(); toggleScroll(); }
});

// Kulaklık kumandası: sessiz ses çalıp medya oturumu olur -> kulaklığın
// ileri/geri (track) ve oynat/duraklat düğmeleri şarkı değiştirir.
let hpAudio = null;
let hpOn = false;
function silentWavUri() {
  const sr = 8000, sec = 1, n = sr * sec;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}
function toggleHeadphone() {
  if (!('mediaSession' in navigator)) { toast('Bu cihaz kulaklık kumandasını desteklemiyor'); return; }
  if (hpOn) { stopHeadphone(); return; }
  if (!hpAudio) {
    hpAudio = new Audio(silentWavUri());
    hpAudio.loop = true;
    hpAudio.volume = 0.001;
  }
  hpAudio.play().then(() => {
    hpOn = true;
    $('hp-toggle').classList.add('on');
    try {
      navigator.mediaSession.setActionHandler('nexttrack', () => gotoRelative(1));
      navigator.mediaSession.setActionHandler('previoustrack', () => gotoRelative(-1));
      navigator.mediaSession.setActionHandler('play', () => toggleScroll());
      navigator.mediaSession.setActionHandler('pause', () => toggleScroll());
      navigator.mediaSession.playbackState = 'playing';
    } catch (_) {}
    toast('Kulaklık kumandası açık: ileri/geri = şarkı');
  }).catch(() => toast('Ses başlatılamadı — bir kez ekrana dokunup tekrar dene'));
}
function stopHeadphone() {
  hpOn = false;
  $('hp-toggle').classList.remove('on');
  if (hpAudio) { try { hpAudio.pause(); } catch (_) {} }
}
function updateMediaMetadata() {
  if (!hpOn || !('mediaSession' in navigator) || !currentSong) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentSong.song || 'Şarkı',
      artist: currentSong.artist || '',
      album: currentSetlist().name || '',
    });
  } catch (_) {}
}

/* ==========================================================================
 * CIHAZLAR ARASI ESITLEME (grup kodu)
 * ========================================================================== */
function syncStatus(msg) { const el = $('sync-status'); if (el) el.textContent = msg; }

function updateSyncUI() {
  const on = sync.connected;
  $('sync-room').value = sync.room;
  $('sync-disconnect').classList.toggle('hidden', !on);
  $('sync-connect').textContent = on ? 'Yeniden Bağlan' : 'Bağlan';
  syncStatus(on ? 'Açık — grup: ' + sync.room : 'Kapalı (her cihaz ayrı)');
}

async function syncConnect() {
  const room = $('sync-room').value.trim();
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(room)) { toast('Kod 3-40 harf/rakam olmalı (boşluksuz)'); return; }
  syncStatus('Bağlanıyor…');
  try {
    const res = await fetch('/api/sync/' + encodeURIComponent(room));
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'hata');

    if (d.data && Array.isArray(d.data.setlists) && d.data.setlists.length) {
      // Sunucuda veri var -> bu cihaza yükle
      if (!confirm('“' + room + '” grubundaki setlistler bu cihaza yüklenecek ve buradaki mevcut setlistlerin yerine geçecek. Devam edilsin mi?')) {
        syncStatus('İptal edildi'); return;
      }
      sync.applyingRemote = true;
      state = d.data; sync.rev = d.rev; saveLocal();
      sync.applyingRemote = false;
      renderList();
    } else {
      // Sunucu boş -> bu cihazdaki veriyi gruba yükle
      sync.rev = d.rev;
      sync.room = room; sync.connected = true;
      await syncPushNow();
    }
    sync.room = room; sync.connected = true;
    localStorage.setItem('sync_room', room);
    localStorage.setItem('sync_rev', String(sync.rev));
    updateSyncUI();
    startPoll();
    toast('Eşitleme açık: ' + room);
  } catch (e) { syncStatus('Bağlanamadı: ' + e.message); }
}

function syncDisconnect() {
  sync.connected = false;
  stopPoll();
  localStorage.removeItem('sync_room');
  updateSyncUI();
  toast('Eşitleme kapatıldı');
}

function schedulePush() {
  clearTimeout(sync.pushTimer);
  sync.pushTimer = setTimeout(syncPushNow, 1200);
}
async function syncPushNow() {
  sync.pushTimer = null;   // zamanlayıcı ateşlendi -> temizle (yoksa yoklama kilitlenir)
  if (!sync.connected || !sync.room) return;
  try {
    const res = await fetch('/api/sync/' + encodeURIComponent(sync.room), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: state }),
    });
    const d = await res.json();
    if (res.ok) {
      sync.rev = d.rev;
      localStorage.setItem('sync_rev', String(sync.rev));
      syncStatus('Eşitlendi ✓ — grup: ' + sync.room);
    }
  } catch (_) { syncStatus('Çevrimdışı — bağlanınca eşitlenecek'); }
}

function startPoll() { stopPoll(); sync.pollTimer = setInterval(syncPoll, 4000); }
function stopPoll() { if (sync.pollTimer) clearInterval(sync.pollTimer); sync.pollTimer = null; }

async function syncPoll() {
  if (!sync.connected || sync.applyingRemote) return;
  if (sync.pushTimer) return; // gonderilecek yerel degisiklik var -> once o gitsin
  try {
    const r = await fetch('/api/sync/' + encodeURIComponent(sync.room) + '?revOnly=1');
    const { rev } = await r.json();
    if (rev > sync.rev) {
      const r2 = await fetch('/api/sync/' + encodeURIComponent(sync.room));
      const d = await r2.json();
      if (d.data && Array.isArray(d.data.setlists)) {
        const openId = currentSong && currentSong.id;
        sync.applyingRemote = true;
        state = d.data; sync.rev = d.rev; saveLocal();
        localStorage.setItem('sync_rev', String(sync.rev));
        sync.applyingRemote = false;
        if (!$('view-song').classList.contains('hidden')) {
          const sl = currentSetlist();
          const s = sl && sl.songs.find((x) => x.id === openId);
          if (s) { currentSong = s; updateNav(); } else showList();
        } else {
          renderList();
        }
        syncStatus('Güncellendi ✓ — grup: ' + sync.room);
      }
    }
  } catch (_) { /* ag hatasi -> sonraki yoklamada */ }
}

// Sayfa acilisinda kayitli gruba yeniden baglan
async function syncResume() {
  if (!sync.room) { updateSyncUI(); return; }
  sync.connected = true;
  updateSyncUI();
  startPoll();
  try {
    const r = await fetch('/api/sync/' + encodeURIComponent(sync.room));
    const d = await r.json();
    if (d.rev > sync.rev && d.data && Array.isArray(d.data.setlists)) {
      sync.applyingRemote = true;
      state = d.data; sync.rev = d.rev; saveLocal();
      localStorage.setItem('sync_rev', String(sync.rev));
      sync.applyingRemote = false;
      renderList();
    } else if (d.rev <= sync.rev) {
      syncPushNow(); // yereldeki (çevrimdışı) değişiklikleri gönder
    }
  } catch (_) {}
}

/* ==========================================================================
 * OLAYLAR
 * ========================================================================== */
$('btn-search').addEventListener('click', openSearch);
$('search-close').addEventListener('click', closeSearch);
$('search-form').addEventListener('submit', doSearch);
$('tab-online').addEventListener('click', () => switchTab('online'));
$('tab-repertoire').addEventListener('click', () => switchTab('repertoire'));
$('tab-manual').addEventListener('click', () => switchTab('manual'));
$('manual-form').addEventListener('submit', manualAdd);
$('repertoire-form').addEventListener('submit', fetchRepertoire);
$('repertoire-import').addEventListener('click', importRepertoire);

$('btn-setlists').addEventListener('click', openSetlists);
$('setlists-close').addEventListener('click', closeSetlists);
$('setlist-form').addEventListener('submit', createSetlist);
$('sync-form').addEventListener('submit', (e) => { e.preventDefault(); syncConnect(); });
$('sync-disconnect').addEventListener('click', syncDisconnect);
$('btn-force-update').addEventListener('click', forceUpdate);
$('btn-export').addEventListener('click', exportData);
$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) importData(f);
  e.target.value = '';
});

$('btn-back').addEventListener('click', showList);
$('btn-song-menu').addEventListener('click', openSongSheet);
$('nav-prev').addEventListener('click', () => gotoRelative(-1));
$('nav-next').addEventListener('click', () => gotoRelative(1));

$('tr-up').addEventListener('click', () => setTranspose(1));
$('tr-down').addEventListener('click', () => setTranspose(-1));
$('tr-reset').addEventListener('click', () => { if (currentSong) { currentSong.transpose = 0; saveState(); paintSong(); updateKeyDisplay(); } });
$('font-up').addEventListener('click', () => changeFont(2));
$('font-down').addEventListener('click', () => changeFont(-2));
$('font-fit').addEventListener('click', fitToWidth);

// Sıralama çipleri
document.querySelectorAll('.sortchip').forEach((chip) => {
  chip.addEventListener('click', () => setSortMode(chip.dataset.sort));
});

// Ekran döndürünce şarkı açıksa yeniden sığdır
window.addEventListener('resize', () => {
  if (!$('view-song').classList.contains('hidden')) fitToWidth();
});
$('scroll-toggle').addEventListener('click', toggleScroll);
$('view-song').addEventListener('touchstart', () => { if (scrolling) stopScroll(); }, { passive: true });

$('song-move-up').addEventListener('click', () => { moveSong(-1); closeSongSheet(); });
$('song-move-down').addEventListener('click', () => { moveSong(1); closeSongSheet(); });
$('song-refresh').addEventListener('click', refreshCurrentSong);
$('song-edit').addEventListener('click', openEdit);
$('song-copy').addEventListener('click', openCopy);
$('song-delete').addEventListener('click', deleteCurrentSong);
$('song-cancel').addEventListener('click', closeSongSheet);
$('edit-close').addEventListener('click', closeEdit);
$('edit-form').addEventListener('submit', saveEdit);
$('copy-cancel').addEventListener('click', closeCopy);

// Görünüm modu çipleri + süre sayacı
document.querySelectorAll('.viewchip').forEach((chip) => {
  chip.addEventListener('click', () => setViewMode(chip.dataset.view));
});
$('timer-pill').addEventListener('click', startSongTimer); // dokun -> sıfırdan başlat

// Sahne modu / metronom / kulaklık / tap tempo
$('stage-mode').addEventListener('click', toggleStage);
$('stage-exit').addEventListener('click', exitStage);
$('metro-toggle').addEventListener('click', toggleMetro);
$('hp-toggle').addEventListener('click', toggleHeadphone);
$('edit-tap').addEventListener('click', tapTempo);

// Etiket menüsü
$('label-segue').addEventListener('click', toggleSegue);
$('label-cancel').addEventListener('click', closeLabel);

// Sette hızlı arama
$('song-filter').addEventListener('input', (e) => { filterText = e.target.value; renderList(); });

// Modal arkaplanina tiklayinca kapat
[['modal-search', closeSearch], ['modal-setlists', closeSetlists], ['sheet-song', closeSongSheet],
 ['modal-edit', closeEdit], ['sheet-copy', closeCopy], ['sheet-label', closeLabel]]
  .forEach(([id, fn]) => {
    $(id).addEventListener('click', (e) => { if (e.target.id === id) fn(); });
  });

/* ---------- Service worker (cevrimdisi + otomatik guncelleme) ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Yeni sürüm bulununca hazır olduğunda sayfayı tazele
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            location.reload();
          }
        });
      });
    }).catch(() => {});
    // Denetleyici değişince (yeni SW devraldı) bir kez tazele
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  });
}

/* ---------- Yedekle / Geri yükle (setlistleri taşı) ---------- */
function exportData() {
  try {
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = 'sahne-setlist-yedek-' + d + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Yedek indirildi');
  } catch (e) { toast('Yedek alınamadı: ' + e.message); }
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.setlists)) throw new Error('Geçersiz yedek dosyası');
      // Mevcutları KORU, yedektekileri ekle (yeni id ile -> çakışma olmaz)
      let added = 0;
      data.setlists.forEach((sl) => {
        if (!sl || !Array.isArray(sl.songs)) return;
        state.setlists.push({ id: uid(), name: sl.name || 'Setlist', sortMode: sl.sortMode || 'manual', songs: sl.songs });
        added++;
      });
      saveState();
      renderList();
      renderSetlists();
      toast(added + ' setlist geri yüklendi');
    } catch (e) { toast('Dosya okunamadı: ' + e.message); }
  };
  reader.readAsText(file);
}

// Önbelleği zorla temizleyip en güncel sürümü yükler (takılan SW'yi kırar)
async function forceUpdate() {
  toast('Güncelleniyor…');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const ks = await caches.keys();
      await Promise.all(ks.map((k) => caches.delete(k)));
    }
  } catch (_) {}
  location.reload();
}

/* ---------- Baslat ---------- */
renderList();
syncResume();
