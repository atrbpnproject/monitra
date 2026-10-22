// Membaca Excel hasil ekstensi "Rekap Tunggakan Kanwil" (atau JSON dari ekstensi)
// dan mengubahnya ke satu format rekap. Semua berjalan di browser, tanpa server.
(function (global) {
  const td = new TextDecoder();

  // ---------- pembaca .xlsx minimal (ZIP + SpreadsheetML) ----------
  async function bacaZip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Bukan file .xlsx yang valid.');
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      files[td.decode(u8.subarray(p + 46, p + 46 + nlen))] = { method, csize, off };
      p += 46 + nlen + xlen + clen;
    }
    return async function ambil(nama) {
      const f = files[nama];
      if (!f) return null;
      const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
      const data = u8.subarray(start, start + f.csize);
      if (f.method === 0) return td.decode(data);
      if (f.method === 8) {
        const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
        return td.decode(out);
      }
      throw new Error('Metode kompresi ZIP tidak didukung: ' + f.method);
    };
  }

  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const tags = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
  const teks = (node) => tags(node, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join('');

  function kolomKeIndeks(ref) {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  // Mengembalikan { 'Nama Sheet': [[sel, ...], ...] }
  async function bacaXlsx(buf) {
    const ambil = await bacaZip(buf);
    const wb = await ambil('xl/workbook.xml');
    if (!wb) throw new Error('File tidak berisi workbook Excel.');
    const relsTxt = await ambil('xl/_rels/workbook.xml.rels');
    const rels = {};
    if (relsTxt) tags(xml(relsTxt), 'Relationship').forEach((r) => {
      let t = r.getAttribute('Target');
      t = t.startsWith('/') ? t.slice(1) : 'xl/' + t;
      rels[r.getAttribute('Id')] = t;
    });
    const ssTxt = await ambil('xl/sharedStrings.xml');
    const shared = ssTxt ? tags(xml(ssTxt), 'si').map(teks) : [];
    const hasil = {};
    for (const s of tags(xml(wb), 'sheet')) {
      const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
      const isi = await ambil(rels[rid] || '');
      if (!isi) continue;
      const rows = [];
      tags(xml(isi), 'row').forEach((row) => {
        const ri = Number(row.getAttribute('r')) - 1;
        const r = [];
        let auto = 0;
        Array.from(row.children).forEach((c) => {
          if (c.localName !== 'c') return;
          let ci = kolomKeIndeks(c.getAttribute('r'));
          if (ci < 0) ci = auto;
          auto = ci + 1;
          const t = c.getAttribute('t');
          const v = tags(c, 'v')[0];
          let val;
          if (t === 'inlineStr') val = teks(c);
          else if (!v) val = null;
          else if (t === 's') val = shared[Number(v.textContent)];
          else if (t === 'b') val = v.textContent === '1';
          else if (t === 'str' || t === 'e') val = v.textContent;
          else { const num = Number(v.textContent); val = isFinite(num) ? num : v.textContent; }
          r[ci] = val;
        });
        rows[isFinite(ri) && ri >= 0 ? ri : rows.length] = r;
      });
      hasil[s.getAttribute('name')] = Array.from(rows, (r) => r || []);
    }
    return hasil;
  }

  // ---------- util nilai ----------
  function angka(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  }
  const p2 = (x) => String(x).padStart(2, '0');
  const iso = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;

  // Tanggal ke 'YYYY-MM-DD' dari: 'dd-mm-yyyy', 'dd/mm/yyyy', 'yyyy-mm-dd', '/Date(ms)/', serial Excel.
  function tanggal(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return v > 20000 && v < 80000 ? iso(new Date(Date.UTC(1899, 11, 30) + v * 864e5)) : '';
    const s = String(v).trim();
    let m = /\/Date\((-?\d+)/.exec(s);
    if (m) { const d = new Date(Number(m[1])); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
    if (m) return `${m[3]}-${p2(m[2])}-${p2(m[1])}`;
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return '';
  }

  // "22/10/2026, 12.23.08" (toLocaleString id-ID) -> ISO lokal
  function waktuEkstraksi(v, namaFile) {
    if (typeof v === 'number') return tanggal(v) + 'T00:00';
    const s = String(v || '');
    let m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\D+(\d{1,2})[.:](\d{2})/.exec(s);
    if (m) return `${m[3]}-${p2(m[2])}-${p2(m[1])}T${p2(m[4])}:${m[5]}`;
    m = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/.exec(namaFile || '');
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
    const t = tanggal(s);
    return t ? t + 'T00:00' : '';
  }

  const METRIK = [
    ['masuk', 'Berkas Masuk', 'berkasmasuk'],
    ['luncuran', 'Berkas Luncuran', 'berkasluncuran'],
    ['prosesSesuai', 'Berkas Proses Sesuai SPOPP', 'prosessesuaiprosedur'],
    ['prosesMelebihi', 'Berkas Proses Melebihi SPOPP', 'prosesmelebihiprosedur'],
    ['selesaiSesuai', 'Berkas Selesai Sesuai SPOPP', 'selesaisesuaiprosedur'],
    ['selesaiMelebihi', 'Berkas Selesai Melebihi SPOPP', 'selesaimelebihiprosedur'],
  ];

  // Ubah tabel (baris header + data) menjadi objek per baris berdasarkan nama kolom.
  function keObjek(rows) {
    if (!rows || !rows.length) return [];
    const head = rows[0].map((h) => String(h ?? '').trim().toLowerCase());
    return rows.slice(1).filter((r) => r && r.some((v) => v !== null && v !== undefined && v !== '')).map((r) => {
      const o = {};
      head.forEach((h, i) => { if (h) o[h] = r[i]; });
      return o;
    });
  }
  const metrikDari = (o, pakaiLabel) => Object.fromEntries(METRIK.map(([k, label, key]) => [k, angka(pakaiLabel ? o[label.toLowerCase()] : o[key])]));
  const cariSheet = (sheets, nama) => sheets[Object.keys(sheets).find((k) => k.trim().toLowerCase() === nama.toLowerCase())];

  function dariExcel(sheets, namaFile) {
    const ring = cariSheet(sheets, 'Ringkasan Kantah');
    const lay = cariSheet(sheets, 'Layanan Tunggakan');
    const det = cariSheet(sheets, 'Detail Berkas');
    if (!ring || !det) throw new Error('Sheet "Ringkasan Kantah" atau "Detail Berkas" tidak ditemukan. Pastikan file berasal dari ekstensi Rekap Tunggakan Kanwil.');
    const info = {};
    keObjek(cariSheet(sheets, 'Info') || []).forEach((o) => { info[String(o.keterangan || '').toLowerCase()] = o.nilai; });

    const kantah = keObjek(ring).filter((o) => o['nama kantah'] && String(o['nama kantah']).trim().toLowerCase() !== 'total').map((o) => ({
      nama: String(o['nama kantah']).trim(),
      m: metrikDari(o, true),
      jmlLayanan: angka(o['jumlah layanan bertunggakan']),
      berkasTerambil: angka(o['berkas detail terambil']),
      catatan: o.catatan ? String(o.catatan) : '',
    }));
    const layanan = keObjek(lay || []).filter((o) => o['nama prosedur']).map((o) => ({
      kantah: String(o['nama kantah']).trim(),
      prosedur: String(o['nama prosedur']).trim(),
      m: metrikDari(o, true),
      berkasTerambil: angka(o['berkas detail terambil']),
      catatan: o.catatan ? String(o.catatan) : '',
    }));
    const berkas = keObjek(det).filter((o) => o['nomor berkas'] !== undefined && o['nomor berkas'] !== null).map((o) => ({
      kantah: String(o['nama kantah'] || '').trim(),
      prosedur: String(o['nama prosedur'] || '').trim(),
      nomor: String(o['nomor berkas']).trim(),
      tahun: angka(o['tahun berkas']) || '',
      posisi: String(o['posisi berkas digital'] || '').trim() || '(tanpa posisi)',
      status: String(o['status berkas'] || '').trim(),
      mulai: tanggal(o['tanggal mulai']),
      durasi: o['durasi (hari)'] === '' || o['durasi (hari)'] == null ? '' : angka(o['durasi (hari)']),
      jatuhTempo: tanggal(o['jatuh tempo']),
    }));
    return {
      kanwil: String(info.kanwil || 'Kanwil'),
      filter: String(info.filter || ''),
      waktu: waktuEkstraksi(info['waktu ekstraksi'], namaFile),
      sumber: 'Excel',
      namaFile: namaFile || '',
      kantah, layanan, berkas,
    };
  }

  // Format state.hasil dari ekstensi (dipakai tombol "Kirim ke Web" atau file .json).
  function dariEkstensi(h) {
    const kantah = [], layanan = [], berkas = [];
    (h.kantah || []).forEach((k) => {
      const nama = String(k.info.namakantah).trim();
      let jml = 0;
      (k.layanan || []).forEach((l) => {
        const det = l.detail || [];
        jml += det.length;
        layanan.push({ kantah: nama, prosedur: String(l.info.namaprosedur).trim(), m: metrikDari(l.info, false), berkasTerambil: det.length, catatan: l.error || '' });
        det.forEach((d) => berkas.push({
          kantah: nama,
          prosedur: String(d.namaprosedur || l.info.namaprosedur).trim(),
          nomor: String(d.nomorberkas ?? '').trim(),
          tahun: angka(d.tahunberkas) || '',
          posisi: String(d.posisi_berkas_digital || '').trim() || '(tanpa posisi)',
          status: String(d.statusberkas || '').trim(),
          mulai: tanggal(d.tanggalmulai),
          durasi: d.durasi === null || d.durasi === undefined || d.durasi === '' ? '' : angka(d.durasi),
          jatuhTempo: tanggal(d.jatuhtempo),
        }));
      });
      kantah.push({
        nama, m: metrikDari(k.info, false), jmlLayanan: (k.layanan || []).length, berkasTerambil: jml,
        catatan: k.error || ((k.layanan || []).some((l) => l.error) ? 'Sebagian layanan gagal diambil' : ''),
      });
    });
    const w = new Date(h.waktu);
    return {
      kanwil: String((h.kanwil && h.kanwil.namakanwil) || 'Kanwil'),
      filter: String(h.filter || ''),
      waktu: isNaN(w) ? '' : `${w.getFullYear()}-${p2(w.getMonth() + 1)}-${p2(w.getDate())}T${p2(w.getHours())}:${p2(w.getMinutes())}`,
      sumber: 'Ekstensi',
      namaFile: '',
      kantah, layanan, berkas,
    };
  }

  async function dariFile(file) {
    const buf = await file.arrayBuffer();
    if (/\.json$/i.test(file.name)) {
      const j = JSON.parse(td.decode(buf));
      return j && j.berkas && j.kantah && j.kanwil ? { ...j, namaFile: file.name } : { ...dariEkstensi(j), namaFile: file.name };
    }
    return dariExcel(await bacaXlsx(buf), file.name);
  }

  global.DataRekap = { bacaXlsx, dariExcel, dariEkstensi, dariFile, METRIK, angka };
})(window);
