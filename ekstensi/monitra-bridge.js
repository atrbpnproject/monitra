// Berjalan di halaman Monitra. Menghubungkan halaman dengan ekstensi lewat window.postMessage:
// - mengumumkan bahwa ekstensi terpasang (REKAP_EKSTENSI_ADA),
// - meneruskan tombol "Rekap Sekarang" (REKAP_MINTA) dan status rekap (REKAP_STATUS),
// - menyerahkan hasil rekap yang dititipkan ekstensi (REKAP_TUNGGAKAN).
(function () {
  const VERSI = chrome.runtime.getManifest().version;
  const kirimKeHalaman = (data) => window.postMessage(data, '*');
  const umumkan = () => kirimKeHalaman({ type: 'REKAP_EKSTENSI_ADA', versi: VERSI });
  const putus = () => kirimKeHalaman({ type: 'REKAP_STATUS', tahap: 'gagal', pesan: 'Ekstensi baru saja dimuat ulang. Muat ulang halaman ini lalu coba lagi.' });

  async function serahkan(id) {
    let r;
    try { r = await chrome.runtime.sendMessage({ type: 'AMBIL_REKAP', id }); } catch (e) { putus(); return; }
    if (!r || !r.hasil) kirimKeHalaman({ type: 'REKAP_TUNGGAKAN_KOSONG', id });
    else kirimKeHalaman({ type: 'REKAP_TUNGGAKAN', id, hasil: r.hasil });
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data) return;
    const d = e.data;
    if (d.type === 'REKAP_EKSTENSI_PING') umumkan();
    if (d.type === 'REKAP_MINTA') {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'MINTA_REKAP', kanwil: d.kanwil || '' });
        if (!r || !r.ok) throw new Error((r && r.error) || 'tidak ada balasan');
        kirimKeHalaman({ type: 'REKAP_STATUS', tahap: 'mulai', pesan: 'Membuka dashboard Kinerja Kantor Pertanahan…', pct: 0 });
      } catch (err) {
        if (/context invalidated/i.test(err.message)) putus();
        else kirimKeHalaman({ type: 'REKAP_STATUS', tahap: 'gagal', pesan: 'Ekstensi gagal memulai rekap: ' + err.message });
      }
    }
    if (d.type === 'REKAP_TUNGGAKAN_DITERIMA' && d.id) {
      chrome.runtime.sendMessage({ type: 'REKAP_DITERIMA', id: d.id }).catch(() => {});
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }
  });

  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m && m.type === 'STATUS_REKAP') kirimKeHalaman({ type: 'REKAP_STATUS', tahap: m.tahap, pesan: m.pesan, pct: m.pct });
    if (m && m.type === 'REKAP_SIAP') serahkan(m.id);
    reply({ ok: true });
  });

  umumkan();
  const h = /ekstensi=([\w-]+)/.exec(location.hash);
  if (h) serahkan(h[1]);
})();
