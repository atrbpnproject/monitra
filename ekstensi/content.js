// Rekap Tunggakan Kanwil — berjalan di halaman Kinerja Kantor Pertanahan (sesi login Anda).
// Alur sama dengan klik manual: Rekap Kanwil -> pilih Kanwil -> tiap Kantah -> tiap layanan
// dengan "Berkas Proses Melebihi SPOPP" > 0 -> ambil daftar berkas (detail tunggakan).
(function () {
  if (window.__rekapTunggakanLoaded) return;
  window.__rekapTunggakanLoaded = true;

  const BASE = '/dashboard/statistik/KinerjaKantorPertanahan/';
  const DEFAULT_KANWIL = /nusa\s*tenggara\s*barat/i;
  const JEDA_MS = 350; // jeda antar permintaan supaya server tidak terbebani
  const METRIK = [
    ['berkasmasuk', 'Berkas Masuk'],
    ['berkasluncuran', 'Berkas Luncuran'],
    ['prosessesuaiprosedur', 'Berkas Proses Sesuai SPOPP'],
    ['prosesmelebihiprosedur', 'Berkas Proses Melebihi SPOPP'],
    ['selesaisesuaiprosedur', 'Berkas Selesai Sesuai SPOPP'],
    ['selesaimelebihiprosedur', 'Berkas Selesai Melebihi SPOPP'],
  ];
  const DETAIL_KOLOM = [
    ['nomorberkas', 'Nomor Berkas'],
    ['tahunberkas', 'Tahun Berkas'],
    ['nomorkanwil', 'Nomor Kanwil'],
    ['tahunkanwil', 'Tahun Kanwil'],
    ['nomorpusat', 'Nomor Pusat'],
    ['tahunpusat', 'Tahun Pusat'],
    ['posisi_berkas_digital', 'Posisi Berkas Digital'],
    ['statusberkas', 'Status Berkas'],
    ['tanggalmulai', 'Tanggal Mulai'],
    ['durasi', 'Durasi (Hari)'],
    ['jatuhtempo', 'Jatuh Tempo'],
  ];

  const state = {
    running: false,
    tugas: null, // permintaan rekap dari Monitra: { monitraTab, kanwil }
    stop: false,
    kanwilList: [],
    hasil: null, // { kanwil, filter, waktu, kantah: [ {info, layanan:[{info, detail:[]}] , error} ] }
  };

  // ---------- util ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  }
  const fmt = (n) => toNum(n).toLocaleString('id-ID');
  function fmtTanggal(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    let d = null;
    const m = s.match(/\/Date\((-?\d+)/);
    if (m) d = new Date(Number(m[1]));
    else if (/^\d{4}-\d{2}-\d{2}/.test(s)) d = new Date(s);
    if (!d || isNaN(d)) return s;
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
  }
  // Pesan galat teknis diterjemahkan menjadi langkah yang bisa dilakukan pengguna.
  function pesanRamah(msg) {
    const m = String(msg || '');
    if (/bukan JSON/i.test(m)) return 'Sesi login ATR/BPN habis. Login ulang di tab ini, lalu jalankan rekap lagi.';
    if (/HTTP 5\d\d/.test(m)) return 'Server ATR/BPN sedang bermasalah (' + m + '). Coba lagi beberapa menit lagi.';
    if (/HTTP 40[13]/.test(m)) return 'Akses ditolak server ATR/BPN (' + m + '). Pastikan masih login.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Koneksi internet terputus. Periksa jaringan lalu coba lagi.';
    return m;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function filterHalaman() {
    const t = document.getElementById('tahun');
    const b = document.getElementById('bulan');
    const tv = t ? t.value : 'all';
    const bv = b ? b.value : '';
    return {
      tahun: !tv || tv === 'all' ? '' : tv, // "Semua Tahun" dikirim kosong (null) seperti halaman aslinya
      bulan: bv || '',
      label: `${t && t.selectedOptions[0] ? t.selectedOptions[0].text : 'Semua Tahun'} / ${b && b.selectedOptions[0] ? b.selectedOptions[0].text : 'Semua Bulan'}`,
    };
  }

  async function post(endpoint, params) {
    const body = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => body.append(k, v ?? ''));
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(BASE + endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01',
          },
          body,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const txt = await r.text();
        let j;
        try { j = JSON.parse(txt); } catch (e) { throw new Error('Respon bukan JSON (sesi login habis?)'); }
        if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { /* biarkan */ } }
        const data = Array.isArray(j) ? j : Array.isArray(j && j.data) ? j.data : Array.isArray(j && j.Data) ? j.Data : null;
        if (!data) throw new Error('Format respon tidak dikenal');
        return data;
      } catch (e) {
        lastErr = e;
        await sleep(1000 * (i + 1));
      }
    }
    throw lastErr;
  }

  const api = {
    kanwil: (f) => post('KanwilTunggakan', { tahun: f.tahun, bulan: f.bulan, currentOrderBy: 'berkasmasuk', currentOrderDir: 'desc' }),
    kantah: (f, kanwilid) => post('KantahTunggakan', { tahun: f.tahun, bulan: f.bulan, currentOrderBy: 'berkasmasuk', currentOrderDir: 'desc', kanwilid }),
    prosedur: (f, kantorid) => post('ProsedurTunggakan', { tahun: f.tahun, bulan: f.bulan, currentOrderBy: 'berkasmasuk', currentOrderDir: 'desc', kantorid }),
    detail: (f, namaprosedur, kantorid) => post('DetailTunggakan', { tahun: f.tahun, bulan: f.bulan, namaprosedur, kantorid }),
  };

  // ---------- UI ----------
  const panel = document.createElement('div');
  panel.id = 'rtk-panel';
  panel.innerHTML = `
    <div class="rtk-head">
      <strong>Rekap Tunggakan Kanwil</strong>
      <span class="rtk-actions">
        <button class="rtk-icon" data-act="min" title="Perkecil">–</button>
        <button class="rtk-icon" data-act="close" title="Tutup">×</button>
      </span>
    </div>
    <div class="rtk-body">
      <div id="rtk-pita" class="rtk-pita" hidden></div>
      <label class="rtk-lbl">Kanwil
        <select id="rtk-kanwil"><option>Memuat daftar kanwil…</option></select>
      </label>
      <div class="rtk-filter">Filter: <b id="rtk-filter"></b> <span class="rtk-muted">(ikut pilihan Tahun/Bulan di halaman)</span></div>
      <div class="rtk-row">
        <button id="rtk-start" class="rtk-btn rtk-primary">Mulai Rekap</button>
        <button id="rtk-stop" class="rtk-btn" disabled>Berhenti</button>
        <button id="rtk-web" class="rtk-btn" disabled title="Buka hasil rekap di web Monitra (data tetap di browser ini)">Buka di Monitra</button>
        <button id="rtk-xlsx" class="rtk-btn" disabled>Unduh Excel</button>
        <button id="rtk-retry" class="rtk-btn" hidden title="Ambil ulang hanya kantah dan layanan yang gagal">Ulangi yang gagal</button>
      </div>
      <div class="rtk-progress"><div id="rtk-bar"></div></div>
      <div id="rtk-status" class="rtk-muted">Siap.</div>
      <div id="rtk-summary"></div>
      <details class="rtk-logwrap" id="rtk-jadwal-wrap"><summary>Rekap otomatis terjadwal</summary>
        <label class="rtk-cek"><input type="checkbox" id="rtk-jadwal-on"> Rekap otomatis setiap hari kerja pukul <input type="time" id="rtk-jam" value="07:30"></label>
        <div id="rtk-jadwal-info" class="rtk-muted">Chrome harus terbuka dan Anda sudah login ATR/BPN. Tab dashboard akan dibuka otomatis; hasilnya tampil saat Monitra dibuka.</div>
      </details>
      <details class="rtk-logwrap"><summary>Log proses</summary><pre id="rtk-log"></pre></details>
    </div>`;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector('#' + id);
  const ui = {
    kanwil: $('rtk-kanwil'), filter: $('rtk-filter'), start: $('rtk-start'), stop: $('rtk-stop'),
    xlsx: $('rtk-xlsx'), web: $('rtk-web'), bar: $('rtk-bar'), status: $('rtk-status'), summary: $('rtk-summary'), log: $('rtk-log'),
    retry: $('rtk-retry'), pita: $('rtk-pita'), jadwalOn: $('rtk-jadwal-on'), jam: $('rtk-jam'), jadwalInfo: $('rtk-jadwal-info'),
  };
  // Satu tombol utama sesuai tahap: Mulai Rekap sebelum ada hasil, Buka di Monitra sesudahnya.
  function aturTombol() {
    const ada = !!(state.hasil && state.hasil.kantah.length) && !state.running;
    ui.start.classList.toggle('rtk-primary', !ada);
    ui.web.classList.toggle('rtk-primary', ada);
    ui.start.textContent = ada ? 'Rekap ulang' : 'Mulai Rekap';
    ui.retry.hidden = !(ada && jumlahGagal() > 0);
    if (!ui.retry.hidden) ui.retry.textContent = `Ulangi yang gagal (${jumlahGagal()})`;
  }
  function jumlahGagal() {
    const h = state.hasil;
    if (!h) return 0;
    return h.kantah.reduce((n, k) => n + (k.error ? 1 : 0) + k.layanan.filter((l) => l.error).length, 0);
  }
  function pita(teks) {
    ui.pita.textContent = teks || '';
    ui.pita.hidden = !teks;
  }
  function log(msg) {
    const t = new Date().toLocaleTimeString('id-ID');
    ui.log.textContent += `[${t}] ${msg}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
  }
  function setStatus(msg, pct) {
    // Perkiraan sisa waktu dari kecepatan sejauh ini.
    if (state.running && state.mulai && pct > 3 && pct < 100) {
      const sisa = (Date.now() - state.mulai) * (100 - pct) / pct;
      msg += sisa < 60000 ? ' · kurang dari 1 menit lagi' : ` · sekitar ${Math.round(sisa / 60000)} menit lagi`;
    }
    ui.status.textContent = msg;
    if (pct !== undefined) ui.bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (state.tugas) laporTugas('proses', msg, pct);
  }
  // Teruskan status rekap ke tab Monitra yang memintanya.
  function laporTugas(tahap, pesan, pct) {
    chrome.runtime.sendMessage({ type: 'STATUS_TUGAS', tahap, pesan, pct }).catch(() => {});
  }
  function refreshFilter() { ui.filter.textContent = filterHalaman().label; }
  ['tahun', 'bulan'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { refreshFilter(); loadKanwil(); });
  });
  refreshFilter();

  // Panel diingat dalam keadaan diperkecil atau tidak, supaya tidak selalu menutupi dashboard.
  chrome.storage.local.get('panelMin').then((o) => { if (o.panelMin && !state.running && !state.tugas) panel.classList.add('rtk-min'); }).catch(() => {});
  panel.querySelector('[data-act="min"]').onclick = () => {
    panel.classList.toggle('rtk-min');
    chrome.storage.local.set({ panelMin: panel.classList.contains('rtk-min') }).catch(() => {});
  };
  panel.querySelector('[data-act="close"]').onclick = () => (panel.style.display = 'none');
  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m && m.type === 'TOGGLE_PANEL') panel.style.display = panel.style.display === 'none' ? '' : 'none';
    if (m && m.type === 'MULAI_TUGAS') cekTugas();
    reply({ ok: true });
  });

  async function loadKanwil() {
    try {
      const list = await api.kanwil(filterHalaman());
      state.kanwilList = list;
      const prev = ui.kanwil.value;
      ui.kanwil.innerHTML = list.map((k) => `<option value="${esc(k.kanwilid)}">${esc(k.namakanwil)}</option>`).join('');
      const pilih = list.find((k) => String(k.kanwilid) === prev) || list.find((k) => DEFAULT_KANWIL.test(k.namakanwil || ''));
      if (pilih) ui.kanwil.value = pilih.kanwilid;
    } catch (e) {
      ui.kanwil.innerHTML = '<option value="">Gagal memuat — pastikan sudah login</option>';
      ui.status.textContent = pesanRamah(e.message);
      log('Gagal memuat daftar kanwil: ' + e.message);
    }
  }
  const kanwilSiap = loadKanwil();

  // Rekap yang diminta dari tombol "Rekap Sekarang" di Monitra.
  async function cekTugas() {
    if (state.running) return;
    const t = await chrome.runtime.sendMessage({ type: 'AMBIL_TUGAS' }).catch(() => null);
    if (!t) return;
    await kanwilSiap;
    if (!state.kanwilList.length) await loadKanwil();
    if (!state.kanwilList.length) {
      laporTugas('gagal', 'Daftar kanwil tidak bisa dimuat. Login dulu di tab dashboard ATR/BPN; rekap akan berjalan sendiri setelah halaman dashboard terbuka kembali.');
      return;
    }
    const k = t.kanwil && state.kanwilList.find((x) => x.namakanwil === t.kanwil);
    if (k) ui.kanwil.value = k.kanwilid;
    panel.style.display = '';
    panel.classList.remove('rtk-min');
    state.tugas = t;
    chrome.runtime.sendMessage({ type: 'TUGAS_DIMULAI' }).catch(() => {});
    pita(t.terjadwal
      ? 'Rekap terjadwal sedang berjalan. Biarkan tab ini terbuka; hasilnya tampil saat Monitra dibuka.'
      : 'Rekap untuk Monitra sedang berjalan. Biarkan tab ini terbuka; hasilnya otomatis tampil di tab Monitra.');
    log(t.terjadwal ? 'Rekap terjadwal dimulai.' : 'Rekap diminta dari Monitra.');
    jalankan();
  }
  cekTugas();

  // ---------- proses utama ----------
  async function jalankan() {
    const kanwilid = ui.kanwil.value;
    const kanwil = state.kanwilList.find((k) => String(k.kanwilid) === kanwilid);
    if (!kanwil) {
      if (state.tugas) { laporTugas('gagal', 'Kanwil belum dipilih di panel ekstensi.'); state.tugas = null; pita(''); return; }
      ui.status.textContent = 'Pilih Kanwil terlebih dahulu. Bila daftar kosong, login dulu lalu muat ulang halaman ini.';
      return;
    }
    const f = filterHalaman();

    state.running = true; state.stop = false; state.mulai = Date.now();
    ui.start.disabled = true; ui.stop.disabled = false; ui.xlsx.disabled = true; ui.web.disabled = true; ui.kanwil.disabled = true;
    ui.log.textContent = '';
    const hasil = { kanwil, filter: f.label, waktu: new Date(), kantah: [], f: { tahun: f.tahun, bulan: f.bulan } };
    state.hasil = hasil;
    renderSummary();
    aturTombol();
    let gagal = null;

    try {
      setStatus(`Mengambil daftar kantah ${kanwil.namakanwil}…`, 2);
      log(`Kanwil: ${kanwil.namakanwil} | Filter: ${f.label}`);
      const kantahList = await api.kantah(f, kanwilid);
      log(`${kantahList.length} kantah ditemukan.`);

      for (let i = 0; i < kantahList.length; i++) {
        if (state.stop) break;
        const kt = kantahList[i];
        const item = { info: kt, layanan: [], error: null };
        hasil.kantah.push(item);
        const basePct = (i / kantahList.length) * 100;
        const step = 100 / kantahList.length;
        setStatus(`(${i + 1}/${kantahList.length}) ${kt.namakantah}: memeriksa layanan…`, basePct);

        try {
          await sleep(JEDA_MS);
          const prosedur = await api.prosedur(f, kt.kantorid);
          const tunggak = prosedur.filter((p) => toNum(p.prosesmelebihiprosedur) > 0);
          log(`${kt.namakantah}: ${prosedur.length} layanan, ${tunggak.length} bertunggakan.`);

          for (let j = 0; j < tunggak.length; j++) {
            if (state.stop) break;
            const p = tunggak[j];
            const lay = { info: p, detail: [], error: null };
            item.layanan.push(lay);
            setStatus(`(${i + 1}/${kantahList.length}) ${kt.namakantah} — ${p.namaprosedur} (${j + 1}/${tunggak.length})`,
              basePct + step * ((j + 1) / (tunggak.length + 1)));
            try {
              await sleep(JEDA_MS);
              lay.detail = await api.detail(f, p.namaprosedur, kt.kantorid);
              const exp = toNum(p.prosesmelebihiprosedur);
              log(`  • ${p.namaprosedur}: ${lay.detail.length} berkas` + (lay.detail.length !== exp ? ` (rekap: ${exp})` : ''));
            } catch (e) {
              lay.error = e.message;
              log(`  ✗ ${p.namaprosedur}: ${e.message}`);
            }
            renderSummary();
          }
        } catch (e) {
          item.error = e.message;
          log(`✗ ${kt.namakantah}: ${e.message}`);
        }
        renderSummary();
      }
      const total = hasil.kantah.reduce((s, k) => s + k.layanan.reduce((a, l) => a + l.detail.length, 0), 0);
      setStatus(state.stop ? `Dihentikan. ${fmt(total)} berkas terekap sejauh ini.` : `Selesai. ${fmt(total)} berkas tunggakan terekap dari ${hasil.kantah.length} kantah.`, 100);
      log(state.stop ? 'Dihentikan oleh pengguna.' : 'Selesai.');
    } catch (e) {
      gagal = e.message;
      setStatus('Gagal: ' + pesanRamah(e.message));
      log('Gagal: ' + e.message);
    } finally {
      state.running = false;
      ui.start.disabled = false; ui.stop.disabled = true; ui.kanwil.disabled = false;
      ui.xlsx.disabled = ui.web.disabled = !(hasil.kantah.length);
      renderSummary();
      aturTombol();
      if (!gagal && jumlahGagal()) setStatus(`${ui.status.textContent} ${jumlahGagal()} bagian gagal diambil; klik Ulangi yang gagal.`);
      if (state.tugas) {
        const tugas = state.tugas;
        state.tugas = null;
        pita('');
        if (!gagal && !state.stop && hasil.kantah.length) kirimKeMonitra(tugas);
        else laporTugas('gagal', gagal ? `Rekap gagal: ${pesanRamah(gagal)}` : 'Rekap dihentikan di panel ekstensi.');
      }
    }
  }

  function renderSummary() {
    const h = state.hasil;
    if (!h) { ui.summary.innerHTML = ''; return; }
    let tRekap = 0, tLay = 0, tBerkas = 0;
    const rows = h.kantah.map((k, i) => {
      const rekap = toNum(k.info.prosesmelebihiprosedur);
      const berkas = k.layanan.reduce((a, l) => a + l.detail.length, 0);
      const err = k.error || k.layanan.some((l) => l.error);
      tRekap += rekap; tLay += k.layanan.length; tBerkas += berkas;
      return `<tr><td>${i + 1}</td><td>${esc(String(k.info.namakantah).replace(/^Kantor Pertanahan /, ''))}</td>
        <td class="n">${fmt(rekap)}</td><td class="n">${k.layanan.length}</td>
        <td class="n ${berkas !== rekap ? 'rtk-warn' : ''}">${fmt(berkas)}</td><td>${err ? '⚠️' : ''}</td></tr>`;
    }).join('');
    ui.summary.innerHTML = `
      <table class="rtk-table">
        <thead><tr><th>#</th><th>Kantah</th><th>Proses &gt; SPOPP</th><th>Layanan</th><th>Berkas</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="rtk-muted">Belum ada data</td></tr>'}</tbody>
        <tfoot><tr><td></td><td>Total</td><td class="n">${fmt(tRekap)}</td><td class="n">${tLay}</td><td class="n">${fmt(tBerkas)}</td><td></td></tr></tfoot>
      </table>`;
  }

  // ---------- ekspor ----------
  function bangunExcel() {
    const h = state.hasil;
    const namaKantah = (k) => k.info.namakantah;

    const ringkas = [['No', 'Nama Kantah', ...METRIK.map((m) => m[1]), 'Jumlah Layanan Bertunggakan', 'Berkas Detail Terambil', 'Catatan']];
    h.kantah.forEach((k, i) => {
      const berkas = k.layanan.reduce((a, l) => a + l.detail.length, 0);
      ringkas.push([i + 1, namaKantah(k), ...METRIK.map((m) => toNum(k.info[m[0]])), k.layanan.length, berkas,
        k.error || (k.layanan.some((l) => l.error) ? 'Sebagian layanan gagal diambil' : '')]);
    });
    const tot = ['', 'Total'];
    for (let c = 2; c < ringkas[0].length - 1; c++) tot.push(ringkas.slice(1).reduce((s, r) => s + (Number(r[c]) || 0), 0));
    ringkas.push(tot);

    const layanan = [['No', 'Nama Kantah', 'Nama Prosedur', ...METRIK.map((m) => m[1]), 'Berkas Detail Terambil', 'Catatan']];
    let no = 1;
    h.kantah.forEach((k) => k.layanan.forEach((l) => {
      layanan.push([no++, namaKantah(k), l.info.namaprosedur, ...METRIK.map((m) => toNum(l.info[m[0]])), l.detail.length, l.error || '']);
    }));

    // kolom tambahan yang tidak dikenal tetap ikut disimpan
    const known = new Set(['namaprosedur', ...DETAIL_KOLOM.map((c) => c[0])]);
    const extra = new Set();
    h.kantah.forEach((k) => k.layanan.forEach((l) => l.detail.forEach((d) => Object.keys(d).forEach((key) => { if (!known.has(key)) extra.add(key); }))));
    const extraKeys = [...extra];
    const detail = [['No', 'Nama Kantah', 'Nama Prosedur', ...DETAIL_KOLOM.map((c) => c[1]), ...extraKeys]];
    no = 1;
    h.kantah.forEach((k) => k.layanan.forEach((l) => l.detail.forEach((d) => {
      detail.push([no++, namaKantah(k), d.namaprosedur || l.info.namaprosedur,
        ...DETAIL_KOLOM.map(([key]) => {
          const v = d[key];
          if (key === 'tanggalmulai' || key === 'jatuhtempo') return fmtTanggal(v);
          if (key === 'durasi') return v === null || v === undefined || v === '' ? '' : (isFinite(Number(v)) ? Number(v) : v);
          return v ?? '';
        }),
        ...extraKeys.map((key) => (d[key] === null || d[key] === undefined ? '' : (typeof d[key] === 'object' ? JSON.stringify(d[key]) : d[key])))]);
    })));

    const info = [
      ['Keterangan', 'Nilai'],
      ['Kanwil', h.kanwil.namakanwil],
      ['Filter', h.filter],
      ['Waktu ekstraksi', h.waktu.toLocaleString('id-ID')],
      ['Sumber', location.origin + BASE],
      ['Jumlah kantah', h.kantah.length],
      ['Jumlah layanan bertunggakan', layanan.length - 1],
      ['Jumlah berkas tunggakan', detail.length - 1],
    ];

    const sheets = [
      { name: 'Ringkasan Kantah', rows: ringkas },
      { name: 'Layanan Tunggakan', rows: layanan },
      { name: 'Detail Berkas', rows: detail },
    ];
    // satu sheet per kantah agar mudah dibagikan ke masing-masing kantah
    h.kantah.forEach((k) => {
      const rows = [['No', 'Nama Prosedur', ...detail[0].slice(3)]];
      let n = 1;
      detail.slice(1).filter((r) => r[1] === namaKantah(k)).forEach((r) => rows.push([n++, ...r.slice(2)]));
      sheets.push({ name: String(namaKantah(k)).replace(/^Kantor Pertanahan (Kabupaten |Kota )?/, (m, g) => (g && g.startsWith('Kota') ? 'Kota ' : '')), rows });
    });
    sheets.push({ name: 'Info', rows: info });
    return XLSXLite.build(sheets);
  }

  function unduh() {
    if (!state.hasil) return;
    const blob = bangunExcel();
    const d = state.hasil.waktu;
    const p = (x) => String(x).padStart(2, '0');
    const nama = String(state.hasil.kanwil.namakanwil).replace(/^Kantor Wilayah (Provinsi )?/i, '').replace(/[^\w]+/g, '_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Tunggakan_SPOPP_${nama}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // Kirim ke Monitra: background menyimpan hasil sementara lalu membuka tab Monitra,
  // dan monitra-bridge.js di tab itu menyerahkannya ke halaman. Tidak lewat server mana pun.
  async function kirimKeMonitra(tugas) {
    if (!state.hasil || state.running) return;
    const dariTugas = !!(tugas && tugas.monitraTab);
    const terjadwal = !!(tugas && tugas.terjadwal);
    ui.web.disabled = true;
    setStatus('Mengirim hasil rekap ke Monitra…');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'KIRIM_MONITRA', hasil: JSON.parse(JSON.stringify(state.hasil)), tujuan: dariTugas ? tugas.monitraTab : null, terjadwal });
      if (!r || !r.ok) throw new Error((r && r.error) || 'tidak ada balasan dari ekstensi');
      setStatus(r.tertunda ? 'Rekap terjadwal selesai dan disimpan. Hasilnya tampil saat Monitra dibuka.' : r.tabBaru ? 'Monitra dibuka di tab baru.' : 'Hasil rekap sudah tampil di tab Monitra.');
      log('Hasil rekap dikirim ke Monitra.');
    } catch (e) {
      setStatus('Gagal mengirim ke Monitra: ' + e.message);
      if (dariTugas) laporTugas('gagal', 'Gagal mengirim hasil ke Monitra: ' + e.message);
      log('Gagal mengirim ke Monitra: ' + e.message);
    } finally {
      ui.web.disabled = false;
    }
  }

  // Ambil ulang hanya kantah dan layanan yang gagal, dengan filter yang sama seperti rekapnya.
  async function ulangiGagal() {
    const h = state.hasil;
    if (!h || state.running) return;
    const f = h.f || filterHalaman();
    state.running = true; state.stop = false; state.mulai = Date.now();
    ui.start.disabled = ui.xlsx.disabled = ui.web.disabled = ui.retry.disabled = true; ui.stop.disabled = false;
    const tugasList = [];
    h.kantah.forEach((k) => {
      if (k.error) tugasList.push({ k });
      k.layanan.forEach((l) => { if (l.error) tugasList.push({ k, l }); });
    });
    let i = 0;
    for (const t of tugasList) {
      if (state.stop) break;
      i++;
      setStatus(`Mengulang ${i}/${tugasList.length}: ${t.k.info.namakantah}${t.l ? ' — ' + t.l.info.namaprosedur : ''}`, (i - 1) / tugasList.length * 100);
      try {
        await sleep(JEDA_MS);
        if (t.l) {
          t.l.detail = await api.detail(f, t.l.info.namaprosedur, t.k.info.kantorid);
          t.l.error = null;
          log(`  ↻ ${t.k.info.namakantah} · ${t.l.info.namaprosedur}: ${t.l.detail.length} berkas`);
        } else {
          const prosedur = await api.prosedur(f, t.k.info.kantorid);
          t.k.layanan = [];
          for (const p of prosedur.filter((x) => toNum(x.prosesmelebihiprosedur) > 0)) {
            const lay = { info: p, detail: [], error: null };
            t.k.layanan.push(lay);
            try { await sleep(JEDA_MS); lay.detail = await api.detail(f, p.namaprosedur, t.k.info.kantorid); } catch (e) { lay.error = e.message; }
          }
          t.k.error = null;
          log(`  ↻ ${t.k.info.namakantah}: ${t.k.layanan.length} layanan diambil ulang`);
        }
      } catch (e) {
        if (t.l) t.l.error = e.message; else t.k.error = e.message;
        log(`  ✗ ulang ${t.k.info.namakantah}${t.l ? ' · ' + t.l.info.namaprosedur : ''}: ${e.message}`);
      }
      renderSummary();
    }
    state.running = false;
    ui.start.disabled = ui.xlsx.disabled = ui.web.disabled = ui.retry.disabled = false; ui.stop.disabled = true;
    const sisa = jumlahGagal();
    setStatus(sisa ? `${sisa} bagian masih gagal. ${pesanRamah(h.kantah.flatMap((k) => [k.error, ...k.layanan.map((l) => l.error)]).find(Boolean))}` : 'Semua bagian yang gagal berhasil diambil ulang. Klik Buka di Monitra untuk memperbarui rekap di Monitra.', 100);
    aturTombol();
  }

  // ---------- rekap terjadwal ----------
  function infoJadwal(berikut) {
    ui.jadwalInfo.textContent = ui.jadwalOn.checked && berikut
      ? `Rekap berikutnya: ${new Date(berikut).toLocaleString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} (Sabtu dan Minggu dilewati). Chrome harus terbuka dan sesi login ATR/BPN masih aktif.`
      : 'Chrome harus terbuka dan Anda sudah login ATR/BPN. Tab dashboard akan dibuka otomatis; hasilnya tampil saat Monitra dibuka.';
  }
  chrome.runtime.sendMessage({ type: 'AMBIL_JADWAL' }).then((r) => {
    if (!r || !r.jadwal) return;
    ui.jadwalOn.checked = !!r.jadwal.aktif;
    if (r.jadwal.jam) ui.jam.value = r.jadwal.jam;
    infoJadwal(r.berikut);
  }).catch(() => {});
  async function simpanJadwal() {
    const k = state.kanwilList.find((x) => String(x.kanwilid) === ui.kanwil.value);
    const jadwal = { aktif: ui.jadwalOn.checked, jam: ui.jam.value || '07:30', kanwil: k ? k.namakanwil : '' };
    const r = await chrome.runtime.sendMessage({ type: 'ATUR_JADWAL', jadwal }).catch(() => null);
    infoJadwal(r && r.berikut);
  }
  ui.jadwalOn.onchange = simpanJadwal;
  ui.jam.onchange = () => { if (ui.jadwalOn.checked) simpanJadwal(); };
  ui.kanwil.addEventListener('change', () => { if (ui.jadwalOn.checked) simpanJadwal(); });

  ui.retry.onclick = ulangiGagal;
  ui.start.onclick = () => { if (!state.running) jalankan(); };
  ui.stop.onclick = () => { state.stop = true; setStatus('Menghentikan setelah permintaan saat ini…'); };
  ui.xlsx.onclick = unduh;
  ui.web.onclick = () => kirimKeMonitra();
})();
