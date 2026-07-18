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

// Canlı takip (oto-geçiş): biri şarkı açınca, "Takip açık" olanlar aynı şarkıya geçer
let follow = localStorage.getItem('follow') === '1';
let liveRev = 0;
let applyingLive = false;
let livePollTimer = null;

// Bookmarklet içe aktarma kutusu
let pendingImports = [];
let pendingImportId = null;

// Sıradaki şarkı önizleme şeridi (varsayılan açık)
let nextPeek = localStorage.getItem('nextpeek') !== '0';
// Ortak Sahne (grup canlı ekranı)
let stageShareOn = false;
let shareRev = 0;
let sharePollTimer = null;

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
  // Gerçek yerel değişiklik -> içerik zaman damgasını güncelle. Eşitleme
  // çakışmalarında (özellikle sunucu uyku sonrası rev'i sıfırlarsa) hangi
  // tarafın daha yeni olduğuna rev yerine BUNA bakarız (bkz. pickNewer).
  state.updatedAt = Date.now();
  saveLocal();
  if (sync.connected && !sync.applyingRemote) schedulePush();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function currentSetlist() {
  return state.setlists.find((s) => s.id === state.currentId) || state.setlists[0];
}

// İstek Havuzu: sahnede seyirci isteklerini hızlıca çekmek için özel setlist
let lastNonPoolId = null;
function ensureRequestPool() {
  if (!state.setlists.some((s) => s.isPool)) {
    state.setlists.push({ id: 'reqpool', name: '🎧 İstek Havuzu', songs: [], isPool: true });
  }
}
// Havuzdaki bir şarkıyı asıl sete (havuz olmayan son setliste) kopyala
function addFromPool(songId) {
  const pool = state.setlists.find((s) => s.isPool);
  const song = pool && pool.songs.find((s) => s.id === songId);
  if (!song) return;
  let target = state.setlists.find((s) => s.id === lastNonPoolId && !s.isPool)
    || state.setlists.find((s) => !s.isPool);
  if (!target) { toast('Önce normal bir setlist seç'); return; }
  target.songs.push({ ...song, id: uid(), addedAt: Date.now(), played: false });
  saveState();
  toast('“' + (song.song || 'Şarkı') + '” → ' + target.name);
}
function togglePool() {
  ensureRequestPool();
  const cur = currentSetlist();
  if (cur && cur.isPool) {
    state.currentId = (lastNonPoolId && state.setlists.some((s) => s.id === lastNonPoolId))
      ? lastNonPoolId : (state.setlists.find((s) => !s.isPool) || {}).id;
  } else {
    lastNonPoolId = state.currentId;
    state.currentId = state.setlists.find((s) => s.isPool).id;
  }
  saveState();
  renderList();
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
 * NAKARAT ÇIKARIMI  — "Sadece nakaratlar" modu (oyun havaları için)
 *  Şarkının yalnızca koro/nakarat bölümünü döndürür. Önce etiketli bölümü
 *  ("Nakarat:", "Chorus" vb.) arar; yoksa gövdedeki EN ÇOK TEKRAR EDEN
 *  paragraf bloğunu seçer (koro genelde birkaç kez tekrarlanır). Bulamazsa ''.
 * ========================================================================== */
function extractChorus(body) {
  if (!body) return '';
  const lines = body.replace(/\r/g, '').split('\n');
  const isLbl = (l) => l.trim().length <= 30 &&
    /(nakarat|nakart|chorus|refran|refr|koro|baglanti)/i.test(trSimplify(l));
  // 1) Etiketli nakarat bloğu (etiketten sonraki ilk boş satıra kadar)
  for (let i = 0; i < lines.length; i++) {
    if (!isLbl(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const blk = [];
    while (j < lines.length && lines[j].trim() !== '') { blk.push(lines[j]); j++; }
    if (blk.join('').trim()) return blk.join('\n').trim();
  }
  // 2) Etiket yok -> en çok tekrar eden (>=2) paragraf bloğu
  const blocks = body.replace(/\r/g, '').split(/\n[ \t]*\n/)
    .map((b) => b.replace(/[ \t]+\n/g, '\n').trim()).filter(Boolean);
  if (blocks.length < 2) return '';
  const sig = (b) => b.split('\n').filter((l) => !isChordLine(l))
    .map((l) => trSimplify(l).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join(' | ');
  const counts = {}, firstBlock = {};
  blocks.forEach((b) => {
    const s = sig(b);
    if (!s || s.length < 8) return;
    counts[s] = (counts[s] || 0) + 1;
    if (!(s in firstBlock)) firstBlock[s] = b;
  });
  let bestSig = '', best = 0;
  for (const s in counts) {
    if (counts[s] >= 2 && s.length > best) { best = s.length; bestSig = s; }
  }
  return bestSig ? firstBlock[bestSig] : '';
}

/* ==========================================================================
 * AKOR GEÇİŞİ  — şarkının ilk/son akoru; "akor geçişli" sıralama için
 * ========================================================================== */
// Şarkının gövdesinden (transpoze dahil) ilk ve son akoru döndürür
function firstLastChords(song) {
  const body = song.body || '';
  if (!body) return null;
  const semi = song.transpose || 0;
  const preferFlat = /b/.test(song.key || '');
  const chords = [];
  body.split('\n').forEach((line) => {
    if (!isChordLine(line)) return;
    line.trim().split(/\s+/).filter(Boolean).forEach((tok) => {
      chords.push(semi ? transposeToken(tok, semi, preferFlat) : tok);
    });
  });
  if (!chords.length) return null;
  return { first: chords[0], last: chords[chords.length - 1] };
}
function chordRoot(tok) {
  const m = (tok || '').match(/^([A-G](##?|bb?)?)/);
  return m ? m[1] : '';
}
// Son akor (a) ile sonraki şarkının ilk akoru (b) ne kadar uyuyor:
// 2 = birebir aynı akor, 1 = aynı kök (Am↔A), 0 = alakasız
function chordMatchScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 2;
  const ra = noteIndex(chordRoot(a)), rb = noteIndex(chordRoot(b));
  if (ra >= 0 && ra === rb) return 1;
  return 0;
}
// Bir grup şarkıyı akor zinciriyle sırala. seed verilirse ilk şarkı, giriş
// akoru seed'e en çok uyan şarkıdır (gruplar arası pürüzsüz geçiş için).
// Akoru olmayan şarkı zinciri koparmaz; önceki akoru taşır. {order,last} döndürür.
function chainByChords(group, seed, ends) {
  const remaining = group.slice();
  const out = [];
  let cur = seed;
  while (remaining.length) {
    let bestI = 0, bestScore = -1;
    for (let i = 0; i < remaining.length; i++) {
      const e = ends[remaining[i].id];
      const score = (cur && e && e.first) ? chordMatchScore(cur, e.first) : 0;
      if (score > bestScore) { bestScore = score; bestI = i; }
    }
    const pick = remaining.splice(bestI, 1)[0];
    out.push(pick);
    const pe = ends[pick.id];
    cur = (pe && pe.last) || cur;   // akor yoksa önceki çıkış akorunu koru
  }
  return { order: out, last: cur };
}

// Akor geçişli sıralama: önce TÜRLERE göre grupla (sahne sırası gibi,
// sl.genreOrder), her tür grubu İÇİNDE akor zinciriyle diz; grup son akorunu
// bir sonraki gruba taşı ki tür geçişleri de mümkünse akoruyla uysun.
function generateChordOrder(sl) {
  const songs = sl.songs.slice();
  if (songs.length <= 1) return songs;
  const ends = {};
  songs.forEach((s) => { ends[s.id] = firstLastChords(s); });

  if (!sl.genreOrder || !sl.genreOrder.length) sl.genreOrder = defaultGenreOrder();
  const orderKeys = sl.genreOrder.slice();
  // sette olup tür sırasında olmayan türleri sona ekle (güvenlik)
  songs.forEach((s) => { const k = s.color || NONE_KEY; if (!orderKeys.includes(k)) orderKeys.push(k); });

  const out = [];
  const done = new Set();
  let carry = null;   // önceki tür grubunun son akoru
  orderKeys.forEach((k) => {
    if (done.has(k)) return;
    done.add(k);
    const group = songs.filter((s) => (s.color || NONE_KEY) === k);
    if (!group.length) return;
    const res = chainByChords(group, carry, ends);
    res.order.forEach((s) => out.push(s));
    carry = res.last;
  });
  return out;
}

/* ==========================================================================
 * GORUNUM: SETLIST LISTESI
 * ========================================================================== */
const NONE_KEY = 'zz-none';
// Varsayılan tür sırası: COLORS sırası + etiketsizler sona
function defaultGenreOrder() {
  return COLORS.map((c) => c.key).concat(NONE_KEY);
}
// Sahne sırası üret: türleri sl.genreOrder sırasıyla grupla; her tür içinde
// şarkılar "Kendi sıram" (sl.songs) sırasında. Ana sırayı DEĞİŞTİRMEZ (sl.stageOrder ayrı).
function generateStageOrder(sl) {
  if (!sl.genreOrder || !sl.genreOrder.length) sl.genreOrder = defaultGenreOrder();
  const out = [];
  const used = new Set();
  sl.genreOrder.forEach((k) => {
    sl.songs.forEach((s) => {
      if ((s.color || NONE_KEY) === k && !used.has(s.id)) { out.push(s.id); used.add(s.id); }
    });
  });
  sl.songs.forEach((s) => { if (!used.has(s.id)) out.push(s.id); }); // güvenlik
  sl.stageOrder = out;
  saveState();
}

// Setlist'in gosterim sirasi (secili siralama moduna gore)
function orderedSongs(sl) {
  const mode = sl.sortMode || 'manual';
  if (mode === 'manual' || mode === 'chorus') return sl.songs;
  if (mode === 'stage') {
    if (!sl.stageOrder || !sl.stageOrder.length) generateStageOrder(sl);
    const byId = {};
    sl.songs.forEach((s) => { byId[s.id] = s; });
    const seen = new Set();
    const out = [];
    (sl.stageOrder || []).forEach((id) => {
      if (byId[id] && !seen.has(id)) { out.push(byId[id]); seen.add(id); }
    });
    sl.songs.forEach((s) => { if (!seen.has(s.id)) out.push(s); }); // yeni eklenenler sona
    return out;
  }
  if (mode === 'chord') return generateChordOrder(sl);
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

// Etiket renkleri (renk = şarkı türü)
const COLORS = [
  { key: 'blue', name: 'Slow', css: '#4c8dff', tint: 'rgba(76,141,255,0.22)' },
  { key: 'green', name: 'Pop', css: '#35d07f', tint: 'rgba(53,208,127,0.22)' },
  { key: 'red', name: 'Rock', css: '#ff5a5a', tint: 'rgba(255,90,90,0.22)' },
  { key: 'orange', name: 'Türkü', css: '#ff9f43', tint: 'rgba(255,159,67,0.22)' },
  { key: 'purple', name: 'Arabesk', css: '#a066ff', tint: 'rgba(160,102,255,0.22)' },
  { key: 'gray', name: 'Oyun Havası', css: '#8a94a6', tint: 'rgba(138,148,166,0.24)' },
];
function colorCss(key) { const c = COLORS.find((x) => x.key === key); return c ? c.css : ''; }
function colorName(key) { const c = COLORS.find((x) => x.key === key); return c ? c.name : ''; }
function colorTint(key) { const c = COLORS.find((x) => x.key === key); return c ? c.tint : ''; }

// Sanatçıya göre otomatik tür tahmini (renk anahtarı döndürür, bulunamazsa '').
// slow/cover otomatik atanmaz (tempo/icra türü); rock/pop/arabesk/türkü atanır.
const ARTIST_GENRE = {};
(function () {
  const map = {
    // blue = Slow / akustik / şarkı-söz (yavaş ballad ağırlıklı)
    blue: ['onur can ozcan', 'cem adrian', 'kaan bosnak', 'deniz tekin', 'sena sener', 'ceylan ertem', 'melike sahin', 'gaye su akyol', 'evdeki saat', 'leyla the band', 'sen', 'no.1', 'sagopa kajmer', 'beduk', 'yuzyuzeyken konusuruz', 'ah kosmos', 'jehan barbur', 'kalben', 'nova norda', 'melek mosso', 'ilyas yalcintas', 'edis?', 'gazapizm', 'ezhel?', 'konyali'],
    red: ['duman', 'manga', 'sebnem ferah', 'mor ve otesi', 'pentagram', 'athena', 'kurban', 'pinhani', 'gripin', 'teoman', 'yuksek sadakat', 'badem', 'model', 'redd', 'emre aydin', 'replikas', 'kargo', 'bulutsuzluk ozlemi', 'feridun duzagac', 'hayko cepkin', 'ogun sanlisoy', 'adamlar', 'son feci bisiklet', 'dolu kadehi ters tut', 'gece yolculari', 'zakkum', 'madrigal', 'kramp', 'ezginin gunlugu', 'moron', 'palmiyeler', 'buyuk ev ablukada', 'kirmizi', 'sattas', 'leman sam', 'cem karaca', 'baris manco', 'erkin koray', 'edip akbayram', 'fikret kizilok', 'mogollar', 'nekropsi', 'coma', 'pilli bebek', 'aylin aslim', 'demir demirkan', 'kramponlar', 'stramiliti', 'no.1?', 'birol namoglu', 'kramp', '86', 'sagopa', 'the ringo jets', 'lin pesto', 'dodo'],
    green: ['tarkan', 'sezen aksu', 'kenan dogulu', 'murat boz', 'hadise', 'hande yener', 'sertab erener', 'gulsen', 'simge', 'mustafa sandal', 'sila', 'aleyna tilki', 'edis', 'mabel matiz', 'ajda pekkan', 'nilufer', 'serdar ortac', 'gokhan ozen', 'bengu', 'ziynet sali', 'gulben ergen', 'demet akalin', 'funda arar', 'gokhan turkmen', 'buray', 'zeynep bastik', 'irem derici', 'feride hilal akin', 'aleyna', 'ece seckin', 'zerrin ozer', 'levent yuksel', 'yalin', 'gokhan kirdar', 'kenan', 'gokce', 'petek dincoz', 'can bonomo', 'nazan oncel', 'ilhan sesen', 'sezen', 'gokhan tepe', 'tuvana', 'ozgun', 'reynmen', 'semicenk', 'lvbel c5', 'mahmut orhan', 'zeynep', 'melis', 'ecem', 'dilara', 'ferhat gocer', 'alisan', 'gozde', 'sagopa?', 'manuel', 'derya ulug', 'kubilay aka', 'ada', 'merve', 'seksendort', 'model?'],
    purple: ['muslum gurses', 'orhan gencebay', 'ferdi tayfur', 'ibrahim tatlises', 'bergen', 'ceylan', 'azer bulbul', 'kibariye', 'hakki bulut', 'mahsun kirmizigul', 'cengiz kurtoglu', 'ozcan deniz', 'ismail yk', 'sibel can', 'emrah', 'selami sahin', 'ebru gundes', 'yildiz tilbe', 'mustafa keser', 'coskun sabah', 'zeki muren', 'bulent ersoy', 'hakan altun', 'ferdi ozbegen', 'gokhan guney', 'intizar', 'deniz seki', 'mine kosan', 'gulden karabocek', 'necati alsan', 'ismail turut', 'ozer sarigul', 'ozan', 'ankarali namik', 'seyyal taner?', 'fatih kisaparmak', 'orhan olmez', 'ahmet selcuk ilkan', 'kucuk emrah', 'gulhan?'],
    orange: ['neset ertas', 'asik veysel', 'musa eroglu', 'arif sag', 'belkis akkale', 'kubat', 'sabahat akkiraz', 'ozay gonlum', 'asik mahzuni serif', 'mahzuni serif', 'davut sulari', 'erkan ogur', 'selda bagcan', 'ruhi su', 'tolga sag', 'cengiz ozkan', 'izzet altinmese', 'sinan yilmaz', 'onur akin', 'ahmet kaya', 'zara', 'resul dindar', 'mahmut tuncer', 'grup yorum', 'kardes turkuler', 'aynur dogan', 'ilkay akkaya', 'ferhat tunc', 'yavuz bingol', 'nilufer saritas', 'sabahat', 'ozan?', 'kivircik ali', 'ismail altunsaray', 'musa', 'bajar', 'koma', 'sivan perwer', 'volkan konak', 'ozcan turkmen', 'gulay', 'ozgur bayram'],
  };
  for (const key in map) map[key].forEach((a) => { if (!a.includes('?')) ARTIST_GENRE[a] = key; });
})();

function guessGenre(artist) {
  const n = trSimplify(artist || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!n) return '';
  if (ARTIST_GENRE[n]) return ARTIST_GENRE[n];
  // "feat."/parantez vb. temizle, ilk sanatçıyı dene
  const base = n.split(/\s*(?:feat\.?|ft\.?|&|,|\/|\(|-)\s*/)[0].trim();
  return ARTIST_GENRE[base] || '';
}

let filterText = '';
// Filtreler cihazda kalıcı: sayfa yenilenince/geri gelince seçim korunur
let filterGenre = localStorage.getItem('filterGenre') || '';   // '' = tümü, ya da renk anahtarı
let filterPlayed = localStorage.getItem('filterPlayed') || ''; // '' | 'played' | 'unplayed'
let filterPractice = localStorage.getItem('filterPractice') === '1'; // sadece prova listesi
let filterHidden = localStorage.getItem('filterHidden') === '1'; // sadece gizlenenler
function saveFilters() {
  localStorage.setItem('filterGenre', filterGenre);
  localStorage.setItem('filterPlayed', filterPlayed);
  localStorage.setItem('filterPractice', filterPractice ? '1' : '0');
  localStorage.setItem('filterHidden', filterHidden ? '1' : '0');
}

// Filtre çubuğunu (tür + çalınan/çalınmayan) çizer
function renderFilters() {
  const sl = currentSetlist();
  const mode = sl.sortMode || 'manual';
  const bar = $('filter-bar');
  bar.innerHTML = '';
  const anyPlayed = sl.songs.some((s) => s.played);
  const anyPractice = sl.songs.some((s) => s.practice);
  const hiddenCount = sl.songs.filter((s) => s.hidden).length;
  // sette bulunan türler
  const genres = [...new Set(sl.songs.map((s) => s.color).filter(Boolean))];
  const modeBar = (mode === 'stage' || mode === 'chord' || mode === 'chorus');
  if (genres.length === 0 && !anyPlayed && !anyPractice && !hiddenCount && !modeBar) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const chip = (label, active, onClick, css) => {
    const b = document.createElement('button');
    b.className = 'filt' + (active ? ' active' : '');
    b.textContent = label;
    if (css && active) { b.style.background = css; b.style.borderColor = css; b.style.color = '#0b0d12'; }
    b.addEventListener('click', onClick);
    bar.appendChild(b);
  };

  // Sahne & Akor geçişli modunda "tür sırasını düzenle" düğmesi
  if (mode === 'stage' || mode === 'chord') {
    const sh = document.createElement('button');
    sh.className = 'filt shuffle';
    sh.textContent = '🎭 Tür sırası';
    sh.addEventListener('click', openGenreOrder);
    bar.appendChild(sh);
  }
  // Nakaratlar modunda "Potpuri oynat" düğmesi
  if (mode === 'chorus') {
    const pp = document.createElement('button');
    pp.className = 'filt shuffle';
    pp.textContent = '▶ Potpuri';
    pp.title = 'Setteki tüm nakaratları tek akışta göster';
    pp.addEventListener('click', openPotpuri);
    bar.appendChild(pp);
  }

  chip('Tümü', !filterGenre && !filterPlayed && !filterPractice && !filterHidden, () => { filterGenre = ''; filterPlayed = ''; filterPractice = false; filterHidden = false; saveFilters(); renderList(); });
  if (anyPractice) {
    chip('🎯 Prova', filterPractice, () => { filterPractice = !filterPractice; if (filterPractice) filterHidden = false; saveFilters(); renderList(); });
  }
  if (anyPlayed) {
    chip('✓ Çalınan', filterPlayed === 'played', () => { filterPlayed = filterPlayed === 'played' ? '' : 'played'; if (filterPlayed) filterHidden = false; saveFilters(); renderList(); });
    chip('○ Çalınmayan', filterPlayed === 'unplayed', () => { filterPlayed = filterPlayed === 'unplayed' ? '' : 'unplayed'; if (filterPlayed) filterHidden = false; saveFilters(); renderList(); });
  }
  if (hiddenCount) {
    chip('🙈 Gizlenen (' + hiddenCount + ')', filterHidden, () => { filterHidden = !filterHidden; if (filterHidden) { filterPlayed = ''; filterPractice = false; } saveFilters(); renderList(); });
  }
  genres.forEach((g) => {
    chip(colorName(g), filterGenre === g, () => { filterGenre = filterGenre === g ? '' : g; saveFilters(); renderList(); }, colorCss(g));
  });
  if (anyPlayed) {
    const clr = document.createElement('button');
    clr.className = 'filt clear';
    clr.textContent = '↺ İşaretleri sıfırla';
    clr.addEventListener('click', () => {
      if (!confirm('Tüm "çalındı" işaretleri kaldırılsın mı?')) return;
      sl.songs.forEach((s) => { s.played = false; });
      saveState();
      renderList();
    });
    bar.appendChild(clr);
  }
}

function renderList() {
  const sl = currentSetlist();
  const mode = sl.sortMode || 'manual';
  renderFilters();
  renderEnergyStrip();
  $('current-setlist-name').textContent = sl.name;
  const totalSec = sl.songs.reduce((a, s) => a + (s.duration || 0), 0);
  $('current-setlist-count').textContent =
    (sl.songs.length ? sl.songs.length + ' şarkı' : '') +
    (totalSec ? ' · ~' + Math.round(totalSec / 60) + ' dk' : '');

  // aktif siralama cipini isaretle
  document.querySelectorAll('.sortchip').forEach((c) =>
    c.classList.toggle('active', c.dataset.sort === mode));

  const draggable = (mode === 'manual' || mode === 'stage' || mode === 'chorus');
  const chordMode = mode === 'chord';
  const list = $('song-list');
  list.className = 'song-list' + (draggable ? '' : ' nodrag');
  list.innerHTML = '';
  $('empty-list').classList.toggle('hidden', sl.songs.length > 0);

  const q = trSimplify(filterText).toLowerCase().trim();
  let shown = 0;
  let prevLast = null;   // akor geçişli modda önceki şarkının çıkış akoru
  orderedSongs(sl).forEach((song, i) => {
    if (q) {
      const hay = trSimplify((song.artist || '') + ' ' + (song.song || song.title || '')).toLowerCase();
      if (!hay.includes(q)) return;
    }
    // Gizlenenler: normalde listede yok; yalnız "🙈 Gizlenen" filtresinde görünür
    if (filterHidden) { if (!song.hidden) return; }
    else if (song.hidden) return;
    if (filterGenre && song.color !== filterGenre) return;
    if (filterPlayed === 'played' && !song.played) return;
    if (filterPlayed === 'unplayed' && song.played) return;
    if (filterPractice && !song.practice) return;
    shown++;
    const card = document.createElement('div');
    card.className = 'song-card' + (song.color ? ' tinted' : '') + (song.played ? ' played' : '');
    card.dataset.id = song.id;
    if (song.color) {
      card.style.background = colorTint(song.color);
      card.style.borderColor = colorCss(song.color);
    }
    const pending = !song.body && song.source ? '<span class="badge">indirilmedi ⬇</span>' : '';
    const dur = song.duration ? `<div class="badge">${fmtDuration(song.duration)}</div>` : '';
    const tag = song.color ? `<span class="badge tag-chip" style="background:${colorCss(song.color)}">${escapeHtml(colorName(song.color))}</span>` : '';
    const segue = song.segue ? '<span class="segue-mark" title="Sonrakine bağlı">🔗</span>' : '';
    const practiceBadge = song.practice ? '<span class="badge practice" title="Prova listesinde">🎯</span>' : '';
    const hiddenBadge = song.hidden ? '<span class="badge hidden-badge" title="Gizli — akor sıralamasına girmez">🙈</span>' : '';
    const vocalBadge = (song.vocalOk && songKeyStr(song))
      ? `<span class="badge vocal" title="Rahat söylenen ton (kilitli)">🎤 ${escapeHtml(songKeyStr(song))}</span>` : '';
    let chorusBadge = '';
    if (mode === 'chorus') {
      const manual = !!(song.chorusText && song.chorusText.trim());
      chorusBadge = chorusOf(song)
        ? `<span class="badge chordbadge${manual ? ' linked' : ''}" title="${manual ? 'Nakarat elle seçildi' : 'Nakarat (otomatik tahmin)'}">🎉${manual ? ' ✓' : ' ~'}</span>`
        : '<span class="badge chordbadge dim" title="Nakarat yok — aç, ⋯ → ✂️ ile seç">nakarat yok</span>';
    }
    let chordbadge = '';
    if (chordMode) {
      const e = firstLastChords(song);
      if (e) {
        const linked = prevLast && chordMatchScore(prevLast, e.first) > 0;
        chordbadge = `<span class="badge chordbadge${linked ? ' linked' : ''}" title="giriş → çıkış akoru">${linked ? '🔗 ' : ''}${escapeHtml(e.first)}→${escapeHtml(e.last)}</span>`;
        prevLast = e.last;
      } else {
        chordbadge = '<span class="badge chordbadge dim" title="Akor bulunamadı — şarkıyı indir">akor yok</span>';
        prevLast = null;
      }
    }
    card.innerHTML =
      `<button class="tick" data-tick title="Çalındı işareti">${song.played ? '✓' : ''}</button>
       <div class="song-num">${i + 1}</div>
       <div class="info">
         <div class="t">${escapeHtml(song.song || song.title || 'Şarkı')} ${segue}</div>
         <div class="a">${escapeHtml(song.artist || '')}</div>
       </div>
       ${chordbadge}
       ${chorusBadge}
       ${vocalBadge}
       ${practiceBadge}
       ${hiddenBadge}
       ${tag}
       ${dur}
       ${song.transpose ? `<div class="badge">${song.transpose > 0 ? '+' : ''}${song.transpose}</div>` : ''}
       ${pending}
       ${sl.isPool ? '<button class="tag-btn" data-addset title="Sete ekle">＋Set</button>' : '<button class="tag-btn" data-tag title="Tür/renk/segue">🏷</button>'}
       <div class="drag" data-handle>⠿</div>`;
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-tick]')) { togglePlayed(song.id); return; }
      if (ev.target.closest('[data-addset]')) { addFromPool(song.id); return; }
      if (ev.target.closest('[data-tag]')) { openLabel(song.id); return; }
      if (!card._dragged) openSong(song.id);
    });
    if (draggable) attachDrag(card, card.querySelector('[data-handle]'));
    list.appendChild(card);
  });
  $('empty-list').classList.toggle('hidden', shown > 0);
}

/* ---------- Tür sırası düzenleyici (sahne sırası) ---------- */
function openGenreOrder() {
  const sl = currentSetlist();
  if (!sl.genreOrder || !sl.genreOrder.length) sl.genreOrder = defaultGenreOrder();
  renderGenreOrder();
  $('sheet-genre').classList.remove('hidden');
}
function closeGenreOrder() { $('sheet-genre').classList.add('hidden'); }
function renderGenreOrder() {
  const sl = currentSetlist();
  const box = $('genre-order-list');
  box.innerHTML = '';
  // yalnızca sette bulunan türleri göster (sıralı)
  const present = new Set(sl.songs.map((s) => s.color || NONE_KEY));
  const visible = sl.genreOrder.filter((k) => present.has(k));
  visible.forEach((k, idx) => {
    const count = sl.songs.filter((s) => (s.color || NONE_KEY) === k).length;
    const row = document.createElement('div');
    row.className = 'genre-row';
    const dot = k === NONE_KEY ? '#3a3a3a' : colorCss(k);
    const name = k === NONE_KEY ? 'Etiketsiz' : colorName(k);
    row.innerHTML =
      `<span class="genre-dot" style="background:${dot}"></span>
       <span class="genre-name">${idx + 1}. ${escapeHtml(name)}</span>
       <span class="muted">${count}</span>
       <button class="gorder-btn" data-up ${idx === 0 ? 'disabled' : ''}>↑</button>
       <button class="gorder-btn" data-down ${idx === visible.length - 1 ? 'disabled' : ''}>↓</button>`;
    row.querySelector('[data-up]').addEventListener('click', () => moveGenre(k, -1));
    row.querySelector('[data-down]').addEventListener('click', () => moveGenre(k, 1));
    box.appendChild(row);
  });
}
function moveGenre(key, dir) {
  const sl = currentSetlist();
  const present = new Set(sl.songs.map((s) => s.color || NONE_KEY));
  const visible = sl.genreOrder.filter((k) => present.has(k));
  const i = visible.indexOf(key);
  const j = i + dir;
  if (j < 0 || j >= visible.length) return;
  [visible[i], visible[j]] = [visible[j], visible[i]];
  // görünür olmayanları sona ekleyerek tam sırayı yeniden kur
  const rest = sl.genreOrder.filter((k) => !present.has(k));
  sl.genreOrder = visible.concat(rest);
  generateStageOrder(sl);   // yeni tür sırasına göre yeniden grupla
  renderGenreOrder();
  renderList();
}

function togglePlayed(songId) {
  const song = currentSetlist().songs.find((s) => s.id === songId);
  if (!song) return;
  song.played = !song.played;
  saveState();
  renderList();
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
  const hb = $('label-hide');
  if (hb) {
    hb.classList.toggle('on', !!song.hidden);
    hb.textContent = (song.hidden ? '🙈 Gizli ✓ — göstermek için dokun' : '🙈 Şarkıyı gizle (listeden/akor sırasından çıkar)');
  }
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
function toggleHide() {
  const song = currentSetlist().songs.find((s) => s.id === labelSongId);
  if (!song) return;
  song.hidden = !song.hidden;
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
  const sl = currentSetlist();
  const mode = sl.sortMode || 'manual';
  // Görünen (belki filtreli) kartların yeni sırası
  const newVisible = [...$('song-list').querySelectorAll('.song-card')].map((c) => c.dataset.id);
  // Bu moddaki tam (filtresiz) sıra
  const oldFull = orderedSongs(sl).map((s) => s.id);
  const visibleSet = new Set(newVisible);
  let vi = 0;
  // Tam sırada, görünen slotlara yeni görünen sırayı yerleştir; gizli olanlar yerinde kalır
  const newFull = oldFull.map((id) => (visibleSet.has(id) ? newVisible[vi++] : id));

  if (mode === 'stage') {
    sl.stageOrder = newFull;               // sadece sahne sırasını değiştir
  } else {
    // manual: ana sırayı yeni tam sıraya göre diz
    const pos = {}; newFull.forEach((id, i) => { pos[id] = i; });
    sl.songs.sort((a, b) => (pos[a.id] ?? 0) - (pos[b.id] ?? 0));
  }
  saveState();
  renderList();
}

/* ==========================================================================
 * GORUNUM: SARKI
 * ========================================================================== */
let autoPlayTimer = null;
async function openSong(songId) {
  const sl = currentSetlist();
  const song = sl.songs.find((s) => s.id === songId);
  if (!song) return;
  currentSong = song;
  chorusOnly = (sl.sortMode === 'chorus');   // Nakaratlar modunda otomatik sadece koro
  ensureRhythmAvailable(song);   // eşitlenen özel davulu yerel listeye geri kur
  // 1 dakikadan fazla açık kalırsa otomatik "çalındı" işaretle (elle de tikleyebilirsin)
  clearTimeout(autoPlayTimer);
  autoPlayTimer = setTimeout(() => {
    if (currentSong && currentSong.id === song.id && !song.played) {
      song.played = true;
      saveState();
    }
  }, 60000);

  $('song-title').textContent = song.song || song.title || 'Şarkı';
  $('song-artist').textContent = song.artist || '';
  updateKeyDisplay();
  applyFont();
  updateNav();

  $('view-list').classList.add('hidden');
  $('view-song').classList.remove('hidden');
  $('view-song').scrollTop = 0;
  stopScroll();
  stopCrawl();
  document.querySelectorAll('.viewchip').forEach((c) =>
    c.classList.toggle('active', c.dataset.view === viewMode));
  startSongTimer();
  requestWakeLock();
  stopRhythm();
  stopBacking();
  updateBpmUI();
  updateQuickBtn();
  broadcastLive();   // gruba "su an bu sarkidayiz" bildir (takip edenler gelsin)

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
  updateCrawlChip();
  updateCrawlLabels();
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
  // Sahne modu alt çubuğu
  $('stage-prev').disabled = !prev;
  $('stage-next').disabled = !next;
  $('stage-prev').textContent = prev ? '‹ ' + (prev.song || prev.title || 'Önceki') : '‹ Önceki';
  $('stage-next').textContent = next ? (next.song || next.title || 'Sonraki') + ' ›' : 'Sonraki ›';
  updateNextPeek(next);
}

/* ==========================================================================
 * SIRADAKI ŞARKI ÖNİZLEME ŞERİDİ  (söz kaydırırken bile altta görünür)
 * ========================================================================== */
function updateNextPeek(next) {
  const bar = $('next-peek');
  if (!bar) return;
  const songOpen = !$('view-song').classList.contains('hidden');
  const stage = document.body.classList.contains('stage');
  if (!nextPeek || !songOpen || stage || !currentSong || !next) {
    bar.classList.add('hidden');
    document.body.classList.remove('has-peek');
    return;
  }
  $('next-peek-name').textContent = next.song || next.title || 'Şarkı';
  const meta = [];
  const k = songKeyStr(next);
  if (k) meta.push('Ton ' + k);
  if (next.bpm) meta.push(next.bpm + ' BPM');
  $('next-peek-meta').textContent = meta.length ? '· ' + meta.join(' · ') : '';
  bar.classList.remove('hidden');
  document.body.classList.add('has-peek');
}
function updatePeekLabel() {
  const b = $('song-peek-toggle');
  if (b) b.textContent = nextPeek ? '👁 Sıradaki şeridi: Açık' : '👁 Sıradaki şeridi: Kapalı';
}
function toggleNextPeek() {
  nextPeek = !nextPeek;
  localStorage.setItem('nextpeek', nextPeek ? '1' : '0');
  updatePeekLabel();
  updateNav();
  toast(nextPeek ? 'Sıradaki şeridi açık' : 'Sıradaki şeridi kapalı');
}

/* ==========================================================================
 * ORTAK SAHNE  — grubun o an çaldığı şarkıyı büyük & otomatik gösteren ekran
 *   (grup kodu açıkken lider hangi şarkıya geçerse bu ekran da geçer)
 * ========================================================================== */
function findSongAnywhere(songId, setlistId) {
  const pref = setlistId && state.setlists.find((x) => x.id === setlistId);
  if (pref) { const s = pref.songs.find((x) => x.id === songId); if (s) return { song: s, sl: pref }; }
  for (const sl of state.setlists) {
    const s = sl.songs.find((x) => x.id === songId);
    if (s) return { song: s, sl };
  }
  return null;
}

function openStageShare() {
  stageShareOn = true;
  shareRev = 0;
  $('modal-stageshare').classList.remove('hidden');
  requestWakeLock();
  $('ss-sync').textContent = sync.connected ? ('grup: ' + sync.room) : 'yerel (grup kapalı)';
  const sl = currentSetlist();
  const first = currentSong || orderedSongs(sl)[0];
  if (first) renderStageShare(first, currentSong ? sl : sl);
  else { $('ss-title').textContent = 'Şarkı seçilmedi'; $('ss-body').textContent = ''; $('ss-next').textContent = ''; }
  sharePoll();
  startSharePoll();
}
function closeStageShare() {
  stageShareOn = false;
  stopSharePoll();
  $('modal-stageshare').classList.add('hidden');
}
function startSharePoll() { stopSharePoll(); sharePollTimer = setInterval(sharePoll, 2000); }
function stopSharePoll() { if (sharePollTimer) clearInterval(sharePollTimer); sharePollTimer = null; }

async function sharePoll() {
  if (!stageShareOn || !sync.connected || !sync.room) return;
  try {
    const r = await fetch('/api/live/' + encodeURIComponent(sync.room));
    const d = await r.json();
    if (!d || typeof d.rev !== 'number' || d.rev <= shareRev || !d.songId) return;
    shareRev = d.rev;
    const f = findSongAnywhere(d.songId, d.setlistId);
    if (f) renderStageShare(f.song, f.sl);
  } catch (_) { /* ag hatasi -> sonraki yoklamada */ }
}

async function renderStageShare(song, sl) {
  if (!song) return;
  $('ss-title').textContent = song.song || song.title || 'Şarkı';
  $('ss-artist').textContent = song.artist || '';
  const k = songKeyStr(song);
  $('ss-key').textContent = k ? ('Ton ' + k) : '';
  $('ss-bpm').textContent = song.bpm ? (song.bpm + ' BPM') : '';
  const list = orderedSongs(sl);
  const i = list.findIndex((x) => x.id === song.id);
  const next = (i >= 0 && i < list.length - 1) ? list[i + 1] : null;
  $('ss-next').textContent = next ? ('Sıradaki › ' + (next.song || next.title || 'Şarkı')) : '— Set sonu —';
  // Gövde tembel yükleme
  if (!song.body && song.source) {
    $('ss-body').textContent = 'Yükleniyor…';
    try {
      const res = await fetch('/api/song?url=' + encodeURIComponent(song.source));
      const data = await res.json();
      if (res.ok) { song.body = data.body; if (data.key) song.key = data.key; saveState(); }
    } catch (_) {}
  }
  const semi = song.transpose || 0;
  $('ss-body').innerHTML = renderBody(song.body || '', semi, /b/.test(song.key || ''), viewMode);
  $('ss-body-wrap').scrollTop = 0;
}

let viewMode = localStorage.getItem('sahne_viewmode') || 'both';
if (viewMode === 'chords') viewMode = 'both';   // Akor modu üst çubuktan kaldırıldı
let chorusOnly = false;   // "Sadece nakaratlar": şarkı ekranında yalnız koro
// Şarkının nakaratı: önce ELLE seçilen (song.chorusText), yoksa otomatik tahmin
function chorusOf(song) {
  if (song && song.chorusText && song.chorusText.trim()) return song.chorusText;
  return extractChorus((song && song.body) || '');
}
function paintSong() {
  if (!currentSong) return;
  const semi = currentSong.transpose || 0;
  const preferFlat = /b/.test(currentSong.key || '');
  let body = currentSong.body || '';
  if (chorusOnly) {
    const ch = chorusOf(currentSong);
    if (ch) body = ch;   // bulunamazsa tüm gövde gösterilir
  }
  $('song-body').innerHTML = renderBody(body, semi, preferFlat, viewMode);
  $('tr-value').textContent = semi;
  const cc = $('chorus-chip'); if (cc) cc.classList.toggle('active', chorusOnly);
}
function toggleChorus() {
  chorusOnly = !chorusOnly;
  if (chorusOnly && currentSong && !chorusOf(currentSong)) {
    toast('Nakarat seçili değil — ✂️ ile seç (⋯ menü). Şimdilik tüm söz.');
  }
  paintSong();
  fitToWidth();
  updateCrawlChip();
}

/* ---------- Otomatik yavaş kaydırma (nakarat modu + potpuri) ----------
 * Sabit hızlı, elleri boşta okuma için. Altyapıya bağlı DEĞİL. */
const CRAWL_SPEEDS = [0.6, 1, 1.5, 2.3];      // px / ~33ms
const CRAWL_LABELS = ['½×', '1×', '1½×', '2×'];
let crawlSpeedIdx = parseInt(localStorage.getItem('crawlSpeedIdx') || '1', 10);
if (!(crawlSpeedIdx >= 0 && crawlSpeedIdx < CRAWL_SPEEDS.length)) crawlSpeedIdx = 1;
let crawlTimer = null;
let crawlEl = null;
let crawlAcc = 0;
function isCrawling() { return !!crawlTimer; }
function startCrawl(el) {
  stopCrawl();
  if (!el) return;
  crawlEl = el;
  crawlAcc = 0;
  crawlTimer = setInterval(() => {
    if (!crawlEl) { stopCrawl(); return; }
    const max = crawlEl.scrollHeight - crawlEl.clientHeight;
    if (max <= 0) return;
    crawlAcc += CRAWL_SPEEDS[crawlSpeedIdx];
    if (crawlAcc >= 1) {
      const step = Math.floor(crawlAcc);
      crawlAcc -= step;
      crawlEl.scrollTop = Math.min(max, crawlEl.scrollTop + step);
      if (crawlEl.scrollTop >= max) { stopCrawl(); updateCrawlBtns(); }
    }
  }, 33);
  updateCrawlBtns();
}
function stopCrawl() { if (crawlTimer) clearInterval(crawlTimer); crawlTimer = null; crawlEl = null; }
function updateCrawlBtns() {
  const on = isCrawling();
  const a = $('crawl-toggle'); if (a) { a.textContent = on ? '⏸ Dur' : '▶ Kaydır'; a.classList.toggle('active', on); }
  const b = $('potpuri-crawl'); if (b) { b.textContent = on ? '⏸' : '▶'; b.classList.toggle('active', on); }
}
function updateCrawlLabels() {
  const l = CRAWL_LABELS[crawlSpeedIdx];
  const a = $('crawl-speed'); if (a) a.textContent = l;
  const b = $('potpuri-speed'); if (b) b.textContent = l;
}
function cycleCrawlSpeed() {
  crawlSpeedIdx = (crawlSpeedIdx + 1) % CRAWL_SPEEDS.length;
  localStorage.setItem('crawlSpeedIdx', String(crawlSpeedIdx));
  updateCrawlLabels();
}
// Nakarat modunda kaydırma grubunu göster/gizle
function updateCrawlChip() {
  const g = $('crawl-group');
  if (g) g.classList.toggle('hidden', !chorusOnly);
  if (!chorusOnly) { stopCrawl(); updateCrawlBtns(); }
}
function toggleSongCrawl() {
  if (isCrawling()) { stopCrawl(); updateCrawlBtns(); }
  else startCrawl($('view-song'));
}
function togglePotpuriCrawl() {
  if (isCrawling()) { stopCrawl(); updateCrawlBtns(); }
  else startCrawl($('potpuri-body'));
}

/* ---------- Sesle komut (deneysel) ----------
 * Şarkı söylerken YANLIŞ tetiklenmesin diye sözde asla geçmeyecek NADİR
 * komut cümleleri kullanır: "sahne ileri" → sonraki, "sahne geri" → önceki.
 * Ayrıca 2.5 sn bekleme (tek cümle iki kez tetiklemesin) + her komuttan sonra
 * dinlemeyi sıfırlama var. webkitSpeechRecognition iPhone Safari'de çoğu
 * sürümde YOK; yoksa kullanıcıyı uyarır. */
let voiceRec = null;
let voiceOn = false;
let voiceCooldown = 0;
function voiceSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
function setVoiceCaption(t) { const el = $('voice-caption'); if (el) el.textContent = t || ''; }
function updateVoiceBtn() {
  const b = $('voice-btn');
  if (b) { b.classList.toggle('active', voiceOn); b.textContent = voiceOn ? '🎙️ Dinliyor…' : '🎙️ Sesle komut'; }
}
function toggleVoice() {
  if (!voiceSupported()) {
    toast('Bu cihaz sesle komutu desteklemiyor (iPhone Safari genelde desteklemez).');
    return;
  }
  if (voiceOn) stopVoice(); else startVoice();
}
function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  try { voiceRec = new SR(); }
  catch (e) { toast('Sesle komut başlatılamadı: ' + e.message); return; }
  voiceRec.lang = 'tr-TR';
  voiceRec.continuous = true;
  voiceRec.interimResults = true;
  voiceRec.onresult = onVoiceResult;
  voiceRec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('Mikrofon izni gerekli — izin verip tekrar dene.');
      stopVoice();
    } else if (e.error === 'no-speech' || e.error === 'aborted') {
      // sessizlik/kesinti: onend zaten yeniden başlatır
    }
  };
  voiceRec.onend = () => { if (voiceOn) { try { voiceRec.start(); } catch (_) {} } };
  try { voiceRec.start(); } catch (_) {}
  voiceOn = true;
  updateVoiceBtn();
  setVoiceCaption('dinleniyor…');
}
function stopVoice() {
  voiceOn = false;
  if (voiceRec) { voiceRec.onend = null; try { voiceRec.stop(); } catch (_) {} voiceRec = null; }
  updateVoiceBtn();
  setVoiceCaption('');
}
function onVoiceResult(ev) {
  let txt = '';
  for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript + ' ';
  const norm = trSimplify(txt).toLowerCase();
  setVoiceCaption('“' + norm.trim().slice(-32) + '”');
  const now = Date.now();
  if (now < voiceCooldown) return;
  let fired = '';
  if (/sahne\s*ileri/.test(norm) || /sonraki\s*sarki/.test(norm)) { gotoRelative(1); fired = '▶ sonraki'; }
  else if (/sahne\s*geri/.test(norm) || /onceki\s*sarki/.test(norm)) { gotoRelative(-1); fired = '◀ önceki'; }
  if (fired) {
    voiceCooldown = now + 2500;
    setVoiceCaption(fired);
    // tamponu temizle ki aynı cümle tekrar tetiklemesin
    if (voiceRec) { try { voiceRec.stop(); } catch (_) {} }
  }
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
  let keyStr;
  if (orig) {
    const preferFlat = /b/.test(orig);
    keyStr = transposeToken(orig, semi, preferFlat);
    el.classList.add('is-key');
    $('key-label').textContent = 'orijinal: ' + orig + (semi ? ' (' + (semi > 0 ? '+' : '') + semi + ')' : '');
  } else {
    keyStr = (semi > 0 ? '+' : '') + semi;
    el.classList.remove('is-key');
    $('key-label').textContent = semi ? 'ton bilinmiyor' : '';
  }
  el.textContent = keyStr;
  $('stage-key').textContent = keyStr;
  updateVocalHint();
}

// Herhangi bir şarkının ekranda görünecek tonu (transpoze dahil)
function songKeyStr(s) {
  const orig = (s.key || '').trim();
  const semi = s.transpose || 0;
  if (!orig) return semi ? ((semi > 0 ? '+' : '') + semi) : '';
  return transposeToken(orig, semi, /b/.test(orig));
}

/* ==========================================================================
 * ENERJİ / TEMPO EĞRİSİ  — setin akışını (yavaş↔hızlı) görselleştirir.
 *  Enerji: BPM varsa ondan, yoksa türden (renk). 1 (çok yavaş) – 5 (çok hızlı).
 * ========================================================================== */
function songEnergy(song) {
  const b = song.bpm || 0;
  if (b) {
    if (b <= 72) return 1;
    if (b <= 92) return 2;
    if (b <= 112) return 3;
    if (b <= 138) return 4;
    return 5;
  }
  const g = { blue: 1, purple: 2, orange: 2, green: 3, red: 4, gray: 5 };
  return g[song.color] || 3;
}
let energyOn = localStorage.getItem('energyOn') === '1';
function updateEnergyBtn() {
  const b = $('btn-energy');
  if (b) b.classList.toggle('active', energyOn);
}
function toggleEnergy() {
  energyOn = !energyOn;
  localStorage.setItem('energyOn', energyOn ? '1' : '0');
  updateEnergyBtn();
  renderEnergyStrip();
}
function renderEnergyStrip() {
  const strip = $('energy-strip');
  if (!strip) return;
  const sl = currentSetlist();
  const songs = orderedSongs(sl);
  if (!energyOn || songs.length < 2) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }
  strip.classList.remove('hidden');
  strip.innerHTML = '';
  const bars = document.createElement('div');
  bars.className = 'es-bars';
  let prevLow = false, warns = 0;
  songs.forEach((song, i) => {
    const e = songEnergy(song);
    const bar = document.createElement('button');
    bar.className = 'es-bar';
    const low = e <= 1;
    if (low && prevLow) { bar.classList.add('warn'); warns++; }
    prevLow = low;
    const col = document.createElement('span');
    col.className = 'es-col';
    col.style.height = (e * 15 + 8) + 'px';
    col.style.background = song.color ? colorCss(song.color) : 'var(--accent)';
    const num = document.createElement('span');
    num.className = 'es-n';
    num.textContent = (i + 1);
    bar.appendChild(col);
    bar.appendChild(num);
    bar.title = (i + 1) + '. ' + (song.song || song.title || 'Şarkı') +
      ' · enerji ' + e + (song.bpm ? (' · ' + song.bpm + ' BPM') : '');
    bar.addEventListener('click', () => openSong(song.id));
    bars.appendChild(bar);
  });
  strip.appendChild(bars);
  const info = document.createElement('div');
  info.className = 'es-info' + (warns ? ' warn' : '');
  info.textContent = warns
    ? ('⚠ ' + warns + ' yerde arka arkaya yavaş şarkı var — pist düşebilir')
    : '👍 Akış dengeli';
  strip.appendChild(info);
}

/* ==========================================================================
 * VOKAL / RAHAT TON  — "range" bilmeye gerek yok: rahat bulunan tonu kilitle,
 *  uygulama onaylı şarkılardan grubun ortalama transpoze KAYMASINI öğrenir ve
 *  yeni şarkıya başlangıç tonu önerir.
 * ========================================================================== */
function vocalProfile() {
  const offs = [];
  const keys = {};
  state.setlists.forEach((sl) => sl.songs.forEach((s) => {
    if (s.vocalOk && s.key) {
      offs.push(s.transpose || 0);
      const pk = songKeyStr(s);
      if (pk) keys[pk] = (keys[pk] || 0) + 1;
    }
  }));
  if (!offs.length) return null;
  const mean = offs.reduce((a, b) => a + b, 0) / offs.length;
  const sd = Math.sqrt(offs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / offs.length);
  const topKeys = Object.keys(keys).sort((a, b) => keys[b] - keys[a]).slice(0, 4);
  return { n: offs.length, avg: Math.round(mean), sd, topKeys };
}
function toggleVocalOk() {
  if (!currentSong) return;
  currentSong.vocalOk = !currentSong.vocalOk;
  saveState();
  closeSongSheet();
  updateKeyDisplay();
  renderList();
  toast(currentSong.vocalOk
    ? ('🎤 Rahat ton kilitlendi: ' + (songKeyStr(currentSong) || '—'))
    : 'Rahat ton işareti kaldırıldı');
}
function updateVocalSheetBtn() {
  const b = $('song-vocal');
  if (b && currentSong) b.textContent = currentSong.vocalOk
    ? '🎤 Rahat ton kilidini kaldır' : '🎤 Bu ton rahat (kilitle)';
}
function updateVocalHint() {
  const el = $('vocal-hint');
  if (!el) return;
  if (!currentSong) { el.classList.add('hidden'); return; }
  if (currentSong.vocalOk) {
    el.className = 'vocal-hint ok';
    el.innerHTML = '🎤 Rahat ton: <b>' + escapeHtml(songKeyStr(currentSong) || '—') + '</b> · kilitli';
    return;
  }
  const p = vocalProfile();
  if (!p || p.n < 3 || !currentSong.key) { el.classList.add('hidden'); return; }
  const suggest = p.avg;
  const cur = currentSong.transpose || 0;
  const sugKey = transposeToken(currentSong.key, suggest, /b/.test(currentSong.key));
  const varnote = p.sd >= 2.5 ? ' · tonların değişken, sadece başlangıç' : '';
  el.className = 'vocal-hint';
  el.innerHTML =
    '🎤 Öneri: <b>' + (suggest > 0 ? '+' : '') + suggest + ' ton → ' + escapeHtml(sugKey) + '</b> ' +
    (cur === suggest ? '<span class="vh-note">(şu an bu tonda)</span>'
      : '<button id="vocal-apply" class="vh-apply">uygula</button>') +
    '<span class="vh-note"> · ' + p.n + ' onaylı şarkıdan' + varnote + '</span>';
  const ap = $('vocal-apply');
  if (ap) ap.addEventListener('click', () => { setTranspose(suggest - (currentSong.transpose || 0)); });
}

let fontSize = parseInt(localStorage.getItem('sahne_font') || '18', 10);
// Punto kilidi: kullanıcı puntoyu elle ayarlayınca sabitlenir; şarkı değişince
// otomatik sığdırma (fitToWidth) artık puntoyu bozmaz. Böylece gitardan el çekip
// her şarkıda yeniden ayarlamak gerekmez.
let fontLocked = localStorage.getItem('sahne_font_lock') === '1';
function applyFont() {
  $('song-body').style.fontSize = fontSize + 'px';
}
function changeFont(delta) {
  fontSize = Math.max(9, Math.min(44, fontSize + delta));
  fontLocked = true;
  localStorage.setItem('sahne_font', String(fontSize));
  localStorage.setItem('sahne_font_lock', '1');
  updateFontAutoBtn();
  applyFont();
}
// Otomatik sığdırmaya geri dön (kilidi kaldır, ekrana göre yeniden ayarla)
function fontAuto() {
  fontLocked = false;
  localStorage.setItem('sahne_font_lock', '0');
  updateFontAutoBtn();
  fitToWidth();
}
function updateFontAutoBtn() {
  const b = $('font-auto');
  if (b) b.classList.toggle('active', !fontLocked);
}

// En geniş satırı ekrana sığdıracak puntoyu GERÇEK ÖLÇÜMLE seçer (proportional
// fontta karakter sayısı yeterli değil). Okunabilir alt sınır 13px; daha da
// gerekiyorsa 13'te kalır ve uzun satır yatay kaydırılır.
const MIN_FIT_FONT = 13;
const MAX_FIT_FONT = 26;
function fitToWidth() {
  if (!currentSong || !currentSong.body) return;
  // Punto kilitliyse kullanıcının seçtiği puntoyu koru; uzun satırlar yatay kayar.
  if (fontLocked) { applyFont(); return; }
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

/* ---------- Otomatik kaydirma (üst çubuktan kaldırıldı; kod güvenli tutuldu) ---------- */
function startScroll() { /* devre dışı */ }
function stopScroll() {
  scrolling = false;
  if (scrollRAF) cancelAnimationFrame(scrollRAF);
  scrollRAF = null;
}
function toggleScroll() { /* devre dışı */ }

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
function closeSearch() { $('modal-search').classList.add('hidden'); pendingImportId = null; }

/* ==========================================================================
 * BOOKMARKLET İLE İÇE AKTARMA
 *  - buildBookmarklet: telefon tarayıcısında akorlar.com gibi sayfada çalışıp
 *    akoru grup koduna gönderen "yer imi" kodunu üretir.
 *  - checkInbox/renderImportBanner: gelen içe aktarmaları gösterir.
 * ========================================================================== */
// Yer imine yapıştırılacak fonksiyon (kaynak olduğu gibi bookmarklet'e gömülür)
function _bkmFn() {
  var R = '__ROOM__', API = '__API__';
  function ic(x) { return /^[A-G](#|b)?(m|maj|min|dim|aug|sus|add)*[0-9]*(sus[0-9]+)?(add[0-9]+)?(\/[A-G](#|b)?)?$/.test(x); }
  function cl(t) { var L = (t || '').split('\n'), c = 0; for (var i = 0; i < L.length; i++) { var k = L[i].trim().split(/\s+/).filter(Boolean); if (k.length && k.every(ic)) c++; } return c; }
  var els = [].slice.call(document.querySelectorAll('pre'));
  var mx = 0; els.forEach(function (e) { mx = Math.max(mx, cl(e.innerText)); });
  if (mx < 2) { els = [].slice.call(document.querySelectorAll('div,section,article,td')); els.forEach(function (e) { mx = Math.max(mx, cl(e.innerText)); }); }
  if (mx < 2) { alert('Bu sayfada akor bulunamadi. Akorlarin oldugu sarki sayfasinda dene.'); return; }
  var best = null, bl = 1e9;
  els.forEach(function (e) { var c = cl(e.innerText), t = e.innerText || ''; if (c >= Math.max(2, mx * 0.6) && t.length < bl) { bl = t.length; best = e; } });
  if (!best) { alert('Akor blogu secilemedi.'); return; }
  var body = (best.innerText || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  var title = (((document.querySelector('h1') || {}).innerText) || document.title || '').trim();
  fetch(API + '/api/inbox/' + R, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title, body: body, source: location.href }) })
    .then(function (r) { return r.json(); })
    .then(function (d) { alert(d && d.ok ? 'Gonderildi! Sahne Setlist uygulamasini ac, ustteki ice aktarma bildirimine dokun.' : ('Hata: ' + ((d && d.error) || '?'))); })
    .catch(function (e) { alert('Gonderilemedi: ' + e); });
}
function buildBookmarklet(room) {
  var src = _bkmFn.toString().replace('__ROOM__', room).replace('__API__', location.origin);
  return 'javascript:(' + src + ')()';
}
function renderBookmarklet() {
  const box = $('bkm-box');
  if (!box) return;
  if (!sync.room) {
    box.innerHTML = '<p class="hint muted">Önce yukarıdan bir <b>grup kodu</b> ile bağlan, sonra yer imi kodu burada çıkar.</p>';
    return;
  }
  const code = buildBookmarklet(sync.room);
  box.innerHTML =
    '<textarea id="bkm-code" class="bkm-code" readonly rows="3"></textarea>' +
    '<button id="bkm-copy" class="chip">📋 Yer imi kodunu kopyala</button>' +
    '<ol class="bkm-steps">' +
    '<li>Yukarıdaki kodu <b>kopyala</b>.</li>' +
    '<li>Tarayıcında bir sayfayı <b>yer imlerine ekle</b> (paylaş → yer imi ekle).</li>' +
    '<li>O yer imini <b>düzenle</b>: adını “Sahne’ye Ekle” yap, <b>adres/URL</b> kısmına kopyaladığın kodu <b>yapıştır</b>, kaydet.</li>' +
    '<li>akorlar.com’da bir şarkı sayfasındayken bu yer imine <b>dokun</b> → akor buraya gelir, aşağıda bildirim çıkar.</li>' +
    '</ol>';
  $('bkm-code').value = code;
  $('bkm-copy').addEventListener('click', () => {
    const ta = $('bkm-code'); ta.focus(); ta.select();
    try { navigator.clipboard.writeText(code); } catch (_) { try { document.execCommand('copy'); } catch (__) {} }
    toast('Yer imi kodu kopyalandı');
  });
}

function parseTitleClient(t) {
  const parts = String(t || '').split(/\s*[-–|·]\s*/).map((x) => x.trim())
    .filter(Boolean).filter((p) => !/^akor/i.test(p) && !/^tab$/i.test(p));
  if (parts.length >= 2) return { artist: parts[0], song: parts[1] };
  return { artist: '', song: parts[0] || String(t || '') };
}
async function checkInbox() {
  if (!sync.room) { pendingImports = []; renderImportBanner(); return; }
  try {
    const r = await fetch('/api/inbox/' + encodeURIComponent(sync.room));
    const d = await r.json();
    pendingImports = (d && d.items) || [];
  } catch (_) { return; }
  renderImportBanner();
}
function renderImportBanner() {
  const b = $('import-banner');
  if (!b) return;
  if (!pendingImports.length) { b.classList.add('hidden'); return; }
  b.textContent = '📥 Tarayıcıdan ' + pendingImports.length + ' şarkı geldi — eklemek için dokun';
  b.classList.remove('hidden');
}
function openNextImport() {
  if (!pendingImports.length) { renderImportBanner(); return; }
  const item = pendingImports[0];
  let a = item.artist, s = item.song;
  if (!s) { const p = parseTitleClient(item.title); a = a || p.artist; s = p.song; }
  $('modal-search').classList.remove('hidden');
  switchTab('manual');
  $('manual-artist').value = a || '';
  $('manual-song').value = s || item.title || '';
  $('manual-key').value = item.key || '';
  $('manual-body').value = item.body || '';
  $('import-url').value = item.source || '';
  let host = '';
  try { host = item.source ? new URL(item.source).hostname.replace(/^www\./, '') : ''; } catch (_) {}
  const st = $('import-url-status');
  st.className = 'import-status ok';
  st.textContent = '🔖 Tarayıcıdan geldi' + (host ? ' (' + host + ')' : '') + '. Kontrol edip “Setliste Ekle”ye bas.';
  pendingImportId = item.id;
}

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
      color: guessGenre(s.artist || ''),
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
// Bir akor sitesinin linkinden şarkıyı çekip elle-ekleme alanlarını doldur
async function fetchFromUrl() {
  const url = $('import-url').value.trim();
  const st = $('import-url-status');
  const btn = $('import-url-btn');
  if (!url) { st.className = 'import-status err'; st.textContent = 'Önce bir akor sayfası linki yapıştır.'; return; }
  st.className = 'import-status muted';
  st.innerHTML = '<span class="spinner"></span> Getiriliyor…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/fetch-url?url=' + encodeURIComponent(url));
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Getirilemedi');
    if (d.artist) $('manual-artist').value = d.artist;
    if (d.song) $('manual-song').value = d.song;
    if (d.key) $('manual-key').value = d.key;
    $('manual-body').value = d.body || '';
    st.className = 'import-status ok';
    st.textContent = '✓ Getirildi. Kontrol edip “Setliste Ekle”ye bas.';
  } catch (err) {
    st.className = 'import-status err';
    st.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

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
    color: $('manual-color').value || guessGenre(artist),
    addedAt: Date.now(),
  };
  currentSetlist().songs.push(song);
  saveState();
  renderList();
  $('manual-artist').value = '';
  $('manual-song').value = '';
  $('manual-key').value = '';
  $('manual-color').value = '';
  $('manual-body').value = '';
  $('import-url').value = '';
  $('import-url-status').textContent = '';
  // Bookmarklet içe aktarmasıysa kutudan sil ve bildirimi güncelle
  if (pendingImportId && sync.room) {
    const pid = pendingImportId;
    fetch('/api/inbox/' + encodeURIComponent(sync.room) + '/' + pid, { method: 'DELETE' }).catch(() => {});
    pendingImports = pendingImports.filter((x) => x.id !== pid);
    renderImportBanner();
  }
  closeSearch();
  toast('“' + songName + '” eklendi');
}

function addSearchSection(box, label) {
  const h = document.createElement('div');
  h.className = 'result-section';
  h.textContent = label;
  box.appendChild(h);
  return h;
}
function makeRepItem(r) {
  const item = document.createElement('div');
  item.className = 'result-item';
  item.innerHTML =
    `<div class="info">
       <div class="t">${escapeHtml(r.song || r.title)}</div>
       <div class="a">${escapeHtml(r.artist || '')} <span class="src src-${r.source}">${escapeHtml(r.source || '')}</span></div>
     </div>
     <div class="add">＋</div>`;
  item.addEventListener('click', () => addSongFromUrl(r, item));
  return item;
}
// "Şu sitede ara" satırı: tıklayınca kullanıcının tarayıcısında (Türkiye'de,
// engelsiz) o siteyi "şarkı adı akor" ile açar. Sunucu tarafı arama Render'ın
// veri-merkezi IP'sinden engellendiği için en güvenilir yol budur.
function webSearchSites(q) {
  const eq = encodeURIComponent(q + ' akor');
  const raw = encodeURIComponent(q);
  return [
    { name: 'Google', desc: '“' + q + ' akor” — tüm siteler birden', icon: '🔎', url: 'https://www.google.com/search?q=' + eq },
    { name: 'akorlar.com', desc: 'Türkçe akor arşivi', icon: '🎸', url: 'https://www.akorlar.com/ara/' + raw },
    { name: 'akorculuk.com', desc: 'Akor + ritim + nota', icon: '🎵', url: 'https://www.google.com/search?q=' + encodeURIComponent('site:akorculuk.com ' + q) },
    { name: 'Ultimate Guitar', desc: 'Yabancı şarkılar için', icon: '🎼', url: 'https://www.ultimate-guitar.com/search.php?search_type=title&value=' + raw },
  ];
}
function makeSearchLinkItem(site) {
  const item = document.createElement('div');
  item.className = 'result-item web';
  item.innerHTML =
    `<div class="info">
       <div class="t">${site.icon} ${escapeHtml(site.name)}’de ara</div>
       <div class="a">${escapeHtml(site.desc)}</div>
     </div>
     <div class="add">↗</div>`;
  item.addEventListener('click', () => window.open(site.url, '_blank', 'noopener'));
  return item;
}

async function doSearch(e) {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (q.length < 2) return;
  const status = $('search-status');
  const box = $('search-results');
  box.innerHTML = '';
  status.innerHTML = '<span class="spinner"></span> Aranıyor…';

  // 1) Repertuarım — hızlı ve güvenilir tek-tık ekleme
  let repCount = 0;
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (res.ok && data.results && data.results.length) {
      repCount = data.results.length;
      addSearchSection(box, '⚡ Hızlı ekle (repertuarim)');
      data.results.forEach((r) => box.appendChild(makeRepItem(r)));
    }
  } catch (_) { /* alttaki site aramalarına devam */ }

  // 2) Diğer siteler — kullanıcının tarayıcısında ara, linki Link/Elle'ye yapıştır
  addSearchSection(box, '🌐 Bulamadın mı? Başka sitede ara');
  const info = document.createElement('div');
  info.className = 'muted websearch-info';
  info.textContent = 'Bir siteye dokun → tarayıcıda “' + q + ' akor” araması açılır. Şarkıyı bul, sayfanın linkini kopyala → “🔗 Link/Elle” sekmesine yapıştırıp Getir’e bas. (Okumaya kapalı sitede akor+sözü kopyalayıp yapıştır.)';
  box.appendChild(info);
  webSearchSites(q).forEach((site) => box.appendChild(makeSearchLinkItem(site)));
  status.textContent = repCount ? (repCount + ' hızlı sonuç · aşağıda diğer siteler') : 'Repertuarim’de yok — aşağıdaki sitelerde ara';
}

async function addSongFromUrl(result, itemEl) {
  const add = itemEl.querySelector('.add');
  add.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch('/api/song?url=' + encodeURIComponent(result.url));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Hata');
    const artist = data.artist || result.artist || '';
    const song = {
      id: uid(),
      title: (data.artist ? data.artist + ' - ' : '') + data.song,
      artist,
      song: data.song || result.song || result.title,
      key: data.key || '',
      body: data.body,
      source: data.source || result.url,
      transpose: 0,
      color: guessGenre(artist),
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
  updateOfflineBtn();
  renderBookmarklet();
  $('modal-setlists').classList.remove('hidden');
}
function closeSetlists() { $('modal-setlists').classList.add('hidden'); }

/* ---------- Set öncesi çevrimdışı indirme ---------- */
function updateOfflineBtn() {
  const btn = $('btn-offline');
  if (!btn) return;
  const sl = currentSetlist();
  const need = sl.songs.filter((s) => !s.body && s.source).length;
  btn.disabled = !need;
  btn.textContent = need ? `📥 Bu seti indir (${need} şarkı)` : '✓ Tümü çevrimdışı hazır';
}
async function downloadSetOffline() {
  const sl = currentSetlist();
  const todo = sl.songs.filter((s) => !s.body && s.source);
  const btn = $('btn-offline');
  if (!todo.length) { toast('Bu setin tüm şarkıları zaten hazır ✓'); return; }
  if (btn) btn.disabled = true;
  let ok = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    if (btn) btn.textContent = `İndiriliyor ${i + 1}/${todo.length}…`;
    try {
      const res = await fetch('/api/song?url=' + encodeURIComponent(s.source));
      const data = await res.json();
      if (res.ok && data.body) { s.body = data.body; if (data.key && !s.key) s.key = data.key; ok++; }
      else fail++;
    } catch (_) { fail++; }
  }
  saveState();
  updateOfflineBtn();
  toast(`Çevrimdışı hazır: ${ok} indirildi` + (fail ? `, ${fail} başarısız (internet?)` : ' ✓'));
}

function renderSetlists() {
  const box = $('setlist-items');
  box.innerHTML = '';
  state.setlists.forEach((sl) => {
    const row = document.createElement('div');
    row.className = 'setlist-item' + (sl.id === state.currentId ? ' active' : '');
    row.innerHTML =
      `<span class="name">${escapeHtml(sl.name)}</span>
       <span class="cnt">${sl.songs.length}</span>
       ${sl.isPool ? '' : '<button class="mini rename" title="Yeniden adlandır">✎</button><button class="mini danger del" title="Sil">🗑</button>'}`;
    row.querySelector('.name').addEventListener('click', () => {
      state.currentId = sl.id;
      saveState();
      renderList();
      closeSetlists();
    });
    if (sl.isPool) { box.appendChild(row); return; }
    row.querySelector('.rename').addEventListener('click', (e) => {
      e.stopPropagation();
      const name = prompt('Setlist adı:', sl.name);
      if (name && name.trim()) { sl.name = name.trim(); saveState(); renderSetlists(); renderList(); }
    });
    row.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.setlists.filter((x) => !x.isPool).length === 1) { toast('Son setlist silinemez'); return; }
      if (!confirm('“' + sl.name + '” silinsin mi?')) return;
      state.setlists = state.setlists.filter((x) => x.id !== sl.id);
      if (state.currentId === sl.id) state.currentId = (state.setlists.find((x) => !x.isPool) || state.setlists[0]).id;
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
  updatePracticeSheetBtn();
  updateVocalSheetBtn();
  $('sheet-song').classList.remove('hidden');
}
function closeSongSheet() { $('sheet-song').classList.add('hidden'); }

/* ---------- Nakaratı elle seç (potpuri için) ---------- */
let chorusPickLines = [];
let chorusPickSel = new Set();
function openChorusPick() {
  if (!currentSong) return;
  closeSongSheet();
  chorusPickLines = (currentSong.body || '').replace(/\r/g, '').split('\n');
  chorusPickSel = new Set();
  if (currentSong.chorusText) {
    const want = new Set(currentSong.chorusText.split('\n').map((l) => l.trim()).filter(Boolean));
    chorusPickLines.forEach((l, i) => { if (l.trim() && want.has(l.trim())) chorusPickSel.add(i); });
  }
  renderChorusPick();
  $('modal-chorus').classList.remove('hidden');
}
function closeChorusPick() { $('modal-chorus').classList.add('hidden'); }
function renderChorusPick() {
  const box = $('chorus-lines');
  box.innerHTML = '';
  chorusPickLines.forEach((l, i) => {
    const empty = l.trim() === '';
    const row = document.createElement('div');
    row.className = 'chorus-line' + (chorusPickSel.has(i) ? ' sel' : '') +
      (empty ? ' empty' : '') + (isChordLine(l) ? ' chord' : '');
    row.textContent = empty ? '·' : l;
    if (!empty) row.addEventListener('click', () => {
      if (chorusPickSel.has(i)) chorusPickSel.delete(i); else chorusPickSel.add(i);
      renderChorusPick();
    });
    box.appendChild(row);
  });
}
function chorusAutoPick() {
  const ch = extractChorus((currentSong && currentSong.body) || '');
  chorusPickSel = new Set();
  if (ch) {
    const want = new Set(ch.split('\n').map((l) => l.trim()).filter(Boolean));
    chorusPickLines.forEach((l, i) => { if (l.trim() && want.has(l.trim())) chorusPickSel.add(i); });
  }
  if (!chorusPickSel.size) toast('Otomatik bulunamadı — satırlara dokunup elle seç');
  renderChorusPick();
}
function saveChorusPick() {
  if (!currentSong) return;
  const idx = [...chorusPickSel].sort((a, b) => a - b);
  const text = idx.map((i) => chorusPickLines[i]).join('\n').trim();
  currentSong.chorusText = text;
  saveState();
  closeChorusPick();
  if (chorusOnly) { paintSong(); fitToWidth(); }
  toast(text ? 'Nakarat kaydedildi ✓' : 'Nakarat temizlendi');
}

/* ---------- Prova listesi ---------- */
function togglePractice() {
  if (!currentSong) return;
  currentSong.practice = !currentSong.practice;
  saveState();
  closeSongSheet();
  renderList();
  toast(currentSong.practice ? '🎯 Prova listesine eklendi' : 'Prova listesinden çıkarıldı');
}
function updatePracticeSheetBtn() {
  const b = $('song-practice');
  if (b && currentSong) b.textContent = currentSong.practice
    ? '🎯 Prova listesinden çıkar' : '🎯 Prova listesine ekle';
}

/* ---------- Sözde ara (tüm repertuar) ---------- */
function openLyricSearch() {
  $('lyric-input').value = '';
  $('lyric-results').innerHTML = '<div class="hint muted">Söz parçası yaz ve “Ara”ya bas.</div>';
  $('modal-lyricsearch').classList.remove('hidden');
  setTimeout(() => $('lyric-input').focus(), 60);
}
function closeLyricSearch() { $('modal-lyricsearch').classList.add('hidden'); }
// trSimplify 1:1 uzunluk korur (her TR harfi tek ASCII'ye) -> indeks orijinalle örtüşür
function makeSnippet(body, pos, len) {
  const start = Math.max(0, pos - 30);
  const end = Math.min(body.length, pos + len + 30);
  const nl = (s) => s.replace(/\s*\n\s*/g, ' / ');
  const pre = escapeHtml(nl(body.slice(start, pos)));
  const mid = escapeHtml(body.slice(pos, pos + len));
  const post = escapeHtml(nl(body.slice(pos + len, end)));
  return (start > 0 ? '…' : '') + pre + '<mark>' + mid + '</mark>' + post + (end < body.length ? '…' : '');
}
function doLyricSearch(e) {
  if (e) e.preventDefault();
  const q = trSimplify($('lyric-input').value).toLowerCase().trim();
  const box = $('lyric-results');
  box.innerHTML = '';
  if (q.length < 2) { box.innerHTML = '<div class="hint muted">En az 2 harf yaz.</div>'; return; }
  const res = [];
  state.setlists.forEach((sl) => {
    sl.songs.forEach((song) => {
      const body = song.body || '';
      if (!body) return;
      const pos = trSimplify(body).toLowerCase().indexOf(q);
      if (pos >= 0) res.push({ song, sl, snippet: makeSnippet(body, pos, q.length) });
    });
  });
  if (!res.length) {
    box.innerHTML = '<div class="hint muted">Bulunamadı. (Not: yalnız indirilmiş şarkıların sözünde arar.)</div>';
    return;
  }
  const seenSet = new Set();
  res.slice(0, 60).forEach((r) => {
    const b = document.createElement('button');
    b.className = 'lyric-item';
    b.innerHTML =
      `<div class="li-t">${escapeHtml(r.song.song || r.song.title || 'Şarkı')}` +
      `<span class="li-a">${escapeHtml(r.song.artist || '')}</span></div>` +
      `<div class="li-set">📁 ${escapeHtml(r.sl.name)}</div>` +
      `<div class="li-snip">${r.snippet}</div>`;
    b.addEventListener('click', () => {
      closeLyricSearch();
      if (state.currentId !== r.sl.id) { state.currentId = r.sl.id; saveLocal(); renderList(); }
      openSong(r.song.id);
    });
    box.appendChild(b);
    seenSet.add(r.sl.id);
  });
  if (res.length > 60) {
    const m = document.createElement('div');
    m.className = 'hint muted';
    m.textContent = res.length + ' sonuç bulundu, ilk 60 gösteriliyor.';
    box.appendChild(m);
  }
}

/* ---------- Potpuri: ELLE seçilen şarkıların nakaratları tek akışta ----------
 * Şarkılar sl.potpuriIds (sıralı) içinde tutulur; kullanıcı "🎵 Şarkı seç"
 * panelinden ekler/çıkarır/sıralar. Seçim gruba senkronlanır. */
let potpuriFont = parseInt(localStorage.getItem('potpuriFont') || '22', 10);
let potpuriPicking = false;
function openPotpuri() {
  const sl = currentSetlist();
  if (!Array.isArray(sl.potpuriIds)) sl.potpuriIds = [];
  potpuriPicking = false;
  applyPotpuriFont();
  updateCrawlLabels();
  updateCrawlBtns();
  $('modal-potpuri').classList.remove('hidden');
  // Hiç seçili şarkı yoksa doğrudan seçim ekranını aç
  if (!sl.potpuriIds.length) togglePotpuriPick(true);
  else togglePotpuriPick(false);
}
function closePotpuri() { stopCrawl(); updateCrawlBtns(); $('modal-potpuri').classList.add('hidden'); }

// Oynat/Seç arası geçiş
function togglePotpuriPick(force) {
  potpuriPicking = (typeof force === 'boolean') ? force : !potpuriPicking;
  stopCrawl(); updateCrawlBtns();
  $('potpuri-body').classList.toggle('hidden', potpuriPicking);
  $('potpuri-pick').classList.toggle('hidden', !potpuriPicking);
  $('potpuri-pick-btn').textContent = potpuriPicking ? '▶ Oynat' : '🎵 Şarkı seç';
  if (potpuriPicking) renderPotpuriPick(); else renderPotpuriPlay();
}

// Oynatma görünümü: seçili nakaratları arka arkaya
function renderPotpuriPlay() {
  const sl = currentSetlist();
  const box = $('potpuri-body');
  box.innerHTML = '';
  const byId = {};
  sl.songs.forEach((s) => { byId[s.id] = s; });
  const chosen = (sl.potpuriIds || []).map((id) => byId[id]).filter(Boolean);
  chosen.forEach((song, i) => {
    const sec = document.createElement('div');
    sec.className = 'pp-sec';
    const head = document.createElement('div');
    head.className = 'pp-head';
    head.textContent = (i + 1) + '. ' + (song.song || song.title || 'Şarkı') +
      (song.artist ? ' — ' + song.artist : '');
    head.title = 'Şarkının tamamını aç';
    head.addEventListener('click', () => { closePotpuri(); openSong(song.id); });
    sec.appendChild(head);
    const pre = document.createElement('pre');
    const ch = chorusOf(song);
    if (ch) {
      pre.className = 'song-body pp-text';
      pre.innerHTML = renderBody(ch, song.transpose || 0, /b/.test(song.key || ''), 'both');
    } else {
      pre.className = 'song-body pp-text pp-empty';
      pre.textContent = '(nakarat seçilmedi — şarkıyı açıp ⋯ → ✂️ Nakaratı seç)';
    }
    sec.appendChild(pre);
    box.appendChild(sec);
  });
  if (!chosen.length) {
    box.innerHTML = '<div class="pp-none">Henüz şarkı seçilmedi.<br>Üstten “🎵 Şarkı seç” ile potpuriye şarkı ekle.</div>';
  }
}

// Seçim paneli: potpuridekiler (sıralı, ↑↓✕) + eklenebilecekler (➕)
function renderPotpuriPick() {
  const sl = currentSetlist();
  if (!Array.isArray(sl.potpuriIds)) sl.potpuriIds = [];
  const box = $('potpuri-pick');
  box.innerHTML = '';
  const byId = {};
  sl.songs.forEach((s) => { byId[s.id] = s; });

  const mkRow = (song, chosen, i) => {
    const row = document.createElement('div');
    row.className = 'pp-pick-row' + (chosen ? ' chosen' : '');
    const has = !!chorusOf(song);
    const name = document.createElement('span');
    name.className = 'ppk-name';
    name.innerHTML = (chosen ? (i + 1) + '. ' : '') +
      escapeHtml(song.song || song.title || 'Şarkı') +
      (song.artist ? ' <span class="ppk-a">' + escapeHtml(song.artist) + '</span>' : '') +
      (has ? '' : ' <span class="ppk-warn">nakarat yok</span>');
    row.appendChild(name);
    const ctr = document.createElement('span');
    ctr.className = 'ppk-ctrls';
    const mkBtn = (txt, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'ppk-btn' + (cls ? ' ' + cls : '');
      b.textContent = txt;
      b.addEventListener('click', fn);
      return b;
    };
    if (chosen) {
      ctr.appendChild(mkBtn('↑', '', () => potpuriMove(song.id, -1)));
      ctr.appendChild(mkBtn('↓', '', () => potpuriMove(song.id, 1)));
      ctr.appendChild(mkBtn('✕', 'danger', () => potpuriRemove(song.id)));
    } else {
      ctr.appendChild(mkBtn('➕ Ekle', 'add', () => potpuriAdd(song.id)));
    }
    row.appendChild(ctr);
    return row;
  };

  const chosen = sl.potpuriIds.map((id) => byId[id]).filter(Boolean);
  const h1 = document.createElement('div');
  h1.className = 'pp-pick-h';
  h1.textContent = '🎉 Potpuride (' + chosen.length + ')';
  box.appendChild(h1);
  if (!chosen.length) {
    const e = document.createElement('div');
    e.className = 'hint muted';
    e.textContent = 'Aşağıdan “➕ Ekle” ile şarkı ekle.';
    box.appendChild(e);
  }
  chosen.forEach((song, i) => box.appendChild(mkRow(song, true, i)));

  const rest = sl.songs.filter((s) => !sl.potpuriIds.includes(s.id) && !s.isPool);
  const h2 = document.createElement('div');
  h2.className = 'pp-pick-h';
  h2.textContent = 'Bu setteki diğer şarkılar (' + rest.length + ')';
  box.appendChild(h2);
  if (!rest.length) {
    const e = document.createElement('div');
    e.className = 'hint muted';
    e.textContent = 'Başka şarkı yok. Ana listeden bu sete şarkı ekleyebilirsin.';
    box.appendChild(e);
  }
  rest.forEach((song) => box.appendChild(mkRow(song, false)));
}
function potpuriAdd(id) {
  const sl = currentSetlist();
  if (!Array.isArray(sl.potpuriIds)) sl.potpuriIds = [];
  if (!sl.potpuriIds.includes(id)) sl.potpuriIds.push(id);
  saveState();
  renderPotpuriPick();
}
function potpuriRemove(id) {
  const sl = currentSetlist();
  sl.potpuriIds = (sl.potpuriIds || []).filter((x) => x !== id);
  saveState();
  renderPotpuriPick();
}
function potpuriMove(id, dir) {
  const sl = currentSetlist();
  const a = sl.potpuriIds || [];
  const i = a.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  saveState();
  renderPotpuriPick();
}
function applyPotpuriFont() { $('potpuri-body').style.fontSize = potpuriFont + 'px'; }
function potpuriFontDelta(d) {
  potpuriFont = Math.max(14, Math.min(42, potpuriFont + d));
  localStorage.setItem('potpuriFont', String(potpuriFont));
  applyPotpuriFont();
}

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
  clearTimeout(autoPlayTimer);
  stopScroll();
  stopCrawl();
  stopVoice();
  stopSongTimer();
  stopRhythm();
  stopBacking();
  exitStage();
  releaseWakeLock();
  $('view-song').classList.add('hidden');
  $('view-list').classList.remove('hidden');
  updateNextPeek(null);   // şeridi gizle
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
  applyStagePos();
  updateNextPeek(null);   // sahne modunda şerit gizli
  fitToWidth();
}

// Sahne kontrol çubuğunun taşınabilir konumu
function applyStagePos() {
  const el = $('stage-ctrls');
  let p = null;
  try { p = JSON.parse(localStorage.getItem('stage_ctrls_pos') || 'null'); } catch (_) {}
  if (p && typeof p.left === 'number' && typeof p.top === 'number') {
    el.style.left = p.left + 'px';
    el.style.top = p.top + 'px';
    el.style.right = 'auto';
  } else {
    el.style.left = ''; el.style.top = ''; el.style.right = '';
  }
}
function setupStageDrag() {
  const el = $('stage-ctrls');
  const grip = el.querySelector('[data-grip]');
  if (!grip) return;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const onMove = (ev) => {
      let left = ev.clientX - offX;
      let top = ev.clientY - offY;
      const maxL = window.innerWidth - el.offsetWidth - 4;
      const maxT = window.innerHeight - el.offsetHeight - 4;
      left = Math.max(4, Math.min(left, maxL));
      top = Math.max(4, Math.min(top, maxT));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.right = 'auto';
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      const r = el.getBoundingClientRect();
      localStorage.setItem('stage_ctrls_pos', JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
}
function exitStage() {
  const wasStage = document.body.classList.contains('stage');
  document.body.classList.remove('stage');
  $('stage-exit').classList.add('hidden');
  if (wasStage && !$('view-song').classList.contains('hidden')) updateNav();  // şeridi geri getir
  fitToWidth();
}
function toggleStage() {
  document.body.classList.contains('stage') ? exitStage() : enterStage();
}

/* ==========================================================================
 * METRONOM — sesli (kick + snare), BPM slider, düğmede görsel darbe
 * ========================================================================== */
let audioCtx = null;
let noiseBuffer = null;
let crashBuffer = null;
let liveBpm = null;            // geçici tempo (yavaşlatma); null ise song.bpm kullanılır
let rhythmPlaying = false;
let rhythmTimer = null;
let rhythmNextTime = 0;
let rhythmStep = 0;
let activePattern = null;

// O an geçerli tempo (yavaşlatma varsa onu, yoksa şarkının BPM'i)
function effectiveBpm() {
  if (liveBpm != null) return liveBpm;
  return (currentSong && currentSong.bpm) || 100;
}

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return true;
}

// Kick: alçalan sinüs + hızlı sönüm (tok bas vuruş)
function playKick(t) {
  const ctx = audioCtx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(155, t);
  osc.frequency.exponentialRampToValueAtTime(48, t + 0.09);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(1, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(t); osc.stop(t + 0.25);
}

// Snare: beyaz gürültü (highpass) + kısa tonal gövde (trampet çıtırtısı)
function getNoiseBuffer() {
  if (!noiseBuffer) {
    const len = Math.floor(audioCtx.sampleRate * 0.2);
    noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}
function playSnare(t, vol) {
  vol = vol == null ? 1 : vol;
  const ctx = audioCtx;
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 1600;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.42 * vol, t);   // snare kısıldı (kick daha net duyulsun)
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
  noise.connect(hp); hp.connect(ng); ng.connect(ctx.destination);
  noise.start(t); noise.stop(t + 0.2);
  const osc = ctx.createOscillator();
  osc.type = 'triangle'; osc.frequency.value = 190;
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.26 * vol, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  osc.connect(og); og.connect(ctx.destination);
  osc.start(t); osc.stop(t + 0.1);
}
// HiHat: kısa yüksek frekanslı gürültü
function playHat(t) {
  const ctx = audioCtx;
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  noise.connect(hp); hp.connect(g); g.connect(ctx.destination);
  noise.start(t); noise.stop(t + 0.06);
}
// Crash zili: uzun sönümlü parlak gürültü ("tsss")
function getCrashBuffer() {
  if (!crashBuffer) {
    const len = Math.floor(audioCtx.sampleRate * 1.4);
    crashBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = crashBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return crashBuffer;
}
function playCrash(t, vol) {
  vol = vol == null ? 1 : vol;
  const ctx = audioCtx;
  const src = ctx.createBufferSource();
  src.buffer = getCrashBuffer();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 3500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5 * vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.3);   // uzun sönüm
  src.connect(hp); hp.connect(g); g.connect(ctx.destination);
  src.start(t); src.stop(t + 1.4);
}
// Tom: alçalan sinüs (davul geçişi)
function playTom(t, freq, vol) {
  vol = vol == null ? 1 : vol;
  const ctx = audioCtx;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.18);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.8 * vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(t); osc.stop(t + 0.3);
}
function finalStyle() {
  const el = $('final-style');
  return (el && el.value) || localStorage.getItem('final_style') || 'roll';
}
// Bitiş fill'i — seçilen stile göre
function playEndingFill() {
  if (!ensureAudio()) return;
  const bpm = effectiveBpm();
  const eighth = (60 / bpm) / 2;
  const six = (60 / bpm) / 4;
  let t = audioCtx.currentTime + 0.04;
  const style = finalStyle();
  if (style === 'crash') {
    playCrash(t);
  } else if (style === 'badumtss') {
    playKick(t); t += eighth;
    playSnare(t, 0.85); t += eighth;
    playCrash(t);
  } else if (style === 'tomfill') {
    [200, 160, 120, 90].forEach((f) => { playTom(t, f, 0.9); t += six; });
    playKick(t); playCrash(t);
  } else if (style === 'bigcrash') {
    playKick(t); playSnare(t, 0.7); playCrash(t);
  } else { // roll
    for (let i = 0; i < 6; i++) { playSnare(t, 0.35 + i * 0.09); t += six; }
    playKick(t); playCrash(t);
  }
}

// Davul düğmesini vuruşta yak (görsel darbe)
function flashRhythmBtn(t) {
  const delay = Math.max(0, (t - audioCtx.currentTime) * 1000);
  setTimeout(() => {
    if (!rhythmPlaying) return;
    const b = $('play-quick');
    if (!b) return;
    b.classList.add('beat');
    setTimeout(() => b.classList.remove('beat'), 90);
  }, delay);
}

/* ---------- Ritim (davul makinesi) — 16 adım: 'x' vuruş, '.' boş ---------- */
const PRESETS = [
  { id: 'p1', name: 'Metronom', k: 'x...x...x...x...', s: '................', h: '................' },
  { id: 'p2', name: 'Rock', k: 'x.......x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
  { id: 'p3', name: 'Pop', k: 'x.......x...x...', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
  { id: 'p4', name: 'Balad (yavaş)', k: 'x.......x.......', s: '....x.......x...', h: 'x...x...x...x...' },
  { id: 'p5', name: 'Disko', k: 'x...x...x...x...', s: '....x.......x...', h: '..x...x...x...x.' },
  { id: 'p6', name: 'Funk', k: 'x.....x...x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
  { id: 'p7', name: 'Reggae', k: '........x.......', s: '....x.......x...', h: '..x...x...x...x.' },
  { id: 'p8', name: 'Shuffle', k: 'x.......x.......', s: '....x.......x...', h: 'x..x..x..x..x..x' },
  { id: 'p9', name: 'Hızlı (punk)', k: 'x...x...x...x...', s: '..x...x...x...x.', h: 'x.x.x.x.x.x.x.x.' },
  { id: 'p10', name: 'Backbeat (el çırpma)', k: '................', s: '....x.......x...', h: '................' },
  { id: 'p11', name: 'Yürüyüş (marş)', k: 'x...x...x...x...', s: 'x...x...x...x...', h: '................' },
];
let customRhythms = [];
try { customRhythms = JSON.parse(localStorage.getItem('rhythms_custom') || '[]'); } catch (_) { customRhythms = []; }
function saveCustomRhythms() { localStorage.setItem('rhythms_custom', JSON.stringify(customRhythms)); }
function allRhythms() { return PRESETS.concat(customRhythms); }
function getRhythm(id) { return allRhythms().find((r) => r.id === id); }
// Şarkının kayıtlı davulu: önce yerel listede ara; bulunamazsa (ör. karşı
// cihazda yapılmış özel ritim) şarkıya gömülü song.rhythmData'yı kullan.
// Böylece davul cihazlar arası eşitlenir.
function songRhythm(s) {
  if (!s || !s.rhythm) return null;
  return getRhythm(s.rhythm) || (s.rhythmData && s.rhythmData.id === s.rhythm ? s.rhythmData : null);
}
// Karşı cihazda yapılmış özel ritim eşitlenince, yerel ritim listesinde yoksa
// gömülü desenden geri kur (böylece menüde görünür ve tekrar kullanılabilir).
function ensureRhythmAvailable(s) {
  if (!s || !s.rhythm || !s.rhythmData) return;
  if (getRhythm(s.rhythm)) return;
  customRhythms.push({ id: s.rhythmData.id, name: s.rhythmData.name, k: s.rhythmData.k, s: s.rhythmData.s, h: s.rhythmData.h, custom: true });
  saveCustomRhythms();
}

function rhythmScheduler() {
  const bpm = effectiveBpm();
  const p = activePattern;
  if (!bpm || !audioCtx || !p) return;
  const stepDur = (60 / bpm) / 4;   // onaltılık nota (1 ölçü = 4 vuruş = 16 adım)
  while (rhythmNextTime < audioCtx.currentTime + 0.14) {
    const i = rhythmStep;
    const t = rhythmNextTime;
    const hasK = p.k[i] === 'x', hasS = p.s[i] === 'x', hasH = p.h[i] === 'x';
    if (hasK) playKick(t);
    if (hasS) playSnare(t, hasK ? 0.55 : 1);   // kick ile aynı anda ise snare'i daha çok kıs
    if (hasH) playHat(t);
    if (i % 4 === 0) flashRhythmBtn(t);
    rhythmStep = (rhythmStep + 1) % 16;
    rhythmNextTime += stepDur;
  }
}
function playPattern(pat) {
  if (currentSong && !currentSong.bpm) setBpm(effectiveBpm());
  if (!(currentSong && currentSong.bpm)) return false;
  if (!ensureAudio()) { toast('Bu cihaz ses üretimini desteklemiyor'); return false; }
  activePattern = pat;
  rhythmPlaying = true;
  rhythmStep = 0;
  if (rhythmTimer) clearInterval(rhythmTimer);
  rhythmNextTime = audioCtx.currentTime + 0.08;
  rhythmScheduler();
  rhythmTimer = setInterval(rhythmScheduler, 25);
  return true;
}
function playRhythmById(id) {
  const pat = getRhythm(id);
  if (!pat || !playPattern(pat)) return;   // menüde çalmak = önizleme (otomatik kaydetmez)
  updateRhythmBtn();
  updateQuickBtn();
  renderRhythmList();
}
function stopRhythm() {
  rhythmPlaying = false;
  if (rhythmTimer) clearInterval(rhythmTimer);
  rhythmTimer = null;
  activePattern = null;
  stopSlow();
  liveBpm = null;
  updateRhythmBtn();
  updateQuickBtn();
  updateBpmUI();
  if (!$('modal-music').classList.contains('hidden')) renderRhythmList();
}
// Davulu bir bitiş fill'iyle (ba-dum-tsss) sonlandır
function rhythmFinal() {
  if (!ensureAudio()) return;
  if (rhythmTimer) clearInterval(rhythmTimer);
  rhythmTimer = null;
  playEndingFill();                 // fill + crash o anki tempoda
  rhythmPlaying = false;
  activePattern = null;
  stopSlow();
  liveBpm = null;
  updateRhythmBtn();
  updateQuickBtn();
  if (!$('modal-music').classList.contains('hidden')) renderRhythmList();
}

/* ---------- Kademeli yavaşlatma (ritardando) — tek dokunuş aç/kapa ---------- */
let slowTimer = null;
function slowStep() {
  const b = effectiveBpm();
  if (b <= 40) { stopSlow(); return; }
  liveBpm = Math.max(40, b - 2);
  updateBpmUI();
}
function startSlow() {
  stopSlow();
  slowStep();
  slowTimer = setInterval(slowStep, 300);   // ~6-7 BPM/sn yumuşak yavaşlama
  const b = $('bpm-slow'); if (b) b.classList.add('on');
}
function stopSlow() {
  if (slowTimer) clearInterval(slowTimer);
  slowTimer = null;
  const b = $('bpm-slow'); if (b) b.classList.remove('on');
}
function toggleSlow() { slowTimer ? stopSlow() : startSlow(); }

// BPM'i yarıya / iki katına (yarı-çift tempo düzeltmesi)
function halveBpm() { setBpm(Math.round(effectiveBpm() / 2)); }
function doubleBpm() { setBpm(Math.round(effectiveBpm() * 2)); }
function updateRhythmBtn() { updateQuickBtn(); }   // geriye dönük uyum
// Kontrollerdeki ▶ hızlı-çal düğmesi (şarkıya kaydedilmiş altyapı veya davul)
function updateQuickBtn() {
  const b = $('play-quick');
  if (!b) return;
  const backs = songBackings(currentSong);
  const rpat = songRhythm(currentSong);
  if (!backs.length && !rpat) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  if (backs.length) {
    const act = backs.find((x) => x.id === currentSong.activeBacking) || backs[0];
    b.textContent = (backingPlaying ? '⏸ ' : '▶ ') + (act.label || 'Altyapı');
    b.classList.toggle('on', backingPlaying);
  } else {
    const thisPlaying = rhythmPlaying && activePattern && activePattern.id === rpat.id;
    b.textContent = (thisPlaying ? '⏸ ' : '▶ ') + rpat.name;
    b.classList.toggle('on', thisPlaying);
  }
}
// ▶ düğmesi: altyapı öncelikli (aktif olan), yoksa kayıtlı davul
function playSaved() {
  if (songBackings(currentSong).length) {
    if (backingPlaying) stopBacking(); else playBacking();
    return;
  }
  const pat = songRhythm(currentSong);
  if (!pat) return;
  if (rhythmPlaying && activePattern && activePattern.id === pat.id) { stopRhythm(); return; }
  if (playPattern(pat)) updateQuickBtn();
}

/* ==========================================================================
 * ALTYAPI (YouTube linki veya doğrudan ses linki) + 4-3-2-1 sayım
 * ========================================================================== */
let backingPlaying = false;
let backingCurId = null;
let backingObjUrl = null;
let ytPlayer = null;
let ytReady = false;
let scrollSyncTimer = null;

// Eski tekil song.backing'i çoklu song.backings dizisine geçir
function songBackings(s) {
  if (!s) return [];
  if (!s.backings && s.backing) {
    s.backings = [{ id: s.id, label: 'Altyapı', url: s.backing }];
    s.activeBacking = s.id;
    delete s.backing;
    saveState();
  }
  return s.backings || [];
}
function loadYT() {
  if (window.YT && window.YT.Player) { ytReady = true; return; }
  if (document.getElementById('yt-api')) return;
  const s = document.createElement('script');
  s.id = 'yt-api';
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
  window.onYouTubeIframeAPIReady = () => { ytReady = true; };
}
function ytId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function ensureYtPlayer(cb) {
  if (ytPlayer) { cb(); return; }
  if (!ytReady || !window.YT || !window.YT.Player) { setTimeout(() => ensureYtPlayer(cb), 300); return; }
  ytPlayer = new YT.Player('yt-player', {
    height: '200', width: '100%',
    playerVars: { playsinline: 1, controls: 1 },
    events: {
      onReady: () => cb(),
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) { onBackingEnded(); }
        else if (e.data === YT.PlayerState.PAUSED) { backingPlaying = false; stopScrollSync(); updateQuickBtn(); renderBackingListSafe(); }
        else if (e.data === YT.PlayerState.PLAYING) { backingPlaying = true; updateQuickBtn(); }
      },
    },
  });
}
// 4-3-2-1 sayım (kapalıysa hemen döner)
function countInThen(done) {
  const on = $('countin-toggle') ? $('countin-toggle').checked : true;
  if (!on) { done(); return; }
  ensureAudio();
  const beat = 60 / effectiveBpm();
  const el = $('countin'), num = $('countin-num');
  el.classList.remove('hidden');
  let n = 4;
  const step = () => {
    if (n === 0) { el.classList.add('hidden'); done(); return; }
    num.textContent = n;
    if (audioCtx) { const t = audioCtx.currentTime + 0.01; if (n === 1) playKick(t); else playHat(t); }
    n--;
    setTimeout(step, beat * 1000);
  };
  step();
}
// ---- IndexedDB: altyapı ses dosyalarını cihazda sakla ----
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sahne-backing', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const rq = db.transaction('files', 'readonly').objectStore('files').get(key);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((res) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(key);
    tx.oncomplete = () => res();
  });
}
/* --- senkron kaydırma (sözler altyapıya göre) --- */
function startScrollSync(getPos) {
  stopScrollSync();
  const el = $('autoscroll-toggle');
  if (el && !el.checked) return;
  scrollSyncTimer = setInterval(() => {
    const p = getPos();
    if (!p || !p.dur || isNaN(p.dur) || p.dur < 1) return;
    const box = $('view-song');
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) return;
    box.scrollTop = Math.max(0, Math.min(max, (p.t / p.dur) * max));
  }, 500);
}
function stopScrollSync() { if (scrollSyncTimer) clearInterval(scrollSyncTimer); scrollSyncTimer = null; }
function onBackingStarted(kind) {
  updateQuickBtn(); renderBackingListSafe();
  const el = $('autoscroll-toggle');
  if (el && el.checked) {
    if (kind === 'audio') startScrollSync(() => { const a = $('backing-audio'); return { t: a.currentTime, dur: a.duration }; });
    else startScrollSync(() => { try { return { t: ytPlayer.getCurrentTime(), dur: ytPlayer.getDuration() }; } catch (_) { return null; } });
  }
}
function onBackingEnded() {
  backingPlaying = false; stopScrollSync(); updateQuickBtn(); renderBackingListSafe();
  const el = $('autonext-toggle');
  if (el && el.checked) gotoRelative(1);
}

/* --- altyapı ekle / çal / seç / sil --- */
function addBacking(label, url) {
  if (!currentSong) return null;
  songBackings(currentSong);
  currentSong.backings = currentSong.backings || [];
  const b = { id: uid(), label: label || 'Altyapı', url };
  currentSong.backings.push(b);
  currentSong.activeBacking = b.id;
  saveState();
  renderBackingList(); updateQuickBtn();
  return b;
}
function saveBacking(e) {
  e.preventDefault();
  const url = $('backing-url').value.trim();
  if (!url || !currentSong) return;
  addBacking($('backing-label').value.trim(), url);
  $('backing-url').value = ''; $('backing-label').value = '';
  toast('Altyapı eklendi');
}
async function pickBackingFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f || !currentSong) return;
  const b = addBacking($('backing-label').value.trim() || f.name, 'file:' + f.name);
  try { await idbPut(b.id, f); } catch (err) { toast('Dosya kaydedilemedi: ' + err.message); }
  $('backing-label').value = '';
  toast('Altyapı dosyası eklendi');
}
function deleteBacking(id) {
  if (!currentSong || !currentSong.backings) return;
  const b = currentSong.backings.find((x) => x.id === id);
  if (b && b.url.indexOf('file:') === 0) idbDel(id);
  currentSong.backings = currentSong.backings.filter((x) => x.id !== id);
  if (currentSong.activeBacking === id) currentSong.activeBacking = currentSong.backings[0] ? currentSong.backings[0].id : null;
  if (backingCurId === id) stopBacking();
  saveState();
  renderBackingList(); updateQuickBtn();
}
async function playBacking(id) {
  const list = songBackings(currentSong);
  if (!list.length) { toast('Bu şarkıda altyapı yok'); return; }
  id = id || (currentSong && currentSong.activeBacking) || list[0].id;
  const b = list.find((x) => x.id === id) || list[0];
  currentSong.activeBacking = b.id; backingCurId = b.id; saveState();
  stopRhythm();
  const url = b.url;
  if (url.indexOf('file:') === 0) {
    let blob;
    try { blob = await idbGet(b.id); } catch (_) {}
    if (!blob) { toast('Dosya bu cihazda yok — bu cihazda tekrar ekle'); return; }
    countInThen(() => {
      const a = $('backing-audio');
      if (backingObjUrl) URL.revokeObjectURL(backingObjUrl);
      backingObjUrl = URL.createObjectURL(blob);
      a.src = backingObjUrl; a.classList.remove('hidden');
      a.play().then(() => { backingPlaying = true; onBackingStarted('audio'); }).catch((err) => toast('Çalınamadı: ' + err.message));
    });
    return;
  }
  countInThen(() => {
    const vid = ytId(url);
    if (vid) {
      $('backing-audio').classList.add('hidden');
      ensureYtPlayer(() => { ytPlayer.loadVideoById(vid); ytPlayer.playVideo(); backingPlaying = true; onBackingStarted('yt'); });
    } else {
      const a = $('backing-audio');
      a.src = url; a.classList.remove('hidden');
      a.play().then(() => { backingPlaying = true; onBackingStarted('audio'); }).catch((e) => toast('Altyapı çalınamadı: ' + e.message));
    }
  });
}
function stopBacking() {
  backingPlaying = false;
  stopScrollSync();
  try { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch (_) {}
  const a = $('backing-audio'); if (a) a.pause();
  updateQuickBtn(); renderBackingListSafe();
}
function renderBackingListSafe() { if (!$('modal-music').classList.contains('hidden')) renderBackingList(); }
function renderBackingList() {
  const box = $('backing-list');
  if (!box) return;
  const list = songBackings(currentSong);
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="hint muted" style="padding:8px 2px">Bu şarkıda kayıtlı altyapı yok</div>'; return; }
  const activeId = currentSong && currentSong.activeBacking;
  list.forEach((b) => {
    const isFile = b.url.indexOf('file:') === 0;
    const playing = backingPlaying && backingCurId === b.id;
    const sub = isFile ? '📁 ' + b.url.slice(5) : b.url;
    const row = document.createElement('div');
    row.className = 'rhythm-row' + (b.id === activeId ? ' playing' : '');
    row.innerHTML =
      `<span class="rhythm-play">${playing ? '⏸' : '▶'}</span>
       <span class="rhythm-name">${escapeHtml(b.label || 'Altyapı')}${b.id === activeId ? ' ⭐' : ''}<span class="backing-sub">${escapeHtml(sub)}</span></span>
       <button class="rhythm-del" data-del title="Sil">🗑</button>`;
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) { deleteBacking(b.id); return; }
      if (playing) stopBacking(); else playBacking(b.id);
    });
    box.appendChild(row);
  });
}
function saveRhythmToSong() {
  if (!currentSong) return;
  if (!(rhythmPlaying && activePattern)) { toast('Önce menüden bir ritim çal, sonra kaydet'); return; }
  currentSong.rhythm = activePattern.id;
  // Deseni de göm ki diğer cihazlarda (özel ritim olsa bile) çalışsın/senkronlansın
  currentSong.rhythmData = { id: activePattern.id, name: activePattern.name, k: activePattern.k, s: activePattern.s, h: activePattern.h };
  saveState();
  updateQuickBtn();
  renderRhythmList();
  toast('Bu şarkıya kaydedildi: ' + activePattern.name);
}

/* ---------- Müzik menüsü (Davul + Altyapı) ---------- */
function openMusic(tab) {
  updateBpmUI();
  renderRhythmList();
  renderBackingList();
  switchMusicTab(tab || 'drum');
  $('modal-music').classList.remove('hidden');
}
function closeMusic() { $('modal-music').classList.add('hidden'); }
function switchMusicTab(which) {
  $('mtab-drum').classList.toggle('active', which === 'drum');
  $('mtab-backing').classList.toggle('active', which === 'backing');
  $('mpane-drum').classList.toggle('hidden', which !== 'drum');
  $('mpane-backing').classList.toggle('hidden', which !== 'backing');
  if (which === 'backing') loadYT();
}
function renderRhythmList() {
  const box = $('rhythm-list');
  if (!box) return;
  box.innerHTML = '';
  const curId = (rhythmPlaying && activePattern) ? activePattern.id : null;
  const savedId = currentSong && currentSong.rhythm;
  allRhythms().forEach((r) => {
    const row = document.createElement('div');
    row.className = 'rhythm-row' + (r.id === curId ? ' playing' : '');
    const star = r.id === savedId ? ' <span class="rhythm-star" title="Bu şarkının kayıtlı davulu">⭐</span>' : '';
    row.innerHTML =
      `<span class="rhythm-play">${r.id === curId ? '⏸' : '▶'}</span>
       <span class="rhythm-name">${escapeHtml(r.name)}${star}</span>
       ${r.custom ? '<button class="rhythm-del" data-del title="Sil">🗑</button>' : ''}`;
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) { deleteCustomRhythm(r.id); return; }
      if (r.id === curId) stopRhythm(); else playRhythmById(r.id);
    });
    box.appendChild(row);
  });
}
function deleteCustomRhythm(id) {
  if (!confirm('Bu ritim silinsin mi?')) return;
  customRhythms = customRhythms.filter((r) => r.id !== id);
  saveCustomRhythms();
  if (activePattern && activePattern.id === id) stopRhythm();
  renderRhythmList();
}

/* ---------- Ritim editörü (16 adım × Kick/Snare/HiHat) ---------- */
let editRows = { k: [], s: [], h: [] };
function openRhythmEditor() {
  editRows = { k: Array(16).fill(false), s: Array(16).fill(false), h: Array(16).fill(false) };
  $('rhythm-name').value = '';
  renderStepGrid();
  $('sheet-rhythm-edit').classList.remove('hidden');
}
function closeRhythmEditor() { $('sheet-rhythm-edit').classList.add('hidden'); stopRhythm(); }
function renderStepGrid() {
  const grid = $('step-grid');
  grid.innerHTML = '';
  [['k', 'Kick', '#4c8dff'], ['s', 'Snare', '#ff9f43'], ['h', 'HiHat', '#35d07f']].forEach((row) => {
    const key = row[0], label = row[1], col = row[2];
    const wrap = document.createElement('div');
    wrap.className = 'step-row';
    wrap.innerHTML = `<span class="step-label">${label}</span>`;
    const cells = document.createElement('div');
    cells.className = 'step-cells';
    for (let i = 0; i < 16; i++) {
      const cell = document.createElement('button');
      cell.className = 'step-cell' + (i % 4 === 0 ? ' beat0' : '') + (editRows[key][i] ? ' on' : '');
      if (editRows[key][i]) cell.style.background = col;
      cell.addEventListener('click', () => { editRows[key][i] = !editRows[key][i]; renderStepGrid(); });
      cells.appendChild(cell);
    }
    wrap.appendChild(cells);
    grid.appendChild(wrap);
  });
}
function editRowsToPattern(id, name) {
  const str = (arr) => arr.map((b) => (b ? 'x' : '.')).join('');
  return { id, name, k: str(editRows.k), s: str(editRows.s), h: str(editRows.h), custom: true };
}
function previewRhythmEdit() { playPattern(editRowsToPattern('preview', 'Önizleme')); updateRhythmBtn(); }
function saveRhythmEdit() {
  const name = $('rhythm-name').value.trim();
  if (!name) { toast('Ritme bir ad ver'); return; }
  if (!['k', 's', 'h'].some((key) => editRows[key].some(Boolean))) { toast('En az bir vuruş ekle'); return; }
  customRhythms.push(editRowsToPattern(uid(), name));
  saveCustomRhythms();
  stopRhythm();
  closeRhythmEditor();
  renderRhythmList();
  toast('“' + name + '” kaydedildi');
}

/* ---------- BPM: −/+ düğmeleri + tap ---------- */
function updateBpmUI() { $('bpm-val').textContent = effectiveBpm(); }
function setBpm(v) {
  v = Math.max(40, Math.min(240, parseInt(v, 10) || 100));
  liveBpm = null;                     // düğme/tap = kalıcı tempo, yavaşlatmayı sıfırla
  if (currentSong) { currentSong.bpm = v; saveState(); }
  $('bpm-val').textContent = v;
}
function changeBpm(d) { setBpm(effectiveBpm() + d); }

// Tempoya vur (tap tempo)
let tapTimes = [];
function tapTempoTo(setter) {
  const now = Date.now();
  tapTimes = tapTimes.filter((t) => now - t < 3000);
  tapTimes.push(now);
  if (tapTimes.length >= 2) {
    let sum = 0;
    for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i - 1];
    const bpm = Math.round(60000 / (sum / (tapTimes.length - 1)));
    if (bpm >= 40 && bpm <= 240) setter(bpm);
  }
}
function tapTempo() { tapTempoTo((bpm) => { $('edit-bpm').value = bpm; }); } // düzenleme formu
function bpmTap() { tapTempoTo((bpm) => setBpm(bpm)); }                       // şarkı içi

// İnternetten otomatik BPM bul (songbpm.com)
async function findBpmForSong() {
  if (!currentSong) return;
  const song = currentSong.song || currentSong.title || '';
  if (!song) { toast('Şarkı adı yok'); return; }
  const btn = $('bpm-find');
  const old = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const url = '/api/bpm?artist=' + encodeURIComponent(currentSong.artist || '') +
      '&song=' + encodeURIComponent(song);
    const res = await fetch(url);
    const d = await res.json();
    if (d.bpm) { setBpm(d.bpm); toast('BPM bulundu: ' + d.bpm + ' (yanlışsa slider ya da TAP ile ayarla)'); }
    else { toast('BPM bulunamadı — TAP ile ölçebilirsin'); }
  } catch (err) {
    toast('BPM alınamadı: ' + err.message);
  }
  btn.textContent = old;
  btn.disabled = false;
}

/* ==========================================================================
 * KLAVYE / PEDAL İLE GEZİNME
 * ========================================================================== */
// Klavye/BT pedal: ← / → sonraki-önceki şarkı, boşluk = kaydırmayı aç/kapat
document.addEventListener('keydown', (e) => {
  if ($('view-song').classList.contains('hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); gotoRelative(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); gotoRelative(-1); }
  else if (e.key === ' ') { e.preventDefault(); toggleScroll(); }
});

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
    startLivePoll();
    checkInbox();
    toast('Eşitleme açık: ' + room);
  } catch (e) { syncStatus('Bağlanamadı: ' + e.message); }
}

function syncDisconnect() {
  sync.connected = false;
  stopPoll();
  stopLivePoll();
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

// İçerik zaman damgasına göre hangi taraf daha güncel? Sunucudaki rev sayacı
// (Render uykuya dalıp dosyayı silince) sıfırlanabildiği için, karar rev'e
// DEĞİL data.updatedAt'e dayanır. Böylece eski veriye sahip bir cihaz, yüksek
// yerel rev'i yüzünden yeni veriyi ezemez. Zaman damgası yoksa (eski veri)
// eski davranışa (rev karşılaştırması) düşeriz.
function pickNewer(serverData, serverRev) {
  const sTs = (serverData && serverData.updatedAt) || 0;
  const lTs = (state && state.updatedAt) || 0;
  if (sTs !== lTs) return sTs > lTs ? 'server' : 'local';
  if (serverRev > sync.rev) return 'server';
  if (serverRev < sync.rev) return 'local';
  return 'equal';
}

// Sunucudan gelen daha yeni durumu bu cihaza uygula (açık şarkıyı koruyarak)
function applyRemoteState(d) {
  const openId = currentSong && currentSong.id;
  sync.applyingRemote = true;
  state = d.data; sync.rev = d.rev; saveLocal();
  localStorage.setItem('sync_rev', String(sync.rev));
  sync.applyingRemote = false;
  if (!$('view-song').classList.contains('hidden')) {
    const sl = currentSetlist();
    const s = sl && sl.songs.find((x) => x.id === openId);
    if (s) {
      currentSong = s; ensureRhythmAvailable(s); updateNav(); updateQuickBtn();
      if (!$('modal-music').classList.contains('hidden')) { renderRhythmList(); renderBackingList(); }
    } else showList();
  } else {
    renderList();
  }
  syncStatus('Güncellendi ✓ — grup: ' + sync.room);
}

let inboxTick = 0;
async function syncPoll() {
  if (!sync.connected || sync.applyingRemote) return;
  if ((inboxTick = (inboxTick + 1) % 3) === 0) checkInbox(); // ~12sn'de bir içe aktarma kutusu
  if (sync.pushTimer) return; // gonderilecek yerel degisiklik var -> once o gitsin
  try {
    const r = await fetch('/api/sync/' + encodeURIComponent(sync.room) + '?revOnly=1');
    const { rev } = await r.json();
    if (rev === sync.rev) return;                 // sunucuda değişiklik yok
    const r2 = await fetch('/api/sync/' + encodeURIComponent(sync.room));
    const d = await r2.json();
    const who = pickNewer(d.data, d.rev || 0);
    if (who === 'server' && d.data && Array.isArray(d.data.setlists)) {
      applyRemoteState(d);
    } else {
      // Sunucu farklı ama bizimki daha yeni/eşit -> rev'i eşitle; bizimki daha
      // yeniyse (ör. sunucu uykudan yeni kalkmış) yerel durumu geri gönder.
      sync.rev = d.rev || 0;
      localStorage.setItem('sync_rev', String(sync.rev));
      if (who === 'local') syncPushNow();
    }
  } catch (_) { /* ag hatasi -> sonraki yoklamada */ }
}

/* ==========================================================================
 * CANLI TAKIP / OTO-GECIS  (arkadasin girdigi sarkiya otomatik gecme)
 *  - broadcastLive(): ben bir sarki acinca "su an bu sarkidayiz" bilgisini
 *    gruba bildir.
 *  - livePoll(): "Takip" acikken grubun son konumunu izle, degisince o
 *    sarkiya otomatik gec.
 * ========================================================================== */
async function broadcastLive() {
  if (!sync.connected || !sync.room || applyingLive || !currentSong) return;
  try {
    const res = await fetch('/api/live/' + encodeURIComponent(sync.room), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: currentSong.id, setlistId: state.currentId }),
    });
    const d = await res.json();
    if (res.ok && typeof d.rev === 'number') liveRev = d.rev;
  } catch (_) { /* ag hatasi -> onemsiz */ }
}

function startLivePoll() { stopLivePoll(); livePollTimer = setInterval(livePoll, 2000); }
function stopLivePoll() { if (livePollTimer) clearInterval(livePollTimer); livePollTimer = null; }

async function livePoll() {
  if (!follow || !sync.connected || !sync.room) return;
  try {
    const r = await fetch('/api/live/' + encodeURIComponent(sync.room));
    const d = await r.json();
    if (!d || typeof d.rev !== 'number' || d.rev <= liveRev || !d.songId) return;
    liveRev = d.rev;
    // Gerekirse once dogru setliste gec
    if (d.setlistId && state.currentId !== d.setlistId &&
        state.setlists.some((sl) => sl.id === d.setlistId)) {
      state.currentId = d.setlistId; saveLocal();
    }
    const sl = currentSetlist();
    const s = sl && sl.songs.find((x) => x.id === d.songId);
    if (s && (!currentSong || currentSong.id !== d.songId)) {
      applyingLive = true;
      await openSong(d.songId);
      setTimeout(() => { applyingLive = false; }, 80);
    }
  } catch (_) { /* ag hatasi -> sonraki yoklamada */ }
}

function updateFollowBtn() {
  const b = $('follow-btn');
  if (!b) return;
  b.classList.toggle('on', follow);
  b.textContent = follow ? '🔗 Takip açık' : '🔗 Takip';
}

function toggleFollow() {
  follow = !follow;
  localStorage.setItem('follow', follow ? '1' : '0');
  updateFollowBtn();
  if (follow) {
    if (!sync.connected) { toast('Önce grup kodu ile bağlan (⚙ menü)'); }
    else { toast('Takip açık — arkadaşının açtığı şarkıya otomatik geçilecek'); livePoll(); }
  } else {
    toast('Takip kapalı');
  }
}

// Sayfa acilisinda kayitli gruba yeniden baglan
async function syncResume() {
  if (!sync.room) { updateSyncUI(); return; }
  sync.connected = true;
  updateSyncUI();
  startPoll();
  startLivePoll();
  checkInbox();
  try {
    const r = await fetch('/api/sync/' + encodeURIComponent(sync.room));
    const d = await r.json();
    const who = pickNewer(d.data, d.rev || 0);
    if (who === 'server' && d.data && Array.isArray(d.data.setlists)) {
      sync.applyingRemote = true;
      state = d.data; sync.rev = d.rev; saveLocal();
      localStorage.setItem('sync_rev', String(sync.rev));
      sync.applyingRemote = false;
      renderList();
    } else if (who === 'local') {
      // Yereldeki (çevrimdışı yapılan) değişiklikler daha yeni -> gönder.
      // Sunucu uykudan yeni kalkıp veriyi kaybetmiş olsa bile bu geri yükler.
      sync.rev = d.rev || 0;
      syncPushNow();
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
$('import-url-btn').addEventListener('click', fetchFromUrl);
$('repertoire-form').addEventListener('submit', fetchRepertoire);
$('repertoire-import').addEventListener('click', importRepertoire);

$('btn-pool').addEventListener('click', togglePool);
$('follow-btn').addEventListener('click', toggleFollow);
$('import-banner').addEventListener('click', openNextImport);
// Uygulamaya geri dönünce (bookmarklet'ten sonra) gelen içe aktarmaları kontrol et
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkInbox(); });
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
$('next-peek').addEventListener('click', () => gotoRelative(1));
$('song-stageshare').addEventListener('click', () => { closeSongSheet(); openStageShare(); });
$('song-peek-toggle').addEventListener('click', () => { closeSongSheet(); toggleNextPeek(); });
$('ss-open-btn').addEventListener('click', () => { closeSetlists(); openStageShare(); });
$('btn-offline').addEventListener('click', downloadSetOffline);
$('ss-exit').addEventListener('click', closeStageShare);
$('nav-prev').addEventListener('click', () => gotoRelative(-1));
$('nav-next').addEventListener('click', () => gotoRelative(1));
$('stage-prev').addEventListener('click', () => gotoRelative(-1));
$('stage-next').addEventListener('click', () => gotoRelative(1));

$('tr-up').addEventListener('click', () => setTranspose(1));
$('tr-down').addEventListener('click', () => setTranspose(-1));
$('font-up').addEventListener('click', () => changeFont(2));
$('font-down').addEventListener('click', () => changeFont(-2));
$('font-auto').addEventListener('click', fontAuto);
updateFontAutoBtn();
$('voice-btn').addEventListener('click', toggleVoice);

// Sıralama çipleri
document.querySelectorAll('.sortchip').forEach((chip) => {
  chip.addEventListener('click', () => setSortMode(chip.dataset.sort));
});

// Ekran döndürünce şarkı açıksa yeniden sığdır
window.addEventListener('resize', () => {
  if (!$('view-song').classList.contains('hidden')) fitToWidth();
});

$('song-move-up').addEventListener('click', () => { moveSong(-1); closeSongSheet(); });
$('song-move-down').addEventListener('click', () => { moveSong(1); closeSongSheet(); });
$('song-refresh').addEventListener('click', refreshCurrentSong);
$('song-edit').addEventListener('click', openEdit);
$('song-chorus-pick').addEventListener('click', openChorusPick);
$('song-vocal').addEventListener('click', toggleVocalOk);
$('song-practice').addEventListener('click', togglePractice);
$('btn-energy').addEventListener('click', toggleEnergy);
$('song-copy').addEventListener('click', openCopy);
$('song-delete').addEventListener('click', deleteCurrentSong);
$('song-cancel').addEventListener('click', closeSongSheet);
$('edit-close').addEventListener('click', closeEdit);
$('edit-form').addEventListener('submit', saveEdit);
$('copy-cancel').addEventListener('click', closeCopy);

// Nakarat seçici
$('chorus-close').addEventListener('click', closeChorusPick);
$('chorus-auto').addEventListener('click', chorusAutoPick);
$('chorus-clear').addEventListener('click', () => { chorusPickSel = new Set(); renderChorusPick(); });
$('chorus-save').addEventListener('click', saveChorusPick);

// Sözde ara
$('btn-lyric-search').addEventListener('click', openLyricSearch);
$('lyric-close').addEventListener('click', closeLyricSearch);
$('lyric-form').addEventListener('submit', doLyricSearch);

// Potpuri
$('potpuri-exit').addEventListener('click', closePotpuri);
$('potpuri-pick-btn').addEventListener('click', () => togglePotpuriPick());
$('potpuri-font-down').addEventListener('click', () => potpuriFontDelta(-2));
$('potpuri-font-up').addEventListener('click', () => potpuriFontDelta(2));
$('potpuri-crawl').addEventListener('click', togglePotpuriCrawl);
$('potpuri-speed').addEventListener('click', cycleCrawlSpeed);

// Nakarat modu otomatik kaydırma
$('crawl-toggle').addEventListener('click', toggleSongCrawl);
$('crawl-speed').addEventListener('click', cycleCrawlSpeed);

// Görünüm modu çipleri + süre sayacı
document.querySelectorAll('.viewchip').forEach((chip) => {
  chip.addEventListener('click', () => { if (chip.dataset.view) setViewMode(chip.dataset.view); });
});
$('chorus-chip').addEventListener('click', toggleChorus);
$('timer-pill').addEventListener('click', startSongTimer); // dokun -> sıfırdan başlat

// Sahne modu / metronom / kulaklık / tap tempo
$('stage-mode').addEventListener('click', toggleStage);
$('stage-exit').addEventListener('click', exitStage);
$('stage-font-down').addEventListener('click', () => changeFont(-2));
$('stage-font-up').addEventListener('click', () => changeFont(2));
$('stage-tr-down').addEventListener('click', () => setTranspose(-1));
$('stage-tr-up').addEventListener('click', () => setTranspose(1));
// Müzik menüsü
$('music-btn').addEventListener('click', () => openMusic('drum'));
$('music-close').addEventListener('click', closeMusic);
$('mtab-drum').addEventListener('click', () => switchMusicTab('drum'));
$('mtab-backing').addEventListener('click', () => switchMusicTab('backing'));
$('play-quick').addEventListener('click', playSaved);
$('bpm-down5').addEventListener('click', () => changeBpm(-5));
$('bpm-down1').addEventListener('click', () => changeBpm(-1));
$('bpm-up1').addEventListener('click', () => changeBpm(1));
$('bpm-up5').addEventListener('click', () => changeBpm(5));
$('bpm-tap').addEventListener('click', bpmTap);
// Final sesi seçimi (hatırlanır) + önizleme
(() => {
  const sel = $('final-style');
  sel.value = localStorage.getItem('final_style') || 'roll';
  sel.addEventListener('change', () => localStorage.setItem('final_style', sel.value));
  $('final-preview').addEventListener('click', () => { ensureAudio(); playEndingFill(); });
})();
$('bpm-find').addEventListener('click', findBpmForSong);
$('edit-tap').addEventListener('click', tapTempo);
$('rhythm-stop').addEventListener('click', stopRhythm);
$('rhythm-save-song').addEventListener('click', saveRhythmToSong);
$('rhythm-final').addEventListener('click', rhythmFinal);
$('rhythm-final-2').addEventListener('click', rhythmFinal);
$('bpm-slow').addEventListener('click', toggleSlow);   // tek dokunuş aç/kapa
$('bpm-half').addEventListener('click', halveBpm);
$('bpm-double').addEventListener('click', doubleBpm);
$('rhythm-new').addEventListener('click', openRhythmEditor);
$('rhythm-preview').addEventListener('click', previewRhythmEdit);
$('rhythm-save').addEventListener('click', saveRhythmEdit);
$('rhythm-edit-cancel').addEventListener('click', closeRhythmEditor);

// Altyapı
$('backing-form').addEventListener('submit', saveBacking);
$('backing-stop').addEventListener('click', stopBacking);
$('backing-file-btn').addEventListener('click', () => $('backing-file').click());
$('backing-file').addEventListener('change', pickBackingFile);
$('backing-audio').addEventListener('ended', onBackingEnded);
(function () {
  const bind = (id, key, def) => {
    const el = $(id);
    const v = localStorage.getItem(key);
    el.checked = v === null ? def : v !== '0';
    el.addEventListener('change', () => localStorage.setItem(key, el.checked ? '1' : '0'));
  };
  bind('countin-toggle', 'countin', true);
  bind('autoscroll-toggle', 'autoscroll', true);
  bind('autonext-toggle', 'autonext', false);
})();

// Etiket menüsü
$('label-segue').addEventListener('click', toggleSegue);
$('label-hide').addEventListener('click', toggleHide);
$('label-cancel').addEventListener('click', closeLabel);
$('genre-order-close').addEventListener('click', closeGenreOrder);

// Sette hızlı arama
$('song-filter').addEventListener('input', (e) => { filterText = e.target.value; renderList(); });

// Modal arkaplanina tiklayinca kapat
[['modal-search', closeSearch], ['modal-setlists', closeSetlists], ['sheet-song', closeSongSheet],
 ['modal-edit', closeEdit], ['sheet-copy', closeCopy], ['sheet-label', closeLabel], ['sheet-genre', closeGenreOrder],
 ['modal-music', closeMusic], ['sheet-rhythm-edit', closeRhythmEditor],
 ['modal-chorus', closeChorusPick], ['modal-lyricsearch', closeLyricSearch]]
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
ensureRequestPool();
setupStageDrag();
updateEnergyBtn();
renderList();
updateFollowBtn();
updatePeekLabel();
syncResume();
