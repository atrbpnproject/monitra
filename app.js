// Dashboard Rekap Tunggakan SPOPP — berjalan sepenuhnya di browser.
// Rekap disimpan di IndexedDB browser ini; tidak ada data yang dikirim ke server mana pun.
(function () {
  const D = window.DataRekap;
  const $ = (s, el = document) => el.querySelector(s);
  const main = $('#main');

  // ---------- util ----------
  const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
  const pct = (a, b) => (b ? (a / b * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%' : '–');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pendek = (n) => String(n).replace(/^Kantor Pertanahan\s+/i, '').replace(/^Kabupaten\s+/i, '');
  const tgl = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : '');
  const waktuLabel = (w) => (w ? `${tgl(w)} ${w.slice(11, 16)}` : 'waktu tidak diketahui');
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

  function toast(msg, ms = 3500) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), ms);
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
    const tx = async (mode, fn) => {
      const db = await open();
      if (!db) return fn(null);
      return new Promise((res, rej) => {
        const t = db.transaction('rekap', mode);
        const r = fn(t.objectStore('rekap'));
        t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      all: () => tx('readonly', (s) => (s ? s.getAll() : { result: [...mem.values()] })),
      put: (r) => tx('readwrite', (s) => (s ? s.put(r) : mem.set(r.id, r))),
      del: (id) => tx('readwrite', (s) => (s ? s.delete(id) : mem.delete(id))),
    };
  })();

  // ---------- state ----------
  const S = {
    list: [], // semua rekap (urut waktu terbaru dulu)
    R: null, // rekap aktif + turunan
    tab: bacaPref('tab') || 'ringkasan',
    kantah: null,
    layanan: null,
    posisiLayanan: '',
    f: { q: '', kantah: '', prosedur: '', posisi: '', tahun: '', umur: '' },
    sort: { key: 'telat', dir: -1 },
    page: 0,
    lsort: { key: 'berkas', dir: -1 },
  };

  function turunkan(r) {
    const ref = r.waktu ? r.waktu.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const refMs = Date.parse(ref + 'T00:00:00Z');
    const berkas = r.berkas.map((b) => {
      const telat = b.jatuhTempo ? Math.round((refMs - Date.parse(b.jatuhTempo + 'T00:00:00Z')) / 864e5) : null;
      return { ...b, telat, umur: telat === null ? -1 : umurIdx(Math.max(telat, 0)) };
    });
    const per = new Map();
    r.kantah.forEach((k) => per.set(k.nama, { ...k, berkas: [] }));
    berkas.forEach((b) => {
      if (!per.has(b.kantah)) per.set(b.kantah, { nama: b.kantah, m: {}, jmlLayanan: 0, berkasTerambil: 0, catatan: '', berkas: [] });
      per.get(b.kantah).berkas.push(b);
    });
    return { ...r, ref, berkas, kantahMap: per, kantahList: [...per.values()] };
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

  // ---------- komponen grafik ----------
  const warnaUmur = (i) => `var(--age-${i})`;
  function legendUmur() {
    return `<div class="legend">${UMUR.map((u, i) => `<span><i style="background:${warnaUmur(i)}"></i>${u.label}</span>`).join('')}</div>`;
  }
  // baris: [{label, total, segs:[n...] | null, go:{...}, tip}]
  function hbars(rows, { stacked = false, max } = {}) {
    const mx = max || Math.max(1, ...rows.map((r) => r.total));
    return `<div class="hbars">${rows.map((r) => {
      const go = r.go ? ` data-go='${esc(JSON.stringify(r.go))}'` : '';
      const segs = stacked
        ? r.segs.map((n, i) => (n ? `<div class="seg" style="width:${n / mx * 100}%;background:${warnaUmur(i)}" data-tip="${esc(r.label)} · ${UMUR[i].label}: ${fmt(n)} berkas"></div>` : '')).join('')
        : `<div class="seg" style="width:${r.total / mx * 100}%;background:var(--bar)" data-tip="${esc(r.tip || r.label + ': ' + fmt(r.total))}"></div>`;
      return `<div class="lbl${r.go ? ' link' : ''}"${go} title="${esc(r.label)}">${esc(r.label)}</div><div class="track">${segs}</div><div class="val">${fmt(r.total)}</div>`;
    }).join('')}</div>`;
  }
  function kolomUmur(u) {
    const mx = Math.max(1, ...u);
    const tot = u.reduce((a, b) => a + b, 0);
    return `<div class="cols">${u.map((n, i) => `<div class="col"><div class="top-val">${fmt(n)}</div><div class="bar" style="height:${n / mx * 100}%;background:${warnaUmur(i)}" data-tip="${UMUR[i].label}: ${fmt(n)} berkas (${pct(n, tot)})"></div></div>`).join('')}</div>
      <div class="cols-x">${UMUR.map((x) => `<span>${x.label}</span>`).join('')}</div>`;
  }
  const kpi = (v, l, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  const go = (o) => `data-go='${esc(JSON.stringify(o))}'`;

  function tabelSort(id, cols, rows, st, opts = {}) {
    const s = [...rows].sort((a, b) => {
      const x = a[st.key], y = b[st.key];
      if (typeof x === 'number' || typeof y === 'number') return ((x ?? -Infinity) - (y ?? -Infinity)) * st.dir;
      return String(x ?? '').localeCompare(String(y ?? ''), 'id') * st.dir;
    });
    const head = cols.map((c) => `<th class="sort ${c.num ? 'num' : ''}" data-sort="${id}:${c.key}">${c.label}${st.key === c.key ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const body = s.map((r) => `<tr ${opts.rowGo ? go(opts.rowGo(r)) + ' class="click"' : ''}>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
    return `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${opts.foot || ''}</table></div>`;
  }

  // ---------- tampilan ----------
  function render() {
    const R = S.R;
    $('#tabs').hidden = !R;
    $('#pilih-rekap').hidden = !S.list.length;
    $('#pilih-rekap').innerHTML = S.list.map((r) => `<option value="${esc(r.id)}" ${R && r.id === R.id ? 'selected' : ''}>${esc(pendekKanwil(r.kanwil))} · ${waktuLabel(r.waktu)}</option>`).join('');
    $('#meta').textContent = R ? `${R.kanwil} · ${R.filter || 'filter tidak diketahui'} · diambil ${waktuLabel(R.waktu)} · sumber ${R.sumber}` : 'Data dibaca dan disimpan di browser ini saja';
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
    if (!R) { main.innerHTML = kosong(); return; }
    const f = { ringkasan, kantah: tabKantah, layanan: tabLayanan, posisi: tabPosisi, berkas: tabBerkas, riwayat: tabRiwayat }[S.tab] || ringkasan;
    f(R);
  }
  const pendekKanwil = (n) => String(n).replace(/^Kantor Wilayah (Provinsi )?/i, '');

  function kosong() {
    return `<div class="empty">
      <h2>Belum ada rekap</h2>
      <p class="lead">Impor file Excel hasil tombol <b>Unduh Excel</b> pada ekstensi Rekap Tunggakan Kanwil.</p>
      <label class="dropzone" style="display:block">
        <input type="file" accept=".xlsx,.json" multiple hidden data-file>
        <div style="font-size:16px;font-weight:600">Klik untuk memilih file, atau seret file ke halaman ini</div>
        <div class="muted small">Format: Tunggakan_SPOPP_*.xlsx. Bisa beberapa file sekaligus.</div>
      </label>
      <ol class="small">
        <li>Data hanya dibaca oleh browser Anda. Tidak ada yang diunggah ke server.</li>
        <li>Setiap rekap tersimpan di browser ini, sehingga rekap dari tanggal berbeda bisa dibandingkan.</li>
        <li>Membuka halaman ini di browser atau komputer lain berarti data harus diimpor ulang.</li>
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
    if (!items.length) return '';
    return `<details class="alert"><summary><b>${items.length} catatan data</b> <span class="muted">— jumlah berkas detail berbeda dari angka rekap, biasanya karena data berubah saat ekstensi berjalan.</span></summary><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></details>`;
  }

  function ringkasan(R) {
    const B = R.berkas;
    const tot = (k) => R.kantahList.reduce((s, x) => s + (x.m[k] || 0), 0);
    const proses = tot('prosesSesuai') + tot('prosesMelebihi');
    const telat = B.map((b) => b.telat).filter((x) => x !== null);
    const lebih90 = B.filter((b) => b.telat > 90).length;
    const u = hitungUmur(B);

    const kantahRows = R.kantahList.map((k) => ({ label: pendek(k.nama), total: k.berkas.length, segs: hitungUmur(k.berkas), go: { tab: 'kantah', kantah: k.nama } }))
      .sort((a, b) => b.total - a.total);
    const lay = kelompok(B, 'prosedur').slice(0, 10).map((g) => ({ label: g.k, total: g.n, go: { tab: 'layanan', layanan: g.k } }));
    const pos = kelompok(B, 'posisi').slice(0, 10).map((g) => ({ label: g.k, total: g.n, go: { tab: 'berkas', f: { posisi: g.k } } }));
    const thn = kelompok(B, 'tahun').sort((a, b) => b.k - a.k).map((g) => ({ label: String(g.k || '(kosong)'), total: g.n, go: { tab: 'berkas', f: { tahun: String(g.k) } } }));

    const rows = R.kantahList.map((k) => ({
      nama: pendek(k.nama), full: k.nama, ...k.m,
      persen: (k.m.prosesSesuai || 0) + (k.m.prosesMelebihi || 0) ? k.m.prosesMelebihi / (k.m.prosesSesuai + k.m.prosesMelebihi) : null,
      berkas: k.berkas.length, layanan: k.jmlLayanan,
      median: median(k.berkas.map((b) => b.telat)), lebih90: k.berkas.filter((b) => b.telat > 90).length,
    }));
    const n = (v) => fmt(v);
    const cols = [
      { key: 'nama', label: 'Kantah' },
      { key: 'masuk', label: 'Masuk', num: 1, fmt: n },
      { key: 'prosesSesuai', label: 'Proses sesuai', num: 1, fmt: n },
      { key: 'prosesMelebihi', label: 'Proses melebihi', num: 1, fmt: n },
      { key: 'persen', label: '% melebihi', num: 1, fmt: (v) => (v === null ? '–' : pct(v, 1)) },
      { key: 'selesaiMelebihi', label: 'Selesai melebihi', num: 1, fmt: n },
      { key: 'layanan', label: 'Layanan', num: 1, fmt: n },
      { key: 'berkas', label: 'Berkas detail', num: 1, fmt: n },
      { key: 'median', label: 'Median telat (hari)', num: 1, fmt: (v) => (v === null ? '–' : fmt(v)) },
      { key: 'lebih90', label: '> 90 hari', num: 1, fmt: n },
    ];
    const foot = `<tfoot><tr><td>Total</td><td class="num">${fmt(tot('masuk'))}</td><td class="num">${fmt(tot('prosesSesuai'))}</td><td class="num">${fmt(tot('prosesMelebihi'))}</td><td class="num">${pct(tot('prosesMelebihi'), proses)}</td><td class="num">${fmt(tot('selesaiMelebihi'))}</td><td class="num">${fmt(R.layanan.length)}</td><td class="num">${fmt(B.length)}</td><td class="num">${fmt(median(telat))}</td><td class="num">${fmt(lebih90)}</td></tr></tfoot>`;

    main.innerHTML = `
      ${peringatan(R)}
      <div class="kpis">
        ${kpi(fmt(B.length), 'Berkas tunggakan', `angka rekap dashboard: ${fmt(tot('prosesMelebihi'))}`)}
        ${kpi(pct(tot('prosesMelebihi'), proses), 'Berkas proses yang melebihi SPOPP', `dari ${fmt(proses)} berkas dalam proses`)}
        ${kpi(telat.length ? fmt(median(telat)) + ' hari' : '–', 'Median lewat jatuh tempo', telat.length ? `terlama ${fmt(Math.max(...telat))} hari` : '')}
        ${kpi(fmt(lebih90), 'Lewat lebih dari 90 hari', `${pct(lebih90, B.length)} dari berkas tunggakan`)}
        ${kpi(fmt(R.layanan.length), 'Layanan bertunggakan', `${fmt(kelompok(B, 'prosedur').length)} jenis layanan di ${fmt(R.kantahList.length)} kantah`)}
      </div>
      <div class="card">
        <div class="card-head"><h3>Berkas tunggakan per kantah, menurut lama lewat jatuh tempo</h3><span class="muted small">Klik nama kantah untuk detail</span></div>
        ${legendUmur()}
        ${hbars(kantahRows, { stacked: true })}
      </div>
      <div class="grid g2">
        <div class="card"><h3>Sebaran lama lewat jatuh tempo</h3>${kolomUmur(u)}
          <p class="muted small">Dihitung dari jatuh tempo sampai tanggal rekap (${tgl(R.ref)}).</p></div>
        <div class="card"><h3>Tahun berkas</h3>${hbars(thn)}</div>
        <div class="card"><div class="card-head"><h3>10 layanan dengan tunggakan terbanyak</h3></div>${hbars(lay)}</div>
        <div class="card"><div class="card-head"><h3>10 posisi berkas terbanyak</h3><span class="muted small">Berkas sedang tertahan di jabatan ini</span></div>${hbars(pos)}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Rekap per kantah</h3><span class="muted small">Angka masuk, proses, selesai dari dashboard; berkas detail dan umur dari daftar berkas</span></div>
        ${tabelSort('ks', cols, rows, S.ksort || (S.ksort = { key: 'berkas', dir: -1 }), { rowGo: (r) => ({ tab: 'kantah', kantah: r.full }), foot })}
      </div>`;
  }

  function tabKantah(R) {
    if (!S.kantah || !R.kantahMap.has(S.kantah)) S.kantah = [...R.kantahList].sort((a, b) => b.berkas.length - a.berkas.length)[0].nama;
    const k = R.kantahMap.get(S.kantah);
    const B = k.berkas;
    const m = k.m || {};
    const proses = (m.prosesSesuai || 0) + (m.prosesMelebihi || 0);
    const telat = B.map((b) => b.telat).filter((x) => x !== null);
    const lebih90 = B.filter((b) => b.telat > 90).length;
    const layRekap = new Map(R.layanan.filter((l) => l.kantah === k.nama).map((l) => [l.prosedur, l]));
    const lay = kelompok(B, 'prosedur').map((g) => ({
      prosedur: g.k, rekap: layRekap.get(g.k) ? layRekap.get(g.k).m.prosesMelebihi : null, berkas: g.n,
      median: median(g.v.map((b) => b.telat)), maks: Math.max(...g.v.map((b) => b.telat ?? 0)), lebih90: g.v.filter((b) => b.telat > 90).length, umur: hitungUmur(g.v),
    }));
    const pos = kelompok(B, 'posisi').slice(0, 12).map((g) => ({ label: g.k, total: g.n, go: { tab: 'berkas', f: { kantah: k.nama, posisi: g.k } } }));
    const terlama = [...B].sort((a, b) => (b.telat ?? 0) - (a.telat ?? 0)).slice(0, 20);
    const mini = (u) => {
      const t = u.reduce((a, b) => a + b, 0) || 1;
      return `<div style="display:flex;gap:2px;height:10px;min-width:120px">${u.map((n, i) => (n ? `<div style="width:${n / t * 100}%;background:${warnaUmur(i)}" data-tip="${UMUR[i].label}: ${fmt(n)}"></div>` : '')).join('')}</div>`;
    };
    const n = (v) => (v === null || v === undefined ? '–' : fmt(v));

    main.innerHTML = `
      <div class="filters no-print">
        <select data-pilih="kantah">${[...R.kantahList].sort((a, b) => a.nama.localeCompare(b.nama)).map((x) => `<option ${x.nama === k.nama ? 'selected' : ''} value="${esc(x.nama)}">${esc(pendek(x.nama))} (${fmt(x.berkas.length)})</option>`).join('')}</select>
        <button class="btn" ${go({ tab: 'berkas', f: { kantah: k.nama } })}>Lihat semua berkas</button>
        <button class="btn" data-act="unduh-kantah">Unduh Excel kantah ini</button>
        <button class="btn" data-act="cetak">Cetak</button>
      </div>
      <h2>${esc(k.nama)}</h2>
      <p class="lead">${esc(R.kanwil)} · rekap ${waktuLabel(R.waktu)}</p>
      <div class="kpis">
        ${kpi(fmt(B.length), 'Berkas tunggakan', `angka rekap: ${n(m.prosesMelebihi)}`)}
        ${kpi(pct(m.prosesMelebihi || 0, proses), 'Berkas proses yang melebihi SPOPP', `dari ${fmt(proses)} berkas dalam proses`)}
        ${kpi(telat.length ? fmt(median(telat)) + ' hari' : '–', 'Median lewat jatuh tempo', telat.length ? `terlama ${fmt(Math.max(...telat))} hari` : '')}
        ${kpi(fmt(lebih90), 'Lewat lebih dari 90 hari', pct(lebih90, B.length))}
        ${kpi(fmt(lay.length), 'Layanan bertunggakan', '')}
      </div>
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
      <div class="card">
        <h3>20 berkas paling lama lewat jatuh tempo</h3>
        ${tabelBerkas(terlama, false)}
      </div>`;
  }

  function tabelBerkas(list, denganKantah = true) {
    return `<div class="tbl-wrap"><table><thead><tr>
      ${denganKantah ? '<th>Kantah</th>' : ''}<th>Layanan</th><th>No. berkas</th><th class="num">Tahun</th><th>Posisi berkas</th>
      <th>Mulai</th><th class="num">SPOPP</th><th>Jatuh tempo</th><th class="num">Telat (hari)</th></tr></thead><tbody>
      ${list.map((b) => `<tr>${denganKantah ? `<td>${esc(pendek(b.kantah))}</td>` : ''}<td>${esc(b.prosedur)}</td><td>${esc(b.nomor)}</td><td class="num">${esc(b.tahun)}</td>
        <td>${esc(b.posisi)}</td><td class="num">${tgl(b.mulai)}</td><td class="num">${b.durasi === '' ? '' : fmt(b.durasi)}</td><td class="num">${tgl(b.jatuhTempo)}</td>
        <td class="num">${b.telat === null ? '' : `<span class="pill ${b.telat > 365 ? 'crit' : b.telat > 90 ? 'warn' : ''}">${fmt(b.telat)}</span>`}</td></tr>`).join('')}
      </tbody></table></div>`;
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
          ], per, S.lpsort || (S.lpsort = { key: 'berkas', dir: -1 }), { rowGo: (r) => ({ tab: 'berkas', f: { kantah: r.full, prosedur: sel.k } }) })}
        </div>`;
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
        ], semua, S.lasort || (S.lasort = { key: 'berkas', dir: -1 }), { rowGo: (r) => ({ tab: 'layanan', layanan: r.prosedur, top: 1 }) })}
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
      return `<td class="h" style="background:color-mix(in srgb, var(--bar) ${t}%, var(--heat-0));color:${t > 55 ? '#fff' : 'inherit'};cursor:pointer" ${go({ tab: 'berkas', f: { kantah: k.nama, posisi: p, prosedur: S.posisiLayanan } })} data-tip="${esc(p)} · ${esc(pendek(k.nama))}: ${fmt(v)} berkas">${fmt(v)}</td>`;
    };
    const layOps = kelompok(R.berkas, 'prosedur').map((g) => g.k).sort((a, b) => a.localeCompare(b, 'id'));
    main.innerHTML = `
      <h2>Di meja siapa berkas tertahan</h2>
      <p class="lead">Jumlah berkas tunggakan menurut posisi berkas digital dan kantah. Warna lebih gelap berarti lebih banyak. Klik sel untuk daftar berkasnya.</p>
      <div class="filters"><select data-pilih="posisiLayanan"><option value="">Semua layanan</option>${layOps.map((l) => `<option ${l === S.posisiLayanan ? 'selected' : ''} value="${esc(l)}">${esc(l)}</option>`).join('')}</select>
        <span class="muted small">${fmt(B.length)} berkas, ${fmt(pos.length)} posisi</span></div>
      <div class="card"><div class="tbl-wrap"><table class="heat">
        <thead><tr><th>Posisi berkas</th>${kantah.map((k) => `<th class="num">${esc(pendek(k.nama))}</th>`).join('')}<th class="num">Total</th></tr></thead>
        <tbody>${pos.map((p) => `<tr><td>${esc(p.k)}</td>${kantah.map((k) => cell(p.k, k)).join('')}<td class="num"><b>${fmt(p.n)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>${kantah.map((k) => `<td class="num">${fmt(B.filter((b) => b.kantah === k.nama).length)}</td>`).join('')}<td class="num">${fmt(B.length)}</td></tr></tfoot>
      </table></div></div>`;
  }

  // ---------- daftar berkas ----------
  function saringBerkas(R) {
    const f = S.f;
    const q = f.q.trim().toLowerCase();
    return R.berkas.filter((b) => (!f.kantah || b.kantah === f.kantah) && (!f.prosedur || b.prosedur === f.prosedur) && (!f.posisi || b.posisi === f.posisi)
      && (!f.tahun || String(b.tahun) === f.tahun) && (f.umur === '' || String(b.umur) === f.umur)
      && (!q || b.nomor.toLowerCase().includes(q) || b.prosedur.toLowerCase().includes(q) || b.posisi.toLowerCase().includes(q)));
  }
  function tabBerkas(R) {
    const ops = (key, label, fmtLbl = (x) => x) => {
      const vals = [...new Set(R.berkas.map((b) => String(b[key])))].sort((a, b) => (key === 'tahun' ? b - a : a.localeCompare(b, 'id')));
      return `<select data-f="${key}"><option value="">${label}</option>${vals.map((v) => `<option ${S.f[key] === v ? 'selected' : ''} value="${esc(v)}">${esc(fmtLbl(v))}</option>`).join('')}</select>`;
    };
    main.innerHTML = `
      <div class="filters">
        <input type="search" data-f="q" placeholder="Cari nomor berkas, layanan, posisi…" value="${esc(S.f.q)}">
        ${ops('kantah', 'Semua kantah', pendek)}
        ${ops('prosedur', 'Semua layanan')}
        ${ops('posisi', 'Semua posisi')}
        ${ops('tahun', 'Semua tahun berkas')}
        <select data-f="umur"><option value="">Semua umur</option>${UMUR.map((u, i) => `<option ${S.f.umur === String(i) ? 'selected' : ''} value="${i}">Telat ${u.label}</option>`).join('')}</select>
        <button class="btn" data-act="reset">Hapus filter</button>
        <button class="btn" data-act="unduh-berkas">Unduh Excel</button>
      </div>
      <div id="berkas-tbl"></div>`;
    isiTabelBerkas(R);
  }
  const PER_HAL = 50;
  function isiTabelBerkas(R) {
    const list = saringBerkas(R);
    const st = S.sort;
    list.sort((a, b) => {
      const x = a[st.key], y = b[st.key];
      if (typeof x === 'number' || typeof y === 'number') return ((x ?? -Infinity) - (y ?? -Infinity)) * st.dir;
      return String(x ?? '').localeCompare(String(y ?? ''), 'id', { numeric: true }) * st.dir;
    });
    const hal = Math.max(1, Math.ceil(list.length / PER_HAL));
    S.page = Math.min(S.page, hal - 1);
    const slice = list.slice(S.page * PER_HAL, S.page * PER_HAL + PER_HAL);
    const cols = [['kantah', 'Kantah'], ['prosedur', 'Layanan'], ['nomor', 'No. berkas'], ['tahun', 'Tahun', 1], ['posisi', 'Posisi berkas'], ['mulai', 'Mulai', 1], ['durasi', 'SPOPP', 1], ['jatuhTempo', 'Jatuh tempo', 1], ['telat', 'Telat (hari)', 1]];
    const head = cols.map(([k, l, num]) => `<th class="sort ${num ? 'num' : ''}" data-bsort="${k}">${l}${st.key === k ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const t = tabelBerkas(slice).replace(/<thead>[\s\S]*?<\/thead>/, `<thead><tr>${head}</tr></thead>`);
    $('#berkas-tbl').innerHTML = `
      <p class="muted small">${fmt(list.length)} dari ${fmt(R.berkas.length)} berkas · median telat ${list.length ? fmt(median(list.map((b) => b.telat))) : '–'} hari</p>
      <div class="card" style="padding:0">${t}</div>
      <div class="pager"><button class="btn" data-page="-1" ${S.page ? '' : 'disabled'}>‹ Sebelumnya</button>
        <span class="muted small">Halaman ${S.page + 1} dari ${hal}</span>
        <button class="btn" data-page="1" ${S.page < hal - 1 ? '' : 'disabled'}>Berikutnya ›</button></div>`;
  }

  // ---------- riwayat & perbandingan ----------
  function tabRiwayat(R) {
    const n = (v) => fmt(v);
    const sama = S.list.filter((r) => r.kanwil === R.kanwil).sort((a, b) => a.waktu.localeCompare(b.waktu));
    if (!S.cmp || !S.list.some((r) => r.id === S.cmp.a) || !S.list.some((r) => r.id === S.cmp.b)) {
      S.cmp = sama.length >= 2 ? { a: sama[sama.length - 2].id, b: sama[sama.length - 1].id } : null;
    }
    let cmp = `<p class="muted">Impor rekap lain dari kanwil yang sama dengan tanggal berbeda untuk melihat perubahan: berkas yang baru menunggak dan berkas yang sudah tidak ada di daftar.</p>`;
    if (S.cmp) {
      const A = turunkan(S.list.find((r) => r.id === S.cmp.a));
      const Bk = turunkan(S.list.find((r) => r.id === S.cmp.b));
      const ka = new Map(A.berkas.map((b) => [kunciBerkas(b), b]));
      const kb = new Map(Bk.berkas.map((b) => [kunciBerkas(b), b]));
      const baru = Bk.berkas.filter((b) => !ka.has(kunciBerkas(b)));
      const hilang = A.berkas.filter((b) => !kb.has(kunciBerkas(b)));
      S.cmpHasil = { baru, hilang, A, B: Bk };
      const nama = [...new Set([...A.kantahList, ...Bk.kantahList].map((k) => k.nama))];
      const rows = nama.map((k) => {
        const x = A.kantahMap.get(k), y = Bk.kantahMap.get(k);
        const a = x ? x.berkas.length : 0, b = y ? y.berkas.length : 0;
        return { nama: pendek(k), a, b, d: b - a, baru: baru.filter((z) => z.kantah === k).length, hilang: hilang.filter((z) => z.kantah === k).length };
      });
      const opt = (sel) => S.list.map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(pendekKanwil(r.kanwil))} · ${waktuLabel(r.waktu)}</option>`).join('');
      const delta = (v) => (v > 0 ? `<span class="up">+${fmt(v)}</span>` : v < 0 ? `<span class="down">${fmt(v)}</span>` : '0');
      cmp = `
        <div class="filters"><span>Bandingkan</span><select data-cmp="a">${opt(S.cmp.a)}</select><span>dengan</span><select data-cmp="b">${opt(S.cmp.b)}</select></div>
        <div class="kpis">
          ${kpi(delta(Bk.berkas.length - A.berkas.length), 'Perubahan jumlah berkas tunggakan', `${fmt(A.berkas.length)} → ${fmt(Bk.berkas.length)}`)}
          ${kpi(fmt(baru.length), 'Berkas baru menunggak', 'ada di rekap baru, tidak ada di rekap lama')}
          ${kpi(fmt(hilang.length), 'Berkas keluar dari daftar', 'kemungkinan sudah selesai atau keluar dari filter')}
        </div>
        ${tabelSort('cp', [
          { key: 'nama', label: 'Kantah' },
          { key: 'a', label: 'Rekap lama', num: 1, fmt: n },
          { key: 'b', label: 'Rekap baru', num: 1, fmt: n },
          { key: 'd', label: 'Selisih', num: 1, fmt: delta },
          { key: 'baru', label: 'Baru menunggak', num: 1, fmt: n },
          { key: 'hilang', label: 'Keluar dari daftar', num: 1, fmt: n },
        ], rows, S.cpsort || (S.cpsort = { key: 'd', dir: -1 }))}
        <div class="filters" style="margin-top:12px"><button class="btn" data-act="unduh-banding">Unduh Excel daftar berkas baru dan keluar</button></div>`;
    }
    const tren = sama.length >= 2 ? (() => {
      const rs = sama.map(turunkan);
      const nama = [...new Set(rs.flatMap((r) => r.kantahList.map((k) => k.nama)))];
      return `<div class="card"><h3>Tren berkas tunggakan per kantah</h3><div class="tbl-wrap"><table>
        <thead><tr><th>Kantah</th>${rs.map((r) => `<th class="num">${waktuLabel(r.waktu)}</th>`).join('')}</tr></thead>
        <tbody>${nama.map((k) => `<tr><td>${esc(pendek(k))}</td>${rs.map((r) => `<td class="num">${r.kantahMap.has(k) ? fmt(r.kantahMap.get(k).berkas.length) : '–'}</td>`).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>${rs.map((r) => `<td class="num">${fmt(r.berkas.length)}</td>`).join('')}</tr></tfoot></table></div></div>`;
    })() : '';

    main.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Rekap tersimpan di browser ini</h3><span class="muted small">${fmt(S.list.length)} rekap</span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Waktu rekap</th><th>Kanwil</th><th>Filter</th><th>Sumber</th><th class="num">Kantah</th><th class="num">Berkas</th><th></th></tr></thead>
        <tbody>${S.list.map((r) => `<tr><td>${waktuLabel(r.waktu)}${r.id === R.id ? ' <span class="pill">aktif</span>' : ''}</td><td>${esc(pendekKanwil(r.kanwil))}</td><td>${esc(r.filter)}</td>
          <td>${esc(r.sumber)}${r.namaFile ? `<div class="muted small">${esc(r.namaFile)}</div>` : ''}</td><td class="num">${fmt(r.kantah.length)}</td><td class="num">${fmt(r.berkas.length)}</td>
          <td style="white-space:nowrap">${r.id === R.id ? '' : `<button class="btn" data-buka="${esc(r.id)}">Tampilkan</button> `}<button class="btn danger" data-hapus="${esc(r.id)}">Hapus</button></td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="card"><h3>Perbandingan dua rekap</h3>${cmp}</div>
      ${tren}`;
  }

  // ---------- ekspor ----------
  function unduhXlsx(nama, sheets) {
    const blob = window.XLSXLite.build(sheets);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nama.replace(/[^\w.-]+/g, '_') + '.xlsx';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  const barisBerkas = (list) => [
    ['No', 'Kantah', 'Layanan', 'Nomor Berkas', 'Tahun Berkas', 'Posisi Berkas Digital', 'Status', 'Tanggal Mulai', 'SPOPP (Hari)', 'Jatuh Tempo', 'Telat (Hari)', 'Kelompok Umur'],
    ...list.map((b, i) => [i + 1, b.kantah, b.prosedur, b.nomor, b.tahun, b.posisi, b.status, tgl(b.mulai), b.durasi, tgl(b.jatuhTempo), b.telat ?? '', b.umur >= 0 ? UMUR[b.umur].label : '']),
  ];

  // ---------- impor ----------
  async function impor(files) {
    let ok = 0;
    for (const file of files) {
      try {
        const r = await D.dariFile(file);
        await simpanRekap(r);
        ok++;
      } catch (e) {
        console.error(e);
        toast(`${file.name}: ${e.message}`, 6000);
      }
    }
    if (ok) toast(`${ok} rekap berhasil diimpor.`);
  }
  async function simpanRekap(r) {
    if (!r.berkas.length && !r.kantah.length) throw new Error('File tidak berisi data kantah atau berkas.');
    r.id = `${r.kanwil}|${r.waktu}|${r.filter}`;
    r.diimpor = new Date().toISOString();
    const ada = S.list.some((x) => x.id === r.id);
    await Store.put(r);
    await muat(r.id);
    if (ada) toast('Rekap dengan waktu yang sama sudah ada, data diperbarui.');
    if (S.tab === 'riwayat' && !ada) S.tab = 'ringkasan';
    render();
  }
  async function muat(aktifId) {
    S.list = ((await Store.all()) || []).sort((a, b) => String(b.waktu).localeCompare(String(a.waktu)));
    const id = aktifId || bacaPref('aktif');
    const r = S.list.find((x) => x.id === id) || S.list[0];
    S.R = r ? turunkan(r) : null;
    if (r) simpanPref('aktif', r.id);
  }

  // ---------- event ----------
  function setTab(t) { S.tab = t; simpanPref('tab', t); render(); window.scrollTo(0, 0); }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-go],[data-tab],[data-sort],[data-bsort],[data-page],[data-act],[data-buka],[data-hapus]');
    if (!el) return;
    if (el.dataset.tab) return setTab(el.dataset.tab);
    if (el.dataset.go) {
      const g = JSON.parse(el.dataset.go);
      if (g.kantah) S.kantah = g.kantah;
      if (g.layanan) S.layanan = g.layanan;
      if (g.f) { S.f = { q: '', kantah: '', prosedur: '', posisi: '', tahun: '', umur: '', ...g.f }; S.page = 0; }
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
      if (S.sort.key === key) S.sort.dir *= -1; else S.sort = { key, dir: ['telat', 'durasi', 'tahun'].includes(key) ? -1 : 1 };
      return isiTabelBerkas(S.R);
    }
    if (el.dataset.page) { S.page += Number(el.dataset.page); isiTabelBerkas(S.R); return; }
    if (el.dataset.buka) { await muat(el.dataset.buka); return setTab('ringkasan'); }
    if (el.dataset.hapus) {
      const r = S.list.find((x) => x.id === el.dataset.hapus);
      if (!r || !confirm(`Hapus rekap ${pendekKanwil(r.kanwil)} · ${waktuLabel(r.waktu)} dari browser ini?`)) return;
      await Store.del(r.id);
      await muat(S.R && S.R.id !== r.id ? S.R.id : null);
      return render();
    }
    const act = el.dataset.act;
    const R = S.R;
    if (act === 'cetak') window.print();
    if (act === 'reset') { S.f = { q: '', kantah: '', prosedur: '', posisi: '', tahun: '', umur: '' }; S.page = 0; render(); }
    if (act === 'unduh-berkas') unduhXlsx(`Berkas_Tunggakan_${pendekKanwil(R.kanwil)}_${R.ref}`, [{ name: 'Berkas', rows: barisBerkas(saringBerkas(R).sort((a, b) => (b.telat ?? 0) - (a.telat ?? 0))) }]);
    if (act === 'unduh-kantah') {
      const k = R.kantahMap.get(S.kantah);
      unduhXlsx(`Tunggakan_${pendek(k.nama)}_${R.ref}`, [{ name: 'Berkas', rows: barisBerkas([...k.berkas].sort((a, b) => (b.telat ?? 0) - (a.telat ?? 0))) }]);
    }
    if (act === 'unduh-banding' && S.cmpHasil) {
      const c = S.cmpHasil;
      unduhXlsx(`Perbandingan_${c.A.ref}_${c.B.ref}`, [{ name: 'Baru menunggak', rows: barisBerkas(c.baru) }, { name: 'Keluar dari daftar', rows: barisBerkas(c.hilang) }]);
    }
  });

  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.id === 'file' || el.hasAttribute('data-file')) { await impor([...el.files]); el.value = ''; return; }
    if (el.id === 'pilih-rekap') { await muat(el.value); return render(); }
    if (el.dataset.pilih) { S[el.dataset.pilih] = el.value; return render(); }
    if (el.dataset.cmp) { S.cmp[el.dataset.cmp] = el.value; return render(); }
    if (el.dataset.f && el.tagName === 'SELECT') { S.f[el.dataset.f] = el.value; S.page = 0; isiTabelBerkas(S.R); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.dataset.f === 'q') { S.f.q = e.target.value; S.page = 0; isiTabelBerkas(S.R); }
  });

  // tooltip
  const tip = $('#tip');
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = x + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
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

  // Jalur untuk ekstensi: skrip ekstensi di halaman ini mengirim hasil rekap lewat window.postMessage.
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'REKAP_TUNGGAKAN' || !e.data.hasil) return;
    try {
      await simpanRekap(D.dariEkstensi(e.data.hasil));
      toast('Rekap dari ekstensi berhasil ditampilkan.');
      window.postMessage({ type: 'REKAP_TUNGGAKAN_DITERIMA', id: e.data.id }, '*');
    } catch (err) {
      toast('Gagal menerima rekap dari ekstensi: ' + err.message, 6000);
    }
  });

  muat().then(render);
})();
