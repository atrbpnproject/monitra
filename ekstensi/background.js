// Alamat web Monitra yang menerima hasil rekap.
const MONITRA_URL = 'https://atrbpnproject.github.io/monitra/';
const KUNCI = (id) => 'rekap_' + id;

// Klik ikon ekstensi -> tampilkan/sembunyikan panel di halaman dashboard.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch (e) {
    // Bukan halaman Kinerja Kantor Pertanahan: buka halamannya.
    chrome.tabs.create({ url: 'https://aplikasi.atrbpn.go.id/dashboard/statistik/KinerjaKantorPertanahan' });
  }
});

// Hasil rekap dititipkan sebentar di penyimpanan ekstensi sampai tab Monitra mengambilnya.
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || !m.type) return;
  if (m.type === 'KIRIM_MONITRA') {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    chrome.storage.local.set({ [KUNCI(id)]: { waktu: Date.now(), hasil: m.hasil } })
      .then(() => chrome.tabs.create({ url: MONITRA_URL + '#ekstensi=' + id, index: sender.tab ? sender.tab.index + 1 : undefined }))
      .then(() => reply({ ok: true, id }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (m.type === 'AMBIL_REKAP') {
    chrome.storage.local.get(KUNCI(m.id)).then((o) => reply({ hasil: o[KUNCI(m.id)] ? o[KUNCI(m.id)].hasil : null }));
    return true;
  }
  if (m.type === 'REKAP_DITERIMA') {
    chrome.storage.local.remove(KUNCI(m.id));
  }
});

// Bersihkan titipan yang tidak pernah diambil (lebih dari 1 hari).
chrome.runtime.onStartup.addListener(async () => {
  const semua = await chrome.storage.local.get(null);
  const lama = Object.keys(semua).filter((k) => k.startsWith('rekap_') && Date.now() - (semua[k].waktu || 0) > 864e5);
  if (lama.length) chrome.storage.local.remove(lama);
});
