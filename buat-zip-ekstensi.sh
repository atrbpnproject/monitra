#!/bin/sh
# Bangun ulang unduh/rekap-tunggakan-kanwil.zip dari folder ekstensi/.
# Jalankan setiap kali isi ekstensi/ berubah, lalu commit ZIP-nya.
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
cp -r ekstensi "$tmp/rekap-tunggakan-kanwil"
mkdir -p unduh
rm -f unduh/rekap-tunggakan-kanwil.zip
(cd "$tmp" && zip -qrX - rekap-tunggakan-kanwil) > unduh/rekap-tunggakan-kanwil.zip
rm -rf "$tmp"
echo "unduh/rekap-tunggakan-kanwil.zip dibuat"
