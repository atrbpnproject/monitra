// Berjalan di halaman Monitra. Mengambil hasil rekap yang dititipkan tombol
// "Kirim ke Monitra" lalu menyerahkannya ke halaman lewat window.postMessage.
(async function () {
  const m = /ekstensi=([\w-]+)/.exec(location.hash);
  if (!m) return;
  const id = m[1];
  const r = await chrome.runtime.sendMessage({ type: 'AMBIL_REKAP', id });
  if (!r || !r.hasil) {
    window.postMessage({ type: 'REKAP_TUNGGAKAN_KOSONG', id }, '*');
    return;
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'REKAP_TUNGGAKAN_DITERIMA' || e.data.id !== id) return;
    chrome.runtime.sendMessage({ type: 'REKAP_DITERIMA', id });
    history.replaceState(null, '', location.pathname + location.search);
  });
  window.postMessage({ type: 'REKAP_TUNGGAKAN', id, hasil: r.hasil }, '*');
})();
