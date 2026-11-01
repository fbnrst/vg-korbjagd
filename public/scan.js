// Scanner input without list state: the camera (the browser's BarcodeDetector where it exists, Chrome/Android; zxing,
// bundled, on iOS) and the product name of a barcode from Open Food Facts. What a code means is classifyScan in flows.js,
// what happens with it is handleCode in app.js.
import { loadScript } from './ui.js';
import { timeoutSignal } from './vg.js';

const loadZxing = () => loadScript(new URL('vendor/zxing.min.js', import.meta.url), () => window.ZXing); // @zxing/library 0.21.3, bundled (no CDN)

// `video`: the <video> element. `onCode(text)` gets every code read (with BarcodeDetector it is awaited, so a question
// pauses the loop); `onFail()` when the camera cannot start. stop() also cancels a start that is still on its way (typing a
// number in the scanner switches the camera off while it may still be starting): a token invalidates pending starts.
export function createCamera(video, { onCode, onFail }) {
  let reader = null, stream = null, token = 0;
  function stop() {
    token++;
    if (reader) { reader.reset(); reader = null; }
    if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    video.srcObject = null;
  }
  // `join`: QR codes of lists instead of product barcodes
  async function start(join = false) {
    const my = ++token;
    try {
      if ('BarcodeDetector' in window && (!join || (await BarcodeDetector.getSupportedFormats()).includes('qr_code'))) { // compat-ok: guarded by 'in window' (Chrome/Android: built in, iOS uses zxing)
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (my !== token) { s.getTracks().forEach(track => track.stop()); return; }
        stream = s; video.srcObject = s; await video.play();
        const det = new BarcodeDetector({ formats: join ? ['qr_code'] : ['ean_13', 'ean_8', 'upc_a', 'upc_e'] }); // compat-ok: only reached when the guard above found the detector (iOS uses zxing)
        const loop = async () => {
          if (!stream || my !== token) return;
          try { const r = await det.detect(video); if (r[0]) { await onCode(r[0].rawValue); if (!stream || my !== token) return; } } catch (e) {}
          setTimeout(loop, 200);
        };
        loop();
      } else { // iOS/Safari etc.: load zxing on demand
        await loadZxing();
        if (my !== token) return;
        reader = new ZXing.BrowserMultiFormatReader();
        reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, r => { if (r) onCode(r.getText()); });
      }
    } catch (e) {
      if (my === token) onFail();
    }
  }
  return { start, stop };
}

// The product name of a barcode (Open Food Facts), or null. Weak signal in a shop: after a few seconds the scan goes on
// without the name instead of blocking the scanner.
export async function productName(ean) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=product_name,product_name_de,brands`, { signal: timeoutSignal(5000) });
    const j = await r.json();
    if (j.status !== 1) return null;
    const p = j.product, name = p.product_name_de || p.product_name;
    return name ? (p.brands ? `${name} (${p.brands.split(',')[0]})` : name) : null;
  } catch (e) { return null; }
}
