# Sahne Setlist

Sahne için setlist + akor/söz uygulaması. Şarkı arar (repertuarim.com), akor & sözü birlikte getirir; transpoze (gerçek ton gösterimi), otomatik kaydırma, çoklu setlist, çevrimdışı, cihazlar arası eşitleme, yedekleme içerir.

Yerelde çalıştırma:

```
npm install
npm start
# http://localhost:3000
```

---

## Render.com'a yükleme (ücretsiz, adım adım)

Eşitleme dahil her şey burada çalışır (kalıcı Node sunucusu).

### 1) Kodu GitHub'a koy
GitHub hesabın yoksa github.com'dan ücretsiz aç. Sonra bu klasörde (terminalde):

```
git init
git add -A
git commit -m "Sahne Setlist"
```

github.com'da yeni bir **boş repo** oluştur (ör. `sahne-setlist`, Private olabilir). Ardından GitHub'ın verdiği iki satırı çalıştır (kendi kullanıcı adınla):

```
git remote add origin https://github.com/KULLANICI_ADIN/sahne-setlist.git
git branch -M main
git push -u origin main
```

### 2) Render'da servis oluştur
1. https://render.com → ücretsiz kaydol (GitHub ile giriş en kolayı).
2. **New +** → **Web Service** → GitHub reposunu (`sahne-setlist`) seç/bağla.
3. Ayarlar (çoğu otomatik gelir):
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. **Create Web Service** → birkaç dakikada `https://sahne-setlist-xxxx.onrender.com` gibi bir adres verir.

> Alternatif: repoda `render.yaml` var; Render'da **New + → Blueprint** ile repoyu seçersen ayarları otomatik yapar.

### 3) Kullan
- Telefonlardan bu `onrender.com` adresini aç. Safari'de **Paylaş → Ana Ekrana Ekle** ile uygulama gibi durur.
- Eşitleme: her telefonda ☰ → aynı **grup kodu** → Bağlan.

### Setlistlerini taşı
Eski adreste (localhost) ☰ → **⬇ Yedeği indir**. Yeni adreste ☰ → **⬆ Geri yükle** → dosyayı seç.

---

## Ücretsiz plan notları
- **Uyku:** Render ücretsiz servis ~15 dk kullanılmayınca uyur; sonraki ilk açılış ~30-60 sn sürer (uyanma). Sonrası hızlı. Kayıtlı şarkılar telefonda saklandığı için çevrimdışı yine açılır; sadece arama/eşitleme sunucuyu uyandırır.
- **Eşitleme verisi:** Ücretsiz planda sunucu yeniden kurulduğunda eşitleme verisi sıfırlanabilir; ama bir telefon bağlanınca kendi verisinden otomatik geri dolar (her cihazda kopya var). Kalıcı garanti istersen Render'da **Disk** (ücretli) ekleyip `SYNC_FILE=/var/data/sync.json` ortam değişkenini ayarla (render.yaml içinde örneği var).

## Railway.app (alternatif, uyumaz)
Railway'de de çalışır (uyku yok, ama ücretsiz kredi aylık sınırlı). New Project → Deploy from GitHub → repoyu seç → otomatik `npm start`.
