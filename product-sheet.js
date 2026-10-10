// Phase 84c — the product sheet: "More info" on the showcase slides this panel in from the right (owner 2026-10-07: "a modern
// slide-in with the product's details — no parts and components, focus on the details"). Everything comes from the product card
// (description, specs) and, for the 3D products, the product config (key features, which 3D views exist).
// Phase 87: the 3D buttons moved onto the page (showcase.js, right of the product); the sheet is details only and exports
// open3D (opens the existing 3D drawer and switches it to a view) and views (which views a product has) for the page.
// Opened by the 'inferno:details' event ({ detail: { card } }) that showcase.js dispatches.

const SERVICE = { '01': 'bakkie', '02': 'bakkie', '03': 'trailer', '04': 'beast', '05': 'skiddy', '06': 'vss', '07': 'extinguisher',
  '08': 'guard', '09': 'guard', '10': 'localised', '11': 'transformer' };
const ICON = {
  cube: '<path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
  system: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5l3 8.5M16 7.5l-3 8.5M8.5 6h7"/>',
  cut: '<path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/><path d="M4 14l6-6" stroke-dasharray="2 2"/>',
  fire: '<path d="M12 22c4 0 7-2.7 7-6.6 0-3.1-2-5.4-3.6-7.2-.5 1.6-1.5 2.8-2.7 3.1.4-3.2-1-6.3-3.7-8.3.2 3-1.3 5.2-3 7.2C4.8 11.6 5 13.4 5 15.4 5 19.3 8 22 12 22z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrow: '<path d="M9 18l6-6-6-6"/>'
};
const svg = (k, s = 16) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const el = document.createElement('div');
el.className = 'psheet'; el.hidden = true;
el.innerHTML = `<div class="psheet__overlay" data-close></div>
  <aside class="psheet__panel" role="dialog" aria-modal="true" aria-labelledby="psheet-name">
    <button type="button" class="psheet__close" data-close aria-label="Close details">${svg('close', 18)}</button>
    <div class="psheet__scroll">
      <div class="psheet__hero"><div class="psheet__glow"></div><img class="psheet__img" alt=""></div>
      <div class="psheet__head">
        <div class="psheet__group"></div>
        <img class="psheet__logo" alt="" hidden>
        <h2 class="psheet__name" id="psheet-name"></h2>
        <p class="psheet__desc"></p>
      </div>
      <div class="psheet__explore" hidden><div class="psheet__label">See it in 3D</div><div class="psheet__btns"></div></div>
      <div class="psheet__stats"></div>
      <div class="psheet__features" hidden><div class="psheet__label">Key features</div><ul></ul></div>
      <details class="psheet__specs"><summary><span class="psheet__label">All specifications</span><span class="psheet__count"></span></summary><dl></dl></details>
    </div>
    <div class="psheet__foot">
      <button type="button" class="psheet__quote">Request a Quote ${svg('arrow')}</button>
      <a class="psheet__talk" href="tel:+27104492051">Talk to us</a>
    </div>
  </aside>`;
document.body.appendChild(el);
const $ = s => el.querySelector(s);
const panel = $('.psheet__panel'), scroller = $('.psheet__scroll');
let card = null, returnFocus = null, cfgCache = new Map();

const getCfg = async url => {
  if (!url) return null;
  if (!cfgCache.has(url)) cfgCache.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return cfgCache.get(url);
};

async function open(c, img, glow, groupLabel, logo) {
  card = c; returnFocus = document.activeElement;
  const d = c.dataset;
  let specs = []; try { specs = JSON.parse(d.productSpecs || '[]'); } catch (e) {}
  $('.psheet__img').src = img || ''; $('.psheet__img').alt = d.productName || '';
  el.style.setProperty('--glow', glow || '#e4202c');
  $('.psheet__group').textContent = groupLabel || '';
  $('.psheet__name').textContent = d.productName || '';
  $('.psheet__logo').src = logo || ''; $('.psheet__logo').hidden = !logo; el.classList.toggle('has-logo', !!logo);
  $('.psheet__desc').textContent = d.productDesc || '';
  // three headline numbers: the specs a buyer compares first
  const pick = ['Cannon Range', 'Agent Weight', 'Capacity', 'Cylinder Capacity', 'Hose Length', 'Spray Time', 'Agent', 'Detection', 'Activation', 'Technology'];
  const chosen = [];
  for (const w of pick) { const s = specs.find(x => x.key.startsWith(w) && !chosen.includes(x)); if (s) chosen.push(s); if (chosen.length === 3) break; }
  for (const s of specs) { if (chosen.length >= 3) break; if (!chosen.includes(s) && !/code/i.test(s.key)) chosen.push(s); }
  $('.psheet__stats').innerHTML = chosen.map(s => `<div class="psheet__stat"><div class="psheet__stat-key">${esc(s.key.replace(/\s*\(.*?\)/g, ''))}</div><div class="psheet__stat-val">${esc(s.val)}</div></div>`).join('');
  $('.psheet__specs dl').innerHTML = specs.map(s => `<div><dt>${esc(s.key)}</dt><dd>${esc(s.val)}</dd></div>`).join('');
  $('.psheet__count').textContent = specs.length;
  $('.psheet__specs').open = false;
  $('.psheet__specs').hidden = !specs.length;
  $('.psheet__features').hidden = true; $('.psheet__explore').hidden = true;
  scroller.scrollTop = 0;

  el.hidden = false; void el.offsetWidth; el.classList.add('is-open');
  document.documentElement.classList.add('psheet-open');
  window.__lenis?.stop?.();
  $('.psheet__close').focus({ preventScroll: true });

  // 3D products: their config says which views exist, and carries the key features
  const cfg = d.productModel === 'true' ? await getCfg(d.productConfig) : null;
  if (card !== c) return;
  const feats = (cfg && cfg.keyFeatures || []).filter(f => f && f.title);
  if (feats.length) {
    $('.psheet__features ul').innerHTML = feats.map(f => `<li><span class="psheet__feat-title">${esc(f.title)}</span>${f.description && f.description !== d.productDesc ? `<span class="psheet__feat-text">${esc(f.description)}</span>` : ''}</li>`).join('');
    $('.psheet__features').hidden = false;
  }
}

function close({ restore = true } = {}) {
  if (el.hidden) return;
  el.classList.remove('is-open');
  document.documentElement.classList.remove('psheet-open');
  window.__lenis?.start?.();
  setTimeout(() => { if (!el.classList.contains('is-open')) el.hidden = true; }, 560);
  if (restore && returnFocus && returnFocus.focus) returnFocus.focus({ preventScroll: true });
}

// open the 3D drawer on this product and switch it to the chosen view once the model is in
function open3D(view, c = card) {
  if (!c) return;
  close({ restore: false });
  c.click();
  if (view === 'full') return;
  const glb = (c.dataset.productGlb || '').split('?')[0];
  const t0 = performance.now();
  const visible = s => { const b = document.querySelector(s); return b && b.getClientRects().length && !b.hidden && !b.disabled ? b : null; };
  const wait = () => {
    const v = window.__dv;
    if (performance.now() - t0 > 60000) return;
    if (!(v && v.loaded && v.url && v.url.startsWith(glb))) return setTimeout(wait, 200);
    setTimeout(() => {
      if (view === 'activate') {
        // the VSS discharges from its own button; a cannon product sprays from Gun view, where the stream reads
        const isVss = /vss/.test(c.dataset.productGlb || '');
        if (isVss) {   // the discharge button lives in System view (it is only see-through, not gone, in Full)
          visible('.drawer__mode[data-mode="system"]')?.click();
          setTimeout(() => { const b = visible('.drawer__activate'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); }, 1600);
        } else {
          const foam = () => { const f = visible('.drawer__foam-toggle'); if (f && !(window.DrawerViewer?.getFoam?.())) f.click(); };
          const g = visible('.drawer__mode[data-mode="gun"]');
          if (g) { g.click(); setTimeout(foam, 1600); } else foam();
        }
      } else visible(`.drawer__mode[data-mode="${view}"]`)?.click();
    }, 700);
  };
  setTimeout(wait, 400);
}

// quote: pick the product's service in the contact form, then go there
function quote() {
  const c = card; close({ restore: false });
  const sel = document.querySelector('.contact-form select[name="service"]');
  const key = SERVICE[c?.dataset.productIndex];
  if (sel && key) {
    const o = [...sel.options].find(x => x.text.toLowerCase().includes(key));
    if (o) { o.selected = true; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  const target = document.getElementById('contact');
  setTimeout(() => {
    if (!target) return;
    if (window.__lenis) window.__lenis.scrollTo(target, { offset: -20 }); else target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (sel) { sel.classList.add('is-prefilled'); setTimeout(() => sel.classList.remove('is-prefilled'), 2400); }
  }, 300);
}

el.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) return close();
  const b = e.target.closest('.psheet__btn'); if (b) return open3D(b.dataset.view);
  if (e.target.closest('.psheet__quote')) return quote();
});
document.addEventListener('keydown', e => {
  if (el.hidden) return;
  if (e.key === 'Escape') { e.stopPropagation(); close(); }
  if (e.key === 'Tab') {   // keep focus inside the sheet
    const f = [...panel.querySelectorAll('button, a[href], summary')].filter(x => x.getClientRects().length);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
}, true);
document.addEventListener('inferno:details', e => open(e.detail.card, e.detail.img, e.detail.glow, e.detail.group, e.detail.logo));
// the 3D views a product offers (from its config), for the page's own buttons
async function views(c) {
  const d = c.dataset;
  if (d.productModel !== 'true') return [];
  const cfg = await getCfg(d.productConfig);
  const modes = cfg?.viewer?.presentation?.modes || { full: true };
  const v = ['full'];
  if (modes.system) v.push('system');
  if (modes.cutaway) v.push('cutaway');
  if (modes.gun || /vss/.test(d.productGlb || '')) v.push('activate');
  return v;
}
window.ProductSheet = { open, close, open3D, views };
