# Monitra — Rekap Tunggakan SPOPP

Dashboard untuk file Excel hasil ekstensi Chrome **Rekap Tunggakan Kanwil**
(berkas proses melebihi SPOPP dari dashboard Kinerja Kantor Pertanahan).

Alamat: https://atrbpnproject.github.io/monitra/

## Cara pakai

1. Jalankan ekstensi, klik **Unduh Excel**.
2. Buka halaman ini, klik **Impor Excel** (atau seret file ke halaman).
3. Rekap tersimpan di browser ini. Impor rekap dari tanggal lain untuk melihat perbandingan.

Data hanya dibaca oleh browser. Tidak ada yang diunggah ke server, dan file
Excel tidak disimpan di repositori ini.

## Isi halaman

- **Ringkasan**: angka utama kanwil, tunggakan per kantah menurut lama lewat jatuh tempo,
  10 layanan dan 10 posisi berkas terbanyak, tahun berkas, tabel rekap per kantah,
  catatan selisih angka rekap vs berkas detail.
- **Kantah**: angka dashboard satu kantah, sebaran umur, posisi berkas, layanan bertunggakan,
  20 berkas terlama, unduh Excel dan cetak.
- **Layanan**: satu layanan dibandingkan di semua kantah.
- **Posisi Berkas**: matriks posisi berkas digital × kantah.
- **Daftar Berkas**: cari, saring, urutkan, unduh Excel hasil saringan.
- **Berkas di luar hitungan dashboard**: daftar detail dashboard diambil per nama layanan, sehingga bisa ikut
  membawa berkas versi SPOPP lain dengan nama sama (contoh: Roya 5 hari, padahal rekap hanya menghitung Roya
  3 hari). Bila tepat satu kelompok durasi SPOPP jumlahnya sama dengan angka rekap, berkas lainnya ditandai
  "di luar hitungan", tidak masuk angka Monitra, dan bisa dilihat lewat filter di Daftar Berkas.
- **Tahun tunggakan**: setiap berkas diberi tahun tunggakan = tahun Tanggal Mulai, sama dengan pilihan
  Tahun di dashboard Kinerja Kantor Pertanahan (bukan tahun nomor berkas). Ada tabel kantah × tahun di
  Ringkasan, layanan × tahun di Kantah, kantah × tahun di Layanan, filter dan kolom di Daftar Berkas.
- **Riwayat & Perbandingan**: rekap tersimpan, berkas baru menunggak dan berkas yang keluar
  dari daftar antara dua rekap, tren per kantah.

"Telat" dihitung dari tanggal jatuh tempo sampai tanggal rekap diambil.

## Ekstensi

Kode ekstensi Chrome ada di folder [`ekstensi/`](ekstensi/). ZIP siap pasang ada di
[`unduh/rekap-tunggakan-kanwil.zip`](unduh/rekap-tunggakan-kanwil.zip) dan bisa diunduh dari
tombol **Rekap Sekarang** bila ekstensi belum terpasang. Setiap kali isi `ekstensi/` berubah,
jalankan `./buat-zip-ekstensi.sh` lalu commit ZIP-nya.

### Rekap Sekarang (dari Monitra)

1. `ekstensi/monitra-bridge.js` berjalan di halaman Monitra dan mengumumkan
   `{ type: 'REKAP_EKSTENSI_ADA', versi }`. Tanpa pengumuman itu, tombol membuka panduan pemasangan.
2. Tombol mengirim `{ type: 'REKAP_MINTA', kanwil }`. Background mencatat permintaan, lalu membuka
   atau mengaktifkan tab dashboard Kinerja Kantor Pertanahan. Tab itu dibuat aktif karena Chrome
   memperlambat timer di tab latar belakang.
3. Panel ekstensi menjalankan rekap untuk kanwil yang sama dengan rekap aktif di Monitra
   (atau Kanwil NTB bila belum ada). Progresnya diteruskan sebagai `REKAP_STATUS`.
4. Bila daftar kanwil gagal dimuat karena belum login, permintaan ditahan sampai 30 menit dan
   rekap berjalan sendiri setelah halaman dashboard dimuat ulang dalam keadaan login.
5. Setelah selesai, hasil dikirim kembali ke tab Monitra yang meminta (lihat di bawah) dan tab itu diaktifkan.

### Kirim ke Monitra (dari panel ekstensi)

1. Ekstensi menitipkan hasil rekap di penyimpanan ekstensi lalu membuka tab
   `https://atrbpnproject.github.io/monitra/#ekstensi=<id>`, atau memberi tahu tab Monitra yang meminta.
2. `monitra-bridge.js` mengambil titipan dan mengirimnya ke halaman:
   `window.postMessage({ type: 'REKAP_TUNGGAKAN', id, hasil }, '*')`.
3. Halaman menyimpan rekap ke IndexedDB, membalas `{ type: 'REKAP_TUNGGAKAN_DITERIMA', id }`,
   dan ekstensi menghapus titipannya.

Data berpindah di dalam browser yang sama dan tidak melewati server. `hasil` sama dengan
`state.hasil` di `ekstensi/content.js`; file `.json` dengan isi itu juga bisa diimpor lewat tombol Impor.

Kalau alamat Monitra berubah, ubah `MONITRA_URL` di `ekstensi/background.js` dan pola
`matches` untuk `monitra-bridge.js` di `ekstensi/manifest.json`.

## Berkas

- `index.html`, `style.css`, `app.js`: tampilan dan logika dashboard.
- `data.js`: pembaca .xlsx (tanpa library) dan pengubah ke format rekap.
- `xlsx-writer.js`: penulis .xlsx yang sama dengan milik ekstensi, untuk tombol unduh.
