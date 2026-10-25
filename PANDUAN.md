# Portal Warga RT 03 Puri Sava: Panduan Pemasangan

Isi paket: `Code.gs` (server), `index.html` (tampilan), `appsscript.json` (pengaturan).
Database memakai Google Sheets milik Anda sendiri, gratis, tanpa server tambahan.

## A. Pemasangan (sekitar 15 menit)

1. Buat Google Spreadsheet baru di akun Google pengurus (misalnya `Database Portal RT 03`). Jangan dibagikan ke siapa pun.
2. Buka **Extensions > Apps Script**.
3. Buat tiga file di editor:
   - `Code.gs`: hapus isi bawaan, tempel isi file `Code.gs`.
   - Klik **+ > HTML**, beri nama `index` (tanpa .html), tempel isi `index.html`.
   - **Project Settings > Show "appsscript.json" manifest file**, lalu ganti isinya dengan `appsscript.json`.
4. Di bagian atas `Code.gs`, isi `ADMIN_AWAL` (nama, HP, email admin pertama). Email harus yang benar-benar aktif karena kode masuk dikirim ke sana.
5. Pilih fungsi `setup` di menu atas, klik **Run**, lalu izinkan akses (Google akan menampilkan peringatan "belum diverifikasi"; pilih *Advanced > Go to project*; ini aman karena script milik Anda sendiri). `setup` membuat semua lembar, mengunci lembar dari pengeditan orang lain, membuat kunci rahasia, mendaftarkan admin pertama, dan menjadwalkan pembersihan harian serta cadangan mingguan.
6. **Deploy > New deployment > Web app**. Isi: *Execute as*: **Me**, *Who has access*: **Anyone**. Klik Deploy dan salin alamat web app (berakhiran `/exec`).
7. Buka alamat itu, masuk memakai HP + email admin, lalu cek email untuk kode 6 angka.
8. Bagikan alamat `/exec` ke grup WhatsApp warga. Setiap kali kode diubah, pilih **Deploy > Manage deployments > Edit > Version: New version** supaya alamat tetap sama.

Tips: untuk tampil seperti aplikasi di HP, buka alamat web app di Chrome lalu pilih **Tambahkan ke layar utama**.

## B. Cara kerja login

Warga memasukkan nomor HP dan email yang terdaftar, lalu menerima kode 6 angka lewat email, berlaku 10 menit. Nomor HP saja atau email saja tidak cukup; keduanya harus cocok dengan data warga yang berstatus Aktif.

Pendaftaran: warga mengisi formulir di halaman masuk, Ketua RT atau Admin memeriksa dan menyetujui di **Menu > Verifikasi pendaftar**. Setelah disetujui, warga bisa masuk.

Batas email: akun Gmail biasa bisa mengirim sekitar 100 email per hari, akun Google Workspace sekitar 1.500. Untuk satu RT biasanya cukup. Jika warga ramai masuk bersamaan, sebagian kode bisa tertunda sampai batas harian pulih.

## C. Siapa bisa apa

| Fitur | Warga | Bendahara | Ketua | Admin |
|---|---|---|---|---|
| Lihat iuran sendiri, kegiatan, pengumuman, laporan kas | ya | ya | ya | ya |
| Lihat nama dan alamat tetangga | ya (bisa dimatikan) | ya | ya | ya |
| Lihat rekap iuran semua warga | tidak | ya | ya | ya |
| Catat iuran, catat dan hapus transaksi kas | tidak | ya | tidak | ya |
| Tambah/ubah pengumuman dan kegiatan | tidak | tidak | ya | ya |
| Verifikasi pendaftar, lihat NIK dan KK lengkap | tidak | tidak | ya | ya |
| Ubah peran dan data warga, lihat catatan aktivitas | tidak | tidak | tidak | ya |

Iuran berstatus **Lunas** otomatis dihitung sebagai pemasukan kas (berdasarkan tanggal bayar), jadi Bendahara tidak perlu mencatat dua kali. Saldo awal dicatat sekali lewat **Kas RT > Catat** dengan akun `SA Saldo awal`. Untuk menyembunyikan daftar nama tetangga dari warga biasa, ubah `DIREKTORI_UNTUK_WARGA` menjadi `false` di `Code.gs`.

## D. Yang sudah dilakukan demi keamanan data

- Spreadsheet tidak pernah diakses langsung oleh warga; semua lewat fungsi server yang memeriksa login dan peran di sisi server.
- Kode masuk dan token sesi disimpan hanya sebagai hash (SHA-256 + garam rahasia). Kode salah 5 kali langsung hangus; permintaan kode dibatasi 5 kali per 15 menit per nomor HP.
- Jawaban "kode dikirim" selalu sama, siapa pun yang mencoba, supaya orang luar tidak bisa menebak siapa yang terdaftar.
- Sesi berlaku 12 jam dan bisa diakhiri lewat **Menu > Keluar**. Akun yang dinonaktifkan langsung tidak bisa dipakai.
- NIK dan KK hanya terlihat oleh Ketua dan Admin, ditampilkan tersamar di daftar, dan setiap pembukaan data lengkap dicatat di lembar `Audit`.
- Semua masukan diperiksa panjang dan bentuknya; tampilan tidak pernah menyisipkan HTML dari data (aman dari penyisipan script).
- Lembar dikunci agar hanya pemilik yang bisa mengedit langsung; ada cadangan otomatis tiap Minggu dini hari ke folder Drive `Cadangan Portal RT 03 Puri Sava` (8 salinan terakhir).
- Pendaftaran dibatasi 15 per jam dan memakai kolom jebakan untuk robot.

## E. Yang perlu Anda jaga

1. Jangan bagikan spreadsheet database dan jangan jadikan pengurus lain editor. Jika Bendahara perlu angka, pakai menu Kas RT di portal.
2. Pakai akun Google khusus RT dengan verifikasi 2 langkah aktif. Itu pintu paling penting dari seluruh sistem.
3. Saat pengurus berganti, ubah peran di **Menu > Kelola warga**. Jika Admin berganti, buat Admin baru dulu, baru turunkan yang lama.
4. Jangan pernah membagikan kode masuk kepada siapa pun, termasuk pengurus. Ingatkan warga lewat grup.
5. Periksa **Catatan aktivitas** secara berkala; baris `OTP_SALAH` atau `AKSES_DITOLAK` berulang patut diselidiki.
6. NIK, KK, nomor HP, dan email adalah data pribadi. Hanya kumpulkan yang dibutuhkan dan beri tahu warga untuk apa dipakai.

## F. Mencoba tampilan tanpa memasang

Buka `index.html` langsung di browser. Layar akan menampilkan pita "Mode contoh" dengan data tiruan (semua peran terbuka); tidak ada data asli yang dibaca atau disimpan.

## G. Batasan yang perlu diketahui

- Google Apps Script cukup untuk satu RT (ratusan warga). Bila lebih dari sekitar 1.000 baris iuran per bulan, pindah ke database sungguhan.
- Pembayaran iuran dicatat manual oleh Bendahara; belum ada pembayaran online.
- Kode masuk lewat email, bukan SMS, karena SMS berbayar. Nomor HP dipakai sebagai identitas dan untuk tautan WhatsApp pengurus.
