// Mobile product-first viewer (Phase 23).
//
// A UI layer over the existing product drawer and DrawerViewer: nothing in this file renders, frames or
// loads the model. On a phone, a portrait tablet or a landscape phone, every product opens full-screen — a minimal
// header, controls in the thumb zone and an information sheet that slides over the model (Phase 42: products without
// a 3D model show their photo and say so). Everywhere else the drawer is untouched (the elements below are only
// created the first time the layout is used).
//
//   ProductViewer          orchestration: when the layout applies, drawer hooks, history, focus, model composition
//   ProductViewerControls  header (back, product name) and the floating controls (Product info, Reset)
//   ProductInfoSheet       CLOSED / PEEK / EXPANDED bottom sheet (a side sheet on a landscape phone)
//   ProductInfoSection     one section of the sheet, rendered from product data; omitted when there is no data
//   ProductLoadingState    "Loading 3D model" until the viewer reports the model ready (dv:ready / dv:error)
//
// Product data is plain data (productFromCard() reads today's card attributes; any object of the same
// shape renders). While the sheet is open the model is moved with a CSS transform on the canvas — the
// WebGL canvas is never resized and the camera is never touched.

export const PRODUCT_VIEWER_CONFIG = {
  // Phase 86 (owner: "the 3D full-screen on desktop too"): every screen gets the product-first viewer — full-screen model, floating
  // controls, details on demand. (Before: phones, portrait tablets and landscape phones only; desktop kept the split drawer.)
  media: 'all',
  sideMaxHeight: 540,                      // landscape at or below this height: the sheet comes in from the right
  peek: { share: 0.46, min: 260, max: 480 },   // PEEK height, share of the viewer height
  productRoom: 140,                        // PEEK always leaves at least this much of the model above the sheet
  rest: { max: 56, band: 72 },             // CLOSED: lift the model into the free space (≤ max px); `band` = opaque base of
                                           // the bottom fade in styles.css, which hides the strip the lift uncovers
  strip: { share: 0.16, min: 96, max: 180 },   // model strip kept above the EXPANDED sheet
  side: { share: 0.46, min: 300, max: 420 },   // side sheet width (landscape phone)
  durationMs: 380,                         // sheet and model move together (matches --pv-dur; 0 with reduced motion)
  flingPxPerMs: 0.45,                      // release speed that moves the sheet on to the next state
  dragSlopPx: 6,
  tap: { maxMs: 280, slopPx: 10, doubleMs: 320, doubleSlopPx: 28 },
  hintKey: 'pv.hint.v1',                   // first-use hint, shown until the first interaction (once per browser)
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode: the hint just shows again next visit */ } },
};

// Element helper. Text always goes in through textContent; `html` is only used for the static icons below.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c) el.append(c);
  return el;
}

// One line-icon language for the whole mobile viewer (Phase 40): 24 px grid, 1.7 px stroke, round joins.
const ICON = (d, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const SVG = {
  back: ICON('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
  info: ICON('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6h.01" stroke-width="2.4"/>'),
  reset: ICON('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4.2h4.2"/>'),
  close: ICON('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  chevUp: ICON('<path d="M6.5 14.5L12 9l5.5 5.5"/>', 18),
  chevLeft: ICON('<path d="M14.5 6L8.5 12l6 6"/>', 18),
  chevRight: ICON('<path d="M9.5 6l6 6-6 6"/>', 18),
  arrowRight: ICON('<path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5"/>', 18),
  phone: ICON('<path d="M6.2 4h2.6l1.7 4.3-2.1 1.3a10.5 10.5 0 0 0 6 6l1.3-2.1 4.3 1.7v2.6a1.7 1.7 0 0 1-1.8 1.7A15.3 15.3 0 0 1 4.5 5.8 1.7 1.7 0 0 1 6.2 4z"/>', 18),
  model: ICON('<path d="M12 3.2l7.8 4.4v8.8L12 20.8l-7.8-4.4V7.6z"/><path d="M4.2 7.6L12 12l7.8-4.4M12 12v8.8"/>', 26),
  full: ICON('<path d="M12 3.2l7.8 4.4v8.8L12 20.8l-7.8-4.4V7.6z"/><path d="M4.2 7.6L12 12l7.8-4.4M12 12v8.8"/>'),
  system: ICON('<circle cx="6" cy="6.5" r="2"/><circle cx="18" cy="6.5" r="2"/><circle cx="12" cy="17.5" r="2"/><path d="M8 6.5h8M7 8.3l4 7.4M17 8.3l-4 7.4"/>'),
  component: ICON('<path d="M12 3.5l8.5 4.7L12 13 3.5 8.2z"/><path d="M3.5 12.4L12 17.2l8.5-4.8"/><path d="M3.5 16.4L12 21l8.5-4.6" opacity=".55"/>'),
  focus: ICON('<path d="M4 8.5V5.2c0-.7.5-1.2 1.2-1.2h3.3M15.5 4h3.3c.7 0 1.2.5 1.2 1.2v3.3M20 15.5v3.3c0 .7-.5 1.2-1.2 1.2h-3.3M8.5 20H5.2c-.7 0-1.2-.5-1.2-1.2v-3.3"/><circle cx="12" cy="12" r="2.6"/>', 18),
  whole: ICON('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 18),
};

// ── Product data ────────────────────────────────────────────────────────────────
const APPLICATION_KEY = /^(applications?|use case)$/i;
const json = (s, fallback) => { if (!s) return fallback; try { return JSON.parse(s); } catch (e) { return fallback; } };

/** Every field the sheet understands; missing ones are simply not shown. */
export function normalizeProduct(p = {}) {
  return { id: '', name: '', category: '', summary: '', description: '', logo: null,
    keySpecs: [], features: [], applications: [], technical: [], photos: [], views: [], components: [], componentCategories: [], ...p };
}

/** Product data from a product card as the site marks them up today (data-product-* attributes). */
export function productFromCard(card, { category = '' } = {}) {
  const d = card.dataset;
  const specs = json(d.productSpecs, []).filter(s => s && s.key && s.val);
  const rest = specs.slice(3), apps = json(d.productApplications, null);
  const photos = json(d.productPhotos, []);
  if (!photos.length && d.productThumb) photos.push(d.productThumb);
  const summary = card.querySelector('.product-card__desc');
  return normalizeProduct({
    id: d.productIndex || '', name: d.productName || '', category,
    logo: d.productLogo || null,
    summary: summary ? summary.textContent.trim() : '',
    description: d.productDesc || '',
    keySpecs: specs.slice(0, 3),
    features: json(d.productFeatures, []),
    // An "Application" / "Use case" spec row reads better as its own section than as a table row.
    applications: apps || rest.filter(s => APPLICATION_KEY.test(s.key)).map(s => s.val),
    technical: apps ? rest : rest.filter(s => !APPLICATION_KEY.test(s.key)),
    photos,
  });
}

// ── Sections ──────────────────────────────────────────────────────────────────────
export class ProductInfoSection {
  constructor({ id, title = null, label = null, render }) { this.id = id; this.title = title; this.label = label; this.renderBody = render; }
  render(product, ctx) {
    const body = this.renderBody(product, ctx);
    if (!body) return null;
    const hid = `pv-sec-${this.id}`;
    return h('section', { class: `pv-section pv-section--${this.id}`, 'aria-labelledby': this.title ? hid : null, 'aria-label': this.title ? null : this.label },
      this.title && h('h3', { class: 'pv-section__title', id: hid, text: this.title }), body);
  }
}

function specList(items, cls) {
  return h('dl', { class: cls }, items.map(s => h('div', { class: 'pv-spec' }, h('dt', { text: s.key }), h('dd', { text: s.val }))));
}
// Long copy in short paragraphs (two sentences each) instead of one block.
function paragraphs(text) {
  const sentences = []; let cur = '';
  for (const tok of text.split(/(\s+)/)) { cur += tok; if (/[.!?]["”')]?$/.test(tok)) { sentences.push(cur.trim()); cur = ''; } }
  if (cur.trim()) sentences.push(cur.trim());
  const paras = [];
  for (let i = 0; i < sentences.length; i += 2) paras.push(sentences.slice(i, i + 2).join(' '));
  return h('div', { class: 'pv-prose' }, paras.map(t => h('p', { text: t })));
}
// Specifications with groups (Phase 28): a heading per group, the group's rows as one list; ungrouped rows first.
function groupedSpecs(items) {
  if (!items.some(s => s.group)) return techList(items);
  const order = [], by = new Map();
  for (const s of items) { const g = s.group || ''; if (!by.has(g)) { by.set(g, []); order.push(g); } by.get(g).push(s); }
  return h('div', { class: 'pv-specgroups' }, order.map(g => h('div', { class: 'pv-specgroup' },
    g && h('h4', { class: 'pv-specgroup__title', text: g }), specList(by.get(g), 'pv-specs pv-specs--tech'))));
}
// Key features: plain strings, or { title, text, componentId } — a feature linked to a 3D component offers "Show in 3D"
function featureList(p, ctx) {
  return h('ul', { class: 'pv-features' }, p.features.map(f => {
    if (typeof f === 'string') return h('li', { text: f });
    const link = f.componentId && ctx.componentAvailable(f.componentId) && (() => {
      const b = h('button', { type: 'button', class: 'pv-feature-link', 'aria-label': `Show ${f.title} in 3D`, text: 'Show in 3D' });
      b.addEventListener('click', () => ctx.component({ id: f.componentId }));
      return b;
    })();
    return h('li', null, h('strong', { text: f.title }), f.text && h('span', { text: f.text }), link);
  }));
}
function applicationList(p) {
  const items = p.applications.map(a => (typeof a === 'string' ? { title: a, text: '' } : a));
  if (!items.some(a => a.text)) return h('ul', { class: 'pv-chips' }, items.map(a => h('li', { text: a.title })));
  return h('ul', { class: 'pv-features pv-apps' }, items.map(a => h('li', null, h('strong', { text: a.title }), a.text && h('span', { text: a.text }))));
}
function techList(items) {
  const LIMIT = 6, dl = specList(items, 'pv-specs pv-specs--tech');
  if (items.length <= LIMIT) return dl;
  const rows = [...dl.children].slice(LIMIT);
  rows.forEach(r => { r.hidden = true; });
  const more = h('button', { type: 'button', class: 'pv-more', 'aria-expanded': 'false', text: `Show all ${items.length}` });
  more.addEventListener('click', () => {
    const open = more.getAttribute('aria-expanded') !== 'true';
    rows.forEach(r => { r.hidden = !open; });
    more.setAttribute('aria-expanded', String(open));
    more.textContent = open ? 'Show fewer' : `Show all ${items.length}`;
  });
  return h('div', null, dl, more);
}
const VIEW_TEXT = {
  full: ['Full view', 'The complete product, as installed'],
  system: ['System view', 'The carrier fades away to show the fire-suppression system'],
  gun: ['Cannon', 'The foam cannon up close'],
  cutaway: ['Cutaway', 'A section through the cylinder'],
};
const exploreItem = (attrs, label, note, onClick, icon = null) => {
  const b = h('button', { type: 'button', class: 'pv-explore__item', ...attrs },
    icon && h('span', { class: 'pv-explore__icon', 'aria-hidden': 'true', html: icon }),
    h('span', { class: 'pv-explore__text' }, h('span', { class: 'pv-explore__label', text: label }), note && h('span', { class: 'pv-explore__note', text: note })),
    h('span', { class: 'pv-explore__chev', 'aria-hidden': 'true', html: SVG.chevRight }));
  b.addEventListener('click', onClick);
  return h('li', null, b);
};
function explore(p, ctx) {
  const views = p.views.length > 1 ? p.views : [];
  if (!views.length) return null;
  const cur = ctx.currentMode();
  return h('ul', { class: 'pv-explore' },
    views.map(v => { const [label, note] = VIEW_TEXT[v] || [v, '']; return exploreItem({ 'data-view': v, 'aria-pressed': String(v === cur) }, label, note, () => ctx.setView(v), SVG[v] || SVG.full); }));
}
function gallery(p, ctx) {
  const alts = new Map((p.photoItems || []).map(m => [m.src, m.alt]));   // Phase 29: the data's own description of each photo
  return h('ul', { class: 'pv-gallery' }, p.photos.map((src, i) => {
    const b = h('button', { type: 'button', class: 'pv-gallery__item', 'aria-label': alts.get(src) ? `Open photo: ${alts.get(src)}` : `Open photo ${i + 1} of ${p.photos.length}` },
      h('img', { src, alt: '', loading: 'lazy', decoding: 'async' }));
    b.addEventListener('click', () => ctx.openPhoto(src));
    return h('li', null, b);
  }));
}
function contact(p, ctx) {
  const quote = h('button', { type: 'button', class: 'pv-cta pv-cta--primary' }, h('span', { text: 'Request a quote' }), h('span', { class: 'pv-cta__icon', 'aria-hidden': 'true', html: SVG.arrowRight }));
  quote.addEventListener('click', () => ctx.quote());
  return h('div', { class: 'pv-contact' }, quote, ctx.phone && h('a', { class: 'pv-cta pv-cta--ghost', href: ctx.phone },
    h('span', { class: 'pv-cta__icon', 'aria-hidden': 'true', html: SVG.phone }), h('span', { text: 'Talk to us' })));
}

// Component explorer (Phase 25 list, Phase 26 categories): product data → selectable parts of the 3D model, grouped by
// the product's own categories. The page's interaction layer owns the selection and decides what a choice does
// (select, highlight, focus); the explorer only shows it. Keyboard and screen-reader route to every component.
function componentExplorer(p, ctx, current = null) {
  if (!p.components.length) return null;
  const byId = new Map(p.components.map(c => [c.id, c]));
  const cats = p.componentCategories.length ? p.componentCategories : [{ id: 'components', name: '', components: p.components.map(c => c.id), implicit: true }];
  const solo = cats.length === 1 && cats[0].implicit;
  return h('div', { class: 'pv-cexplorer' }, cats.map(k => h('div', { class: 'pv-ccat' },
    !solo && h('h4', { class: 'pv-ccat__title', text: k.name }),
    h('ul', { class: 'pv-explore pv-components' }, k.components.map(id => byId.get(id)).filter(Boolean).map(c => {
      const ok = ctx.componentAvailable(c.id), view = c.camera && c.camera.view && ctx.viewLabel(c.camera.view);
      const note = ok ? [c.shortDescription || c.note, view ? `Opens in ${view} view` : ''].filter(Boolean).join(' · ') : 'Not in this 3D model';
      return exploreItem({ 'data-component': c.id, 'aria-pressed': String(c.id === current), 'aria-disabled': ok ? null : 'true' }, c.name, note, () => { if (ok) ctx.component(c); }, SVG.component);
    })))));
}
// Order: the sheet head carries the name and one-line summary, so PEEK shows the key specifications next; then the
// content hierarchy (Phase 28): overview → key features → applications → interactive components → full specifications.
export const INFO_SECTIONS = [
  new ProductInfoSection({ id: 'specs', title: 'Key specifications', render: p => p.keySpecs.length ? specList(p.keySpecs, 'pv-specs pv-specs--key') : null }),
  new ProductInfoSection({ id: 'overview', title: 'Overview', render: p => p.description ? paragraphs(p.description) : null }),
  new ProductInfoSection({ id: 'features', title: 'Key features', render: (p, ctx) => p.features.length ? featureList(p, ctx) : null }),
  new ProductInfoSection({ id: 'applications', title: 'Applications', render: p => p.applications.length ? applicationList(p) : null }),
  new ProductInfoSection({ id: 'interactive', title: 'Interactive components', render: (p, ctx) => componentExplorer(p, ctx, ctx.selectedComponent()) }),
  new ProductInfoSection({ id: 'technical', title: 'Technical information', render: p => p.technical.length ? groupedSpecs(p.technical) : null }),
  new ProductInfoSection({ id: 'views', title: 'Explore in 3D', render: explore }),
  new ProductInfoSection({ id: 'gallery', title: 'Photos', render: (p, ctx) => p.photos.length ? gallery(p, ctx) : null }),
  new ProductInfoSection({ id: 'contact', label: 'Contact', render: contact }),
];

// ── Loading state ───────────────────────────────────────────────────────────────
export class ProductLoadingState {
  constructor(host, { onRetry } = {}) {
    this.text = h('span', { class: 'pv-loading__text' });
    this.sub = h('span', { class: 'pv-loading__sub' });
    this.retry = h('button', { type: 'button', class: 'pv-btn pv-loading__retry', hidden: true }, h('span', { 'aria-hidden': 'true', html: SVG.reset }), h('span', { text: 'Try again' }));
    if (onRetry) this.retry.addEventListener('click', onRetry);
    this.el = h('div', { class: 'pv-loading pv-ui', 'data-state': 'idle' },
      h('span', { class: 'pv-loading__icon', 'aria-hidden': 'true', html: SVG.model }),
      h('div', { class: 'pv-loading__msg', role: 'status', 'aria-live': 'polite' }, this.text, this.sub),
      h('span', { class: 'pv-loading__bar', 'aria-hidden': 'true' }, h('span')), this.retry);
    host.append(this.el);
  }
  // 'loading' | 'ready' | 'error' | 'idle'
  set(state) {
    this.state = state;
    this.el.dataset.state = state;
    this.retry.hidden = state !== 'error';
    if (state === 'loading') { this.text.textContent = 'Loading 3D model'; this.sub.textContent = ''; }
    else if (state === 'error') { this.text.textContent = '3D model unavailable'; this.sub.textContent = 'Product information is still available below.'; }
    else if (state === 'none') { this.text.textContent = '3D view not available for this product'; this.sub.textContent = ''; }   // Phase 41: no model at all
  }
}

// ── Header + floating controls ────────────────────────────────────────────────
export class ProductViewerControls {
  constructor(host, { onBack, onInfo, onInfoAll, onReset }) {
    this.back = h('button', { type: 'button', class: 'pv-btn pv-btn--icon pv-back', 'aria-label': 'Back to products', html: SVG.back });
    this.eyebrow = h('span', { class: 'pv-header__eyebrow' });
    this.name = h('span', { class: 'pv-header__name', id: 'pv-header-name' });
    this.infoTop = h('button', { type: 'button', class: 'pv-btn pv-btn--icon pv-infotop', 'aria-label': 'All product information', 'aria-controls': 'pv-sheet', 'aria-expanded': 'false', 'aria-haspopup': 'dialog', html: SVG.info });
    // Phase 86: a quote action in the header (wide screens) — the drawer's own enquire button does the prefill + scroll
    this.quote = h('button', { type: 'button', class: 'pv-quote', html: 'Request a Quote' });
    this.quote.addEventListener('click', () => { const b = document.querySelector('.drawer__cta--primary'); if (b) b.click(); });
    this.header = h('header', { class: 'pv-header pv-ui' }, this.back,
      h('div', { class: 'pv-header__title' }, this.eyebrow, this.name), this.quote, this.infoTop);
    // Phase 40: the product strip (a collapsed information panel) replaces the "Product info" pill; same button, same job.
    this.stripName = h('span', { class: 'pv-info__name' });
    this.stripMeta = h('span', { class: 'pv-info__meta' });
    this.info = h('button', { type: 'button', class: 'pv-btn pv-info', 'aria-controls': 'pv-sheet', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' },
      h('span', { class: 'pv-info__grip', 'aria-hidden': 'true' }),
      h('span', { class: 'pv-info__text' }, this.stripName, this.stripMeta),
      h('span', { class: 'pv-info__chev', 'aria-hidden': 'true', html: SVG.chevUp }));
    this.reset = h('button', { type: 'button', class: 'pv-btn pv-btn--icon pv-reset', 'aria-label': 'Reset view', html: SVG.reset });
    this.bar = h('div', { class: 'pv-controls pv-ui', role: 'group', 'aria-label': 'Model controls' }, this.reset, this.info);
    host.prepend(this.header);           // first in the tab order: back, info, then the model controls
    host.append(this.bar);
    this.back.addEventListener('click', onBack);
    this.infoTop.addEventListener('click', onInfoAll);
    this.info.addEventListener('click', onInfo);
    this.reset.addEventListener('click', onReset);
  }
  setProduct(p) {
    this.eyebrow.textContent = p.category || '';
    this.eyebrow.hidden = !p.category;
    this.name.textContent = p.name;
    const n = (p.components || []).length;
    this.stripName.textContent = p.name;
    this.stripMeta.textContent = [p.category, n ? `${n} component${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    this.stripMeta.hidden = !this.stripMeta.textContent;
    this.info.setAttribute('aria-label', `Product information: ${p.name}`);
  }
}

// ── Information sheet ─────────────────────────────────────────────────────────
// Bottom layout: the sheet is EXPANDED-tall and translated down, so PEEK and EXPANDED differ only in
// its transform. Side layout (landscape phone): one open state beside the model.
export class ProductInfoSheet {
  constructor(host, { config, onChange, onMove, onDrag, sections = INFO_SECTIONS }) {
    this.cfg = config; this.onChange = onChange; this.onMove = onMove; this.onDrag = onDrag; this.sections = sections;
    this.state = 'closed'; this.offset = 0; this.side = false; this.m = null; this.drag = null; this.pull = null;
    this.handle = h('button', { type: 'button', class: 'pv-sheet__handle', 'aria-controls': 'pv-sheet-body', 'aria-expanded': 'false', 'aria-label': 'Show all product information' },
      h('span', { 'aria-hidden': 'true' }));
    this.eyebrow = h('p', { class: 'pv-sheet__eyebrow' });
    this.title = h('h2', { class: 'pv-sheet__title', id: 'pv-sheet-title', tabindex: '-1' });
    this.tagline = h('p', { class: 'pv-sheet__tagline' });
    this.closeBtn = h('button', { type: 'button', class: 'pv-btn pv-btn--icon pv-sheet__close', 'aria-label': 'Close product information', html: SVG.close });
    this.grab = h('div', { class: 'pv-sheet__grab' }, this.handle,
      h('div', { class: 'pv-sheet__head' }, h('div', { class: 'pv-sheet__titles' }, this.eyebrow, this.title, this.tagline), this.closeBtn));
    this.inner = h('div', { class: 'pv-sheet__inner' });
    this.body = h('div', { class: 'pv-sheet__body', id: 'pv-sheet-body', 'data-lenis-prevent': '' }, this.inner);
    this.el = h('section', { class: 'pv-sheet pv-ui is-closed', id: 'pv-sheet', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'pv-sheet-title', 'data-state': 'closed', inert: true },
      this.grab, this.body);
    host.append(this.el);

    this.handle.addEventListener('click', () => { if (!this.side) this.setState(this.state === 'expanded' ? 'peek' : 'expanded'); });
    this.closeBtn.addEventListener('click', () => this.setState('closed', { restoreFocus: true }));
    for (const el of [this.grab, this.body]) el.addEventListener('pointerdown', e => this.down(e));
    this.el.addEventListener('pointermove', e => this.move(e));
    this.el.addEventListener('pointerup', e => this.up(e));
    this.el.addEventListener('pointercancel', e => this.up(e));
    // EXPANDED: the body scrolls natively; pulling down from its top drags the sheet instead.
    this.body.addEventListener('touchstart', e => this.tstart(e), { passive: true });
    this.body.addEventListener('touchmove', e => this.tmove(e), { passive: false });
    this.body.addEventListener('touchend', e => this.tend(e), { passive: true });
    this.body.addEventListener('touchcancel', e => this.tend(e), { passive: true });
    // Keyboard focus reaching content below the PEEK fold opens the sheet fully. Focus that a tap brings (Android Chrome
    // focuses a tapped button — e.g. a component's previous / next inside PEEK) leaves it where it is (Phase 26).
    this.body.addEventListener('pointerdown', () => { this.tapFocusAt = performance.now(); }, true);
    this.body.addEventListener('focusin', () => { if (this.state === 'peek' && !(performance.now() - (this.tapFocusAt || -1e9) < 800)) this.setState('expanded'); });
  }

  render(p, ctx) {
    this.eyebrow.textContent = p.category || '';
    this.eyebrow.hidden = !p.category;
    this.title.textContent = p.name;
    this.tagline.textContent = p.summary || '';
    this.tagline.hidden = !p.summary;
    const top = this.body.scrollTop;
    this.inner.replaceChildren(...this.sections.map(s => s.render(p, ctx)).filter(Boolean));
    this.body.scrollTop = top;
  }

  // Component view (Phase 25; navigation + view Phase 26): the same sheet, showing the selected component — the
  // interaction layer's view model `c` (category, position, neighbours, level-of-detail and view state).
  renderComponent(c, p, ctx) {
    const act = this.inner.contains(document.activeElement) ? document.activeElement : null;
    const keep = act ? act.dataset.nav || (act.hasAttribute('data-frame') ? 'frame' : null) : null;   // previous / next / whole-product keep focus
    this.eyebrow.textContent = 'Component' + (c.category && !c.category.implicit ? ' · ' + c.category.name : (p.name ? ' · ' + p.name : ''));
    this.eyebrow.hidden = false;
    this.title.textContent = c.name;
    this.tagline.textContent = c.shortDescription || '';
    this.tagline.hidden = !c.shortDescription;
    const sec = (id, title, body) => h('section', { class: `pv-section pv-section--${id}`, 'aria-labelledby': 'pv-sec-' + id }, h('h3', { class: 'pv-section__title', id: 'pv-sec-' + id, text: title }), body);
    const navBtn = (dir, to, label, icon) => {
      const b = h('button', { type: 'button', class: 'pv-cnav__btn', 'data-nav': dir, 'aria-label': `${label} component: ${to ? to.name : 'none'}`, 'aria-disabled': to ? null : 'true' },
        h('span', { class: 'pv-cnav__icon', 'aria-hidden': 'true', html: icon }), h('span', { class: 'pv-cnav__label', text: label }));
      b.addEventListener('click', () => { if (to) ctx.navigate(dir === 'prev' ? -1 : 1); });
      return b;
    };
    const nav = c.count > 1 && h('div', { class: 'pv-cnav', role: 'group', 'aria-label': 'Components' + (c.category && !c.category.implicit ? ' in ' + c.category.name : '') },
      navBtn('prev', c.prev, 'Previous', SVG.chevLeft),
      h('span', { class: 'pv-cnav__count' }, h('span', { 'aria-hidden': 'true', text: `${c.index + 1} / ${c.count}` }), h('span', { class: 'pc-sr', text: `Component ${c.index + 1} of ${c.count}` })),
      navBtn('next', c.next, 'Next', SVG.chevRight));
    // presentation actions (Phase 26 view button, Phase 27 whole product ↔ focus): one row, inside PEEK
    const offView = c.view && !c.view.active, acts = [];
    if (offView) {
      const vb = h('button', { type: 'button', class: 'pv-more pv-cview__btn' }, h('span', { 'aria-hidden': 'true', html: SVG[c.camera && c.camera.view] || SVG.system }), h('span', { text: `Show in ${c.view.label} view` }));
      vb.addEventListener('click', () => { ctx.showInView(); this.title.focus({ preventScroll: true }); });
      acts.push(vb);
    }
    const fb = h('button', { type: 'button', class: 'pv-more pv-cview__btn pv-cframe__btn', 'data-frame': '' },
      h('span', { 'aria-hidden': 'true', html: c.framing === 'component' ? SVG.whole : SVG.focus }), h('span', { text: c.framing === 'component' ? 'View whole product' : `Focus on ${c.name}` }));
    fb.addEventListener('click', () => ctx.frame());
    acts.push(fb);
    const view = h('div', { class: 'pv-cview' }, offView && h('p', { class: 'pv-component-note', text: `Best seen in ${c.view.label} view.` }), h('div', { class: 'pv-cview__row' }, acts));
    const media = (c.media || []).filter(m => m.type === 'image');
    const gallery = media.length ? h('ul', { class: 'pv-gallery pv-cmedia' }, media.map((m, i) => {
      const b = h('button', { type: 'button', class: 'pv-gallery__item', 'aria-label': m.alt ? `Open photo: ${m.alt}` : `Open photo ${i + 1} of ${media.length}` }, h('img', { src: m.src, alt: '', loading: 'lazy', decoding: 'async' }));
      b.addEventListener('click', () => ctx.openPhoto(m.src));
      return h('li', null, b, m.caption && h('span', { class: 'pv-cmedia__caption', text: m.caption }));
    })) : null;
    const back = h('button', { type: 'button', class: 'pv-more pv-back-product' }, h('span', { 'aria-hidden': 'true', html: SVG.chevLeft }), h('span', { text: 'All product information' }));
    back.addEventListener('click', () => ctx.back());
    this.inner.replaceChildren(...[
      nav,
      view,
      gallery,
      c.description && sec('c-about', 'About this component', h('p', { class: 'pv-component-desc' + (c.placeholder ? ' is-placeholder' : ''), text: c.description })),
      c.information.length && sec('c-info', 'Information', specList(c.information, 'pv-specs pv-specs--tech')),
      c.pending && h('p', { class: 'pv-component-note', text: 'Not shown at the current level of detail.' }),
      h('div', { class: 'pv-section pv-section--c-back' }, back),
      sec('c-others', 'All components', componentExplorer(p, ctx, c.id)),
    ].filter(Boolean));
    if (keep) { const b = this.inner.querySelector(keep === 'frame' ? '[data-frame]' : `[data-nav="${keep}"]`); if (b) b.focus({ preventScroll: true }); }
    else this.body.scrollTop = 0;
  }

  layout(m) {
    this.m = m; this.side = m.side;
    this.el.classList.toggle('pv-sheet--side', m.side);
    this.el.style.height = m.side ? '' : m.expH + 'px';
    if (m.side && this.state === 'peek') { this.state = 'expanded'; this.el.dataset.state = 'expanded'; }
    this.place(this.stop(this.state), false);
  }
  stop(state) {
    const m = this.m;
    if (this.side) return state === 'closed' ? m.sw + 40 : 0;
    return state === 'closed' ? m.expH + 40 : state === 'peek' ? m.expH - m.peekH : 0;
  }
  extent() { return this.m ? Math.max(0, (this.side ? this.m.sw : this.m.expH) - this.offset) : 0; }
  place(off, animate) {
    this.offset = off;
    this.el.style.transform = this.side ? `translate3d(${off}px, 0, 0)` : `translate3d(0, ${off}px, 0)`;
    this.onMove(this.extent(), animate);
  }
  reset() {
    clearTimeout(this.hideT);
    this.drag = this.pull = null;
    this.state = 'closed'; this.el.dataset.state = 'closed';
    this.el.inert = true; this.el.classList.add('is-closed');
    this.body.scrollTop = 0;
    this.handle.setAttribute('aria-expanded', 'false');
    if (this.m) this.place(this.stop('closed'), false);
  }
  durationMs() { return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : this.cfg.durationMs; }

  setState(state, { animate = true, focus = false, restoreFocus = false } = {}) {
    if (!this.m) return;
    if (this.side && state === 'peek') state = 'expanded';
    const prev = this.state;
    this.state = state;
    this.el.dataset.state = state;
    clearTimeout(this.hideT);
    if (state !== 'closed') { this.el.classList.remove('is-closed'); this.el.inert = false; }
    this.handle.setAttribute('aria-expanded', String(state === 'expanded'));
    this.handle.setAttribute('aria-label', state === 'expanded' ? 'Show less product information' : 'Show all product information');
    if (state !== 'expanded' && this.body.scrollTop) this.body.scrollTo({ top: 0, behavior: this.durationMs() ? 'smooth' : 'auto' });
    this.place(this.stop(state), animate);
    if (state === 'closed') {
      this.el.inert = true;
      this.hideT = setTimeout(() => { if (this.state === 'closed') this.el.classList.add('is-closed'); }, (animate ? this.durationMs() : 0) + 40);
    }
    if (focus && state !== 'closed') this.title.focus({ preventScroll: true });
    if (prev !== state) this.onChange(state, prev, { restoreFocus });
  }

  // Release: a fling moves on to the next state in its direction, otherwise the nearest state wins.
  settle(v) {
    const stops = (this.side ? ['expanded', 'closed'] : ['expanded', 'peek', 'closed']).map(s => [s, this.stop(s)]);
    const off = this.offset, f = this.cfg.flingPxPerMs;
    let t;
    if (v > f) t = stops.find(([, o]) => o > off + 1) || stops[stops.length - 1];
    else if (v < -f) t = [...stops].reverse().find(([, o]) => o < off - 1) || stops[0];
    else t = stops.reduce((a, b) => (Math.abs(b[1] - off) < Math.abs(a[1] - off) ? b : a));
    this.setState(t[0], { restoreFocus: t[0] === 'closed' });
  }
  dragTo(off) { this.place(clamp(off, 0, this.stop('closed')), false); }
  velocity(samples) {
    const a = samples[0], b = samples[samples.length - 1];
    return b && a && b[0] > a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : 0;
  }

  // Pointer drag: the handle and head always; the body only in PEEK (where it does not scroll).
  down(e) {
    if (this.drag || (e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('.pv-sheet__close')) return;
    if (e.currentTarget === this.body && (this.side || this.state !== 'peek')) return;
    this.drag = { id: e.pointerId, el: e.currentTarget, x0: e.clientX, y0: e.clientY, off0: this.offset, moved: false, s: [[e.timeStamp, 0]] };
  }
  move(e) {
    const d = this.drag; if (!d || e.pointerId !== d.id) return;
    const along = this.side ? e.clientX - d.x0 : e.clientY - d.y0, across = this.side ? e.clientY - d.y0 : e.clientX - d.x0;
    if (!d.moved) {
      if (Math.abs(along) < this.cfg.dragSlopPx) return;
      if (Math.abs(across) > Math.abs(along) * 1.2) { this.drag = null; return; }   // sideways: not a sheet drag
      d.moved = true;
      try { d.el.setPointerCapture(d.id); } catch (err) { /* pointer already gone */ }
      this.onDrag(true);
    }
    this.dragTo(d.off0 + along);
    d.s.push([e.timeStamp, along]);
    while (d.s.length > 2 && e.timeStamp - d.s[0][0] > 90) d.s.shift();
  }
  up(e) {
    const d = this.drag; if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (!d.moved) return;                         // a tap: the handle / links handle their own click
    this.onDrag(false);
    this.settle(e.type === 'pointercancel' ? 0 : this.velocity(d.s));
  }
  tstart(e) {
    this.pull = (!this.side && this.state === 'expanded' && e.touches.length === 1 && this.body.scrollTop <= 0)
      ? { y0: e.touches[0].clientY, active: false, s: [] } : null;
  }
  tmove(e) {
    const p = this.pull; if (!p) return;
    if (e.touches.length !== 1) { this.pull = null; return; }
    const dy = e.touches[0].clientY - p.y0;
    if (!p.active) {
      if (dy < 0 || !e.cancelable) { this.pull = null; return; }   // scrolling up the content: leave it to the browser
      if (dy === 0) return;
      p.active = true; p.off0 = this.offset; this.onDrag(true);
    }
    e.preventDefault();
    this.dragTo(p.off0 + dy);
    p.s.push([e.timeStamp, dy]);
    while (p.s.length > 2 && e.timeStamp - p.s[0][0] > 90) p.s.shift();
  }
  tend(e) {
    const p = this.pull; this.pull = null;
    if (!p || !p.active) return;
    this.onDrag(false);
    this.settle(e.type === 'touchcancel' ? 0 : this.velocity(p.s));
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────────
export class ProductViewer {
  constructor(config = PRODUCT_VIEWER_CONFIG) {
    this.cfg = config;
    this.drawer = document.getElementById('product-drawer');
    this.panel = this.drawer && this.drawer.querySelector('.product-drawer__panel');
    this.canvas = document.getElementById('drawer-canvas');
    this.hint = document.getElementById('drawer-viewer-hint');
    this.modes = document.getElementById('drawer-modes');
    this.mq = matchMedia(config.media);
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)');
    this.isOpen = false; this.active = false; this.wants = false; this.ready = false; this.caps = null;
    this.built = false; this.pushed = false; this.ignorePop = false; this.dragging = false;
    this.card = null; this.product = null; this.component = null; this.box = null; this.metrics = null; this.inerted = null;
    this.pointers = new Map(); this.multi = false; this.lastTap = null;
    if (!this.drawer || !this.panel) return;

    this.mq.addEventListener('change', () => { if (this.isOpen) this.apply(); });
    window.addEventListener('resize', () => { if (this.active) this.scheduleLayout(); }, { passive: true });
    window.addEventListener('keydown', e => this.onKey(e), true);
    window.addEventListener('popstate', () => this.onPop());
    document.addEventListener('dv:ready', e => this.onModel('ready', e.detail));
    document.addEventListener('dv:error', e => this.onModel('error', e.detail));
    if (this.canvas) {
      this.canvas.addEventListener('pointerdown', e => this.canvasDown(e), { passive: true });
      this.canvas.addEventListener('pointerup', e => this.canvasUp(e), { passive: true });
      this.canvas.addEventListener('pointercancel', e => this.canvasUp(e), { passive: true });
      this.canvas.addEventListener('wheel', () => { if (this.active) this.dismissHint(); }, { passive: true });
    }
    // after the page's own handler has switched the mode
    if (this.modes) this.modes.addEventListener('click', () => { if (this.active) this.syncViews(); });
  }

  build() {
    if (this.built) return;
    this.built = true;
    this.controls = new ProductViewerControls(this.panel, {
      onBack: () => { const b = document.getElementById('drawer-close'); if (b) b.click(); },
      onInfo: () => this.sheet.setState('peek', { focus: true }),
      onInfoAll: () => this.sheet.setState('expanded', { focus: true }),
      onReset: () => this.resetView(),
    });
    this.loading = new ProductLoadingState(this.panel, { onRetry: () => this.retry() });
    this.sheet = new ProductInfoSheet(this.panel, {
      config: this.cfg,
      onChange: (s, prev, o) => this.onSheet(s, prev, o),
      onMove: (ext, animate) => this.onMove(ext, animate),
      onDrag: on => this.onDrag(on),
    });
  }

  // ── drawer hooks (called by the page's open() / close()) ──
  open(card, { category = '' } = {}) {
    this.isOpen = true; this.card = card; this.ready = false; this.caps = null; this.box = null; this.component = null;
    this.product = productFromCard(card, { category });
    // Phase 42: on a phone every product opens in this one shell. A product without a 3D model (or a browser without the 3D
    // viewer) keeps its own photo in the model area and says that 3D is not available — it is never given another
    // product's model. The page's open() makes the same call (use3D), so the two always agree.
    this.noModel = card.dataset.productModel !== 'true' || !window.DrawerViewer;
    this.wants = true;
    this.apply({ opening: true });
    return this.active;
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.pushed) { this.pushed = false; this.ignorePop = true; try { history.back(); } catch (e) { this.ignorePop = false; } }
    if (this.active) {
      this.setPageInert(false);
      if (this.card && this.drawer.contains(document.activeElement)) this.card.focus({ preventScroll: true });
      // The panel slides away as it is; sheet and model composition reset on the next open.
    }
  }

  // Product-first on/off for the open product (on open, and when the viewport crosses the breakpoint).
  apply({ opening = false } = {}) {
    const on = this.isOpen && this.wants && this.mq.matches;
    const DV = window.DrawerViewer;
    if (on) {
      this.build();
      const was = this.active;
      this.active = true;
      this.drawer.classList.add('pv-mobile');
      this.drawer.classList.toggle('pv-no-model', !!this.noModel);
      this.drawer.classList.toggle('pv-ready', this.ready);
      this.panelAria(true);
      if (opening || !was) {
        this.drawer.classList.remove('pv-sheet-open', 'pv-single-view', 'pv-many-views');
        if (this.ready && this.caps) this.setViews(this.caps);
        this.controls.setProduct(this.product);
        this.sheet.render(this.product, this.ctx());
        this.sheet.reset();
        this.clearCanvas();
        this.loading.set(this.noModel ? 'none' : this.ready ? 'ready' : 'loading');
        this.hintState();
        this.setPageInert(true);
        if (!this.pushed) this.pushHistory();
        if (opening) this.controls.back.focus({ preventScroll: true });
      }
      if (!opening && DV) DV.refreshSize();     // the canvas box changed with the layout
      this.layoutNow();
    } else {
      const was = this.active;
      this.active = false;
      this.drawer.classList.remove('pv-mobile', 'pv-ready', 'pv-sheet-open', 'pv-landscape', 'pv-single-view', 'pv-many-views', 'pv-no-model', 'pv-still');
      if (this.built) this.sheet.reset();
      this.clearCanvas();
      this.panelAria(false);
      this.setPageInert(false);
      if (this.hint) { this.hint.classList.remove('is-dismissed'); if (this.hint.textContent === 'Drag to explore') this.hint.textContent = 'Drag to rotate'; }
      if (was && !opening && DV) DV.refreshSize();
    }
  }

  ctx() {
    const DV = window.DrawerViewer;
    const tel = document.querySelector('.drawer__cta-row a[href^="tel:"]');
    return {
      currentMode: () => (DV ? DV.getMode() : 'full'),
      setView: m => this.setView(m),
      openPhoto: src => this.openPhoto(src),
      quote: () => { const b = document.getElementById('drawer-enquire'); if (b) b.click(); },
      phone: tel ? tel.getAttribute('href') : null,
      // components (Phase 25/26): the interaction layer (product-interaction.js) owns the selection; these only ask it
      component: c => this.drawer.dispatchEvent(new CustomEvent('productviewer:component', { bubbles: true, detail: { product: this.product.id, component: c.id } })),
      navigate: dir => this.drawer.dispatchEvent(new CustomEvent('productviewer:component-nav', { bubbles: true, detail: { dir } })),
      showInView: () => this.drawer.dispatchEvent(new CustomEvent('productviewer:component-view', { bubbles: true })),
      frame: () => this.drawer.dispatchEvent(new CustomEvent('productviewer:component-frame', { bubbles: true })),
      back: () => this.drawer.dispatchEvent(new CustomEvent('productviewer:component-back', { bubbles: true })),
      selectedComponent: () => { const pi = window.ProductInteraction; return pi ? pi.current() : null; },
      componentAvailable: id => { const pi = window.ProductInteraction; return pi ? pi.available(id) : true; },
      viewLabel: m => { const b = this.modes && this.modes.querySelector(`.drawer__mode[data-mode="${m}"]`); return b && !b.hidden ? b.textContent.trim() : null; },
    };
  }

  // ── model state from the viewer ──
  onModel(kind, detail) {
    if (!this.isOpen || !this.card || !detail || detail.url !== this.card.dataset.productGlb) return;
    if (kind === 'error') { if (this.active) this.loading.set('error'); return; }
    this.ready = true; this.caps = detail;
    if (!this.active) return;
    this.drawer.classList.add('pv-ready');
    this.loading.set('ready');
    this.setViews(detail);
    this.rerender();
  }
  rerender() {
    if (!this.built) return;
    if (this.component) this.sheet.renderComponent(this.component, this.product, this.ctx());
    else this.sheet.render(this.product, this.ctx());
  }
  // Product data from a configuration (Phase 25); the viewer's own facts (views) are kept.
  setProduct(data) {
    this.product = normalizeProduct({ ...(this.product || {}), ...data, views: this.product ? this.product.views : [] });
    if (this.active) { this.controls.setProduct(this.product); this.rerender(); }
    return true;
  }
  // Render the interaction layer's selection (its view model, or null for the product view). `this.component` is only
  // what the sheet is showing, never a second selection state. A new choice opens PEEK (the highlighted model stays in
  // view) and moves focus to its title; previous / next keep focus on the button, and a level-of-detail or view update
  // only re-renders.
  showComponent(c, { source = null } = {}) {
    if (!this.active) return false;
    const was = this.component;
    this.component = c || null;
    this.rerender();
    const fresh = c && (!was || was.id !== c.id) && source !== 'nav';
    if (fresh && this.sheet.state !== 'peek') this.sheet.setState('peek', { focus: true });
    else if (fresh) this.sheet.title.focus({ preventScroll: true });
    else if (!c && was && source === 'back' && this.sheet.state !== 'closed') this.sheet.title.focus({ preventScroll: true });
    return true;
  }
  setViews(caps) {
    this.product.views = ['full', 'system', 'gun', 'cutaway'].filter(m => m === 'full' || caps[m]);
    this.drawer.classList.toggle('pv-single-view', this.product.views.length < 2);
    this.drawer.classList.toggle('pv-many-views', this.product.views.length > 2);   // legacy Attac models: Full · System · Gun · Cutaway
    if (this.metrics && this.sheet) { this.measureStack(); this.compose(this.sheet.extent()); }
  }
  syncViews() {
    const DV = window.DrawerViewer, cur = DV ? DV.getMode() : 'full';
    if (this.sheet) this.sheet.inner.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === cur)));
  }
  setView(mode) {
    const b = this.modes && this.modes.querySelector(`.drawer__mode[data-mode="${mode}"]`);
    if (b && !b.hidden && !b.classList.contains('is-active')) b.click();   // the page's own mode switch
    this.sheet.setState('closed', { restoreFocus: true });
  }
  openPhoto(src) {
    const lb = document.getElementById('drawer-lightbox'), img = document.getElementById('drawer-lightbox-img');
    if (!lb || !img) return;
    img.src = src;
    lb.classList.add('is-open');
    const x = document.getElementById('drawer-lightbox-close');
    if (x) x.focus({ preventScroll: true });
  }
  // "Try again" after a failed model: the page's own open() for the same card (the loading path itself is unchanged).
  retry() {
    if (!this.isOpen || !this.card) return;
    this.loading.set('loading');
    this.card.click();
  }
  resetView() {
    const DV = window.DrawerViewer;
    if (DV && DV.resetView) DV.resetView({ animate: !this.reduce.matches });
    this.drawer.dispatchEvent(new CustomEvent('productviewer:reset', { bubbles: true }));   // a presented component is no longer framed (Phase 27)
  }

  // ── sheet ↔ model composition ──
  onSheet(state, prev, { restoreFocus }) {
    this.drawer.classList.toggle('pv-sheet-open', state !== 'closed');
    this.drawer.dispatchEvent(new CustomEvent('productviewer:sheet', { bubbles: true, detail: { state, prev } }));
    this.controls.info.setAttribute('aria-expanded', String(state !== 'closed'));
    this.controls.infoTop.setAttribute('aria-expanded', String(state !== 'closed'));
    if (state !== 'closed') this.syncViews();
    if (state === 'closed' && (restoreFocus || this.sheet.el.contains(document.activeElement))) this.controls.info.focus({ preventScroll: true });
  }
  onDrag(on) {
    this.dragging = on;
    cancelAnimationFrame(this.stillRaf);
    this.drawer.classList.toggle('pv-still', on);
  }
  // One write without transitions (layout changes, instant placement).
  still() {
    this.drawer.classList.add('pv-still');
    if (this.dragging) return;
    cancelAnimationFrame(this.stillRaf);
    this.stillRaf = requestAnimationFrame(() => { this.stillRaf = requestAnimationFrame(() => { if (!this.dragging) this.drawer.classList.remove('pv-still'); }); });
  }
  onMove(ext, animate) {
    if (!animate && !this.dragging) this.still();
    if (ext <= 0.5 && !this.dragging) this.box = null;
    this.compose(ext);
  }
  // The model moves into the space the sheet leaves: PEEK slides the canvas up (the strip it uncovers
  // is always under the sheet), EXPANDED shrinks it into a live card above the sheet, the side sheet
  // slides it left. Transform and clip only — the canvas keeps its size and the camera its pose.
  compose(ext) {
    const m = this.metrics; if (!m || !this.canvas) return;
    const els = [this.canvas, document.getElementById('dv-callouts'), this.noModel && document.getElementById('drawer-stage')].filter(Boolean);   // no model: the photo moves instead
    if (ext > 0.5 && !this.box && window.DrawerViewer && window.DrawerViewer.getProductScreenBox) this.box = window.DrawerViewer.getProductScreenBox();
    const { W, H, top } = m, px = W / 2, py = H / 2;   // the camera looks at its pivot: always the canvas centre
    // Always an inset() clip (never `none`), so every state change interpolates instead of snapping.
    let tx = 0, ty = 0, s = 1, clip = 'inset(0px 0px 0px 0px round 0px)';
    if (m.side) tx = -Math.min(ext, m.sw) / 2;
    else {
      const tyPeek = (top + H - m.peekH) / 2 - py, ty0 = this.restOffset(tyPeek);
      if (ext <= m.peekH) ty = mix(ty0, tyPeek, ext / m.peekH);
      else {
        const c = this.cardFrame(m), u = clamp((ext - m.peekH) / (m.expH - m.peekH), 0, 1);
        ty = mix(tyPeek, c.ty, u); s = mix(1, c.s, u);
        clip = `inset(${(c.t * u).toFixed(1)}px 0px ${(c.b * u).toFixed(1)}px 0px round ${(c.r * u).toFixed(1)}px)`;
      }
    }
    const tf = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0px) scale(${s.toFixed(4)})`;
    for (const el of els) { el.style.transformOrigin = `${px}px ${py}px`; el.style.transform = tf; el.style.clipPath = clip; }
  }
  // CLOSED: the pivot (the camera's centre of view) centred between the header and the controls stack. The lift
  // uncovers a strip at the bottom; it is capped so that strip stays inside the opaque base of the bottom fade —
  // and under the sheet — at every point of the CLOSED ⇄ PEEK move (both are linear in the same eased time).
  measureStack() {
    const m = this.metrics;
    if (!m || m.side) { this.restTy = 0; return; }
    let stack = this.controls.bar.offsetTop;
    if (this.modes && !this.drawer.classList.contains('pv-single-view') && this.modes.offsetHeight) stack = Math.min(stack, this.modes.offsetTop);
    this.restTy = Math.min(0, (m.top + stack) / 2 - m.H / 2);
  }
  restOffset(tyPeek) {
    const m = this.metrics, B = this.cfg.rest.band;
    if (!m || m.side || !this.restTy) return 0;
    return -Math.max(0, Math.min(-this.restTy, this.cfg.rest.max, B * (m.peekH + tyPeek) / (m.peekH - B)));
  }
  // EXPANDED: a full-width band around the product, scaled to fit the strip above the sheet.
  cardFrame(m) {
    const { W, H, top } = m, py = H / 2, b = this.box;
    const hh = clamp(b ? Math.max(py - b.y0, b.y1 - py) : W * 0.35, 40, Math.min(H / 2, W * 0.6));
    const pad = 18, band = 2 * (hh + pad);
    const s = clamp(Math.min((m.stripH - 16) / band, (W - 32) / W), 0.2, 1);
    return { s, ty: top + m.stripH / 2 - py, t: Math.max(0, py - hh - pad), b: Math.max(0, H - (py + hh + pad)), r: 16 / s };
  }
  clearCanvas() {
    this.box = null;
    for (const el of [this.canvas, document.getElementById('dv-callouts'), document.getElementById('drawer-stage')]) if (el) { el.style.transform = ''; el.style.clipPath = ''; el.style.transformOrigin = ''; }
  }

  // ── layout ──
  scheduleLayout() {
    if (this.layoutRaf) return;
    this.layoutRaf = requestAnimationFrame(() => { this.layoutRaf = 0; if (this.active) this.layoutNow(); });
  }
  layoutNow() {
    const W = this.panel.clientWidth, H = this.panel.clientHeight;
    if (!W || !H) return;
    const side = W > H && (H <= this.cfg.sideMaxHeight || W >= 1024), c = this.cfg;   // desktop: the details come in from the right
    this.drawer.classList.toggle('pv-landscape', side);
    const m = { W, H, side, top: this.controls.header.offsetHeight };
    if (side) {
      m.sw = Math.round(clamp(W * c.side.share, c.side.min, c.side.max));
      this.drawer.style.setProperty('--pv-side-w', m.sw + 'px');
    } else {
      m.peekH = Math.round(clamp(H * c.peek.share, c.peek.min, Math.min(c.peek.max, H - m.top - c.productRoom)));
      m.stripH = Math.round(clamp(H * c.strip.share, c.strip.min, c.strip.max));
      m.expH = Math.max(m.peekH + 48, H - m.top - m.stripH);
      m.stripH = H - m.top - m.expH;
    }
    this.metrics = m;
    this.box = null;                                     // re-measure the product on the new canvas
    this.measureStack();
    this.still();
    this.sheet.layout(m);
  }

  // ── page state ──
  panelAria(on) {
    const p = this.panel;
    if (on) {
      p.setAttribute('role', 'dialog'); p.setAttribute('aria-modal', 'true'); p.setAttribute('aria-labelledby', 'pv-header-name');
      if (this.canvas) { this.canvas.setAttribute('role', 'img'); this.canvas.setAttribute('aria-label', `Interactive 3D model of ${this.product ? this.product.name : 'the product'}. Drag to rotate, pinch to zoom, double-tap to reset.`); }
    } else {
      for (const a of ['role', 'aria-modal', 'aria-labelledby']) p.removeAttribute(a);
      if (this.canvas) { this.canvas.removeAttribute('role'); this.canvas.removeAttribute('aria-label'); }
    }
  }
  // Everything outside the drawer leaves the tab order and the accessibility tree while the viewer is up.
  setPageInert(on) {
    if (!on) { if (this.inerted) for (const el of this.inerted) el.inert = false; this.inerted = null; return; }
    if (this.inerted) return;
    this.inerted = [];
    for (let node = this.drawer; node && node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sib of node.parentElement.children) {
        if (sib === node || sib.inert || /^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT|META)$/.test(sib.tagName)) continue;
        sib.inert = true; this.inerted.push(sib);
      }
    }
  }
  // The phone's back gesture / button closes the viewer instead of leaving the site.
  pushHistory() {
    try { history.pushState(Object.assign({}, history.state, { pvViewer: 1 }), ''); this.pushed = true; } catch (e) { this.pushed = false; }
  }
  onPop() {
    if (this.ignorePop) { this.ignorePop = false; return; }
    if (this.pushed && this.isOpen) { this.pushed = false; const b = document.getElementById('drawer-close'); if (b) b.click(); }
  }
  onKey(e) {
    if (e.key !== 'Escape' || !this.active || !this.isOpen || !this.sheet || this.sheet.state === 'closed') return;
    const lb = document.getElementById('drawer-lightbox');
    if (lb && lb.classList.contains('is-open')) return;   // the page closes the photo first
    e.stopPropagation(); e.preventDefault();
    this.sheet.setState('closed', { restoreFocus: true });
  }

  // ── first-use hint ──
  hintState() {
    if (!this.hint) return;
    this.hint.textContent = 'Drag to explore';
    this.hint.classList.toggle('is-dismissed', store.get(this.cfg.hintKey) === '1');
  }
  dismissHint() {
    if (!this.hint || this.hint.classList.contains('is-dismissed')) return;
    this.hint.classList.add('is-dismissed');
    store.set(this.cfg.hintKey, '1');
  }

  // ── taps on the model: tap (future hotspots), double-tap = reset ──
  canvasDown(e) {
    if (!this.active) return;
    this.dismissHint();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (this.pointers.size > 1) this.multi = true;
  }
  canvasUp(e) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const multi = this.multi;
    if (!this.pointers.size) this.multi = false;
    if (!this.active || !p || multi || e.type === 'pointercancel') return;
    const T = this.cfg.tap;
    if (e.timeStamp - p.t > T.maxMs || Math.hypot(e.clientX - p.x, e.clientY - p.y) > T.slopPx) { this.lastTap = null; return; }
    const l = this.lastTap;
    if (l && e.timeStamp - l.t < T.doubleMs && Math.hypot(e.clientX - l.x, e.clientY - l.y) < T.doubleSlopPx) {
      this.lastTap = null;
      if (this.sheet.state !== 'expanded') this.resetView();
      return;
    }
    this.lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    if (this.sheet.state === 'expanded' && !this.sheet.side) { this.sheet.setState('peek'); return; }   // tap the live card: back to the model
    this.drawer.dispatchEvent(new CustomEvent('productviewer:tap', { bubbles: true, detail: { product: this.product && this.product.id, clientX: e.clientX, clientY: e.clientY } }));
  }

  snapshot() {
    return { active: this.active, open: this.isOpen, ready: this.ready, sheet: this.sheet ? this.sheet.state : null, metrics: this.metrics,
      canvas: this.canvas ? { transform: this.canvas.style.transform, clip: this.canvas.style.clipPath, origin: this.canvas.style.transformOrigin } : null,
      pushed: this.pushed, inert: this.inerted ? this.inerted.length : 0, product: this.product ? this.product.id : null, views: this.product ? this.product.views : [], component: this.component ? this.component.id : null };
  }
}

const viewer = new ProductViewer();
window.ProductViewerUI = {
  open: (card, opts) => viewer.open(card, opts),
  close: () => viewer.close(),
  setSheet: state => (viewer.active && viewer.sheet ? (viewer.sheet.setState(state, { focus: state !== 'closed' }), viewer.sheet.state) : null),
  state: () => viewer.snapshot(),
  // Render any product-data object into the sheet (the architecture works for every product, not just the VSS).
  render: data => { if (!viewer.active) return false; viewer.product = normalizeProduct(data); viewer.controls.setProduct(viewer.product); viewer.sheet.render(viewer.product, viewer.ctx()); return true; },
  setProduct: data => viewer.setProduct(data),
  showComponent: c => viewer.showComponent(c),
  fromCard: (card, opts) => productFromCard(card, opts),
  viewer,
};
