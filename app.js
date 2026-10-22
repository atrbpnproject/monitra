// Dashboard Rekap Tunggakan SPOPP — berjalan sepenuhnya di browser.
// Rekap disimpan di IndexedDB browser ini; tidak ada data yang dikirim ke server mana pun.
(function () {
  const D = window.DataRekap;
  const $ = (s, el = document) => el.querySelector(s);
  const main = $('#main');

  // Versi ekstensi terbaru di unduh/rekap-tunggakan-kanwil.zip. Naikkan bersama ekstensi/manifest.json.
  const VERSI_EKSTENSI = '1.3.0';
  const TABS = ['ringkasan', 'kantah', 'layanan', 'posisi', 'berkas', 'riwayat'];

  // ---------- util ----------
  const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
  const pct = (a, b) => (b ? (a / b * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%' : '–');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pendek = (n) => String(n).replace(/^Kantor Pertanahan\s+/i, '').replace(/^Kabupaten\s+/i, '');
  const tgl = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : '');
  const waktuLabel = (w) => (w ? `${tgl(w)} ${w.slice(11, 16)}` : 'waktu tidak diketahui');
  const maks = (arr) => arr.reduce((a, b) => (b > a ? b : a), -Infinity);
  const median = (arr) => {
    const a = arr.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  };
  const UMUR = [
    { label: '≤ 7 hari', max: 7 },
    { label: '8–30 hari', max: 30 },
    { label: '31–90 hari', max: 90 },
    { label: '91–365 hari', max: 365 },
    { label: '> 365 hari', max: Infinity },
  ];
  const umurIdx = (t) => UMUR.findIndex((u) => t <= u.max);
  const kunciBerkas = (b) => `${b.kantah}|${b.prosedur}|${b.nomor}|${b.tahun}`;
  const simpanPref = (k, v) => { try { localStorage.setItem('rt.' + k, v); } catch (e) { /* abaikan */ } };
  const bacaPref = (k) => { try { return localStorage.getItem('rt.' + k); } catch (e) { return null; } };
  const lebihLama = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
    return false;
  };
  const hp = window.matchMedia('(max-width: 640px)');
  const gerakHemat = window.matchMedia('(prefers-reduced-motion: reduce)');

  // toast(pesan, ms, { label, fn }) — aksi opsional, misalnya "Urungkan".
  function toast(msg, ms = 3500, aksi) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>${aksi ? `<button type="button" class="toast-aksi">${esc(aksi.label)}</button>` : ''}`;
    if (aksi) $('.toast-aksi', t).onclick = () => { t.hidden = true; aksi.fn(); };
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), ms);
  }

  async function salin(teks, pesan = 'Disalin.') {
    try {
      await navigator.clipboard.writeText(teks);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = teks;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) { /* abaikan */ }
      ta.remove();
    }
    toast(pesan);
  }

  function unduhBlob(nama, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nama;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // ---------- penyimpanan (IndexedDB, cadangan: memori) ----------
  const Store = (() => {
    let dbp = null;
    const mem = new Map();
    function open() {
      if (!dbp) {
        dbp = new Promise((res) => {
          try {
            const rq = indexedDB.open('rekap-tunggakan', 1);
            rq.onupgradeneeded = () => rq.result.createObjectStore('rekap', { keyPath: 'id' });
            rq.onsuccess = () => res(rq.result);
            rq.onerror = () => res(null);
          } catch (e) { res(null); }
        });
      }
      return dbp;
    }
    const hasil = (r) => (r && typeof r === 'object' && 'result' in r ? r.result : undefined);
    const tx = async (mode, fn) => {
      const db = await open();
      if (!db) return hasil(fn(null));
      return new Promise((res, rej) => {
        let t;
        try { t = db.transaction('rekap', mode); } catch (e) { rej(e); return; }
        const r = fn(t.objectStore('rekap'));
        t.oncomplete = () => res(hasil(r));
        t.onerror = () => rej(t.error || new Error('Rekap tidak bisa disimpan di browser ini.'));
        t.onabort = () => rej(t.error || new Error('Penyimpanan browser penuh atau ditolak.'));
      });
    };
    return {
      all: () => tx('readonly', (s) => (s ? s.getAll() : { result: [...mem.values()] })),
      put: (r) => tx('readwrite', (s) => (s ? s.put(r) : void mem.set(r.id, r))),
      del: (id) => tx('readwrite', (s) => (s ? s.delete(id) : void mem.delete(id))),
    };
  })();

  // ---------- state ----------
  const F0 = () => ({ q: '', kantah: '', prosedur: '', posisi: '', tahun: '', thn: '', umur: '', hitung: '', macet: '' });
  const S = {
    list: [], // semua rekap (urut waktu terbaru dulu)
    R: null, // rekap aktif + turunan
    tab: 'ringkasan',
    kantah: null,
    layanan: null,
    posisiLayanan: '',
    f: F0(),
    sort: { key: 'telat', dir: -1 },
    page: 0,
    perHal: Number(bacaPref('perHal')) || 50,
    filterBuka: false,
    trenKantah: '',
    ext: null, // { versi } bila ekstensi Rekap Tunggakan Kanwil terdeteksi
    tungguEkstensi: /ekstensi=/.test(location.hash),
  };

  // Hasil turunkan() disimpan per rekap supaya Riwayat tidak menghitung ulang semua rekap di setiap tampilan.
  const cache = new Map();
  const turun = (r) => {
    const k = r.id + '|' + r.diimpor;
    if (!cache.has(k)) cache.set(k, turunkan(r));
    return cache.get(k);
  };

  function turunkan(r) {
    const ref = r.waktu ? r.waktu.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const refMs = Date.parse(ref + 'T00:00:00Z');
    const berkas = r.berkas.map((b) => {
      const telat = b.jatuhTempo ? Math.round((refMs - Date.parse(b.jatuhTempo + 'T00:00:00Z')) / 864e5) : null;
      // Tahun tunggakan = tahun Tanggal Mulai, sama dengan filter Tahun di dashboard Kinerja Kantor Pertanahan.
      const thn = b.mulai ? Number(b.mulai.slice(0, 4)) : null;
      return { ...b, telat, thn, umur: telat === null ? -1 : umurIdx(Math.max(telat, 0)) };
    });
    // Daftar detail diambil per nama layanan, sehingga bisa ikut membawa berkas versi SPOPP lain dengan nama yang sama
    // (contoh: Roya 3 hari dihitung dashboard, Roya 5 hari tidak). Bila detail melebihi angka rekap dan tepat satu
    // kelompok durasi SPOPP jumlahnya sama dengan angka rekap, berkas di luar kelompok itu ditandai luar hitungan.
    const luar = new Set();
    const seleksi = [];
    r.layanan.forEach((l) => {
      const rekap = l.m.prosesMelebihi;
      const list = berkas.filter((b) => b.kantah === l.kantah && b.prosedur === l.prosedur);
      if (rekap === null || rekap === undefined || list.length <= rekap) return;
      const perDurasi = kelompok(list, 'durasi');
      const cocok = perDurasi.filter((g) => g.n === rekap);
      if (perDurasi.length < 2 || cocok.length !== 1) return;
      const dihitung = cocok[0].k;
      const keluar = list.filter((b) => b.durasi !== dihitung);
      keluar.forEach((b) => luar.add(b));
      seleksi.push({ kantah: l.kantah, prosedur: l.prosedur, rekap, dihitung, keluar: keluar.length, durasiLuar: [...new Set(keluar.map((b) => b.durasi))] });
    });
    const semua = berkas.map((b) => (luar.has(b) ? { ...b, luar: true } : b));
    const dihitung = semua.filter((b) => !b.luar);
    const per = new Map();
    r.kantah.forEach((k) => per.set(k.nama, { ...k, berkas: [] }));
    dihitung.forEach((b) => {
      if (!per.has(b.kantah)) per.set(b.kantah, { nama: b.kantah, m: {}, jmlLayanan: 0, berkasTerambil: 0, catatan: '', berkas: [] });
      per.get(b.kantah).berkas.push(b);
    });
    return { ...r, ref, berkas: dihitung, luar: semua.filter((b) => b.luar), semua, seleksi, kantahMap: per, kantahList: [...per.values()] };
  }

  // Rekap dari kanwil dan filter yang sama, terbaru dulu. Hanya rekap sejenis yang adil dibandingkan.
  const sejenis = (r) => S.list.filter((x) => x.kanwil === r.kanwil && x.filter === r.filter);
  const sebelumnya = (r) => sejenis(r).find((x) => x.waktu < r.waktu) || null;

  // Peta nomor berkas -> posisi untuk satu rekap (dipakai untuk mencari berkas yang tidak bergerak).
  const petaPosisi = new Map();
  function posisiDi(r) {
    if (!petaPosisi.has(r.id)) petaPosisi.set(r.id, new Map(r.berkas.map((b) => [kunciBerkas(b), b.posisi])));
    return petaPosisi.get(r.id);
  }
  // Tandai setiap berkas dengan berapa rekap berturut-turut posisinya tidak berubah (b.macet) dan sejak kapan (b.sejak).
  function lengkapi(R) {
    const lama = sejenis(R).filter((x) => x.waktu < R.waktu).slice(0, 30);
    const p = sebelumnya(R);
    R.prev = p ? turun(p) : null;
    R.adaRiwayat = lama.length > 0;
    R.semua.forEach((b) => {
      const k = kunciBerkas(b);
      let n = 0, sejak = null;
      for (const x of lama) {
        if (posisiDi(x).get(k) !== b.posisi) break;
        n++;
        sejak = x.waktu;
      }
      b.macet = n;
      b.sejak = sejak;
    });
    return R;
  }

  function hitungUmur(list) {
    const u = [0, 0, 0, 0, 0];
    list.forEach((b) => { if (b.umur >= 0) u[b.umur]++; });
    return u;
  }
  function kelompok(list, key) {
    const m = new Map();
    list.forEach((b) => { const k = b[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(b); });
    return [...m.entries()].map(([k, v]) => ({ k, v, n: v.length })).sort((a, b) => b.n - a.n);
  }

  // ---------- alamat halaman (#tab?filter=...) ----------
  function keHash() {
    const p = new URLSearchParams();
    if (S.tab === 'kantah' && S.kantah) p.set('kantah', S.kantah);
    if (S.tab === 'layanan' && S.layanan) p.set('layanan', S.layanan);
    if (S.tab === 'posisi' && S.posisiLayanan) p.set('layanan', S.posisiLayanan);
    if (S.tab === 'berkas') {
      Object.entries(S.f).forEach(([k, v]) => { if (v) p.set(k, v); });
      if (S.page) p.set('hal', S.page + 1);
    }
    const q = p.toString();
    return '#' + S.tab + (q ? '?' + q : '');
  }
  function dariHash(h) {
    const m = /^#([a-z]+)(?:\?(.*))?$/.exec(h || '');
    if (!m || !TABS.includes(m[1])) return false;
    const p = new URLSearchParams(m[2] || '');
    S.tab = m[1];
    if (S.tab === 'kantah' && p.get('kantah')) S.kantah = p.get('kantah');
    if (S.tab === 'layanan' && p.get('layanan')) S.layanan = p.get('layanan');
    if (S.tab === 'posisi') S.posisiLayanan = p.get('layanan') || '';
    if (S.tab === 'berkas') {
      S.f = F0();
      Object.keys(S.f).forEach((k) => { if (p.get(k)) S.f[k] = p.get(k); });
      S.page = Math.max(0, (Number(p.get('hal')) || 1) - 1);
    }
    return true;
  }
  // push = true menambah langkah di riwayat browser (tombol Kembali); selain itu alamat hanya diperbarui.
  function catat(push) {
    if (S.tungguEkstensi) return; // alamat #ekstensi=… masih dibaca ekstensi
    const h = keHash();
    if (location.hash === h) return;
    history[push ? 'pushState' : 'replaceState'](null, '', location.pathname + location.search + h);
  }
  window.addEventListener('popstate', () => {
    if (dariHash(location.hash)) render();
  });

  // ---------- komponen grafik ----------
  const warnaUmur = (i) => `var(--age-${i})`;
  function legendUmur() {
    return `<div class="legend">${UMUR.map((u, i) => `<span${i === UMUR.length - 1 ? ' class="legend-crit"' : ''}><i style="background:${warnaUmur(i)}"></i>${u.label}</span>`).join('')}</div>`;
  }
  // baris: [{label, total, segs:[n...] | null, go:{...}, tip}]
  function hbars(rows, { stacked = false, max } = {}) {
    const mx = max || Math.max(1, ...rows.map((r) => r.total));
    return `<div class="hbars">${rows.map((r) => {
      const go = r.go ? ` data-go='${esc(JSON.stringify(r.go))}'` : '';
      const segs = stacked
        ? r.segs.map((n, i) => (n ? `<div class="seg" style="width:${n / mx * 100}%;background:${warnaUmur(i)}" data-tip="${esc(r.label)} · ${UMUR[i].label}: ${fmt(n)} berkas"></div>` : '')).join('')
        : `<div class="seg" style="width:${r.total / mx * 100}%;background:var(--bar)" data-tip="${esc(r.tip || r.label + ': ' + fmt(r.total))}"></div>`;
      return `<div class="lbl${r.go ? ' link' : ''}"${go} title="${esc(r.label)}">${esc(r.label)}</div><div class="track${r.go ? ' link' : ''}"${go}${r.go ? ' tabindex="-1"' : ''}>${segs}</div><div class="val">${fmt(r.total)}</div>`;
    }).join('')}</div>`;
  }
  function kolomUmur(u) {
    const mx = Math.max(1, ...u);
    const tot = u.reduce((a, b) => a + b, 0);
    return `<div class="cols">${u.map((n, i) => `<div class="col"><div class="top-val">${fmt(n)}</div><div class="bar" style="height:${n / mx * 100}%;background:${warnaUmur(i)}" data-tip="${UMUR[i].label}: ${fmt(n)} berkas (${pct(n, tot)})"></div></div>`).join('')}</div>
      <div class="cols-x">${UMUR.map((x, i) => `<span${i === UMUR.length - 1 ? ' class="legend-crit"' : ''}>${x.label}</span>`).join('')}</div>`;
  }
  // Berkas per tahun tunggakan (terbaru dulu) sebagai baris hbars; f = filter tambahan untuk Daftar Berkas.
  function perTahun(list, f = {}) {
    return kelompok(list, 'thn').sort((a, b) => (b.k ?? 0) - (a.k ?? 0))
      .map((g) => ({ label: g.k ? String(g.k) : '(tanpa tanggal mulai)', total: g.n, go: { tab: 'berkas', f: { ...f, thn: String(g.k ?? '') } } }));
  }
  // Tabel baris × tahun tunggakan. baris: [{ label, list, f }]
  function tabelTahun(baris, semua) {
    const th = [...new Set(semua.map((b) => b.thn))].filter((x) => x).sort((a, b) => b - a);
    const sel = (list, f, t) => {
      const n = list.filter((b) => b.thn === t).length;
      return n ? `<td class="num"><a href="#" ${go({ tab: 'berkas', f: { ...f, thn: String(t) } })}>${fmt(n)}</a></td>` : '<td class="num muted">–</td>';
    };
    return `<div class="tbl-wrap"><table class="stick-col"><thead><tr><th></th>${th.map((t) => `<th class="num">${t}</th>`).join('')}<th class="num">Total</th></tr></thead>
      <tbody>${baris.map((r) => `<tr><td>${esc(r.label)}</td>${th.map((t) => sel(r.list, r.f, t)).join('')}<td class="num"><b>${fmt(r.list.length)}</b></td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td>${th.map((t) => `<td class="num">${fmt(semua.filter((b) => b.thn === t).length)}</td>`).join('')}<td class="num">${fmt(semua.length)}</td></tr></tfoot></table></div>`;
  }
  const CATATAN_TAHUN = 'Tahun tunggakan = tahun Tanggal Mulai berkas, sama dengan pilihan Tahun di dashboard Kinerja Kantor Pertanahan.';
  const kpi = (v, l, s, d) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}${s ? `<div class="s">${s}</div>` : ''}</div>`;
  const go = (o) => `data-go='${esc(JSON.stringify(o))}'`;
  // Perubahan dibanding rekap sebelumnya. naikBuruk: kenaikan berarti memburuk (merah).
  function beda(v, { naikBuruk = true, satuan = '' } = {}) {
    if (v === null || v === undefined || isNaN(v)) return '';
    if (!v) return '<span class="muted">tetap</span>';
    const buruk = naikBuruk ? v > 0 : v < 0;
    return `<span class="${buruk ? 'up' : 'down'}">${v > 0 ? '▲ naik' : '▼ turun'} ${fmt(Math.abs(v))}${satuan}</span>`;
  }
  const sejakPrev = (R) => (R.prev ? ` sejak ${tgl(R.prev.waktu)}` : '');

  function tabelSort(id, cols, rows, st, opts = {}) {
    const s = [...rows].sort((a, b) => {
      const x = a[st.key], y = b[st.key];
      if (typeof x === 'number' || typeof y === 'number') return ((x ?? -Infinity) - (y ?? -Infinity)) * st.dir;
      return String(x ?? '').localeCompare(String(y ?? ''), 'id') * st.dir;
    });
    const head = cols.map((c) => `<th class="sort ${c.num ? 'num' : ''}" data-sort="${id}:${c.key}" aria-sort="${st.key === c.key ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}${st.key === c.key ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const body = s.map((r) => `<tr ${opts.rowGo ? go(opts.rowGo(r)) + ' class="click"' : ''}>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
    return `<div class="tbl-wrap"><table class="${opts.cls || ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${opts.foot || ''}</table></div>`;
  }

  // Elemen yang bisa diklik dibuat bisa dijangkau keyboard (Tab lalu Enter).
  function aksesibel(root) {
    root.querySelectorAll('[data-go]:not(a):not(button), [data-sort], [data-bsort]').forEach((el) => {
      if (el.hasAttribute('tabindex')) return;
      el.tabIndex = 0;
      el.setAttribute('role', el.matches('[data-sort],[data-bsort]') ? 'button' : 'link');
    });
  }

  // ---------- tampilan ----------
  function render(push = false) {
    const R = S.R;
    $('#tabs').hidden = !R;
    tandaiEkstensi();
    $('#pilih-rekap').hidden = !S.list.length;
    $('#pilih-rekap').innerHTML = S.list.map((r) => `<option value="${esc(r.id)}" ${R && r.id === R.id ? 'selected' : ''}>${esc(pendekKanwil(r.kanwil))} · ${waktuLabel(r.waktu)}</option>`).join('');
    const meta = $('#meta');
    meta.textContent = R ? `${R.filter || 'filter tidak diketahui'} · sumber ${R.sumber}` : 'Data dibaca dan disimpan di browser ini saja';
    meta.title = R ? `${R.kanwil} · ${R.filter} · diambil ${waktuLabel(R.waktu)} · sumber ${R.sumber}` : '';
    document.querySelectorAll('#tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === S.tab);
      b.setAttribute('aria-selected', b.dataset.tab === S.tab ? 'true' : 'false');
    });
    if (!R) { main.innerHTML = kosong(); animasiMasuk('kosong'); catat(push); return; }
    const f = { ringkasan, kantah: tabKantah, layanan: tabLayanan, posisi: tabPosisi, berkas: tabBerkas, riwayat: tabRiwayat }[S.tab] || ringkasan;
    f(R);
    aksesibel(main);
    animasiMasuk(S.tab + '|' + R.id);
    const on = $('#tabs .on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    catat(push);
  }
  // Animasi masuk hanya saat tab atau rekap berganti, bukan setiap kali filter atau urutan diubah.
  function animasiMasuk(kunci) {
    if (animasiMasuk.k === kunci) return;
    animasiMasuk.k = kunci;
    main.classList.remove('tampil');
    void main.offsetWidth;
    main.classList.add('tampil');
    if (gerakHemat.matches) return;
    main.querySelectorAll('.kpi .v').forEach((el) => {
      const m = el.childElementCount ? null : el.textContent.match(/^(\d{1,3}(?:\.\d{3})*)(\D*)$/);
      const target = m ? Number(m[1].replace(/\./g, '')) : 0;
      if (target < 10) return;
      const akhir = el.textContent, t0 = performance.now(), lama = 900;
      const langkah = (t) => {
        const x = Math.min(1, (t - t0) / lama);
        el.textContent = x < 1 ? fmt(Math.round(target * (1 - Math.pow(1 - x, 3)))) + m[2] : akhir;
        if (x < 1 && el.isConnected) requestAnimationFrame(langkah);
      };
      requestAnimationFrame(langkah);
    });
  }
  function gantiTema() {
    const root = document.documentElement;
    const gelap = root.dataset.theme ? root.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.add('ganti-tema');
    root.dataset.theme = gelap ? 'light' : 'dark';
    simpanPref('tema', root.dataset.theme);
    setTimeout(() => root.classList.remove('ganti-tema'), 500);
  }
  const pendekKanwil = (n) => String(n).replace(/^Kantor Wilayah (Provinsi )?/i, '');

  function kosong() {
    return `<div class="empty">
      <img class="empty-logo" src="logo.svg" alt="" width="88" height="88">
      <div class="empty-kicker">Selamat datang di Monitra</div>
      <h2>Belum ada rekap</h2>
      <p class="lead">Klik <b>Rekap Sekarang</b> untuk menjalankan ekstensi Rekap Tunggakan Kanwil, atau impor file Excel hasil tombol <b>Unduh Excel</b> pada ekstensi.</p>
      <p class="tombol-baris"><button class="btn primary" data-act="rekap-sekarang">Rekap Sekarang</button> <button class="btn" data-act="contoh">Coba dengan data contoh</button></p>
      <label class="dropzone">
        <input type="file" accept=".xlsx,.json" multiple hidden data-file>
        <svg class="dz-ikon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
        <div class="dz-judul">Klik untuk memilih file, atau seret file ke halaman ini</div>
        <div class="muted small">Format: Tunggakan_SPOPP_*.xlsx, atau file cadangan Monitra (.json). Bisa beberapa file sekaligus.</div>
      </label>
      <ol class="small">
        <li>Data hanya dibaca oleh browser Anda. Tidak ada yang diunggah ke server.</li>
        <li>Setiap rekap tersimpan di browser ini, sehingga rekap dari tanggal berbeda bisa dibandingkan.</li>
        <li>Untuk pindah komputer, buat cadangan di tab Riwayat lalu impor file cadangannya di komputer baru.</li>
        <li>Rekap Sekarang membuka dashboard Kinerja Kantor Pertanahan di tab baru (login dulu bila diminta), menjalankan rekap, lalu kembali ke sini dengan hasilnya.</li>
      </ol>
    </div>`;
  }

  function peringatan(R) {
    const items = [];
    R.kantahList.forEach((k) => {
      const rekap = k.m.prosesMelebihi ?? 0;
      const ambil = k.berkas.length;
      if (rekap !== ambil) items.push(`<b>${esc(pendek(k.nama))}</b>: angka rekap ${fmt(rekap)}, berkas detail ${fmt(ambil)} (selisih ${ambil > rekap ? '+' : ''}${fmt(ambil - rekap)})`);
      if (k.catatan) items.push(`<b>${esc(pendek(k.nama))}</b>: ${esc(k.catatan)}`);
    });
    R.layanan.filter((l) => l.catatan).forEach((l) => items.push(`<b>${esc(pendek(l.kantah))}</b> · ${esc(l.prosedur)}: ${esc(l.catatan)}`));
    let html = '';
    if (R.luar.length) {
      html += `<details class="alert"><summary><b>${fmt(R.luar.length)} berkas di luar hitungan dashboard</b> <span class="muted">— tidak dimasukkan ke angka di halaman ini supaya sama dengan dashboard.</span></summary>
        <p class="small">Daftar detail di dashboard diambil per nama layanan, sehingga ikut membawa berkas dengan nama layanan sama tetapi SPOPP berbeda. Angka rekap dashboard hanya menghitung satu versi SPOPP. Berkas ini tetap tertahan dan layak ditindaklanjuti.</p>
        <ul>${R.seleksi.map((x) => `<li><b>${esc(pendek(x.kantah))}</b> · ${esc(x.prosedur)}: rekap ${fmt(x.rekap)} = berkas SPOPP ${fmt(x.dihitung)} hari; ${fmt(x.keluar)} berkas SPOPP ${x.durasiLuar.map(fmt).join('/')} hari di luar hitungan</li>`).join('')}</ul>
        <p><a href="#" ${go({ tab: 'berkas', f: { hitung: 'luar' } })}>Lihat ${fmt(R.luar.length)} berkas ini di Daftar Berkas</a></p></details>`;
    }
    if (items.length) {
      html += `<details class="alert"><summary><b>${items.length} catatan data</b> <span class="muted">— jumlah berkas detail berbeda dari angka rekap. Bisa karena data berubah saat ekstensi berjalan atau ada layanan yang gagal diambil; rekap ulang untuk memastikan.</span></summary><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></details>`;
    }
    return html;
  }

  // Pengingat cadangan: muncul bila ada 3 rekap atau lebih dan belum dicadangkan 30 hari terakhir.
  function pengingatCadangan() {
    if (S.list.length < 3) return '';
    const terakhir = Date.parse(bacaPref('cadangan') || '') || 0;
    const tunda = Date.parse(bacaPref('cadanganTunda') || '') || 0;
    if (Date.now() - terakhir < 30 * 864e5 || Date.now() - tunda < 7 * 864e5) return '';
    return `<div class="alert info no-print"><b>${fmt(S.list.length)} rekap hanya tersimpan di browser ini.</b> ${terakhir ? `Cadangan terakhir ${tgl(new Date(terakhir).toISOString())}.` : 'Belum pernah dicadangkan.'} Bila data browser dibersihkan atau Anda pindah komputer, riwayat dan tren akan hilang.
      <div class="tombol-baris"><button class="btn primary" data-act="cadangkan">Cadangkan sekarang</button><button class="btn" data-act="tunda-cadangan">Ingatkan minggu depan</button></div></div>`;
  }

  // Berkas yang posisinya tidak berubah sejak rekap sebelumnya, paling lama di posisi itu dulu.
  function kartuMacet(R, list, f = {}) {
    if (!R.adaRiwayat) {
      return `<div class="card"><h3>Perlu didorong: berkas yang tidak bergerak</h3><p class="muted">Daftar ini muncul setelah ada dua rekap atau lebih dari kanwil dan filter yang sama. Rekap lagi di hari lain untuk melihat berkas yang posisinya tidak berubah.</p></div>`;
    }
    const macet = list.filter((b) => b.macet > 0).sort((a, b) => b.macet - a.macet || (b.telat ?? 0) - (a.telat ?? 0));
    const perPos = kelompok(macet, 'posisi').slice(0, 6).map((g) => ({ label: g.k, total: g.n, go: { tab: 'berkas', f: { ...f, macet: '1', posisi: g.k } } }));
    return `<div class="card">
      <div class="card-head"><h3>Perlu didorong: ${fmt(macet.length)} berkas tidak bergerak</h3><a href="#" class="small" ${go({ tab: 'berkas', f: { ...f, macet: '1' } })}>Lihat semua</a></div>
      <p class="muted small">Posisi berkas sama dengan rekap sebelumnya (${tgl(R.prev ? R.prev.waktu : '')}) atau lebih lama. Diurutkan dari yang paling lama tidak bergerak.</p>
      ${macet.length ? `<div class="grid g2 tight"><div>${hbars(perPos)}</div><div class="tbl-wrap"><table><thead><tr><th>Berkas</th><th>Posisi</th><th class="num">Tidak bergerak</th></tr></thead><tbody>
        ${macet.slice(0, 8).map((b) => `<tr><td>${esc(b.nomor)}<div class="muted small">${esc(pendek(b.kantah))} · ${esc(b.prosedur)}</div></td><td>${esc(b.posisi)}</td><td class="num">${pillMacet(b)}</td></tr>`).join('')}
        </tbody></table></div></div>` : '<p class="muted">Tidak ada. Semua berkas tunggakan berpindah posisi sejak rekap sebelumnya.</p>'}
    </div>`;
  }
  const pillMacet = (b) => (b.macet > 0 ? `<span class="pill warn" title="Posisi sama sejak rekap ${esc(waktuLabel(b.sejak))}">sejak ${tgl(b.sejak)}${b.macet > 1 ? ` · ${b.macet} rekap` : ''}</span>` : '');

  function ringkasan(R) {
    const B = R.berkas;
    const P = R.prev;
    const tot = (k) => R.kantahList.reduce((s, x) => s + (x.m[k] || 0), 0);
    const proses = tot('prosesSesuai') + tot('prosesMelebihi');
    const telat = B.map((b) => b.telat).filter((x) => x !== null);
    const lebih90 = B.filter((b) => b.telat > 90).length;
    const u = hitungUmur(B);
    const mdn = median(telat);

    const kantahRows = R.kantahList.map((k) => ({ label: pendek(k.nama), total: k.berkas.length, segs: hitungUmur(k.berkas), go: { tab: 'kantah', kantah: k.nama } }))
      .sort((a, b) => b.total - a.total);
    const lay = kelompok(B, 'prosedur').slice(0, 10).map((g) => ({ label: g.k, total: g.n, go: { tab: 'layanan', layanan: g.k } }));
    const pos = kelompok(B, 'posisi').slice(0, 10).map((g) => ({ label: g.k, total: g.n, go: { tab: 'berkas', f: { posisi: g.k } } }));

    const rows = R.kantahList.map((k) => {
      const pk = P && P.kantahMap.get(k.nama);
      return {
        nama: pendek(k.nama), full: k.nama, ...k.m,
        persen: (k.m.prosesSesuai || 0) + (k.m.prosesMelebihi || 0) ? k.m.prosesMelebihi / (k.m.prosesSesuai + k.m.prosesMelebihi) : null,
        berkas: k.berkas.length, ubah: P ? k.berkas.length - (pk ? pk.berkas.length : 0) : null, layanan: k.jmlLayanan,
        median: median(k.berkas.map((b) => b.telat)), lebih90: k.berkas.filter((b) => b.telat > 90).length,
        macet: k.berkas.filter((b) => b.macet > 0).length,
      };
    });
    const n = (v) => fmt(v);
    const cols = [
      { key: 'nama', label: 'Kantah' },
      { key: 'berkas', label: 'Berkas tunggakan', num: 1, fmt: n },
      ...(P ? [{ key: 'ubah', label: `Perubahan sejak ${tgl(P.waktu)}`, num: 1, fmt: (v) => beda(v) }] : []),
      { key: 'persen', label: '% melebihi', num: 1, fmt: (v) => (v === null ? '–' : pct(v, 1)) },
      { key: 'median', label: 'Median lewat jatuh tempo (hari)', num: 1, fmt: (v) => (v === null ? '–' : fmt(v)) },
      { key: 'lebih90', label: '> 90 hari', num: 1, fmt: n },
      ...(R.adaRiwayat ? [{ key: 'macet', label: 'Tidak bergerak', num: 1, fmt: n }] : []),
      { key: 'masuk', label: 'Masuk', num: 1, fmt: n },
      { key: 'prosesSesuai', label: 'Proses sesuai', num: 1, fmt: n },
      { key: 'prosesMelebihi', label: 'Proses melebihi', num: 1, fmt: n },
      { key: 'selesaiMelebihi', label: 'Selesai melebihi', num: 1, fmt: n },
      { key: 'layanan', label: 'Layanan', num: 1, fmt: n },
    ];
    const totMacet = B.filter((b) => b.macet > 0).length;
    const foot = `<tfoot><tr><td>Total</td><td class="num">${fmt(B.length)}</td>${P ? `<td class="num">${beda(B.length - P.berkas.length)}</td>` : ''}<td class="num">${pct(tot('prosesMelebihi'), proses)}</td><td class="num">${fmt(mdn)}</td><td class="num">${fmt(lebih90)}</td>${R.adaRiwayat ? `<td class="num">${fmt(totMacet)}</td>` : ''}<td class="num">${fmt(tot('masuk'))}</td><td class="num">${fmt(tot('prosesSesuai'))}</td><td class="num">${fmt(tot('prosesMelebihi'))}</td><td class="num">${fmt(tot('selesaiMelebihi'))}</td><td class="num">${fmt(R.layanan.length)}</td></tr></tfoot>`;
    const rekapDash = tot('prosesMelebihi');
    const pTelat = P ? median(P.berkas.map((b) => b.telat)) : null;

    main.innerHTML = `
      ${pengingatCadangan()}
      <div class="judul-baris">
        <div><h2>${esc(R.kanwil)}</h2><p class="lead">Rekap ${waktuLabel(R.waktu)} · ${esc(R.filter || 'filter tidak diketahui')}${P ? ` · dibandingkan dengan rekap ${waktuLabel(P.waktu)}` : ''}</p></div>
        <div class="tombol-baris no-print"><button class="btn" data-act="salin-kanwil">Salin ringkasan WhatsApp</button><button class="btn" data-act="laporan-kantah">Unduh laporan semua kantah</button></div>
      </div>
      ${peringatan(R)}
      <div class="kpis">
        ${kpi(fmt(B.length), 'Berkas tunggakan', rekapDash !== B.length ? `<span class="warn-t">angka rekap dashboard: ${fmt(rekapDash)}</span>` : '', P ? beda(B.length - P.berkas.length) + sejakPrev(R) : '')}
        ${kpi(pct(tot('prosesMelebihi'), proses), 'Berkas proses yang melebihi SPOPP', `dari ${fmt(proses)} berkas dalam proses`)}
        ${kpi(telat.length ? fmt(mdn) + ' hari' : '–', 'Median lewat jatuh tempo', telat.length ? `nilai tengah; terlama ${fmt(maks(telat))} hari` : '', P && pTelat !== null && mdn !== null ? beda(mdn - pTelat, { satuan: ' hari' }) : '')}
        ${kpi(fmt(lebih90), 'Lewat lebih dari 90 hari', `${pct(lebih90, B.length)} dari berkas tunggakan`, P ? beda(lebih90 - P.berkas.filter((b) => b.telat > 90).length) : '')}
        ${R.adaRiwayat ? kpi(fmt(totMacet), 'Tidak bergerak sejak rekap lalu', `${pct(totMacet, B.length)} dari berkas tunggakan`) : kpi(fmt(R.layanan.length), 'Layanan bertunggakan', `${fmt(kelompok(B, 'prosedur').length)} jenis layanan di ${fmt(R.kantahList.length)} kantah`)}
      </div>
      ${kartuMacet(R, B)}
      <div class="card">
        <div class="card-head"><h3>Berkas tunggakan per kantah, menurut lama lewat jatuh tempo</h3><span class="muted small">Klik nama atau bar kantah untuk detail</span></div>
        ${legendUmur()}
        ${hbars(kantahRows, { stacked: true })}
      </div>
      <div class="card">
        <div class="card-head"><h3>Rekap per kantah</h3><span class="muted small">Klik judul kolom untuk mengurutkan, klik baris untuk detail kantah</span></div>
        ${tabelSort('ks', cols, rows, S.ksort || (S.ksort = { key: 'berkas', dir: -1 }), { rowGo: (r) => ({ tab: 'kantah', kantah: r.full }), foot, cls: 'stick-col' })}
      </div>
      <div class="grid g2">
        <div class="card"><h3>Sebaran lama lewat jatuh tempo</h3>${kolomUmur(u)}
          <p class="muted small">Dihitung dari jatuh tempo sampai tanggal rekap (${tgl(R.ref)}).</p></div>
        <div class="card"><div class="card-head"><h3>Tunggakan per tahun</h3><span class="muted small">menurut tahun Tanggal Mulai</span></div>${hbars(perTahun(B))}</div>
        <div class="card"><div class="card-head"><h3>10 layanan dengan tunggakan terbanyak</h3></div>${hbars(lay)}</div>
        <div class="card"><div class="card-head"><h3>10 posisi berkas terbanyak</h3><span class="muted small">Berkas sedang tertahan di jabatan ini</span></div>${hbars(pos)}</div>
      </div>
      <details class="card lipat">
        <summary><h3>Tunggakan per kantah dan tahun</h3><span class="muted small">Klik untuk membuka</span></summary>
        ${tabelTahun([...R.kantahList].sort((a, b) => b.berkas.length - a.berkas.length).map((k) => ({ label: pendek(k.nama), list: k.berkas, f: { kantah: k.nama } })), B)}
        <p class="muted small">${CATATAN_TAHUN}</p>
      </details>`;
  }

  function tabKantah(R) {
    if (!S.kantah || !R.kantahMap.has(S.kantah)) S.kantah = [...R.kantahList].sort((a, b) => b.berkas.length - a.berkas.length)[0].nama;
    const k = R.kantahMap.get(S.kantah);
    const pk = R.prev && R.prev.kantahMap.get(k.nama);
    const B = k.berkas;
    const m = k.m || {};
    const proses = (m.prosesSesuai || 0) + (m.prosesMelebihi || 0);
    const telat = B.map((b) => b.telat).filter((x) => x !== null);
    const lebih90 = B.filter((b) => b.telat > 90).length;
    const macet = B.filter((b) => b.macet > 0).length;
    const layRekap = new Map(R.layanan.filter((l) => l.kantah === k.nama).map((l) => [l.prosedur, l]));
    const lay = kelompok(B, 'prosedur').map((g) => ({
      prosedur: g.k, rekap: layRekap.get(g.k) ? layRekap.get(g.k).m.prosesMelebihi : null, berkas: g.n,
      median: median(g.v.map((b) => b.telat)), maks: maks(g.v.map((b) => b.telat ?? 0)), lebih90: g.v.filter((b) => b.telat > 90).length, umur: hitungUmur(g.v),
    }));
    const pos = kelompok(B, 'posisi').slice(0, 12).map((g) => ({ label: g.k, total: g.n, go: { tab: 'berkas', f: { kantah: k.nama, posisi: g.k } } }));
    const terlama = [...B].sort((a, b) => (b.telat ?? 0) - (a.telat ?? 0)).slice(0, 20);
    const mini = (u) => {
      const t = u.reduce((a, b) => a + b, 0) || 1;
      return `<div style="display:flex;gap:2px;height:10px;min-width:120px">${u.map((n, i) => (n ? `<div style="width:${n / t * 100}%;background:${warnaUmur(i)}" data-tip="${UMUR[i].label}: ${fmt(n)}"></div>` : '')).join('')}</div>`;
    };
    const n = (v) => (v === null || v === undefined ? '–' : fmt(v));
    const urut = [...R.kantahList].sort((a, b) => a.nama.localeCompare(b.nama));
    const idx = urut.findIndex((x) => x.nama === k.nama);

    main.innerHTML = `
      <div class="filters no-print">
        <button class="btn" ${go({ tab: 'kantah', kantah: urut[(idx - 1 + urut.length) % urut.length].nama })} aria-label="Kantah sebelumnya">‹</button>
        <select data-pilih="kantah" aria-label="Pilih kantah">${urut.map((x) => `<option ${x.nama === k.nama ? 'selected' : ''} value="${esc(x.nama)}">${esc(pendek(x.nama))} (${fmt(x.berkas.length)})</option>`).join('')}</select>
        <button class="btn" ${go({ tab: 'kantah', kantah: urut[(idx + 1) % urut.length].nama })} aria-label="Kantah berikutnya">›</button>
        <button class="btn" ${go({ tab: 'berkas', f: { kantah: k.nama } })}>Lihat semua berkas</button>
        <button class="btn" data-act="salin-kantah">Salin ringkasan WhatsApp</button>
        <button class="btn" data-act="unduh-kantah">Unduh Excel kantah ini</button>
        <button class="btn" data-act="cetak">Cetak</button>
      </div>
      <h2>${esc(k.nama)}</h2>
      <p class="lead">${esc(R.kanwil)} · rekap ${waktuLabel(R.waktu)}${R.prev ? ` · dibandingkan dengan rekap ${waktuLabel(R.prev.waktu)}` : ''}</p>
      <div class="kpis">
        ${kpi(fmt(B.length), 'Berkas tunggakan', m.prosesMelebihi !== B.length ? `<span class="warn-t">angka rekap: ${n(m.prosesMelebihi)}</span>` : '', R.prev ? beda(B.length - (pk ? pk.berkas.length : 0)) + sejakPrev(R) : '')}
        ${kpi(pct(m.prosesMelebihi || 0, proses), 'Berkas proses yang melebihi SPOPP', `dari ${fmt(proses)} berkas dalam proses`)}
        ${kpi(telat.length ? fmt(median(telat)) + ' hari' : '–', 'Median lewat jatuh tempo', telat.length ? `nilai tengah; terlama ${fmt(maks(telat))} hari` : '')}
        ${kpi(fmt(lebih90), 'Lewat lebih dari 90 hari', pct(lebih90, B.length))}
        ${R.adaRiwayat ? kpi(fmt(macet), 'Tidak bergerak sejak rekap lalu', pct(macet, B.length)) : kpi(fmt(lay.length), 'Layanan bertunggakan', '')}
      </div>
      ${kartuMacet(R, B, { kantah: k.nama })}
      <div class="card">
        <h3>Angka dashboard Kinerja Kantor Pertanahan</h3>
        <div class="tbl-wrap"><table><thead><tr>${D.METRIK.map(([, l]) => `<th class="num">${l.replace('Berkas ', '')}</th>`).join('')}</tr></thead>
        <tbody><tr>${D.METRIK.map(([key]) => `<td class="num">${n(m[key])}</td>`).join('')}</tr></tbody></table></div>
      </div>
      <div class="grid g2">
        <div class="card"><h3>Sebaran lama lewat jatuh tempo</h3>${kolomUmur(hitungUmur(B))}</div>
        <div class="card"><div class="card-head"><h3>Posisi berkas</h3><span class="muted small">Klik untuk daftar berkasnya</span></div>${hbars(pos)}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Layanan bertunggakan</h3>${legendUmur()}</div>
        ${tabelSort('lk', [
          { key: 'prosedur', label: 'Layanan' },
          { key: 'rekap', label: 'Rekap', num: 1, fmt: n },
          { key: 'berkas', label: 'Berkas', num: 1, fmt: n },
          { key: 'median', label: 'Median telat', num: 1, fmt: n },
          { key: 'maks', label: 'Terlama', num: 1, fmt: n },
          { key: 'lebih90', label: '> 90 hari', num: 1, fmt: n },
          { key: 'umur', label: 'Umur', fmt: mini },
        ], lay, S.lksort || (S.lksort = { key: 'berkas', dir: -1 }), { rowGo: (r) => ({ tab: 'berkas', f: { kantah: k.nama, prosedur: r.prosedur } }) })}
      </div>
      <details class="card lipat">
        <summary><h3>Layanan bertunggakan per tahun</h3><span class="muted small">Klik untuk membuka</span></summary>
        ${tabelTahun(kelompok(B, 'prosedur').map((g) => ({ label: g.k, list: g.v, f: { kantah: k.nama, prosedur: g.k } })), B)}
        <p class="muted small">${CATATAN_TAHUN}</p>
      </details>
      <div class="card">
        <h3>20 berkas paling lama lewat jatuh tempo</h3>
        ${tabelBerkas(terlama, false)}
      </div>`;
  }

  const pillTelat = (b) => (b.telat === null ? '' : `<span class="pill ${b.telat > 365 ? 'crit' : b.telat > 90 ? 'warn' : ''}">${fmt(b.telat)}</span>`);
  const pillLuar = (b) => (b.luar ? ' <span class="pill warn" title="Tidak dihitung di angka rekap dashboard (SPOPP berbeda)">di luar hitungan</span>' : '');
  const nomorSalin = (b) => `<button type="button" class="salin" data-salin="${esc(b.nomor)}" title="Klik untuk menyalin nomor berkas">${esc(b.nomor)}</button>`;
  const KOLOM_BERKAS = [['kantah', 'Kantah'], ['prosedur', 'Layanan'], ['nomor', 'No. berkas'], ['thn', 'Tahun tunggakan', 1], ['posisi', 'Posisi berkas'], ['mulai', 'Mulai', 1], ['durasi', 'SPOPP (hari)', 1], ['jatuhTempo', 'Jatuh tempo', 1], ['telat', 'Lewat (hari)', 1]];

  function tabelBerkas(list, denganKantah = true, head, gulir = false) {
    const cols = KOLOM_BERKAS.filter(([k]) => denganKantah || k !== 'kantah');
    return `<div class="tbl-wrap${gulir ? ' tbl-scroll' : ''}"><table class="stick-col"><thead><tr>${head || cols.map(([, l, num]) => `<th class="${num ? 'num' : ''}">${l}</th>`).join('')}</tr></thead><tbody>
      ${list.map((b) => `<tr>${denganKantah ? `<td>${esc(pendek(b.kantah))}</td>` : ''}<td>${esc(b.prosedur)}</td><td>${nomorSalin(b)}${pillLuar(b)}</td><td class="num" title="Tahun berkas: ${esc(b.tahun)}">${esc(b.thn ?? '')}</td>
        <td>${esc(b.posisi)}${b.macet > 0 ? `<div>${pillMacet(b)}</div>` : ''}</td><td class="num">${tgl(b.mulai)}</td><td class="num">${b.durasi === '' ? '' : fmt(b.durasi)}</td><td class="num">${tgl(b.jatuhTempo)}</td>
        <td class="num">${pillTelat(b)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  // Tampilan kartu untuk layar HP: satu kartu per berkas.
  function kartuBerkas(list) {
    if (!list.length) return '<p class="muted">Tidak ada berkas yang cocok dengan filter.</p>';
    return `<div class="kartu-list">${list.map((b) => `<div class="kartu-berkas">
      <div class="kb-top">${nomorSalin(b)}${pillLuar(b)}<span class="kb-telat">${pillTelat(b)}<span class="muted small"> hari</span></span></div>
      <div>${esc(b.prosedur)}</div>
      <div class="muted small">${esc(pendek(b.kantah))} · ${esc(b.posisi)}</div>
      ${b.macet > 0 ? `<div>${pillMacet(b)}</div>` : ''}
      <div class="muted small">Mulai ${tgl(b.mulai)} · SPOPP ${b.durasi === '' ? '–' : fmt(b.durasi)} hari · jatuh tempo ${tgl(b.jatuhTempo)}</div>
    </div>`).join('')}</div>`;
  }

  function tabLayanan(R) {
    const grup = kelompok(R.berkas, 'prosedur');
    if (!S.layanan || !grup.some((g) => g.k === S.layanan)) S.layanan = grup[0] && grup[0].k;
    const sel = grup.find((g) => g.k === S.layanan);
    const semua = grup.map((g) => ({
      prosedur: g.k, kantah: new Set(g.v.map((b) => b.kantah)).size, berkas: g.n,
      median: median(g.v.map((b) => b.telat)), lebih90: g.v.filter((b) => b.telat > 90).length,
      spopp: median(g.v.map((b) => (b.durasi === '' ? null : b.durasi))),
    }));
    const n = (v) => (v === null || v === undefined ? '–' : fmt(v));
    let detail = '';
    if (sel) {
      const rek = new Map(R.layanan.filter((l) => l.prosedur === sel.k).map((l) => [l.kantah, l]));
      const per = R.kantahList.map((k) => {
        const v = sel.v.filter((b) => b.kantah === k.nama);
        const l = rek.get(k.nama);
        const m = l ? l.m : {};
        return {
          nama: pendek(k.nama), full: k.nama, masuk: m.masuk ?? null, prosesSesuai: m.prosesSesuai ?? null, prosesMelebihi: m.prosesMelebihi ?? null,
          selesaiSesuai: m.selesaiSesuai ?? null, selesaiMelebihi: m.selesaiMelebihi ?? null,
          tepat: m.selesaiSesuai + m.selesaiMelebihi ? m.selesaiSesuai / (m.selesaiSesuai + m.selesaiMelebihi) : null,
          berkas: v.length, median: median(v.map((b) => b.telat)),
        };
      }).filter((r) => r.berkas || r.prosesMelebihi);
      const pos = kelompok(sel.v, 'posisi').slice(0, 10).map((g) => ({ label: g.k, total: g.n, go: { tab: 'berkas', f: { prosedur: sel.k, posisi: g.k } } }));
      detail = `
        <div class="filters no-print"><select data-pilih="layanan" aria-label="Pilih layanan">${grup.map((g) => g.k).sort((a, b) => a.localeCompare(b, 'id')).map((l) => `<option ${l === sel.k ? 'selected' : ''} value="${esc(l)}">${esc(l)}</option>`).join('')}</select>
          <button class="btn" ${go({ tab: 'berkas', f: { prosedur: sel.k } })}>Lihat semua berkas layanan ini</button></div>
        <h2>${esc(sel.k)}</h2>
        <p class="lead">${fmt(sel.n)} berkas tunggakan di ${fmt(per.length)} kantah. Angka masuk sampai selesai hanya tersedia untuk kantah yang layanan ini bertunggakan.</p>
        <div class="grid g2">
          <div class="card"><h3>Berkas tunggakan per kantah</h3>${legendUmur()}${hbars(R.kantahList.map((k) => {
            const v = sel.v.filter((b) => b.kantah === k.nama);
            return { label: pendek(k.nama), total: v.length, segs: hitungUmur(v), go: { tab: 'berkas', f: { kantah: k.nama, prosedur: sel.k } } };
          }).filter((r) => r.total).sort((a, b) => b.total - a.total), { stacked: true })}</div>
          <div class="card"><h3>Posisi berkas</h3>${hbars(pos)}</div>
        </div>
        <div class="card"><h3>Perbandingan antar kantah</h3>
          ${tabelSort('lp', [
            { key: 'nama', label: 'Kantah' },
            { key: 'masuk', label: 'Masuk', num: 1, fmt: n },
            { key: 'prosesSesuai', label: 'Proses sesuai', num: 1, fmt: n },
            { key: 'prosesMelebihi', label: 'Proses melebihi', num: 1, fmt: n },
            { key: 'selesaiSesuai', label: 'Selesai sesuai', num: 1, fmt: n },
            { key: 'selesaiMelebihi', label: 'Selesai melebihi', num: 1, fmt: n },
            { key: 'tepat', label: '% selesai tepat waktu', num: 1, fmt: (v) => (v === null ? '–' : pct(v, 1)) },
            { key: 'berkas', label: 'Berkas detail', num: 1, fmt: n },
            { key: 'median', label: 'Median telat', num: 1, fmt: n },
          ], per, S.lpsort || (S.lpsort = { key: 'berkas', dir: -1 }), { rowGo: (r) => ({ tab: 'berkas', f: { kantah: r.full, prosedur: sel.k } }), cls: 'stick-col' })}
        </div>
        <details class="card lipat">
          <summary><h3>Per kantah dan tahun tunggakan</h3><span class="muted small">Klik untuk membuka</span></summary>
          ${tabelTahun(R.kantahList.map((k) => ({ label: pendek(k.nama), list: sel.v.filter((b) => b.kantah === k.nama), f: { kantah: k.nama, prosedur: sel.k } })).filter((r) => r.list.length).sort((a, b) => b.list.length - a.list.length), sel.v)}
        </details>`;
    }
    main.innerHTML = `${detail}
      <div class="card">
        <div class="card-head"><h3>Semua layanan bertunggakan</h3><span class="muted small">Klik baris untuk memilih layanan</span></div>
        ${tabelSort('la', [
          { key: 'prosedur', label: 'Layanan', fmt: (v) => (v === S.layanan ? `<b>${esc(v)}</b>` : esc(v)) },
          { key: 'spopp', label: 'SPOPP (hari)', num: 1, fmt: n },
          { key: 'kantah', label: 'Kantah', num: 1, fmt: n },
          { key: 'berkas', label: 'Berkas', num: 1, fmt: n },
          { key: 'median', label: 'Median telat', num: 1, fmt: n },
          { key: 'lebih90', label: '> 90 hari', num: 1, fmt: n },
        ], semua, S.lasort || (S.lasort = { key: 'berkas', dir: -1 }), { rowGo: (r) => ({ tab: 'layanan', layanan: r.prosedur }) })}
      </div>`;
  }

  function tabPosisi(R) {
    const B = S.posisiLayanan ? R.berkas.filter((b) => b.prosedur === S.posisiLayanan) : R.berkas;
    const kantah = R.kantahList.filter((k) => B.some((b) => b.kantah === k.nama)).sort((a, b) => b.berkas.length - a.berkas.length);
    const pos = kelompok(B, 'posisi');
    const sel = new Map();
    B.forEach((b) => { const key = b.posisi + '|' + b.kantah; sel.set(key, (sel.get(key) || 0) + 1); });
    const mx = Math.max(1, ...sel.values());
    const cell = (p, k) => {
      const v = sel.get(p + '|' + k.nama) || 0;
      if (!v) return '<td class="h"></td>';
      const t = Math.round(12 + (v / mx) * 88);
      return `<td class="h" style="background:color-mix(in srgb, var(--bar) ${t}%, var(--heat-0));color:${t > 55 ? 'var(--on-bar)' : 'inherit'};cursor:pointer" ${go({ tab: 'berkas', f: { kantah: k.nama, posisi: p, prosedur: S.posisiLayanan } })} data-tip="${esc(p)} · ${esc(pendek(k.nama))}: ${fmt(v)} berkas" aria-label="${esc(p)} di ${esc(pendek(k.nama))}: ${fmt(v)} berkas">${fmt(v)}</td>`;
    };
    const layOps = kelompok(R.berkas, 'prosedur').map((g) => g.k).sort((a, b) => a.localeCompare(b, 'id'));
    main.innerHTML = `
      <h2>Di meja siapa berkas tertahan</h2>
      <p class="lead">Jumlah berkas tunggakan menurut posisi berkas digital dan kantah. Warna lebih gelap berarti lebih banyak. Klik sel untuk daftar berkasnya.</p>
      <div class="filters"><select data-pilih="posisiLayanan" aria-label="Saring layanan"><option value="">Semua layanan</option>${layOps.map((l) => `<option ${l === S.posisiLayanan ? 'selected' : ''} value="${esc(l)}">${esc(l)}</option>`).join('')}</select>
        <span class="muted small">${fmt(B.length)} berkas, ${fmt(pos.length)} posisi</span></div>
      <div class="card"><div class="tbl-wrap"><table class="heat stick-col">
        <thead><tr><th>Posisi berkas</th>${kantah.map((k) => `<th class="num">${esc(pendek(k.nama))}</th>`).join('')}<th class="num">Total</th></tr></thead>
        <tbody>${pos.map((p) => `<tr><td>${esc(p.k)}</td>${kantah.map((k) => cell(p.k, k)).join('')}<td class="num"><b>${fmt(p.n)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>${kantah.map((k) => `<td class="num">${fmt(B.filter((b) => b.kantah === k.nama).length)}</td>`).join('')}<td class="num">${fmt(B.length)}</td></tr></tfoot>
      </table></div></div>`;
  }

  // ---------- daftar berkas ----------
  const dasarBerkas = (R) => (S.f.hitung === 'luar' ? R.luar : S.f.hitung === 'semua' ? R.semua : R.berkas);
  function saringBerkas(R) {
    const f = S.f;
    const q = f.q.trim().toLowerCase();
    return dasarBerkas(R).filter((b) => (!f.kantah || b.kantah === f.kantah) && (!f.prosedur || b.prosedur === f.prosedur) && (!f.posisi || b.posisi === f.posisi)
      && (!f.tahun || String(b.tahun) === f.tahun) && (!f.thn || String(b.thn ?? '') === f.thn) && (f.umur === '' || String(b.umur) === f.umur)
      && (!f.macet || b.macet > 0)
      && (!q || b.nomor.toLowerCase().includes(q) || b.prosedur.toLowerCase().includes(q) || b.posisi.toLowerCase().includes(q) || b.kantah.toLowerCase().includes(q)));
  }
  const LABEL_F = {
    q: (v) => `Cari "${v}"`,
    kantah: pendek,
    prosedur: (v) => v,
    posisi: (v) => v,
    thn: (v) => (v && v !== 'null' ? 'Tahun tunggakan ' + v : 'Tanpa tanggal mulai'),
    tahun: (v) => 'Tahun berkas ' + v,
    umur: (v) => 'Lewat ' + (UMUR[Number(v)] ? UMUR[Number(v)].label : v),
    hitung: (v) => (v === 'luar' ? 'Di luar hitungan dashboard' : 'Semua berkas detail'),
    macet: () => 'Tidak bergerak sejak rekap lalu',
  };
  const jumlahFilter = () => Object.entries(S.f).filter(([k, v]) => v && k !== 'q').length;
  function tabBerkas(R) {
    const ops = (key, label, fmtLbl = (x) => x) => {
      const vals = [...new Set(R.semua.map((b) => String(b[key])))].sort((a, b) => (key === 'tahun' || key === 'thn' ? b.localeCompare(a) : a.localeCompare(b, 'id')));
      return `<select data-f="${key}" aria-label="${esc(label)}"><option value="">${label}</option>${vals.map((v) => `<option ${S.f[key] === v ? 'selected' : ''} value="${esc(v)}">${esc(fmtLbl(v))}</option>`).join('')}</select>`;
    };
    main.innerHTML = `
      <div class="filters">
        <input type="search" id="cari-berkas" data-f="q" placeholder="Cari nomor, layanan, posisi, kantah…" value="${esc(S.f.q)}" aria-label="Cari berkas">
        <button class="btn hanya-hp" data-act="buka-filter" aria-expanded="${S.filterBuka}">Filter</button>
        <div class="filter-isi${S.filterBuka ? ' buka' : ''}">
          ${ops('kantah', 'Semua kantah', pendek)}
          ${ops('prosedur', 'Semua layanan')}
          ${ops('posisi', 'Semua posisi')}
          ${ops('thn', 'Semua tahun tunggakan', LABEL_F.thn)}
          ${ops('tahun', 'Semua tahun berkas', LABEL_F.tahun)}
          <select data-f="umur" aria-label="Lama lewat jatuh tempo"><option value="">Semua lama lewat</option>${UMUR.map((u, i) => `<option ${S.f.umur === String(i) ? 'selected' : ''} value="${i}">Lewat ${u.label}</option>`).join('')}</select>
          ${R.adaRiwayat ? `<select data-f="macet" aria-label="Pergerakan berkas"><option value="">Semua pergerakan</option><option value="1" ${S.f.macet ? 'selected' : ''}>Tidak bergerak sejak rekap lalu</option></select>` : ''}
          ${R.luar.length ? `<select data-f="hitung" aria-label="Hitungan dashboard"><option value="">Dihitung dashboard</option><option value="luar" ${S.f.hitung === 'luar' ? 'selected' : ''}>Di luar hitungan dashboard (${fmt(R.luar.length)})</option><option value="semua" ${S.f.hitung === 'semua' ? 'selected' : ''}>Semua berkas detail</option></select>` : ''}
        </div>
        <button class="btn" data-act="reset">Hapus filter</button>
        <button class="btn" data-act="unduh-berkas">Unduh Excel</button>
      </div>
      <div id="berkas-tbl"></div>`;
    isiTabelBerkas(R);
  }
  function isiTabelBerkas(R) {
    const list = saringBerkas(R);
    const st = S.sort;
    list.sort((a, b) => {
      const x = a[st.key], y = b[st.key];
      if (typeof x === 'number' || typeof y === 'number') return ((x ?? -Infinity) - (y ?? -Infinity)) * st.dir;
      return String(x ?? '').localeCompare(String(y ?? ''), 'id', { numeric: true }) * st.dir;
    });
    const per = S.perHal;
    const hal = Math.max(1, Math.ceil(list.length / per));
    S.page = Math.min(S.page, hal - 1);
    const slice = list.slice(S.page * per, S.page * per + per);
    const head = KOLOM_BERKAS.map(([k, l, num]) => `<th class="sort ${num ? 'num' : ''}" data-bsort="${k}" aria-sort="${st.key === k ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${st.key === k ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const nf = jumlahFilter();
    const tb = $('[data-act="buka-filter"]');
    if (tb) tb.textContent = nf ? `Filter (${nf})` : 'Filter';
    const chips = Object.entries(S.f).filter(([, v]) => v).map(([k, v]) => `<span class="chip">${esc(LABEL_F[k](v))}<button type="button" data-lepas="${k}" aria-label="Hapus filter ${esc(LABEL_F[k](v))}">×</button></span>`).join('');
    $('#berkas-tbl').innerHTML = `
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      <p class="muted small" aria-live="polite">${fmt(list.length)} dari ${fmt(dasarBerkas(R).length)} berkas${S.f.hitung === 'luar' ? ' di luar hitungan dashboard' : ''} · median lewat jatuh tempo ${list.length ? fmt(median(list.map((b) => b.telat))) : '–'} hari</p>
      ${hp.matches ? kartuBerkas(slice) : `<div class="card tbl-card">${tabelBerkas(slice, true, head, true)}</div>`}
      <div class="pager">
        <label class="muted small">Baris per halaman <select data-perhal>${[50, 100, 500].map((x) => `<option ${x === per ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <button class="btn" data-page="-1" ${S.page ? '' : 'disabled'}>‹ Sebelumnya</button>
        <select data-hal aria-label="Pilih halaman">${Array.from({ length: hal }, (_, i) => `<option value="${i}" ${i === S.page ? 'selected' : ''}>Halaman ${i + 1} dari ${hal}</option>`).join('')}</select>
        <button class="btn" data-page="1" ${S.page < hal - 1 ? '' : 'disabled'}>Berikutnya ›</button></div>`;
    aksesibel($('#berkas-tbl'));
  }

  // ---------- riwayat & perbandingan ----------
  // Grafik garis jumlah berkas tunggakan dari rekap ke rekap. titik: [{ waktu, n }]
  function grafikTren(titik) {
    const W = Math.max(300, Math.min(1200, main.clientWidth - 64)), H = 220, L = 48, Rr = 20, T = 20, Bm = 36;
    const mx = Math.max(1, ...titik.map((t) => t.n));
    const langkah = Math.pow(10, Math.floor(Math.log10(mx)));
    const atas = Math.ceil(mx / langkah) * langkah;
    const x = (i) => L + (titik.length === 1 ? (W - L - Rr) / 2 : i * (W - L - Rr) / (titik.length - 1));
    const y = (v) => T + (H - T - Bm) * (1 - v / atas);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${L}" x2="${W - Rr}" y1="${y(atas * f)}" y2="${y(atas * f)}" class="grid-l"/><text x="${L - 6}" y="${y(atas * f) + 4}" text-anchor="end" class="ax">${fmt(atas * f)}</text>`).join('');
    const tiap = Math.max(1, Math.ceil(titik.length / 8));
    const label = titik.map((t, i) => (i % tiap === 0 || i === titik.length - 1 ? `<text x="${x(i)}" y="${H - Bm + 18}" text-anchor="${titik.length > 1 && i === 0 ? 'start' : titik.length > 1 && i === titik.length - 1 ? 'end' : 'middle'}" class="ax">${tgl(t.waktu).slice(0, 5)}</text>` : '')).join('');
    const d = titik.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t.n).toFixed(1)}`).join(' ');
    const area = titik.length > 1 ? `<path d="${d} L${x(titik.length - 1)},${y(0)} L${x(0)},${y(0)} Z" class="area"/>` : '';
    const dots = titik.map((t, i) => `<circle cx="${x(i)}" cy="${y(t.n)}" r="${i === titik.length - 1 ? 5 : 3.5}" class="dot" data-tip="${waktuLabel(t.waktu)}: ${fmt(t.n)} berkas"><title>${waktuLabel(t.waktu)}: ${fmt(t.n)} berkas</title></circle>`).join('');
    const akhir = titik[titik.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" class="tren" role="img" aria-label="Tren berkas tunggakan, terakhir ${fmt(akhir.n)} berkas">${grid}${area}<path d="${d}" class="garis" pathLength="1"/>${dots}${label}
      <text x="${x(titik.length - 1)}" y="${y(akhir.n) - 10}" text-anchor="end" class="ax kuat">${fmt(akhir.n)}</text></svg>`;
  }

  function tabRiwayat(R) {
    const n = (v) => fmt(v);
    const sama = sejenis(R).slice().sort((a, b) => a.waktu.localeCompare(b.waktu));
    const kanwilSama = S.list.filter((r) => r.kanwil === R.kanwil);
    if (!S.cmp || !kanwilSama.some((r) => r.id === S.cmp.a) || !kanwilSama.some((r) => r.id === S.cmp.b)) {
      S.cmp = sama.length >= 2 ? { a: sama[sama.length - 2].id, b: sama[sama.length - 1].id } : null;
    }
    let cmp = `<p class="muted">Impor atau rekap lagi untuk kanwil dan filter yang sama di tanggal berbeda untuk melihat perubahan: berkas yang baru menunggak dan berkas yang sudah tidak ada di daftar.</p>`;
    if (S.cmp) {
      const ra = kanwilSama.find((r) => r.id === S.cmp.a), rb = kanwilSama.find((r) => r.id === S.cmp.b);
      const A = turun(ra), Bk = turun(rb);
      // Dicocokkan dengan semua berkas detail, supaya berkas yang hanya berpindah status hitungan tidak terhitung baru atau keluar.
      const ka = new Map(A.semua.map((b) => [kunciBerkas(b), b]));
      const kb = new Map(Bk.semua.map((b) => [kunciBerkas(b), b]));
      const baru = Bk.berkas.filter((b) => !ka.has(kunciBerkas(b)));
      const hilang = A.berkas.filter((b) => !kb.has(kunciBerkas(b)));
      const pindah = Bk.semua.filter((b) => ka.has(kunciBerkas(b)) && !!ka.get(kunciBerkas(b)).luar !== !!b.luar);
      S.cmpHasil = { baru, hilang, pindah, A, B: Bk };
      const nama = [...new Set([...A.kantahList, ...Bk.kantahList].map((k) => k.nama))];
      const rows = nama.map((k) => {
        const x = A.kantahMap.get(k), y = Bk.kantahMap.get(k);
        const a = x ? x.berkas.length : 0, b = y ? y.berkas.length : 0;
        return { nama: pendek(k), a, b, d: b - a, baru: baru.filter((z) => z.kantah === k).length, hilang: hilang.filter((z) => z.kantah === k).length };
      });
      const opt = (sel) => kanwilSama.map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${waktuLabel(r.waktu)} · ${esc(r.filter)}</option>`).join('');
      const delta = (v) => (v > 0 ? `<span class="up">+${fmt(v)}</span>` : v < 0 ? `<span class="down">${fmt(v)}</span>` : '0');
      cmp = `
        <div class="filters"><span>Bandingkan</span><select data-cmp="a" aria-label="Rekap lama">${opt(S.cmp.a)}</select><span>dengan</span><select data-cmp="b" aria-label="Rekap baru">${opt(S.cmp.b)}</select></div>
        ${A.filter !== Bk.filter ? `<div class="alert"><b>Filter kedua rekap berbeda</b> (${esc(A.filter)} dan ${esc(Bk.filter)}). Berkas baru dan keluar di bawah sebagian besar karena beda filter, bukan karena berkas selesai.</div>` : ''}
        <div class="kpis">
          ${kpi(delta(Bk.berkas.length - A.berkas.length), 'Perubahan jumlah berkas tunggakan', `${fmt(A.berkas.length)} → ${fmt(Bk.berkas.length)}`)}
          ${kpi(fmt(baru.length), 'Berkas baru menunggak', 'ada di rekap baru, tidak ada di rekap lama')}
          ${kpi(fmt(hilang.length), 'Berkas keluar dari daftar', 'kemungkinan sudah selesai atau keluar dari filter')}
          ${pindah.length ? kpi(fmt(pindah.length), 'Berpindah status hitungan', 'berkas sama, masuk atau keluar hitungan dashboard') : ''}
        </div>
        ${tabelSort('cp', [
          { key: 'nama', label: 'Kantah' },
          { key: 'a', label: 'Rekap lama', num: 1, fmt: n },
          { key: 'b', label: 'Rekap baru', num: 1, fmt: n },
          { key: 'd', label: 'Selisih', num: 1, fmt: delta },
          { key: 'baru', label: 'Baru menunggak', num: 1, fmt: n },
          { key: 'hilang', label: 'Keluar dari daftar', num: 1, fmt: n },
        ], rows, S.cpsort || (S.cpsort = { key: 'd', dir: -1 }), { cls: 'stick-col' })}
        <div class="filters" style="margin-top:12px"><button class="btn" data-act="unduh-banding">Unduh Excel daftar berkas baru dan keluar</button></div>`;
    }
    let tren = '';
    if (sama.length >= 2) {
      const rs = sama.slice(-60).map(turun);
      const nama = [...new Set(rs.flatMap((r) => r.kantahList.map((k) => k.nama)))].sort((a, b) => a.localeCompare(b));
      if (S.trenKantah && !nama.includes(S.trenKantah)) S.trenKantah = '';
      const titik = rs.map((r) => ({ waktu: r.waktu, n: S.trenKantah ? (r.kantahMap.has(S.trenKantah) ? r.kantahMap.get(S.trenKantah).berkas.length : 0) : r.berkas.length }));
      tren = `<div class="card"><div class="card-head"><h3>Tren berkas tunggakan</h3>
          <select data-pilih="trenKantah" aria-label="Pilih kantah untuk tren"><option value="">Total kanwil</option>${nama.map((k) => `<option value="${esc(k)}" ${k === S.trenKantah ? 'selected' : ''}>${esc(pendek(k))}</option>`).join('')}</select></div>
        <p class="muted small">${esc(pendekKanwil(R.kanwil))} · ${esc(R.filter)} · ${fmt(rs.length)} rekap</p>
        ${grafikTren(titik)}
        <details class="lipat-dalam"><summary>Tabel per kantah</summary><div class="tbl-wrap"><table class="stick-col">
        <thead><tr><th>Kantah</th>${rs.map((r) => `<th class="num">${waktuLabel(r.waktu)}</th>`).join('')}</tr></thead>
        <tbody>${nama.map((k) => `<tr><td>${esc(pendek(k))}</td>${rs.map((r) => `<td class="num">${r.kantahMap.has(k) ? fmt(r.kantahMap.get(k).berkas.length) : '–'}</td>`).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>${rs.map((r) => `<td class="num">${fmt(r.berkas.length)}</td>`).join('')}</tr></tfoot></table></div></details></div>`;
    }
    const terakhir = bacaPref('cadangan');

    main.innerHTML = `
      ${tren}
      <div class="card"><h3>Perbandingan dua rekap</h3>${cmp}</div>
      <div class="card">
        <div class="card-head"><h3>Rekap tersimpan di browser ini</h3><span class="muted small">${fmt(S.list.length)} rekap</span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Waktu rekap</th><th>Kanwil</th><th>Filter</th><th>Sumber</th><th class="num">Kantah</th><th class="num">Berkas</th><th></th></tr></thead>
        <tbody>${S.list.map((r) => `<tr><td>${waktuLabel(r.waktu)}${r.id === R.id ? ' <span class="pill">aktif</span>' : ''}</td><td>${esc(pendekKanwil(r.kanwil))}</td><td>${esc(r.filter)}</td>
          <td>${esc(r.sumber)}${r.namaFile ? `<div class="muted small">${esc(r.namaFile)}</div>` : ''}</td><td class="num">${fmt(r.kantah.length)}</td><td class="num">${fmt(r.berkas.length)}</td>
          <td style="white-space:nowrap">${r.id === R.id ? '' : `<button class="btn" data-buka="${esc(r.id)}">Tampilkan</button> `}<button class="btn danger" data-hapus="${esc(r.id)}">Hapus</button></td></tr>`).join('')}</tbody></table></div>
        <div class="filters" style="margin-top:12px">
          <span class="muted small">Hapus rekap yang lebih lama dari</span>
          <select id="hapus-umur" aria-label="Batas umur rekap"><option value="30">30 hari</option><option value="90" selected>90 hari</option><option value="180">180 hari</option><option value="365">1 tahun</option></select>
          <button class="btn danger" data-act="hapus-lama">Hapus</button>
        </div>
      </div>
      <div class="card">
        <h3>Cadangan</h3>
        <p class="muted">Rekap hanya tersimpan di browser ini. Simpan file cadangan untuk berjaga-jaga, atau untuk memindahkan riwayat ke komputer lain: buka Monitra di komputer itu lalu impor file cadangannya lewat Impor Excel.</p>
        <p class="small muted">${terakhir ? `Cadangan terakhir: ${waktuLabel(terakhir.slice(0, 16))}.` : 'Belum pernah dicadangkan dari browser ini.'}</p>
        <div class="tombol-baris"><button class="btn primary" data-act="cadangkan">Cadangkan semua rekap (.json)</button>
          <label class="btn">Pulihkan dari cadangan<input type="file" accept=".json" hidden data-file></label></div>
      </div>`;
  }

  // ---------- ekspor ----------
  function unduhXlsx(nama, sheets) {
    unduhBlob(nama.replace(/[^\w.-]+/g, '_') + '.xlsx', window.XLSXLite.build(sheets));
  }
  const barisBerkas = (list) => [
    ['No', 'Kantah', 'Layanan', 'Nomor Berkas', 'Tahun Berkas', 'Posisi Berkas Digital', 'Status', 'Tanggal Mulai', 'SPOPP (Hari)', 'Jatuh Tempo', 'Tahun Tunggakan', 'Lewat Jatuh Tempo (Hari)', 'Kelompok Umur', 'Posisi Sama Sejak', 'Hitungan Dashboard'],
    ...list.map((b, i) => [i + 1, b.kantah, b.prosedur, b.nomor, b.tahun, b.posisi, b.status, tgl(b.mulai), b.durasi, tgl(b.jatuhTempo), b.thn ?? '', b.telat ?? '', b.umur >= 0 ? UMUR[b.umur].label : '', b.macet > 0 ? tgl(b.sejak) : '', b.luar ? 'Di luar hitungan' : 'Dihitung']),
  ];
  const urutTelat = (list) => [...list].sort((a, b) => (b.telat ?? 0) - (a.telat ?? 0));

  // Satu file Excel: sheet ringkasan + satu sheet per kantah, siap dibagikan ke masing-masing kantah.
  function laporanKantah(R) {
    const P = R.prev;
    const kantah = [...R.kantahList].sort((a, b) => b.berkas.length - a.berkas.length);
    const ring = [['Kantah', 'Berkas Tunggakan', P ? `Perubahan Sejak ${tgl(P.waktu)}` : 'Perubahan', 'Lewat > 90 Hari', 'Median Lewat Jatuh Tempo (Hari)', 'Tidak Bergerak Sejak Rekap Lalu', 'Angka Rekap Dashboard']];
    kantah.forEach((k) => {
      const pk = P && P.kantahMap.get(k.nama);
      ring.push([k.nama, k.berkas.length, P ? k.berkas.length - (pk ? pk.berkas.length : 0) : '', k.berkas.filter((b) => b.telat > 90).length,
        median(k.berkas.map((b) => b.telat)) ?? '', R.adaRiwayat ? k.berkas.filter((b) => b.macet > 0).length : '', k.m.prosesMelebihi ?? '']);
    });
    unduhXlsx(`Laporan_Tunggakan_${pendekKanwil(R.kanwil)}_${R.ref}`, [
      { name: 'Ringkasan', rows: ring },
      ...kantah.map((k) => ({ name: pendek(k.nama), rows: barisBerkas(urutTelat(k.berkas)) })),
    ]);
  }

  // Teks pendek untuk ditempel di WhatsApp (format *tebal* WhatsApp).
  function teksRingkas(judul, R, list, sebelum) {
    const top = (key) => kelompok(list, key).slice(0, 3).map((g) => `${g.k} (${fmt(g.n)})`).join(', ');
    const telat = list.map((b) => b.telat).filter((x) => x !== null);
    const d = sebelum === null || sebelum === undefined ? '' : list.length - sebelum;
    const baris = [
      `*${judul}*`,
      `Rekap ${waktuLabel(R.waktu)} (${R.filter})`,
      `Berkas tunggakan: *${fmt(list.length)}*${d === '' ? '' : d ? ` (${d > 0 ? 'naik' : 'turun'} ${fmt(Math.abs(d))} sejak ${tgl(R.prev.waktu)})` : ' (tetap)'}`,
      `Lewat > 90 hari: ${fmt(list.filter((b) => b.telat > 90).length)}`,
      telat.length ? `Median lewat jatuh tempo: ${fmt(median(telat))} hari` : '',
      R.adaRiwayat ? `Tidak bergerak sejak rekap lalu: ${fmt(list.filter((b) => b.macet > 0).length)}` : '',
      list.length ? `Layanan terbanyak: ${top('prosedur')}` : '',
      list.length ? `Posisi terbanyak: ${top('posisi')}` : '',
    ];
    return baris.filter(Boolean).join('\n');
  }
  function teksKanwil(R) {
    const P = R.prev;
    const head = teksRingkas(`Tunggakan SPOPP ${pendekKanwil(R.kanwil)}`, R, R.berkas, P ? P.berkas.length : null);
    const per = [...R.kantahList].sort((a, b) => b.berkas.length - a.berkas.length).map((k) => {
      const pk = P && P.kantahMap.get(k.nama);
      const d = P ? k.berkas.length - (pk ? pk.berkas.length : 0) : null;
      return `• ${pendek(k.nama)}: ${fmt(k.berkas.length)}${d ? ` (${d > 0 ? '+' : ''}${fmt(d)})` : ''}`;
    });
    return head + '\n\nPer kantah:\n' + per.join('\n');
  }

  // ---------- impor ----------
  async function impor(files) {
    let ok = 0;
    for (const file of files) {
      try {
        const hasil = await D.dariFile(file);
        const list = Array.isArray(hasil) ? hasil : [hasil];
        for (const r of list) { await simpanRekap(r, list.length > 1); ok++; }
        if (Array.isArray(hasil)) simpanPref('cadangan', new Date().toISOString());
      } catch (e) {
        console.error(e);
        toast(`${file.name}: ${e.message}`, 7000);
      }
    }
    if (ok) {
      render(true);
      toast(`${ok} rekap berhasil diimpor.`);
    }
  }
  async function simpanRekap(r, diam = false) {
    if (!r.berkas.length && !r.kantah.length) throw new Error('File tidak berisi data kantah atau berkas.');
    r.id = `${r.kanwil}|${r.waktu}|${r.filter}`;
    r.diimpor = new Date().toISOString();
    const ada = S.list.some((x) => x.id === r.id);
    await Store.put(r);
    // Minta browser tidak menghapus rekap saat ruang disk menipis.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await muat(r.id);
    if (ada && !diam) toast('Rekap dengan waktu yang sama sudah ada, data diperbarui.');
    if (S.tab === 'riwayat' && !ada && !diam) S.tab = 'ringkasan';
  }
  async function muat(aktifId) {
    S.list = ((await Store.all()) || []).sort((a, b) => String(b.waktu).localeCompare(String(a.waktu)));
    cache.clear();
    petaPosisi.clear();
    const id = aktifId || bacaPref('aktif');
    const r = S.list.find((x) => x.id === id) || S.list[0];
    S.R = r ? lengkapi(turun(r)) : null;
    if (r) simpanPref('aktif', r.id);
  }
  async function hapusRekap(daftar) {
    for (const r of daftar) await Store.del(r.id);
    await muat(S.R && !daftar.some((r) => r.id === S.R.id) ? S.R.id : null);
    render();
    toast(daftar.length === 1 ? `Rekap ${waktuLabel(daftar[0].waktu)} dihapus.` : `${fmt(daftar.length)} rekap dihapus.`, 8000, {
      label: 'Urungkan',
      fn: async () => {
        for (const r of daftar) await Store.put(r);
        await muat(S.R ? S.R.id : null);
        render();
        toast('Rekap dikembalikan.');
      },
    });
  }
  function cadangkan() {
    const isi = { jenis: 'monitra-cadangan', versi: 1, dibuat: new Date().toISOString(), rekap: S.list };
    const d = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    unduhBlob(`Cadangan_Monitra_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.json`, new Blob([JSON.stringify(isi)], { type: 'application/json' }));
    simpanPref('cadangan', new Date().toISOString());
    toast(`Cadangan ${fmt(S.list.length)} rekap diunduh. Simpan file ini di tempat aman.`, 5000);
  }

  // ---------- event ----------
  function setTab(t) { S.tab = t; simpanPref('tab', t); render(true); window.scrollTo(0, 0); }

  document.addEventListener('click', async (e) => {
    const lepas = e.target.closest('[data-lepas]');
    if (lepas) { S.f[lepas.dataset.lepas] = ''; S.page = 0; return render(); }
    const salinEl = e.target.closest('[data-salin]');
    if (salinEl) return salin(salinEl.dataset.salin, `Nomor berkas ${salinEl.dataset.salin} disalin.`);
    const el = e.target.closest('[data-go],[data-tab],[data-sort],[data-bsort],[data-page],[data-act],[data-buka],[data-hapus]');
    if (!el) return;
    if (el.dataset.tab) return setTab(el.dataset.tab);
    if (el.dataset.go) {
      e.preventDefault();
      const g = JSON.parse(el.dataset.go);
      if (g.kantah) S.kantah = g.kantah;
      if (g.layanan) S.layanan = g.layanan;
      if (g.f) { S.f = { ...F0(), ...g.f }; S.page = 0; }
      return setTab(g.tab);
    }
    if (el.dataset.sort) {
      const [id, key] = el.dataset.sort.split(':');
      const st = S[id + 'sort'] || (S[id + 'sort'] = { key, dir: -1 });
      if (st.key === key) st.dir *= -1; else { st.key = key; st.dir = ['nama', 'prosedur'].includes(key) ? 1 : -1; }
      return render();
    }
    if (el.dataset.bsort) {
      const key = el.dataset.bsort;
      if (S.sort.key === key) S.sort.dir *= -1; else S.sort = { key, dir: ['telat', 'durasi', 'tahun', 'thn'].includes(key) ? -1 : 1 };
      return isiTabelBerkas(S.R);
    }
    if (el.dataset.page) { S.page += Number(el.dataset.page); isiTabelBerkas(S.R); catat(false); return; }
    if (el.dataset.buka) { await muat(el.dataset.buka); return setTab('ringkasan'); }
    if (el.dataset.hapus) {
      const r = S.list.find((x) => x.id === el.dataset.hapus);
      if (r) await hapusRekap([r]);
      return;
    }
    const act = el.dataset.act;
    const R = S.R;
    if (act === 'tema') return gantiTema();
    if (act === 'rekap-sekarang') return rekapSekarang();
    if (act === 'periksa-lagi') return periksaLagi();
    if (act === 'tutup-status') { $('#status-rekap').hidden = true; return; }
    if (act === 'tutup-versi') { simpanPref('tutupVersi', VERSI_EKSTENSI); $('#pita-versi').hidden = true; return; }
    if (act === 'cara-perbarui') { bukaDialog('perbarui'); return; }
    if (act === 'salin-ext') return salin('chrome://extensions', 'Alamat disalin. Tempel di kolom alamat tab baru.');
    if (act === 'contoh') {
      try { await simpanRekap(D.contoh()); render(true); toast('Data contoh dimuat. Hapus kapan saja dari tab Riwayat.', 5000); } catch (err) { toast(err.message, 6000); }
      return;
    }
    if (act === 'cadangkan') return cadangkan();
    if (act === 'tunda-cadangan') { simpanPref('cadanganTunda', new Date().toISOString()); return render(); }
    if (act === 'hapus-lama') {
      const hari = Number($('#hapus-umur').value);
      const batas = new Date(Date.now() - hari * 864e5).toISOString().slice(0, 16);
      const lama = S.list.filter((r) => r.waktu && r.waktu < batas);
      if (!lama.length) return toast(`Tidak ada rekap yang lebih lama dari ${hari} hari.`);
      return hapusRekap(lama);
    }
    if (act === 'buka-filter') {
      S.filterBuka = !S.filterBuka;
      $('.filter-isi').classList.toggle('buka', S.filterBuka);
      el.setAttribute('aria-expanded', S.filterBuka);
      return;
    }
    if (act === 'cetak') window.print();
    if (act === 'reset') { S.f = F0(); S.page = 0; render(); }
    if (act === 'unduh-berkas') unduhXlsx(`Berkas_Tunggakan_${pendekKanwil(R.kanwil)}_${R.ref}`, [{ name: 'Berkas', rows: barisBerkas(urutTelat(saringBerkas(R))) }]);
    if (act === 'unduh-kantah') {
      const k = R.kantahMap.get(S.kantah);
      unduhXlsx(`Tunggakan_${pendek(k.nama)}_${R.ref}`, [{ name: 'Berkas', rows: barisBerkas(urutTelat(k.berkas)) }]);
    }
    if (act === 'laporan-kantah') laporanKantah(R);
    if (act === 'salin-kanwil') salin(teksKanwil(R), 'Ringkasan kanwil disalin. Tempel di WhatsApp.');
    if (act === 'salin-kantah') {
      const k = R.kantahMap.get(S.kantah);
      const pk = R.prev && R.prev.kantahMap.get(k.nama);
      salin(teksRingkas(`Tunggakan SPOPP ${k.nama}`, R, k.berkas, R.prev ? (pk ? pk.berkas.length : 0) : null), 'Ringkasan kantah disalin. Tempel di WhatsApp.');
    }
    if (act === 'unduh-banding' && S.cmpHasil) {
      const c = S.cmpHasil;
      unduhXlsx(`Perbandingan_${c.A.ref}_${c.B.ref}`, [{ name: 'Baru menunggak', rows: barisBerkas(c.baru) }, { name: 'Keluar dari daftar', rows: barisBerkas(c.hilang) }]);
    }
  });

  // Enter atau Spasi pada elemen yang bisa diklik (bukan tombol/tautan asli) menjalankan kliknya.
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-go]:not(a):not(button), [data-sort], [data-bsort]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.id === 'file' || el.hasAttribute('data-file')) { await impor([...el.files]); el.value = ''; return; }
    if (el.id === 'pilih-rekap') { await muat(el.value); return render(true); }
    if (el.dataset.pilih) { S[el.dataset.pilih] = el.value; return render(el.dataset.pilih !== 'trenKantah'); }
    if (el.dataset.cmp) { S.cmp[el.dataset.cmp] = el.value; return render(); }
    if (el.hasAttribute('data-perhal')) { S.perHal = Number(el.value); simpanPref('perHal', el.value); S.page = 0; isiTabelBerkas(S.R); return catat(false); }
    if (el.hasAttribute('data-hal')) { S.page = Number(el.value); isiTabelBerkas(S.R); return catat(false); }
    if (el.dataset.f && el.tagName === 'SELECT') { S.f[el.dataset.f] = el.value; S.page = 0; isiTabelBerkas(S.R); catat(false); }
  });
  let tundaCari = null;
  document.addEventListener('input', (e) => {
    if (e.target.dataset.f !== 'q') return;
    S.f.q = e.target.value;
    S.page = 0;
    clearTimeout(tundaCari);
    tundaCari = setTimeout(() => { isiTabelBerkas(S.R); catat(false); }, 200);
  });
  hp.addEventListener('change', () => { if (S.R && S.tab === 'berkas') isiTabelBerkas(S.R); });

  // tooltip: mouse, sentuhan, dan fokus keyboard
  const tip = $('#tip');
  function tampilTip(el, x, y) {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(x + 14, window.innerWidth - tip.offsetWidth - 8)) + 'px';
    tip.style.top = (y + 16) + 'px';
  }
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tampilTip(el, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tampilTip(el, e.clientX, e.clientY);
    clearTimeout(tampilTip.t);
    tampilTip.t = setTimeout(() => (tip.hidden = true), 2500);
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    const r = el.getBoundingClientRect();
    tampilTip(el, r.left, r.bottom - 8);
  });

  // seret & lepas file
  let dragN = 0;
  const drop = $('#drop');
  document.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragN++; drop.hidden = false; } });
  document.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; drop.hidden = true; } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragN = 0;
    drop.hidden = true;
    const files = [...e.dataTransfer.files].filter((f) => /\.(xlsx|json)$/i.test(f.name));
    if (files.length) impor(files); else toast('Hanya file .xlsx atau .json yang bisa diimpor.');
  });

  // Tinggi header berubah saat tombolnya turun ke baris kedua; baris tab menempel tepat di bawahnya.
  const top = $('.top');
  const aturTinggi = () => document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px');
  if (window.ResizeObserver) new ResizeObserver(aturTinggi).observe(top);
  aturTinggi();

  // ---------- ekstensi ----------
  function tandaiEkstensi() {
    const b = $('#rekap-sekarang');
    b.classList.toggle('terhubung', !!S.ext);
    b.title = S.ext ? `Ekstensi Rekap Tunggakan Kanwil ${S.ext.versi} terhubung` : 'Ekstensi belum terdeteksi: klik untuk memeriksa dan memasang';
    $('#ext-label').textContent = S.ext ? 'Ekstensi terhubung' : '';
    const pita = $('#pita-versi');
    const lama = S.ext && lebihLama(S.ext.versi, VERSI_EKSTENSI) && bacaPref('tutupVersi') !== VERSI_EKSTENSI;
    pita.hidden = !lama;
    if (lama) $('#pita-versi-teks').textContent = `Ekstensi Anda versi ${S.ext.versi}. Versi ${VERSI_EKSTENSI} sudah tersedia dengan rekap terjadwal dan tombol ulangi yang gagal.`;
  }
  // Tanya ekstensi apakah terpasang; jawabannya REKAP_EKSTENSI_ADA dari monitra-bridge.js.
  let jawabEkstensi = null;
  function cekEkstensi(ms) {
    return new Promise((res) => {
      const t = setTimeout(() => { jawabEkstensi = null; res(null); }, ms);
      jawabEkstensi = (v) => { clearTimeout(t); jawabEkstensi = null; res(v); };
      window.postMessage({ type: 'REKAP_EKSTENSI_PING' }, '*');
    });
  }
  // Dua kali coba, supaya komputer lambat atau ekstensi yang baru dimuat tidak dianggap belum terpasang.
  async function deteksi() {
    if (S.ext) return S.ext.versi;
    return (await cekEkstensi(2500)) || (await cekEkstensi(1500));
  }
  function bukaDialog(mode) {
    const dlg = $('#dlg-ekstensi');
    dlg.querySelectorAll('[data-mode]').forEach((x) => { x.hidden = x.dataset.mode !== mode; });
    if (!dlg.open) dlg.showModal();
  }
  async function rekapSekarang() {
    const tombol = document.querySelectorAll('[data-act="rekap-sekarang"]');
    tombol.forEach((b) => { b.disabled = true; b.dataset.label = b.textContent; b.textContent = 'Memeriksa ekstensi…'; });
    const versi = await deteksi();
    tombol.forEach((b) => { b.disabled = false; b.textContent = b.dataset.label; });
    S.ext = versi ? { versi } : null;
    tandaiEkstensi();
    if (!S.ext) { bukaDialog('pasang'); return; }
    window.postMessage({ type: 'REKAP_MINTA', kanwil: S.R ? S.R.kanwil : '' }, '*');
    statusRekap('mulai', 'Meminta ekstensi memulai rekap…', 0);
  }
  async function periksaLagi() {
    const b = $('[data-act="periksa-lagi"]');
    b.disabled = true;
    b.textContent = 'Memeriksa…';
    const versi = await deteksi();
    b.disabled = false;
    b.textContent = 'Periksa lagi';
    if (!versi) { toast('Ekstensi masih belum terdeteksi. Pastikan sudah dipasang dan aktif, lalu muat ulang halaman ini (F5).', 6000); return; }
    S.ext = { versi };
    $('#dlg-ekstensi').close();
    rekapSekarang();
  }
  function statusRekap(tahap, pesan, pct) {
    const box = $('#status-rekap');
    box.hidden = false;
    box.classList.toggle('gagal', tahap === 'gagal');
    $('#status-teks').textContent = (tahap === 'gagal' ? '' : 'Ekstensi: ') + pesan;
    $('#status-ulang').hidden = tahap !== 'gagal';
    if (pct !== undefined && pct !== null) $('#status-progres').style.width = Math.max(0, Math.min(100, pct)) + '%';
    clearTimeout(statusRekap.t);
    if (tahap === 'selesai') statusRekap.t = setTimeout(() => (box.hidden = true), 6000);
  }

  // Jalur untuk ekstensi: skrip ekstensi di halaman ini mengirim hasil rekap lewat window.postMessage.
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'REKAP_EKSTENSI_ADA') {
      S.ext = { versi: e.data.versi };
      tandaiEkstensi();
      if (jawabEkstensi) jawabEkstensi(e.data.versi);
      return;
    }
    if (e.data.type === 'REKAP_STATUS') { statusRekap(e.data.tahap, e.data.pesan, e.data.pct); return; }
    if (e.data.type === 'REKAP_TUNGGAKAN_KOSONG') {
      toast('Data dari ekstensi tidak ditemukan atau sudah diterima sebelumnya. Klik Buka di Monitra lagi di panel ekstensi.', 6000);
      S.tungguEkstensi = false;
      catat(false);
      return;
    }
    if (e.data.type !== 'REKAP_TUNGGAKAN' || !e.data.hasil) return;
    try {
      await siap;
      S.tab = 'ringkasan';
      const r = D.dariEkstensi(e.data.hasil);
      await simpanRekap(r);
      S.tungguEkstensi = false;
      render(true);
      statusRekap('selesai', `${e.data.terjadwal ? 'Rekap terjadwal' : 'Rekap'} ${waktuLabel(r.waktu)} diterima: ${fmt(S.R.berkas.length)} berkas tunggakan ditampilkan.`, 100);
      window.postMessage({ type: 'REKAP_TUNGGAKAN_DITERIMA', id: e.data.id }, '*');
      // Ekstensi versi lama menghapus seluruh alamat setelah menerima; tulis ulang alamat tampilan.
      setTimeout(() => catat(false), 300);
    } catch (err) {
      toast('Gagal menerima rekap dari ekstensi: ' + err.message, 6000);
    }
  });

  if (!dariHash(location.hash)) S.tab = TABS.includes(bacaPref('tab')) ? bacaPref('tab') : 'ringkasan';
  const siap = muat().then(() => render()).catch((err) => {
    console.error(err);
    main.innerHTML = `<div class="empty"><h2>Rekap tidak bisa dibuka</h2><p class="lead">${esc(err.message)}</p><p>Coba muat ulang halaman. Bila tetap gagal, browser ini mungkin memblokir penyimpanan situs (mode penyamaran atau pengaturan privasi).</p></div>`;
  });
  // Splash tampil paling sedikit sebentar pada kunjungan pertama di sesi ini; klik untuk melewati.
  function tutupSplash() {
    const sp = $('#splash');
    if (!sp || sp.classList.contains('pergi')) return;
    const lewati = document.documentElement.classList.contains('tanpa-splash');
    const tunggu = lewati ? 0 : Math.max(0, (gerakHemat.matches ? 500 : 2000) - performance.now());
    setTimeout(() => {
      sp.classList.add('pergi');
      try { sessionStorage.setItem('rt.splash', '1'); } catch (e) { /* abaikan */ }
      setTimeout(() => sp.remove(), 800);
    }, tunggu);
  }
  $('#splash').addEventListener('click', () => { document.documentElement.classList.add('tanpa-splash'); tutupSplash(); });
  siap.finally(tutupSplash);
  window.postMessage({ type: 'REKAP_EKSTENSI_PING' }, '*');
})();
