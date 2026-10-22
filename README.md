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
- **Riwayat & Perbandingan**: rekap tersimpan, berkas baru menunggak dan berkas yang keluar
  dari daftar antara dua rekap, tren per kantah.

"Telat" dihitung dari tanggal jatuh tempo sampai tanggal rekap diambil.

## Untuk ekstensi

Halaman menerima rekap langsung lewat `window.postMessage`:

```js
window.postMessage({ type: 'REKAP_TUNGGAKAN', id, hasil: state.hasil }, '*');
// balasan: { type: 'REKAP_TUNGGAKAN_DITERIMA', id }
```

`hasil` sama dengan `state.hasil` di `content.js` ekstensi. File `.json` dengan isi yang sama
juga bisa diimpor lewat tombol Impor.

## Berkas

- `index.html`, `style.css`, `app.js`: tampilan dan logika dashboard.
- `data.js`: pembaca .xlsx (tanpa library) dan pengubah ke format rekap.
- `xlsx-writer.js`: penulis .xlsx yang sama dengan milik ekstensi, untuk tombol unduh.
