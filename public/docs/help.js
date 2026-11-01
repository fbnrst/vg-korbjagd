// Help page (docs/index.html): language, hiding header, QR code on wide screens, DEV look. A file of its own, not inline,
// so the page's Content-Security-Policy needs no 'unsafe-inline' for scripts.
import { lang } from '../i18n.js';
import { IS_DEV } from '../env.js';
document.documentElement.lang = lang;
document.title = lang === 'de' ? 'Hilfe' : 'Help';
document.getElementById('back').textContent = lang === 'de' ? '← Einkaufsliste' : '← Shopping list';
{
  const head = document.querySelector('header');
  let last = scrollY;
  addEventListener('scroll', () => {
    const y = scrollY;
    if (Math.abs(y - last) < 6) return; // ignore jitter
    head.classList.toggle('away', y > last && y > head.offsetHeight);
    last = y;
  }, { passive: true });
}
// the install instructions all start folded: open the one for your device
const appUrl = new URL('../', location.href).href;
if (matchMedia('(min-width: 820px)').matches) {
  const sc = document.createElement('script'); sc.src = '../vendor/qrcode.js';
  sc.onload = () => { const q = window.qrcode(0, 'M'); q.addData(appUrl); q.make(); document.querySelectorAll('[data-qr]').forEach(el => { el.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }); };
  document.head.appendChild(sc);
}
if (IS_DEV) {
  document.title += ' DEV';
  document.getElementById('back').insertAdjacentHTML('afterend', '<span class="devtag">DEV</span>');
}
