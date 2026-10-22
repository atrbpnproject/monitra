// Alamat web Monitra yang menerima hasil rekap.
const MONITRA_URL = 'https://atrbpnproject.github.io/monitra/';
const ATR_URL = 'https://aplikasi.atrbpn.go.id/dashboard/statistik/KinerjaKantorPertanahan';
const KUNCI = (id) => 'rekap_' + id;
const BATAS_TUGAS_MS = 30 * 60 * 1000;
const ALARM = 'rekap-terjadwal';

// Klik ikon ekstensi -> tampilkan/sembunyikan panel di halaman dashboard.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch (e) {
    // Bukan halaman Kinerja Kantor Pertanahan: buka halamannya.
    chrome.tabs.create({ url: ATR_URL });
  }
});

async function tabAda(id) {
  try { return await chrome.tabs.get(id); } catch (e) { return null; }
}
async function tampilkan(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}
async function ambilTugas() {
  const { tugas } = await chrome.storage.local.get('tugas');
  if (!tugas || Date.now() - tugas.waktu > BATAS_TUGAS_MS) return null;
  return tugas;
}
async function lapor(tugas, tahap, pesan, pct) {
  if (!tugas || !tugas.monitraTab) return;
  chrome.tabs.sendMessage(tugas.monitraTab, { type: 'STATUS_REKAP', tahap, pesan, pct }).catch(() => {});
}

// Buka (atau aktifkan) tab dashboard lalu minta panel menjalankan tugas.
// Tab dashboard dibuat aktif karena Chrome memperlambat timer di tab latar belakang.
async function bukaDashboard(index) {
  const [tab] = await chrome.tabs.query({ url: ATR_URL + '*' });
  if (tab) {
    await tampilkan(tab);
    try { await chrome.tabs.sendMessage(tab.id, { type: 'MULAI_TUGAS' }); } catch (e) { await chrome.tabs.reload(tab.id); }
  } else {
    await chrome.tabs.create({ url: ATR_URL, index });
  }
}

// Monitra meminta rekap: catat permintaannya, lalu buka dashboard.
async function mintaRekap(m, sender) {
  const tugas = { monitraTab: sender.tab.id, kanwil: m.kanwil || '', waktu: Date.now(), dimulai: false };
  await chrome.storage.local.set({ tugas });
  await bukaDashboard(sender.tab.index + 1);
}

// Hasil rekap dititipkan sebentar di penyimpanan ekstensi sampai tab Monitra mengambilnya.
// Rekap terjadwal hanya dititipkan; Monitra mengambilnya saat dibuka atau dilihat lagi.
async function kirim(m, sender) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await chrome.storage.local.set({ [KUNCI(id)]: { waktu: Date.now(), hasil: m.hasil, terjadwal: !!m.terjadwal } });
  await chrome.storage.local.remove('tugas');
  if (m.terjadwal) return { ok: true, id, tertunda: true };
  const tujuan = m.tujuan && (await tabAda(m.tujuan));
  if (tujuan) {
    try {
      await chrome.tabs.sendMessage(tujuan.id, { type: 'REKAP_SIAP', id });
      await tampilkan(tujuan);
      return { ok: true, id, tabBaru: false };
    } catch (e) { /* tab Monitra sudah berpindah halaman: buka tab baru */ }
  }
  await chrome.tabs.create({ url: MONITRA_URL + '#ekstensi=' + id, index: sender.tab ? sender.tab.index + 1 : undefined });
  return { ok: true, id, tabBaru: true };
}

// ---------- rekap terjadwal ----------
// jadwal: { aktif, jam: 'HH:MM', kanwil }
function waktuBerikut(jam) {
  const [h, mnt] = String(jam || '07:30').split(':').map(Number);
  const t = new Date();
  t.setHours(h || 0, mnt || 0, 0, 0);
  if (t <= new Date()) t.setDate(t.getDate() + 1);
  return t.getTime();
}
async function aturJadwal(jadwal) {
  await chrome.storage.local.set({ jadwal });
  await chrome.alarms.clear(ALARM);
  if (jadwal && jadwal.aktif) chrome.alarms.create(ALARM, { when: waktuBerikut(jadwal.jam), periodInMinutes: 24 * 60 });
  return { ok: true, berikut: jadwal && jadwal.aktif ? waktuBerikut(jadwal.jam) : null };
}
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  const { jadwal } = await chrome.storage.local.get('jadwal');
  if (!jadwal || !jadwal.aktif) return;
  const hari = new Date().getDay();
  if (hari === 0 || hari === 6) return; // hanya hari kerja
  // Alarm yang tertunda (komputer tidur, Chrome tertutup) dijalankan bila masih di hari yang sama.
  if (Date.now() - a.scheduledTime > 12 * 3600 * 1000) return;
  const tugas = { monitraTab: null, kanwil: jadwal.kanwil || '', waktu: Date.now(), dimulai: false, terjadwal: true };
  await chrome.storage.local.set({ tugas });
  await bukaDashboard();
});

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || !m.type) return;
  const balas = (p) => p.then(reply, (e) => reply({ ok: false, error: e.message }));
  switch (m.type) {
    case 'KIRIM_MONITRA':
      balas(kirim(m, sender));
      return true;
    case 'AMBIL_REKAP':
      balas(chrome.storage.local.get(KUNCI(m.id)).then((o) => {
        const t = o[KUNCI(m.id)];
        return { hasil: t ? t.hasil : null, terjadwal: !!(t && t.terjadwal) };
      }));
      return true;
    case 'TITIPAN_TERTUNDA':
      balas(chrome.storage.local.get(null).then((o) => ({
        ids: Object.keys(o).filter((k) => k.startsWith('rekap_') && o[k].terjadwal).sort((a, b) => o[a].waktu - o[b].waktu).map((k) => k.slice(6)),
      })));
      return true;
    case 'REKAP_DITERIMA':
      chrome.storage.local.remove(KUNCI(m.id));
      return;
    case 'MINTA_REKAP':
      balas(mintaRekap(m, sender).then(() => ({ ok: true })));
      return true;
    case 'AMBIL_TUGAS':
      balas(ambilTugas().then((t) => (t && !t.dimulai ? t : null)));
      return true;
    case 'TUGAS_DIMULAI':
      ambilTugas().then((t) => t && chrome.storage.local.set({ tugas: { ...t, dimulai: true } }));
      return;
    case 'STATUS_TUGAS':
      ambilTugas().then((t) => {
        lapor(t, m.tahap, m.pesan, m.pct);
        if (t && m.tahap === 'gagal' && t.dimulai) chrome.storage.local.remove('tugas');
      });
      return;
    case 'AMBIL_JADWAL':
      balas(Promise.all([chrome.storage.local.get('jadwal'), chrome.alarms.get(ALARM)]).then(([o, a]) => ({ jadwal: o.jadwal || null, berikut: a ? a.scheduledTime : null })));
      return true;
    case 'ATUR_JADWAL':
      balas(aturJadwal(m.jadwal));
      return true;
  }
});

// Bersihkan titipan yang tidak pernah diambil (lebih dari 3 hari).
chrome.runtime.onStartup.addListener(async () => {
  const semua = await chrome.storage.local.get(null);
  const lama = Object.keys(semua).filter((k) => k.startsWith('rekap_') && Date.now() - (semua[k].waktu || 0) > 3 * 864e5);
  if (lama.length) chrome.storage.local.remove(lama);
});
