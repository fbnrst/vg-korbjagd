// Privacy page (privacy.html): language, DEV look and contact details. A file of its own, not inline, so the page's
// Content-Security-Policy needs no 'unsafe-inline' for scripts.
import { lang } from './i18n.js';
import { IS_DEV } from './env.js';
import legal from './legal-config.js';
document.documentElement.lang = lang;
document.title = lang === 'de' ? 'Datenschutz' : 'Privacy';
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
if (IS_DEV) {
  document.title += ' DEV';
  document.getElementById('back').insertAdjacentHTML('afterend', '<span class="devtag">DEV</span>');
}
document.querySelectorAll('.who').forEach(el => { el.textContent = legal.name; });
document.querySelectorAll('.contact').forEach(el => {
  const a = document.createElement('a');
  if (legal.email) { a.href = 'mailto:' + legal.email; a.textContent = legal.email; }
  else { a.href = legal.contactUrl; a.textContent = legal.contactUrl.replace(/^https:\/\//, ''); a.rel = 'noopener'; }
  el.append(a);
});
