/*
 * Sahne Setlist - sunucu
 * ----------------------
 * - Statik on yuzu (public/) servis eder
 * - /api/search : iki kaynakta arama yapar
 *     1) repertuarim.com  -> kendi yerel aramasi (/ara/<slug>/) [birincil, guvenilir]
 *     2) akorculuk.com    -> DuckDuckGo site-ici arama [ikincil, best-effort]
 * - /api/song   : secilen sarki sayfasini ceker, akor+soz metnini ayiklar
 *                 (her iki site de akorlari <pre data-key="..."> icinde tutar)
 *
 * Node 18+ gereklidir (global fetch). Tek bagimlilik: express.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
// Bazı sunucularda (Render vb.) IPv6 yolu takılabiliyor -> IPv4'ü tercih et.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));

/* ==========================================================================
 * Cihazlar arasi esitleme (grup kodu ile ortak depolama)
 * ---------------------------------------------------------------------------
 * Basit "son yazan kazanir" (last-write-wins) model + revizyon sayaci.
 * Her grup kodu (room) icin { rev, data } tutulur, dosyaya yazilir.
 * ========================================================================== */
const SYNC_FILE = process.env.SYNC_FILE || path.join(__dirname, 'data', 'sync.json');
let syncStore = {};
try { syncStore = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')); } catch (_) { syncStore = {}; }

let writeTimer = null;
function persistSync() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(SYNC_FILE), { recursive: true });
      fs.writeFileSync(SYNC_FILE, JSON.stringify(syncStore));
    } catch (e) { console.error('persistSync:', e.message); }
  }, 300);
}
function validRoom(r) { return /^[A-Za-z0-9_-]{3,40}$/.test(r); }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ==========================================================================
 * Yardimcilar
 * ========================================================================== */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', ccedil: 'ç', Ccedil: 'Ç',
  auml: 'ä', Auml: 'Ä', szlig: 'ß', eacute: 'é', Eacute: 'É',
  iexcl: '¡', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', deg: '°', middot: '·', bull: '•',
};

function decodeEntities(str) {
  if (!str) return '';
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const num =
        code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      if (!Number.isNaN(num)) {
        try { return String.fromCodePoint(num); } catch { return m; }
      }
      return m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, code)
      ? NAMED_ENTITIES[code]
      : m;
  });
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
}

// Turkce karakterleri sadelestirir.
function trSimplify(s) {
  return String(s || '')
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/ş/g, 's').replace(/Ş/g, 's')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .replace(/ç/g, 'c').replace(/Ç/g, 'c')
    .replace(/ö/g, 'o').replace(/Ö/g, 'o')
    .replace(/ü/g, 'u').replace(/Ü/g, 'u');
}

// "Sezen Aksu" -> "sezen-aksu"  (repertuarim slug bicimi)
function trSlug(s) {
  return trSimplify(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...extraHeaders,
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// "Artist - Song - Akor (...)" -> {artist, song}
function splitTitle(text) {
  let t = String(text || '').trim();
  // sondaki "Akor", "Akorları", "- Akor (...)" gibi ekleri at
  const parts = t.split(/\s+[-–|·]\s+/).map((p) => p.trim()).filter(Boolean);
  const cleaned = parts.filter(
    (p) => !/^akor(lar|ları|leri)?\b/i.test(p) && !/^tab\b/i.test(p)
  );
  let artist = '';
  let song = '';
  if (cleaned.length >= 2) { artist = cleaned[0]; song = cleaned[1]; }
  else if (cleaned.length === 1) { song = cleaned[0]; }
  return { artist, song };
}

/* ==========================================================================
 * KAYNAK: repertuarim.com
 * ---------------------------------------------------------------------------
 * Not: akorculuk / akorlar / akordefteri gibi diger siteler sunucu tarafi
 * (Node) isteklerini WAF/CDN ile engelliyor (UND_ERR_CONNECT_TIMEOUT / 403),
 * bu yuzden otomatik aramada yalnizca repertuarim guvenilir sekilde kazinabiliyor.
 * Diger siteler icin uygulamada "Elle Ekle" (yapistir) yolu var.
 *
 * repertuarim iki farkli listeleme sunuyor:
 *   - /ara/<slug>/       : SARKI ADINA gore arama ( or. "gulumse")
 *   - /akor-tab/<slug>/  : SANATCI sayfasi ( or. "duman", "tarkan")
 * Ikisini de cekip, sorgu kelimelerine gore puanlayip alakasizlari eliyoruz.
 * ========================================================================== */

// Bir sayfadaki tum sarki linki + basligini cikarir.
// (arama/sanatci/repertuar sayfalari; <li> ozellikli de olsa calisir,
//  baslik once <div class="title">, yoksa <a title="..."> ozelliginden alinir)
function extractSongLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<li[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const hrefM = attrs.match(/href="([^"]*\/akor\/[a-z0-9\-]+-akor-\d+\.html)"/i);
    if (!hrefM) continue;
    const link = hrefM[1];
    if (seen.has(link)) continue;
    seen.add(link);

    let rawTitle = '';
    const titleDiv = inner.match(/class="title"[^>]*>([\s\S]*?)<\/div>/i);
    if (titleDiv) rawTitle = stripTags(titleDiv[1]);
    if (!rawTitle) {
      const titleAttr = attrs.match(/title="([^"]*)"/i);
      if (titleAttr) rawTitle = decodeEntities(titleAttr[1]).replace(/\s+akor\w*\s*$/i, '').trim();
    }
    if (!rawTitle) rawTitle = stripTags(inner);
    if (!rawTitle) continue;

    const { artist, song } = splitTitle(rawTitle);
    out.push({ source: 'repertuarim', url: link, artist, song: song || rawTitle, title: rawTitle });
  }
  return out;
}

// Repertuar (calma listesi) sayfasi -> {title, songs[]}
function parseRepertoire(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let title = h1 ? stripTags(h1[1]) : '';
  title = title.replace(/\s*repertuar[iı]?\s*$/i, '').trim() || 'Repertuar';

  // Yalnizca sarki listesi konteynerleri (kenar cubugu haric)
  let scope = '';
  const uls = html.matchAll(/<ul[^>]*class="[^"]*r-content-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi);
  for (const u of uls) scope += u[1];
  const songs = extractSongLinks(scope || html);
  return { title, songs };
}

async function searchRepertuarim(query) {
  const slug = trSlug(query);
  if (!slug) return [];
  const base = 'https://www.repertuarim.com';
  const [songSearch, artistPage] = await Promise.allSettled([
    fetchText(`${base}/ara/${encodeURIComponent(slug)}/`),
    fetchText(`${base}/akor-tab/${encodeURIComponent(slug)}/`),
  ]);

  const all = [];
  const seenUrl = new Set();
  // Sanatci sayfasi sonuclari once (sanatci sorgularinda en alakalilar)
  for (const p of [artistPage, songSearch]) {
    if (p.status !== 'fulfilled') continue;
    for (const r of extractSongLinks(p.value)) {
      if (seenUrl.has(r.url)) continue;
      seenUrl.add(r.url);
      all.push(r);
    }
  }

  // Alaka puani: baslikte gecen sorgu kelimesi sayisi
  const tokens = trSimplify(query).toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return all.slice(0, 30);

  const scored = all.map((r) => {
    const norm = trSimplify(r.title).toLowerCase();
    const artistNorm = trSimplify(r.artist).toLowerCase();
    let score = 0;
    let artistHit = false;
    for (const t of tokens) {
      if (norm.includes(t)) score += 1;
      if (artistNorm.includes(t)) artistHit = true;
    }
    return { r, score, artistHit };
  }).filter((x) => x.score > 0);

  // Once cok eslesen, sonra sanatci eslesmesi olan
  scored.sort((a, b) => (b.score - a.score) || (b.artistHit - a.artistHit));
  return scored.slice(0, 30).map((x) => x.r);
}

async function searchSongs(query) {
  return searchRepertuarim(query);
}

/* ==========================================================================
 * Sarki sayfasi -> akor + soz  (her iki site icin)
 * ========================================================================== */
function parseSongPage(html, sourceUrl) {
  // --- baslik / sanatci ---
  let titleText = '';
  const h1 = html.match(/<h1([^>]*)>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const attr = h1[1].match(/title="([^"]*)"/i);
    if (attr && attr[1].includes(' - ')) titleText = attr[1];
    else titleText = stripTags(h1[2]);
  }
  if (!titleText || titleText.split('-').length < 2) {
    const tt = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tt) titleText = stripTags(tt[1]);
  }
  const { artist, song } = splitTitle(titleText);

  // --- orijinal ton ---
  let key = '';
  const dk = html.match(/<pre[^>]*data-key="([^"]*)"/i);
  if (dk) key = dk[1].trim();

  // --- akor + soz blogu (<pre ...>) ---
  const pre =
    html.match(/<pre[^>]*class="[^"]*chords[^"]*"[^>]*>([\s\S]*?)<\/pre>/i) ||
    html.match(/<pre[^>]*data-key="[^"]*"[^>]*>([\s\S]*?)<\/pre>/i) ||
    html.match(/<pre[^>]*id="key"[^>]*>([\s\S]*?)<\/pre>/i) ||
    html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);

  let body = '';
  if (pre) {
    body = pre[1]
      .replace(/\r/g, '')
      .replace(/<br\s*\/?>\n/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[^>]+>/g, '');
    body = decodeEntities(body)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return { artist, song, key, body, source: sourceUrl };
}

// Izin verilen sarki adresleri (acik proxy olmamasi icin)
function isAllowedSongUrl(url) {
  return (
    /^https?:\/\/(www\.)?repertuarim\.com\/akor\/[a-z0-9\-]+-akor-\d+\.html$/i.test(url) ||
    /^https?:\/\/(www\.)?akorculuk\.com\/akorlar\/\d+\/[a-z0-9\-]+\/[a-z0-9\-]+-akor\/?$/i.test(url)
  );
}

function isAllowedRepertoireUrl(url) {
  return /^https?:\/\/(www\.)?repertuarim\.com\/repertuar\/\d+\/[a-z0-9\-]+\.html$/i.test(url);
}

async function getRepertoire(url) {
  const html = await fetchText(url);
  const rep = parseRepertoire(html);
  if (!rep.songs.length) throw new Error('Bu repertuarda sarki bulunamadi.');
  return rep;
}

async function getSong(url) {
  const html = await fetchText(url);
  const parsed = parseSongPage(html, url);
  if (!parsed.body) throw new Error('Bu sayfada akor/soz blogu bulunamadi.');
  return parsed;
}

/* ==========================================================================
 * Rotalar
 * ========================================================================== */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'En az 2 harf girin.' });
  try {
    const results = await searchSongs(q);
    res.json({ query: q, results });
  } catch (err) {
    console.error('search error:', err.message);
    res.status(502).json({ error: 'Arama yapilamadi: ' + err.message });
  }
});

app.get('/api/song', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!isAllowedSongUrl(url)) {
    return res.status(400).json({ error: 'Gecersiz sarki adresi.' });
  }
  try {
    const song = await getSong(url);
    res.json(song);
  } catch (err) {
    console.error('song error:', err.message);
    res.status(502).json({ error: 'Sarki alinamadi: ' + err.message });
  }
});

app.get('/api/repertoire', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!isAllowedRepertoireUrl(url)) {
    return res.status(400).json({
      error: 'Geçerli bir repertuarim.com repertuar adresi girin (…/repertuar/…/….html).',
    });
  }
  try {
    const rep = await getRepertoire(url);
    res.json(rep);
  } catch (err) {
    console.error('repertoire error:', err.message);
    res.status(502).json({ error: 'Repertuar alınamadı: ' + err.message });
  }
});

// Grup verisini oku (revOnly=1 ile sadece revizyon -> hafif yoklama)
app.get('/api/sync/:room', (req, res) => {
  const room = req.params.room;
  if (!validRoom(room)) return res.status(400).json({ error: 'Geçersiz grup kodu.' });
  const rec = syncStore[room];
  if (req.query.revOnly) return res.json({ rev: rec ? rec.rev : 0 });
  res.json({ rev: rec ? rec.rev : 0, data: rec ? rec.data : null });
});

// Grup verisini yaz (son yazan kazanir)
app.post('/api/sync/:room', (req, res) => {
  const room = req.params.room;
  if (!validRoom(room)) return res.status(400).json({ error: 'Geçersiz grup kodu.' });
  const data = req.body && req.body.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.setlists)) {
    return res.status(400).json({ error: 'Geçersiz veri.' });
  }
  const cur = syncStore[room] || { rev: 0 };
  syncStore[room] = { rev: cur.rev + 1, data, updatedAt: Date.now() };
  persistSync();
  res.json({ rev: syncStore[room].rev });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sahne Setlist calisiyor:  http://localhost:${PORT}`);
});
