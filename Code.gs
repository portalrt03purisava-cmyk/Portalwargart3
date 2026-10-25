/**
 * PORTAL WARGA RT 03 PURI SAVA — BACKEND (Google Apps Script)
 * Database: Google Sheets yang terikat pada script ini (container-bound).
 *
 * Alur keamanan singkat:
 *  - Login = nomor HP + email terdaftar, lalu kode 6 digit yang dikirim ke email itu.
 *  - Kode & token sesi hanya disimpan dalam bentuk hash (SHA-256 + garam rahasia).
 *  - Semua pemeriksaan hak akses dilakukan di server, bukan di tampilan.
 *  - Spreadsheet TIDAK boleh dibagikan ke siapa pun; warga hanya lewat web app.
 *
 * Langkah awal: isi ADMIN_AWAL di bawah, lalu jalankan fungsi setup() sekali.
 */

// ====== WAJIB DIISI SEBELUM MENJALANKAN setup() ======
const ADMIN_AWAL = {
  nama: 'GANTI DENGAN NAMA ADMIN',
  hp: '08xxxxxxxxxx',
  email: 'ganti-dengan-email-admin@gmail.com',
  nik: '0000000000000000',
  nokk: '0000000000000000',
  alamat: 'Blok ? No. ?',
};

// ====== PENGATURAN YANG BOLEH DIUBAH ======
const CFG = {
  NAMA_RT: 'RT 03 Puri Sava',
  ZONA: 'Asia/Jakarta',
  SESI_JAM: 12,            // masa berlaku login
  OTP_MENIT: 10,           // masa berlaku kode
  OTP_MAKS_SALAH: 5,       // salah memasukkan kode -> kode dihanguskan
  OTP_MAKS_MINTA: 5,       // permintaan kode per 15 menit per nomor HP
  DAFTAR_MAKS_PER_JAM: 15, // batas pendaftaran baru per jam (anti-spam)
  IURAN_BULANAN: 50000,
  IURAN_JATUH_TEMPO_TGL: 10,
  CARA_BAYAR: 'Bayar ke Bendahara RT atau kolektor iuran. Status diperbarui setelah pembayaran dicatat.',
  CADANGAN_SIMPAN: 8,      // jumlah salinan cadangan mingguan yang disimpan
  DIREKTORI_UNTUK_WARGA: true, // false = warga biasa tidak melihat daftar nama tetangga (hanya kontak pengurus)
  KODE_AKUN: {
    Masuk: [['SA', 'Saldo awal'], ['P01', 'Sumbangan warga'], ['P02', 'Donasi kegiatan'], ['P03', 'Jasa/bunga'], ['P99', 'Pemasukan lain']],
    Keluar: [['B01', 'Keamanan (satpam)'], ['B02', 'Kebersihan & sampah'], ['B03', 'Listrik & air pos'], ['B04', 'Kegiatan sosial'], ['B05', 'Perbaikan & inventaris'], ['B06', 'Administrasi'], ['B99', 'Pengeluaran lain']],
  },
};

const PERAN = ['Warga', 'Bendahara', 'Ketua', 'Admin'];
const STATUS_WARGA = ['Menunggu', 'Aktif', 'Nonaktif', 'Ditolak'];
const STATUS_IURAN = ['Lunas', 'Belum', 'Bebas'];
const STATUS_PROGRAM = ['Akan datang', 'Selesai', 'Dibatalkan'];

const IZIN = {
  Warga: ['lihat'],
  Bendahara: ['lihat', 'rekap', 'iuran', 'kas'],
  Ketua: ['lihat', 'rekap', 'verifikasi', 'program', 'pengumuman', 'dataLengkap'],
  Admin: ['lihat', 'rekap', 'iuran', 'kas', 'verifikasi', 'program', 'pengumuman', 'dataLengkap', 'kelolaWarga', 'audit'],
};

const SKEMA = {
  Warga: ['ID', 'Nama', 'NIK', 'NoKK', 'HP', 'Email', 'Alamat', 'Pekerjaan', 'Peran', 'Status', 'IuranMulai', 'DibuatPada'],
  Sesi: ['TokenHash', 'WargaID', 'Kadaluarsa'],
  OTP: ['WargaID', 'KodeHash', 'Kadaluarsa', 'Percobaan'],
  Iuran: ['ID', 'WargaID', 'Periode', 'Jumlah', 'Status', 'TglBayar', 'Catatan', 'DicatatOleh'],
  Keuangan: ['ID', 'Tanggal', 'Jenis', 'KodeAkun', 'Uraian', 'Jumlah', 'DicatatOleh'],
  Program: ['ID', 'Judul', 'Deskripsi', 'Tanggal', 'Lokasi', 'Status'],
  Pengumuman: ['ID', 'Judul', 'Isi', 'Tanggal', 'Penulis'],
  Audit: ['Waktu', 'WargaID', 'Aksi', 'Detail'],
};
const KOLOM_ANGKA = ['Jumlah', 'Kadaluarsa', 'Percobaan'];

// ====== TITIK MASUK WEB APP ======
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Portal Warga ' + CFG.NAMA_RT)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Satu pintu untuk semua permintaan dari tampilan. Fungsi berakhiran "_" tidak bisa dipanggil dari browser.
function api(aksi, token, data) {
  try {
    data = data && typeof data === 'object' ? data : {};
    if (typeof aksi !== 'string' || !Object.prototype.hasOwnProperty.call(RUTE, aksi)) return { ok: false, error: 'Permintaan tidak dikenal.' };
    const r = RUTE[aksi];
    let user = null;
    if (!r.publik) {
      user = cekSesi_(token);
      if (!user) return { ok: false, error: 'Sesi berakhir. Silakan masuk lagi.', sesiHabis: true };
      if (r.izin && !punyaIzin_(user, r.izin)) {
        audit_(user.ID, 'AKSES_DITOLAK', aksi);
        return { ok: false, error: 'Anda tidak punya akses untuk ini.' };
      }
    }
    return { ok: true, data: r.fn(data, user, token) };
  } catch (e) {
    if (e && e.pesan) return { ok: false, error: e.pesan };
    console.error((e && e.stack) || e);
    return { ok: false, error: 'Terjadi kesalahan. Coba lagi sebentar.' };
  }
}

const RUTE = {
  info: { publik: true, fn: info_ },
  daftar: { publik: true, fn: daftar_ },
  mintaOtp: { publik: true, fn: mintaOtp_ },
  masuk: { publik: true, fn: masuk_ },
  keluar: { fn: keluar_ },
  saya: { fn: saya_ },
  profilUbah: { fn: profilUbah_ },
  beranda: { fn: beranda_ },
  iuranSaya: { fn: iuranSaya_ },
  iuranRekap: { izin: 'rekap', fn: iuranRekap_ },
  iuranCatat: { izin: 'iuran', fn: iuranCatat_ },
  kas: { fn: kas_ },
  kasTambah: { izin: 'kas', fn: kasTambah_ },
  kasHapus: { izin: 'kas', fn: kasHapus_ },
  programDaftar: { fn: programDaftar_ },
  programSimpan: { izin: 'program', fn: programSimpan_ },
  programHapus: { izin: 'program', fn: programHapus_ },
  pengumumanDaftar: { fn: pengumumanDaftar_ },
  pengumumanSimpan: { izin: 'pengumuman', fn: pengumumanSimpan_ },
  pengumumanHapus: { izin: 'pengumuman', fn: pengumumanHapus_ },
  warga: { fn: warga_ },
  wargaDetail: { izin: 'dataLengkap', fn: wargaDetail_ },
  wargaUbah: { izin: 'kelolaWarga', fn: wargaUbah_ },
  pendaftar: { izin: 'verifikasi', fn: pendaftar_ },
  pendaftarProses: { izin: 'verifikasi', fn: pendaftarProses_ },
  audit: { izin: 'audit', fn: auditDaftar_ },
};

// ====== PENYIMPANAN (GOOGLE SHEETS) ======
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function lembar_(nama) {
  const s = ss_().getSheetByName(nama);
  if (!s) throw new Error('Lembar ' + nama + ' belum ada. Jalankan setup().');
  return s;
}

function teksSel_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CFG.ZONA, 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

function baca_(nama) {
  const s = lembar_(nama), kol = SKEMA[nama], n = s.getLastRow() - 1;
  if (n < 1) return [];
  return s.getRange(2, 1, n, kol.length).getValues().map(function (r, i) {
    const o = { _baris: i + 2 };
    kol.forEach(function (k, j) { o[k] = KOLOM_ANGKA.indexOf(k) >= 0 ? Number(r[j]) || 0 : teksSel_(r[j]); });
    return o;
  });
}

// Mencegah rumus berbahaya jika sheet diekspor ke Excel/CSV.
function bersih_(v) {
  if (typeof v !== 'string') return v == null ? '' : v;
  return /^[=+\-@]/.test(v) ? ' ' + v : v;
}

function formatKolom_(nama) {
  return SKEMA[nama].map(function (k) { return KOLOM_ANGKA.indexOf(k) >= 0 ? '0' : '@'; });
}

let KUNCI_DALAM = 0;
function kunci_(fn) {
  if (KUNCI_DALAM > 0) return fn();
  const l = LockService.getScriptLock();
  l.waitLock(20000);
  KUNCI_DALAM = 1;
  try { return fn(); } finally { KUNCI_DALAM = 0; l.releaseLock(); }
}

function tambah_(nama, obj) {
  return kunci_(function () {
    const s = lembar_(nama), kol = SKEMA[nama];
    const rng = s.getRange(s.getLastRow() + 1, 1, 1, kol.length);
    rng.setNumberFormats([formatKolom_(nama)]);
    rng.setValues([kol.map(function (k) { return bersih_(obj[k]); })]);
  });
}

function ubah_(nama, baris, obj) {
  return kunci_(function () {
    const kol = SKEMA[nama], rng = lembar_(nama).getRange(baris, 1, 1, kol.length);
    const v = rng.getValues()[0];
    kol.forEach(function (k, j) { if (Object.prototype.hasOwnProperty.call(obj, k)) v[j] = bersih_(obj[k]); });
    rng.setValues([v]);
  });
}

function hapusDi_(nama, cocok) {
  return kunci_(function () {
    const s = lembar_(nama);
    baca_(nama).filter(cocok).map(function (r) { return r._baris; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (b) { s.deleteRow(b); });
  });
}

// ====== KEAMANAN & UTILITAS ======
function garam_() {
  const p = PropertiesService.getScriptProperties();
  let g = p.getProperty('GARAM');
  if (!g) { g = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('GARAM', g); }
  return g;
}

function hash_(s) {
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, garam_() + '|' + s, Utilities.Charset.UTF_8);
  return b.map(function (x) { return ('0' + (x & 0xff).toString(16)).slice(-2); }).join('');
}

function acakId_(awalan) { return awalan + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function acak6_() { return ('000000' + (parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 1000000)).slice(-6); }

function batas_(kunci, maks, detik) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(kunci) || 0);
  if (n >= maks) return false;
  c.put(kunci, String(n + 1), detik);
  return true;
}

function gagal_(pesan) { throw { pesan: pesan }; }

function noHp_(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.indexOf('62') === 0) return d;
  if (d.indexOf('0') === 0) return '62' + d.slice(1);
  if (d.indexOf('8') === 0) return '62' + d;
  return d;
}
function hpValid_(hp) { return /^628\d{7,12}$/.test(hp); }
function email_(e) {
  e = String(e || '').trim().toLowerCase();
  return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}
function teks_(v, min, maks, label) {
  v = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  if (v.length < min) gagal_(label + (min > 0 && !v ? ' harus diisi.' : ' terlalu pendek (minimal ' + min + ' huruf).'));
  if (v.length > maks) gagal_(label + ' terlalu panjang (maksimal ' + maks + ' huruf).');
  return v;
}
function angka_(v, min, maks, label) {
  const n = Number(v);
  if (!isFinite(n) || n < min || n > maks) gagal_(label + ' harus berupa angka ' + min + ' sampai ' + maks + '.');
  return Math.round(n);
}
function tgl_(v, label) {
  v = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v + 'T00:00:00Z').getTime())) gagal_(label + ' tidak valid.');
  return v;
}
function periode_(v) {
  v = String(v || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v) || v < '2020-01' || v > geserPeriode_(periodeKini_(), 12)) gagal_('Periode tidak valid.');
  return v;
}
function topeng_(s) { s = String(s || ''); return s.length > 4 ? '************' + s.slice(-4) : s; }
function hariIni_() { return Utilities.formatDate(new Date(), CFG.ZONA, 'yyyy-MM-dd'); }
function periodeKini_() { return Utilities.formatDate(new Date(), CFG.ZONA, 'yyyy-MM'); }
function geserPeriode_(p, n) {
  const a = p.split('-').map(Number), i = a[0] * 12 + (a[1] - 1) + n;
  return Math.floor(i / 12) + '-' + ('0' + ((i % 12) + 1)).slice(-2);
}
function daftarPeriode_(n, akhir) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(geserPeriode_(akhir, -i));
  return out;
}

function audit_(wargaId, aksi, detail) {
  try {
    tambah_('Audit', { Waktu: Utilities.formatDate(new Date(), CFG.ZONA, 'yyyy-MM-dd HH:mm:ss'), WargaID: wargaId, Aksi: aksi, Detail: String(detail || '').slice(0, 300) });
  } catch (e) { console.error(e); }
}

function punyaIzin_(u, izin) { return (IZIN[u.Peran] || []).indexOf(izin) >= 0; }
function cariWarga_(id) { return baca_('Warga').filter(function (w) { return w.ID === id; })[0] || null; }
function cariLogin_(hp, em) {
  return baca_('Warga').filter(function (w) { return w.HP === hp && w.Email.toLowerCase() === em && w.Status === 'Aktif'; })[0] || null;
}
function profil_(w) {
  return { id: w.ID, nama: w.Nama, peran: w.Peran, alamat: w.Alamat, pekerjaan: w.Pekerjaan, hp: w.HP, email: w.Email, izin: IZIN[w.Peran] || [] };
}
function kirimEmail_(ke, judul, isi) {
  MailApp.sendEmail({ to: ke, subject: judul, body: isi, name: 'Portal Warga ' + CFG.NAMA_RT, noReply: true });
}

function cekSesi_(token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 100) return null;
  const h = hash_(token), cache = CacheService.getScriptCache(), sekarang = Date.now();
  let id = null;
  const c = cache.get('s_' + h);
  if (c) {
    const p = c.split('|');
    if (Number(p[1]) > sekarang) id = p[0];
  }
  if (!id) {
    const r = baca_('Sesi').filter(function (x) { return x.TokenHash === h && x.Kadaluarsa > sekarang; })[0];
    if (!r) return null;
    id = r.WargaID;
    cache.put('s_' + h, id + '|' + r.Kadaluarsa, 300);
  }
  const w = cariWarga_(id);
  return w && w.Status === 'Aktif' ? w : null;
}

// ====== LOGIN ======
function info_() {
  return { namaRt: CFG.NAMA_RT, iuran: CFG.IURAN_BULANAN, tempo: CFG.IURAN_JATUH_TEMPO_TGL, caraBayar: CFG.CARA_BAYAR, kodeAkun: CFG.KODE_AKUN, peran: PERAN, statusWarga: STATUS_WARGA, statusIuran: STATUS_IURAN, statusProgram: STATUS_PROGRAM };
}

function mintaOtp_(d) {
  const hp = noHp_(d.hp), em = email_(d.email);
  if (!hpValid_(hp) || !em) gagal_('Isi nomor HP dan email dengan benar.');
  if (!batas_('otp_' + hash_(hp), CFG.OTP_MAKS_MINTA, 900)) gagal_('Terlalu sering meminta kode. Tunggu 15 menit lalu coba lagi.');
  const w = cariLogin_(hp, em);
  if (w) {
    const kode = acak6_();
    kunci_(function () {
      hapusDi_('OTP', function (r) { return r.WargaID === w.ID; });
      tambah_('OTP', { WargaID: w.ID, KodeHash: hash_(w.ID + '|' + kode), Kadaluarsa: Date.now() + CFG.OTP_MENIT * 60000, Percobaan: 0 });
    });
    try {
      kirimEmail_(em, 'Kode masuk Portal Warga ' + CFG.NAMA_RT,
        'Kode masuk Anda: ' + kode + '\n\nBerlaku ' + CFG.OTP_MENIT + ' menit. Jangan berikan kode ini kepada siapa pun, termasuk pengurus RT.\nJika Anda tidak merasa meminta kode ini, abaikan email ini.');
      audit_(w.ID, 'OTP_DIKIRIM', '');
    } catch (e) { audit_(w.ID, 'OTP_EMAIL_GAGAL', String(e).slice(0, 120)); }
  } else {
    audit_('-', 'OTP_TIDAK_COCOK', 'hp ****' + hp.slice(-4));
  }
  // Jawaban selalu sama agar orang luar tidak bisa menebak siapa yang terdaftar.
  return { pesan: 'Jika nomor HP dan email cocok dengan data warga, kode masuk sudah dikirim ke email. Cek kotak masuk atau folder spam.' };
}

function masuk_(d) {
  const hp = noHp_(d.hp), em = email_(d.email), kode = String(d.kode || '').replace(/\D/g, '');
  const galat = 'Kode salah atau sudah kedaluwarsa. Minta kode baru bila perlu.';
  if (!hpValid_(hp) || !em || kode.length !== 6) gagal_(galat);
  if (!batas_('v_' + hash_(hp), 20, 900)) gagal_('Terlalu banyak percobaan. Tunggu 15 menit lalu coba lagi.');
  const w = cariLogin_(hp, em);
  if (!w) gagal_(galat);
  return kunci_(function () {
    const o = baca_('OTP').filter(function (r) { return r.WargaID === w.ID; })[0];
    if (!o || o.Kadaluarsa < Date.now() || o.Percobaan >= CFG.OTP_MAKS_SALAH) gagal_(galat);
    if (o.KodeHash !== hash_(w.ID + '|' + kode)) {
      ubah_('OTP', o._baris, { Percobaan: o.Percobaan + 1 });
      audit_(w.ID, 'OTP_SALAH', 'percobaan ' + (o.Percobaan + 1));
      gagal_(galat);
    }
    hapusDi_('OTP', function (r) { return r.WargaID === w.ID; });
    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    tambah_('Sesi', { TokenHash: hash_(token), WargaID: w.ID, Kadaluarsa: Date.now() + CFG.SESI_JAM * 3600000 });
    audit_(w.ID, 'MASUK', '');
    return { token: token, pengguna: profil_(w) };
  });
}

function keluar_(d, u, token) {
  const h = hash_(token);
  hapusDi_('Sesi', function (r) { return r.TokenHash === h; });
  CacheService.getScriptCache().remove('s_' + h);
  audit_(u.ID, 'KELUAR', '');
  return { ok: true };
}

function saya_(d, u) { return profil_(u); }

function profilUbah_(d, u) {
  const alamat = teks_(d.alamat, 5, 120, 'Alamat'), kerja = teks_(d.pekerjaan, 0, 60, 'Pekerjaan');
  kunci_(function () {
    const w = cariWarga_(u.ID);
    ubah_('Warga', w._baris, { Alamat: alamat, Pekerjaan: kerja });
  });
  audit_(u.ID, 'PROFIL_UBAH', '');
  return profil_(cariWarga_(u.ID));
}

// ====== PENDAFTARAN & VERIFIKASI ======
function daftar_(d) {
  const sama = { pesan: 'Pendaftaran diterima. Pengurus RT akan memeriksa data Anda. Jika sebelumnya sudah mendaftar, tidak perlu mendaftar lagi. Setelah disetujui, Anda bisa masuk dengan nomor HP dan email ini.' };
  if (d.website) return sama; // kolom jebakan untuk robot
  const nama = teks_(d.nama, 3, 80, 'Nama');
  const nik = String(d.nik || '').replace(/\D/g, ''), kk = String(d.nokk || '').replace(/\D/g, '');
  if (nik.length !== 16) gagal_('NIK harus 16 angka.');
  if (kk.length !== 16) gagal_('Nomor KK harus 16 angka.');
  const hp = noHp_(d.hp), em = email_(d.email);
  if (!hpValid_(hp)) gagal_('Nomor HP tidak valid. Contoh: 0812 3456 7890.');
  if (!em) gagal_('Email tidak valid.');
  const alamat = teks_(d.alamat, 5, 120, 'Alamat'), kerja = teks_(d.pekerjaan, 0, 60, 'Pekerjaan');
  if (!batas_('daftar_global', CFG.DAFTAR_MAKS_PER_JAM, 3600)) gagal_('Pendaftaran sedang ramai. Coba lagi satu jam lagi atau hubungi pengurus.');
  const baru = kunci_(function () {
    const ada = baca_('Warga').some(function (w) { return w.HP === hp || w.Email.toLowerCase() === em || w.NIK === nik; });
    if (ada) { audit_('-', 'DAFTAR_DUPLIKAT', 'hp ****' + hp.slice(-4)); return false; }
    tambah_('Warga', { ID: acakId_('W'), Nama: nama, NIK: nik, NoKK: kk, HP: hp, Email: em, Alamat: alamat, Pekerjaan: kerja, Peran: 'Warga', Status: 'Menunggu', IuranMulai: '', DibuatPada: Utilities.formatDate(new Date(), CFG.ZONA, 'yyyy-MM-dd HH:mm') });
    audit_('-', 'DAFTAR_BARU', nama);
    return true;
  });
  if (baru) {
    try {
      const tujuan = baca_('Warga').filter(function (w) { return w.Status === 'Aktif' && (w.Peran === 'Ketua' || w.Peran === 'Admin'); }).map(function (w) { return w.Email; });
      if (tujuan.length) kirimEmail_(tujuan.join(','), 'Pendaftar baru menunggu verifikasi', 'Ada pendaftar baru di Portal Warga ' + CFG.NAMA_RT + ': ' + nama + '. Buka portal > Menu > Verifikasi pendaftar.');
    } catch (e) { console.error(e); }
  }
  return sama;
}

function pendaftar_(d, u) {
  audit_(u.ID, 'LIHAT_PENDAFTAR', '');
  return baca_('Warga').filter(function (w) { return w.Status === 'Menunggu'; })
    .map(function (w) { return { id: w.ID, nama: w.Nama, nik: w.NIK, nokk: w.NoKK, hp: w.HP, email: w.Email, alamat: w.Alamat, pekerjaan: w.Pekerjaan, waktu: w.DibuatPada }; });
}

function pendaftarProses_(d, u) {
  const setuju = d.keputusan === 'setuju';
  if (!setuju && d.keputusan !== 'tolak') gagal_('Keputusan tidak valid.');
  const w = kunci_(function () {
    const x = cariWarga_(String(d.id || ''));
    if (!x || x.Status !== 'Menunggu') gagal_('Pendaftar tidak ditemukan atau sudah diproses.');
    ubah_('Warga', x._baris, setuju ? { Status: 'Aktif', IuranMulai: periodeKini_() } : { Status: 'Ditolak' });
    return x;
  });
  audit_(u.ID, setuju ? 'PENDAFTAR_SETUJU' : 'PENDAFTAR_TOLAK', w.Nama);
  try {
    kirimEmail_(w.Email, setuju ? 'Pendaftaran disetujui' : 'Pendaftaran belum dapat disetujui',
      setuju ? 'Pendaftaran Anda di Portal Warga ' + CFG.NAMA_RT + ' sudah disetujui. Silakan masuk dengan nomor HP dan email yang Anda daftarkan.'
        : 'Pendaftaran Anda di Portal Warga ' + CFG.NAMA_RT + ' belum dapat disetujui. Silakan hubungi pengurus RT.');
  } catch (e) { console.error(e); }
  return { ok: true };
}

// ====== DATA WARGA ======
function warga_(d, u) {
  const lengkap = punyaIzin_(u, 'dataLengkap'), pengurus = punyaIzin_(u, 'rekap'), kelola = punyaIzin_(u, 'kelolaWarga') && d.semua === true;
  const semua = baca_('Warga');
  const daftar = semua.filter(function (w) { return kelola ? true : w.Status === 'Aktif'; })
    .sort(function (a, b) { return a.Alamat.localeCompare(b.Alamat, 'id', { numeric: true }); })
    .map(function (w) {
      const o = { id: w.ID, nama: w.Nama, alamat: w.Alamat };
      if (pengurus) { o.hp = w.HP; o.pekerjaan = w.Pekerjaan; }
      if (lengkap) { o.nik = topeng_(w.NIK); o.nokk = topeng_(w.NoKK); o.email = w.Email; o.peran = w.Peran; }
      if (kelola) { o.status = w.Status; o.peran = w.Peran; o.email = w.Email; o.hp = w.HP; o.pekerjaan = w.Pekerjaan; }
      return o;
    });
  if (!pengurus && !CFG.DIREKTORI_UNTUK_WARGA) daftar.length = 0;
  const kontak = semua.filter(function (w) { return w.Status === 'Aktif' && w.Peran !== 'Warga'; })
    .map(function (w) { return { nama: w.Nama, peran: w.Peran, hp: w.HP }; });
  return { daftar: daftar, kontak: kontak };
}

function wargaDetail_(d, u) {
  const w = cariWarga_(String(d.id || ''));
  if (!w) gagal_('Warga tidak ditemukan.');
  audit_(u.ID, 'LIHAT_DATA_LENGKAP', w.Nama);
  return { id: w.ID, nama: w.Nama, nik: w.NIK, nokk: w.NoKK, hp: w.HP, email: w.Email, alamat: w.Alamat, pekerjaan: w.Pekerjaan, peran: w.Peran, status: w.Status };
}

function wargaUbah_(d, u) {
  const peran = String(d.peran || ''), status = String(d.status || '');
  if (PERAN.indexOf(peran) < 0 || STATUS_WARGA.indexOf(status) < 0) gagal_('Peran atau status tidak valid.');
  const nama = teks_(d.nama, 3, 80, 'Nama');
  const alamat = teks_(d.alamat, 5, 120, 'Alamat'), kerja = teks_(d.pekerjaan, 0, 60, 'Pekerjaan');
  const hp = noHp_(d.hp), em = email_(d.email);
  if (!hpValid_(hp)) gagal_('Nomor HP tidak valid.');
  if (!em) gagal_('Email tidak valid.');
  kunci_(function () {
    const semua = baca_('Warga'), w = semua.filter(function (x) { return x.ID === String(d.id || ''); })[0];
    if (!w) gagal_('Warga tidak ditemukan.');
    if (semua.some(function (x) { return x.ID !== w.ID && (x.HP === hp || x.Email.toLowerCase() === em); })) gagal_('Nomor HP atau email itu sudah dipakai warga lain.');
    if (w.ID === u.ID && (peran !== 'Admin' || status !== 'Aktif')) gagal_('Anda tidak bisa menurunkan peran atau menonaktifkan akun Anda sendiri.');
    const adminAktif = semua.filter(function (x) { return x.ID === w.ID ? (peran === 'Admin' && status === 'Aktif') : (x.Peran === 'Admin' && x.Status === 'Aktif'); }).length;
    if (adminAktif < 1) gagal_('Harus ada minimal satu Admin aktif.');
    const ubahan = { Nama: nama, Peran: peran, Status: status, Alamat: alamat, Pekerjaan: kerja, HP: hp, Email: em };
    if (status === 'Aktif' && w.Status !== 'Aktif' && !w.IuranMulai) ubahan.IuranMulai = periodeKini_();
    ubah_('Warga', w._baris, ubahan);
    if (status !== 'Aktif' || hp !== w.HP || em !== w.Email) hapusDi_('Sesi', function (r) { return r.WargaID === w.ID; });
    audit_(u.ID, 'WARGA_UBAH', w.Nama + ': ' + w.Peran + '/' + w.Status + ' -> ' + peran + '/' + status);
  });
  return { ok: true };
}

// ====== IURAN ======
function statusIuran_(wargaId, periode, semua) {
  const r = semua.filter(function (x) { return x.WargaID === wargaId && x.Periode === periode; })[0];
  return r ? { status: r.Status, jumlah: r.Jumlah || CFG.IURAN_BULANAN, tgl: r.TglBayar, catatan: r.Catatan }
    : { status: 'Belum', jumlah: CFG.IURAN_BULANAN, tgl: '', catatan: '' };
}

function iuranSaya_(d, u) {
  const semua = baca_('Iuran'), kini = periodeKini_();
  let periode = daftarPeriode_(12, kini).filter(function (p) { return !u.IuranMulai || p >= u.IuranMulai; });
  if (!periode.length) periode = [kini];
  return { periode: periode.map(function (p) { const s = statusIuran_(u.ID, p, semua); return { periode: p, status: s.status, jumlah: s.jumlah, tgl: s.tgl }; }) };
}

function iuranRekap_(d) {
  const p = periode_(d.periode || periodeKini_()), semua = baca_('Iuran');
  const daftar = baca_('Warga').filter(function (w) { return w.Status === 'Aktif' && (!w.IuranMulai || w.IuranMulai <= p); })
    .map(function (w) { const s = statusIuran_(w.ID, p, semua); return { id: w.ID, nama: w.Nama, alamat: w.Alamat, status: s.status, jumlah: s.jumlah, tgl: s.tgl, catatan: s.catatan }; })
    .sort(function (a, b) { return a.alamat.localeCompare(b.alamat, 'id', { numeric: true }); });
  const ringkas = { lunas: 0, belum: 0, bebas: 0, terkumpul: 0 };
  daftar.forEach(function (x) {
    if (x.status === 'Lunas') { ringkas.lunas++; ringkas.terkumpul += x.jumlah; } else if (x.status === 'Bebas') ringkas.bebas++; else ringkas.belum++;
  });
  return { periode: p, periodeOpsi: daftarPeriode_(12, periodeKini_()), daftar: daftar, ringkas: ringkas };
}

function iuranCatat_(d, u) {
  const status = String(d.status || '');
  if (STATUS_IURAN.indexOf(status) < 0) gagal_('Status iuran tidak valid.');
  const p = periode_(d.periode), catatan = teks_(d.catatan, 0, 120, 'Catatan');
  let jumlah = CFG.IURAN_BULANAN, tgl = '';
  if (status === 'Lunas') { jumlah = angka_(d.jumlah, 1000, 10000000, 'Jumlah'); tgl = tgl_(d.tglBayar || hariIni_(), 'Tanggal bayar'); }
  if (status === 'Bebas') jumlah = 0;
  const w = kunci_(function () {
    const x = cariWarga_(String(d.wargaId || ''));
    if (!x || x.Status !== 'Aktif') gagal_('Warga tidak ditemukan.');
    const ada = baca_('Iuran').filter(function (r) { return r.WargaID === x.ID && r.Periode === p; })[0];
    const isi = { Jumlah: jumlah, Status: status, TglBayar: tgl, Catatan: catatan, DicatatOleh: u.ID };
    if (ada) ubah_('Iuran', ada._baris, isi);
    else tambah_('Iuran', Object.assign({ ID: acakId_('I'), WargaID: x.ID, Periode: p }, isi));
    return x;
  });
  audit_(u.ID, 'IURAN_CATAT', w.Nama + ' ' + p + ' ' + status + ' ' + jumlah);
  return { ok: true };
}

// ====== KAS (LAPORAN KEUANGAN) ======
// Iuran yang berstatus Lunas otomatis dihitung sebagai pemasukan (berdasarkan tanggal bayar).
function kas_(d, u) {
  const iuran = baca_('Iuran').filter(function (r) { return r.Status === 'Lunas'; });
  const kas = baca_('Keuangan');
  const jml = function (arr, f) { return arr.filter(f).reduce(function (a, r) { return a + r.Jumlah; }, 0); };
  const masukIuran = jml(iuran, function () { return true; });
  const masukLain = jml(kas, function (r) { return r.Jenis === 'Masuk'; });
  const keluar = jml(kas, function (r) { return r.Jenis === 'Keluar'; });
  const bulanan = daftarPeriode_(6, periodeKini_()).map(function (p) {
    return {
      periode: p,
      iuran: jml(iuran, function (r) { return r.TglBayar.indexOf(p) === 0; }),
      masukLain: jml(kas, function (r) { return r.Jenis === 'Masuk' && r.Tanggal.indexOf(p) === 0; }),
      keluar: jml(kas, function (r) { return r.Jenis === 'Keluar' && r.Tanggal.indexOf(p) === 0; }),
    };
  });
  const nama = {};
  [].concat(CFG.KODE_AKUN.Masuk, CFG.KODE_AKUN.Keluar).forEach(function (k) { nama[k[0]] = k[1]; });
  const transaksi = kas.sort(function (a, b) { return a.Tanggal < b.Tanggal ? 1 : a.Tanggal > b.Tanggal ? -1 : 0; }).slice(0, 60)
    .map(function (r) { return { id: r.ID, tanggal: r.Tanggal, jenis: r.Jenis, kode: r.KodeAkun, akun: nama[r.KodeAkun] || r.KodeAkun, uraian: r.Uraian, jumlah: r.Jumlah }; });
  return { saldo: masukIuran + masukLain - keluar, masuk: masukIuran + masukLain, masukIuran: masukIuran, keluar: keluar, bulanan: bulanan, transaksi: transaksi, boleh: punyaIzin_(u, 'kas') };
}

function kasTambah_(d, u) {
  const jenis = String(d.jenis || '');
  if (jenis !== 'Masuk' && jenis !== 'Keluar') gagal_('Jenis transaksi tidak valid.');
  const kode = String(d.kode || '');
  if (!CFG.KODE_AKUN[jenis].some(function (k) { return k[0] === kode; })) gagal_('Kode akun tidak sesuai jenis transaksi.');
  const tanggal = tgl_(d.tanggal, 'Tanggal');
  if (tanggal > hariIni_()) gagal_('Tanggal tidak boleh di masa depan.');
  const uraian = teks_(d.uraian, 3, 120, 'Uraian'), jumlah = angka_(d.jumlah, 1, 1000000000, 'Jumlah');
  tambah_('Keuangan', { ID: acakId_('K'), Tanggal: tanggal, Jenis: jenis, KodeAkun: kode, Uraian: uraian, Jumlah: jumlah, DicatatOleh: u.ID });
  audit_(u.ID, 'KAS_TAMBAH', jenis + ' ' + kode + ' ' + jumlah + ' ' + uraian);
  return { ok: true };
}

function kasHapus_(d, u) {
  const r = kunci_(function () {
    const x = baca_('Keuangan').filter(function (k) { return k.ID === String(d.id || ''); })[0];
    if (!x) gagal_('Transaksi tidak ditemukan.');
    lembar_('Keuangan').deleteRow(x._baris);
    return x;
  });
  audit_(u.ID, 'KAS_HAPUS', r.Jenis + ' ' + r.KodeAkun + ' ' + r.Jumlah + ' ' + r.Uraian);
  return { ok: true };
}

// ====== PROGRAM & PENGUMUMAN ======
function programDaftar_() {
  return baca_('Program').sort(function (a, b) { return a.Tanggal < b.Tanggal ? 1 : -1; })
    .map(function (r) { return { id: r.ID, judul: r.Judul, deskripsi: r.Deskripsi, tanggal: r.Tanggal, lokasi: r.Lokasi, status: r.Status }; });
}

function programSimpan_(d, u) {
  const status = String(d.status || '');
  if (STATUS_PROGRAM.indexOf(status) < 0) gagal_('Status kegiatan tidak valid.');
  const isi = { Judul: teks_(d.judul, 3, 100, 'Judul'), Deskripsi: teks_(d.deskripsi, 0, 1000, 'Keterangan'), Tanggal: tgl_(d.tanggal, 'Tanggal'), Lokasi: teks_(d.lokasi, 0, 100, 'Lokasi'), Status: status };
  kunci_(function () {
    const ada = d.id ? baca_('Program').filter(function (r) { return r.ID === String(d.id); })[0] : null;
    if (d.id && !ada) gagal_('Kegiatan tidak ditemukan.');
    if (ada) ubah_('Program', ada._baris, isi); else tambah_('Program', Object.assign({ ID: acakId_('G') }, isi));
  });
  audit_(u.ID, d.id ? 'PROGRAM_UBAH' : 'PROGRAM_TAMBAH', isi.Judul);
  return { ok: true };
}

function programHapus_(d, u) {
  hapusDi_('Program', function (r) { return r.ID === String(d.id || ''); });
  audit_(u.ID, 'PROGRAM_HAPUS', String(d.id));
  return { ok: true };
}

function pengumumanDaftar_() {
  return baca_('Pengumuman').sort(function (a, b) { return a.Tanggal < b.Tanggal ? 1 : -1; }).slice(0, 30)
    .map(function (r) { return { id: r.ID, judul: r.Judul, isi: r.Isi, tanggal: r.Tanggal, penulis: r.Penulis }; });
}

function pengumumanSimpan_(d, u) {
  const isi = { Judul: teks_(d.judul, 3, 100, 'Judul'), Isi: teks_(d.isi, 3, 1000, 'Isi pengumuman') };
  kunci_(function () {
    const ada = d.id ? baca_('Pengumuman').filter(function (r) { return r.ID === String(d.id); })[0] : null;
    if (d.id && !ada) gagal_('Pengumuman tidak ditemukan.');
    if (ada) ubah_('Pengumuman', ada._baris, isi);
    else tambah_('Pengumuman', Object.assign({ ID: acakId_('N'), Tanggal: hariIni_(), Penulis: u.Nama }, isi));
  });
  audit_(u.ID, d.id ? 'PENGUMUMAN_UBAH' : 'PENGUMUMAN_TAMBAH', isi.Judul);
  return { ok: true };
}

function pengumumanHapus_(d, u) {
  hapusDi_('Pengumuman', function (r) { return r.ID === String(d.id || ''); });
  audit_(u.ID, 'PENGUMUMAN_HAPUS', String(d.id));
  return { ok: true };
}

function beranda_(d, u) {
  const p = periodeKini_(), iur = statusIuran_(u.ID, p, baca_('Iuran'));
  const wajib = !u.IuranMulai || u.IuranMulai <= p;
  const hari = hariIni_();
  const o = {
    periode: p,
    iuran: wajib ? iur : { status: 'Bebas', jumlah: 0, tgl: '', catatan: 'Iuran Anda mulai bulan ' + u.IuranMulai },
    pengumuman: pengumumanDaftar_().slice(0, 3),
    program: programDaftar_().filter(function (r) { return r.status === 'Akan datang' && r.tanggal >= hari; }).sort(function (a, b) { return a.tanggal < b.tanggal ? -1 : 1; }).slice(0, 3),
  };
  if (punyaIzin_(u, 'verifikasi')) o.menunggu = baca_('Warga').filter(function (w) { return w.Status === 'Menunggu'; }).length;
  return o;
}

function auditDaftar_() {
  const n = {};
  baca_('Warga').forEach(function (w) { n[w.ID] = w.Nama; });
  return baca_('Audit').slice(-150).reverse().map(function (r) { return { waktu: r.Waktu, siapa: n[r.WargaID] || r.WargaID, aksi: r.Aksi, detail: r.Detail }; });
}

// ====== PEMASANGAN, PEMBERSIHAN, CADANGAN ======
function setup() {
  const ss = ss_();
  Object.keys(SKEMA).forEach(function (nama) {
    const s = ss.getSheetByName(nama) || ss.insertSheet(nama), kol = SKEMA[nama];
    s.getRange(1, 1, 1, kol.length).setValues([kol]).setFontWeight('bold').setBackground('#dcefe6');
    s.setFrozenRows(1);
    const f = formatKolom_(nama);
    kol.forEach(function (k, j) { s.getRange(2, j + 1, Math.max(s.getMaxRows() - 1, 1), 1).setNumberFormat(f[j]); });
    // Hanya pemilik spreadsheet yang boleh mengedit langsung.
    const p = s.protect().setDescription('Dikelola oleh Portal Warga');
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  });
  const awal = ss.getSheetByName('Sheet1') || ss.getSheetByName('Sheet 1') || ss.getSheetByName('Lembar1');
  if (awal && ss.getSheets().length > 1) ss.deleteSheet(awal);
  garam_();
  if (baca_('Warga').length === 0) {
    const hp = noHp_(ADMIN_AWAL.hp), em = email_(ADMIN_AWAL.email);
    if (!hpValid_(hp) || !em) throw new Error('Isi ADMIN_AWAL (nama, hp, email) dengan benar lalu jalankan setup() lagi.');
    tambah_('Warga', { ID: acakId_('W'), Nama: ADMIN_AWAL.nama, NIK: ADMIN_AWAL.nik, NoKK: ADMIN_AWAL.nokk, HP: hp, Email: em, Alamat: ADMIN_AWAL.alamat, Pekerjaan: '', Peran: 'Admin', Status: 'Aktif', IuranMulai: periodeKini_(), DibuatPada: Utilities.formatDate(new Date(), CFG.ZONA, 'yyyy-MM-dd HH:mm') });
  }
  pasangTrigger_();
  console.log('Setup selesai. Lanjut: Deploy > New deployment > Web app.');
}

function pasangTrigger_() {
  const ada = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (ada.indexOf('bersihkan') < 0) ScriptApp.newTrigger('bersihkan').timeBased().everyDays(1).atHour(3).create();
  if (ada.indexOf('cadangan') < 0) ScriptApp.newTrigger('cadangan').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).create();
}

// Dijalankan otomatis tiap hari: hapus sesi dan kode yang sudah kedaluwarsa.
function bersihkan() {
  const t = Date.now();
  hapusDi_('Sesi', function (r) { return r.Kadaluarsa < t; });
  hapusDi_('OTP', function (r) { return r.Kadaluarsa < t; });
}

// Dijalankan otomatis tiap minggu: salinan spreadsheet disimpan di folder Drive pemilik.
function cadangan() {
  const nama = 'Cadangan Portal ' + CFG.NAMA_RT;
  const it = DriveApp.getFoldersByName(nama);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(nama);
  DriveApp.getFileById(ss_().getId()).makeCopy('Cadangan ' + hariIni_(), folder);
  const files = [], fi = folder.getFiles();
  while (fi.hasNext()) files.push(fi.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(CFG.CADANGAN_SIMPAN).forEach(function (f) { f.setTrashed(true); });
}
