// Product components: selection layer (Phase 25) + component explorer (Phase 26).
//
// Shared by every product. A product configuration (product-data.js) names components by the 3D asset's feature names
// and groups them into categories; this module owns the ONE selection state and every view renders from it:
//
//   3D click / tap ──┐                                                         ┌─ highlight  DrawerViewer.setHighlight
//   list · keyboard ─┼─► select(id, { source }) ─► state: none | pending | selected ─► render() ─┼─ camera     DrawerViewer.focusFeatures (once per choice)
//   previous / next ─┤                                                         ├─ desktop    component card + explorer in the info column
//   deep link ───────┘   Escape · ✕ · back · empty tap ─► clear() ─────────────┼─ mobile     the Phase 23 sheet (ProductViewerUI.showComponent)
//                                                                              └─ URL        ?product=…&component=… (history.replaceState)
//
// Orbit, pinch and the Phase 23 double-tap reset keep working: a tap is short and still (≤ 350 ms, ≤ 8 px), two fingers
// never select, and on touch a single tap waits out the double-tap window, so the second tap of a reset cancels it.
// A 3D pick never changes the view (the part is on screen). A choice from a list, previous/next or a link switches to
// the view a component asks for (`camera.view`, e.g. parts inside a vehicle) and focuses it there, in one move.
// Clearing removes the highlight and the information; the camera and the view stay where the visitor has them.
// `pending` = selected, but none of its features is on the level of detail on screen: no highlight, no camera move;
// both follow when a level of detail that carries it comes in (dv:lod). Nothing is ever loaded for it.
//
// Product content (Phase 28): for a structured (inferno.product/2) product the desktop info column is rendered from the
// product data — key specifications, overview, key features, applications, grouped specifications — in the page's
// existing elements and styles; the mobile sheet renders the same data. The tab title follows the product while open.
//
// Presentation (Phase 27) rides on the same state — no second selection: a choice is `presenting` while the camera
// moves to the component and its highlight eases in, then `presented`. The component's `camera` block is its
// presentation (fill = share of the frame, optional azimuth / elevation for choices made away from the model — a 3D
// pick keeps the visitor's angle). "View whole product" is the existing Reset with the selection kept; "Focus on …"
// brings the component back. On touch, a tap that misses every component is given a small tolerance (DrawerViewer.pickNear).

import { loadProductConfig, mergeProduct, resolveComponents } from './product-data.js?v=9';

export const INTERACTION_CONFIG = {
  tapMaxMs: 350, tapSlopPx: 8,             // longer or further = a drag (orbit), never a selection
  doubleTapMs: 320, doubleTapSlopPx: 28,   // touch: a second tap inside this window is the viewer's reset
  focusFill: 0.40,                         // default presentation (Phase 27, Niel's choice B): component bounds fill this share of the frame (`camera.fill` overrides)
  highlightFadeMs: 350,                    // a new selection's highlight eases in (0 with reduced motion)
  // touch tolerance is opted in per component by the product data (`interaction.touchTolerancePx`, small parts only)
  mobileStopBeforeLOD: 0,                  // Phase 24 guard (approved option C): on the phone layout, focus stays coarser than LOD0
  deepLink: true,                          // ?product=<id>&component=<id> while a component is selected
};

const DV = () => window.DrawerViewer, UI = () => window.ProductViewerUI;
const NONE = Object.freeze({ status: 'none', id: null });
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v === true ? '' : v); }
  for (const c of kids.flat()) if (c) el.append(c);
  return el;
}
// component media (Phase 27): thumbnails that open the page's lightbox; nothing at all when a component has none
export function mediaThumbs(c, open) {
  return (c.media || []).filter(m => m.type === 'image').map((m, i, all) => {
    const b = h('button', { type: 'button', class: 'pc-media__item', 'aria-label': m.alt ? `Open photo: ${m.alt}` : `Open photo ${i + 1} of ${all.length}` },
      h('img', { src: m.src, alt: '', loading: 'lazy', decoding: 'async' }));
    b.addEventListener('click', () => open(m.src));
    return m.caption ? h('figure', { class: 'pc-media__fig' }, b, h('figcaption', { text: m.caption })) : b;
  });
}
const setDisabled = (b, off) => (off ? b.setAttribute('aria-disabled', 'true') : b.removeAttribute('aria-disabled'));
const isDisabled = b => b.getAttribute('aria-disabled') === 'true';

export class ProductInteraction {
  constructor(config = INTERACTION_CONFIG) {
    this.cfg = config;
    this.drawer = document.getElementById('product-drawer');
    this.canvas = document.getElementById('drawer-canvas');
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)');
    this.card = null; this.product = null; this.resolved = null; this.ready = false; this.sel = NONE; this.link = null; this.presentToken = 0; this.selectable = null;
    this.pointers = new Map(); this.multi = false; this.ignore = false; this.pending = null; this.last = null;
    if (!this.drawer || !this.canvas) return;
    this.live = h('div', { class: 'pc-live', role: 'status', 'aria-live': 'polite' });
    this.drawer.appendChild(this.live);
    this.canvas.addEventListener('pointerdown', e => this.down(e), { passive: true });
    this.canvas.addEventListener('pointerup', e => this.up(e), { passive: true });
    this.canvas.addEventListener('pointercancel', e => this.up(e), { passive: true });
    document.addEventListener('dv:ready', e => this.onModel(e.detail));
    document.addEventListener('dv:lod', e => this.onLOD(e.detail));
    // requests from the mobile sheet (product-viewer-ui.js)
    this.drawer.addEventListener('productviewer:component', e => this.select(e.detail.component, { source: 'list' }));
    this.drawer.addEventListener('productviewer:component-nav', e => this.step(e.detail.dir));
    this.drawer.addEventListener('productviewer:component-view', () => this.showInView());
    this.drawer.addEventListener('productviewer:component-back', () => this.clear({ source: 'back' }));
    this.drawer.addEventListener('productviewer:component-frame', () => this.toggleFraming());
    this.drawer.addEventListener('productviewer:reset', () => { if (this.sel.id) { this.sel.framing = 'product'; this.render({ source: 'frame' }); } });   // Phase 23 Reset / double-tap
    this.drawer.addEventListener('productviewer:sheet', e => { if (e.detail.state === 'closed' && this.sel.id && this.mobile()) this.clear({ source: 'sheet' }); });
    window.addEventListener('keydown', e => this.key(e), true);
    const modes = document.getElementById('drawer-modes');
    if (modes) modes.addEventListener('click', () => { if (this.sel.id && !this.byUs) { this.sel.framing = 'product'; this.render({ source: 'mode' }); } });   // the visitor's own view choice re-frames the product
    if (this.cfg.deepLink) this.applyLink();
  }
  mobile() { const u = UI(); return !!(u && u.state().active); }
  get selected() { return this.sel.id ? this.component(this.sel.id) : null; }

  // ── drawer hooks (called by the page's open() / close()) ──
  open(card, { category = '' } = {}) {
    this.clear({ silent: true });
    this.card = card; this.product = null; this.resolved = null; this.ready = false;
    this.restoreTitle();
    this.renderContent();                                            // nothing until a structured product's data is in
    this.renderDesktop(null);                                        // nothing for a product without configuration
    const url = card.dataset.productConfig; if (!url) { this.link = null; this.cardTitle(card); return; }
    loadProductConfig(url).then(cfg => {
      if (this.card !== card) return;
      const u = UI(), base = (u && u.fromCard) ? u.fromCard(card, { category }) : { name: card.dataset.productName, category };
      this.product = mergeProduct(base, cfg);
      if (this.product.dataIssues.length) console.warn('[product] configuration:', this.product.dataIssues);
      const cam = cfg.viewer && cfg.viewer.camera;                     // per-product legacy framing (Phase 29); production assets ignore it
      if (DV() && DV().setFraming) DV().setFraming(card.dataset.productGlb, cam && typeof cam === 'object' ? cam : null);
      const pres = cfg.viewer && cfg.viewer.presentation;             // Phase 66: declared presentation modes + System-view context
      if (DV() && DV().setPresentation) DV().setPresentation(card.dataset.productGlb, pres && typeof pres === 'object' ? pres : null);
      if (this.link && !this.product.components.length) { console.warn(`[product] link: ${this.product.id} has no components ("${this.link}" ignored)`); this.link = null; }
      if (u && u.setProduct) u.setProduct(this.product);             // mobile sheet: configuration content + components
      this.renderContent();
      this.renderDesktop(null);
      this.resolve();
      if (this.product.seo && this.product.seo.title) { if (this.pageTitle == null) this.pageTitle = document.title; document.title = this.product.seo.title; }
    }).catch(e => { console.warn('[product] configuration', e.message); this.link = null; });
  }
  close() {
    this.clear({ silent: true });
    this.card = null; this.product = null; this.resolved = null; this.ready = false; this.link = null;
    this.pointers.clear(); clearTimeout(this.pending && this.pending.timer); this.pending = null;
    this.writeUrl(null);
    this.restoreTitle();
  }
  restoreTitle() { if (this.pageTitle != null) { document.title = this.pageTitle; this.pageTitle = null; } }
  // Products without a configuration file (Phase 58): the card's own name, in the same "<name> | Ritestand Fire"
  // form as the configured products' seo.title; restored on close like theirs.
  cardTitle(card) {
    const name = (card.dataset.productName || '').trim(); if (!name) return;
    if (this.pageTitle == null) this.pageTitle = document.title;
    document.title = `${name} | Ritestand Fire`;
  }

  // ── desktop product content (Phase 28): the drawer's own elements, filled from the product data ──
  renderContent() {
    if (!this.deskWrap && !this.buildDesktop()) return;
    const p = this.product, box = this.deskContent;
    if (!p || !p.content) { box.hidden = true; box.replaceChildren(); return; }   // card-driven products keep the page's own rendering
    const $ = id => document.getElementById(id);
    const hl = $('drawer-highlights'), desc = $('drawer-desc'), det = $('drawer-specs-details'), specs = $('drawer-specs'), count = $('drawer-specs-count'), photos = $('drawer-photos');
    if (hl) { hl.replaceChildren(...p.keySpecs.map(s => h('div', { class: 'drawer__highlight' }, h('div', { class: 'drawer__highlight-key', text: s.key }), h('div', { class: 'drawer__highlight-val', text: s.val })))); hl.style.display = p.keySpecs.length ? '' : 'none'; }
    if (desc) desc.textContent = p.description || '';
    if (specs && det) {
      const rows = [], groups = [...new Set(p.technical.map(s => s.group || ''))];   // in data order; ungrouped rows keep no heading
      for (const g of groups) {
        const items = p.technical.filter(s => (s.group || '') === g);
        rows.push(h('div', { class: 'drawer__spec-group' }, g && h('h4', { class: 'drawer__spec-group-title', text: g }),
          h('dl', { class: 'drawer__spec-list' }, items.map(s => h('div', { class: 'drawer__spec-row' }, h('dt', { class: 'drawer__spec-key', text: s.key }), h('dd', { class: 'drawer__spec-val', text: s.val }))))));
      }
      specs.replaceChildren(...rows);
      if (count) count.textContent = p.technical.length + ' more detail' + (p.technical.length === 1 ? '' : 's');
      det.style.display = p.technical.length ? '' : 'none';
    }
    if (photos && p.photos) {
      const items = p.photoItems || p.photos.map(src => ({ src, alt: '' }));
      photos.replaceChildren(...items.map(m => h('button', { type: 'button', class: 'drawer__photo', 'data-src': m.src, 'aria-label': `Open photo: ${m.alt || p.name}` }, h('img', { src: m.src, alt: '', loading: 'lazy' }))));
      photos.style.display = p.photos.length ? '' : 'none';
    }
    // key features + applications: between the overview and the interactive components
    const sec = (id, title, body) => h('section', { class: 'pc-content__section', 'aria-labelledby': `pc-content-${id}` }, h('h3', { class: 'pc-desk__title', id: `pc-content-${id}`, text: title }), body);
    const feats = p.features.map(f => (typeof f === 'string' ? { title: f, text: '' } : f));
    const apps = p.applications.map(a => (typeof a === 'string' ? { title: a, text: '' } : a));
    box.replaceChildren(...[
      feats.length && sec('features', 'Key features', h('ul', { class: 'pc-features' }, feats.map(f => {
        const link = f.componentId && this.available(f.componentId) && (() => { const b = h('button', { type: 'button', class: 'pc-features__link', 'aria-label': `Show ${f.title} in 3D`, text: 'Show in 3D' }); b.addEventListener('click', () => this.select(f.componentId, { source: 'list' })); return b; })();
        return h('li', null, h('span', { class: 'pc-features__title', text: f.title }), f.text && f.text !== f.title && h('span', { class: 'pc-features__text', text: f.text }), link);
      }))),
      apps.length && sec('applications', 'Applications', h('ul', { class: 'pc-apps' }, apps.map(a => h('li', null, h('span', { class: 'pc-apps__title', text: a.title }), a.text && h('span', { class: 'pc-apps__text', text: a.text }))))),
    ].filter(Boolean));
    box.hidden = !box.children.length;
  }
  onModel(detail) {
    if (!this.card || !detail || detail.url !== this.card.dataset.productGlb) return;
    this.ready = true; this.resolve();
  }
  // feature names of every component, once both the configuration and the model's feature catalogue are there
  resolve() {
    if (!this.product || !this.ready || this.resolved) return;
    const catalog = DV().featureCatalog();
    if (!catalog.length) return;
    this.resolved = resolveComponents(this.product.components, catalog);
    this.selectable = new Set(this.resolved.byFeature.keys());          // every feature that belongs to a component (an exact hit always wins)
    this.touchTargets = new Map();                                       // small parts' invisible touch targets: feature → tolerance px
    for (const c of this.resolved.components) { const t = c.interaction && +c.interaction.touchTolerancePx; if (t > 0) for (const n of c.featureNames) this.touchTargets.set(n, t); }
    if (this.resolved.issues.length) console.warn('[product] component references:', this.resolved.issues);
    const u = UI(); if (u && u.state().active && u.setProduct) u.setProduct(this.product);   // availability into the sheet's explorer
    this.renderContent();                                                                   // feature → component links need availability
    this.renderDesktop(null);
    if (this.link) this.followLink();
  }
  component(id) { return this.resolved ? this.resolved.components.find(c => c.id === id) || null : null; }
  available(id) { if (!this.resolved) return true; const c = this.component(id); return !!(c && c.available); }

  // category, position and selectable neighbours of a component (unavailable components are skipped)
  neighbours(id) {
    const cats = (this.product && this.product.componentCategories) || [];
    const cat = cats.find(k => k.components.includes(id));
    if (!cat) return { category: null, index: 0, count: 1, prev: null, next: null };
    const list = cat.components.filter(x => this.available(x)), i = list.indexOf(id);
    return { category: cat, index: i, count: list.length, prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
  }
  // what every view renders: the selected component + its place in the explorer + its view state
  viewModel() {
    const c = this.selected; if (!c) return null;
    const n = this.neighbours(c.id), want = c.camera && c.camera.view, brief = id => { const x = id && this.component(id); return x ? { id: x.id, name: x.name } : null; };
    return { ...c,
      category: n.category ? { id: n.category.id, name: n.category.name, implicit: !!n.category.implicit } : null, index: n.index, count: n.count, prev: brief(n.prev), next: brief(n.next),
      visible: this.sel.status === 'selected', pending: this.sel.status === 'pending', presentation: this.sel.presentation, framing: this.sel.framing,
      view: want && this.viewButton(want) ? { mode: want, label: this.viewLabel(want), active: DV().getMode() === want } : null };
  }

  // ── selection: the only writer of the state ──
  select(id, { focus = true, source = 'api' } = {}) {
    this.resolve();
    const c = this.component(id);
    if (!c) { if (this.resolved) console.warn(`[product] no component "${id}"`); return false; }
    if (!c.available) { this.announce(`${c.name} is not in this 3D model.`); return false; }
    const hl = DV().setHighlight(c.featureNames, { fadeMs: this.reduce.matches ? 0 : this.cfg.highlightFadeMs });
    const want = c.camera && c.camera.view;
    const switched = !!(want && source !== 'pick' && DV().getMode() !== want && this.setView(want));
    this.sel = { status: hl.overlays ? 'selected' : 'pending', id: c.id, source, highlight: hl, focus: null, focusDue: !!focus, switched, keepAngle: source === 'pick', framing: 'product', presentation: 'presenting' };
    if (focus && hl.overlays) this.focusNow();
    this.present();
    this.render({ source });
    const n = this.neighbours(c.id);
    this.announce(`${c.name} selected` + (n.category && n.count > 1 ? `, ${n.index + 1} of ${n.count} in ${n.category.name}.` : '.') +
      (switched ? ` ${this.viewLabel(want)} view.` : '') + (hl.overlays ? '' : ' Not shown at the current level of detail.'));
    this.drawer.dispatchEvent(new CustomEvent('productviewer:select', { bubbles: true, detail: { product: this.product.id, component: c.id, source, features: c.featureNames.length, highlight: hl, focus: this.sel.focus, switched } }));
    return true;
  }
  clear({ silent = false, source = 'api' } = {}) {
    if (!this.sel.id) return false;
    const was = this.selected, focusIn = !!(this.deskCard && this.deskCard.contains(document.activeElement));
    this.sel = NONE; ++this.presentToken; this.drawer.dataset.presentation = '';
    DV().setHighlight(null);
    this.render({ source });
    if (focusIn && was) { const b = this.deskList.querySelector(`.pc-list__item[data-component="${was.id}"]`); if (b) b.focus({ preventScroll: true }); }
    if (!silent && was) { this.announce(`${was.name} deselected.`); this.drawer.dispatchEvent(new CustomEvent('productviewer:clear', { bubbles: true, detail: { component: was.id, source } })); }
    return true;
  }
  step(dir) {
    const c = this.selected; if (!c) return false;
    const n = this.neighbours(c.id), id = dir < 0 ? n.prev : n.next;
    return id ? this.select(id, { source: 'nav' }) : false;
  }
  // the selected component in the view it asks for (from the card / sheet when it was picked in another view)
  showInView() {
    const c = this.selected, want = c && c.camera && c.camera.view;
    if (!want || DV().getMode() === want || !this.setView(want)) return false;
    this.sel.switched = true; this.sel.keepAngle = false;
    if (this.sel.status === 'selected') this.focusNow(); else this.sel.focusDue = true;
    this.present();
    this.render({ source: 'view' });
    this.announce(`${this.viewLabel(want)} view.`);
    return true;
  }
  // the component's presentation: its `camera` block over the defaults; a pick keeps the visitor's angle
  focusNow() {
    const c = this.selected; if (!c) return null;
    const cam = c.camera || {}, o = { ...cam, fill: cam.fill != null ? cam.fill : this.cfg.focusFill, animate: !this.reduce.matches };
    delete o.view;
    if (this.sel.keepAngle) { delete o.azimuth; delete o.elevation; }
    if (this.mobile()) o.stopBeforeLOD = this.cfg.mobileStopBeforeLOD;
    this.sel.focus = DV().focusFeatures(c.featureNames, o);
    this.sel.focusDue = false;
    if (this.sel.focus) this.sel.framing = 'component';
    return this.sel.focus;
  }
  // presenting → presented: the camera has landed (or the visitor took over) and the highlight has eased in
  present() {
    const id = this.presentToken = (this.presentToken || 0) + 1, t0 = performance.now(), fade = this.reduce.matches ? 0 : this.cfg.highlightFadeMs;
    this.sel.presentation = 'presenting'; this.drawer.dataset.presentation = 'presenting';
    const tick = () => {
      if (id !== this.presentToken || !this.sel.id) return;
      if (DV().isCameraMoving() || performance.now() - t0 < fade) { requestAnimationFrame(tick); return; }
      this.sel.presentation = 'presented'; this.drawer.dataset.presentation = 'presented';
      this.drawer.dispatchEvent(new CustomEvent('productviewer:presented', { bubbles: true, detail: { component: this.sel.id, ms: Math.round(performance.now() - t0) } }));
    };
    requestAnimationFrame(tick);
  }
  // "View whole product" (the existing Reset; the selection stays) ↔ "Focus on <component>"
  toggleFraming() {
    const c = this.selected; if (!c) return false;
    if (this.sel.framing === 'component') {
      DV().resetView({ animate: !this.reduce.matches });
      this.sel.framing = 'product';
      this.announce('Whole product in view.');
    } else {
      this.sel.keepAngle = false;
      if (this.sel.status === 'selected') this.focusNow(); else this.sel.focusDue = true;
      this.present();
      this.announce(`${c.name} in focus.`);
    }
    this.render({ source: 'frame' });
    return true;
  }
  // a level of detail came in: the viewer has rebuilt the highlight; a pending selection now shows (and focuses)
  onLOD(d) {
    if (!this.sel.id || !this.card || !d || d.url !== this.card.dataset.productGlb) return;
    const hl = DV().getHighlight(), was = this.sel.status;
    this.sel.highlight = hl; this.sel.status = hl.overlays ? 'selected' : 'pending';
    if (this.sel.status === 'selected' && this.sel.focusDue) { this.focusNow(); this.present(); }
    if (was !== this.sel.status) { this.render({ source: 'lod' }); if (this.sel.status === 'selected') this.announce(`${this.selected.name} shown.`); }
  }
  render({ source } = {}) {
    const v = this.viewModel();
    this.renderDesktop(v, source);
    const u = UI(); if (u && u.state().active) u.showComponent(v, { source });
    this.writeUrl(v);
  }
  // the page's own Full / System switch (keeps its buttons, classes and hint in step)
  viewButton(mode) { const b = document.querySelector(`#drawer-modes .drawer__mode[data-mode="${mode}"]`); return b && !b.hidden ? b : null; }
  viewLabel(mode) { const b = this.viewButton(mode); return (b && b.textContent.trim()) || mode; }
  setView(mode) {
    const b = this.viewButton(mode); if (!b) return false;
    this.byUs = true; b.click(); this.byUs = false;
    return true;
  }
  announce(text) { this.live.textContent = ''; requestAnimationFrame(() => { this.live.textContent = text; }); }

  // ── deep link: ?product=<id>&component=<id> ──
  // Written with replaceState while a component is selected (no history entries of its own, so the Phase 23 back
  // button is unchanged) and removed on clear / close. On load the page entry is cleaned first — the open viewer
  // carries the state — then the product opens through the page's own card and the component follows once the model
  // and its features are there. An unknown product or component opens nothing more than what exists.
  writeUrl(v) {
    if (!this.cfg.deepLink) return;
    try {
      const u = new URL(location.href), q = u.searchParams;
      if (v && this.product) { q.set('product', this.product.id); q.set('component', v.id); } else { q.delete('product'); q.delete('component'); }
      const s = q.toString(), next = u.pathname + (s ? '?' + s : '') + u.hash;
      if (next !== location.pathname + location.search + location.hash) history.replaceState(history.state, '', next);
    } catch (e) { /* URL state is a convenience only */ }
  }
  applyLink() {
    let product = null, component = null;
    try { const q = new URLSearchParams(location.search); product = q.get('product'); component = q.get('component'); } catch (e) { return; }
    if (!product) return;
    this.writeUrl(null);
    const cards = [...document.querySelectorAll('.product-card[data-product-config]')];
    (async () => {
      for (const card of cards) { try { if ((await loadProductConfig(card.dataset.productConfig)).id === product) return card; } catch (e) { /* next */ } }
      return null;
    })().then(card => {
      if (!card) { console.warn(`[product] link: no product "${product}"`); return; }
      const go = () => { this.link = component || null; card.click(); };   // the page's own open()
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
    });
  }
  followLink() {
    const id = this.link; this.link = null;
    const c = this.component(id);
    if (!c || !c.available) { console.warn(`[product] link: no component "${id}" in ${this.product.id}`); return; }
    const card = this.card, t0 = performance.now();
    const go = () => {                                               // after the model is framed and its first LOD is on screen
      if (this.card !== card) return;
      const l = DV().getLODState();
      if ((!l || l.active == null || l.px == null) && performance.now() - t0 < 8000) { requestAnimationFrame(go); return; }
      this.select(id, { source: 'link' });
    };
    requestAnimationFrame(go);
  }

  // ── taps on the model ──
  down(e) {
    if (!this.resolved) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (this.pointers.size > 1) this.multi = true;
    const u = UI(); if (this.pointers.size === 1) this.ignore = !!(u && u.state().active && u.state().sheet === 'expanded');   // that tap returns the sheet to PEEK
  }
  up(e) {
    const p = this.pointers.get(e.pointerId); this.pointers.delete(e.pointerId);
    const multi = this.multi; if (!this.pointers.size) this.multi = false;
    if (!p || multi || this.ignore || e.type === 'pointercancel' || !this.resolved) return;
    if (e.timeStamp - p.t > this.cfg.tapMaxMs || Math.hypot(e.clientX - p.x, e.clientY - p.y) > this.cfg.tapSlopPx) return;   // a drag: orbit
    const x = e.clientX, y = e.clientY;
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') { this.tapAt(x, y); return; }
    const q = this.pending;
    if (q && e.timeStamp - q.t < this.cfg.doubleTapMs && Math.hypot(x - q.x, y - q.y) < this.cfg.doubleTapSlopPx) { clearTimeout(q.timer); this.pending = null; return; }   // double-tap = reset
    this.pending = { t: e.timeStamp, x, y, timer: setTimeout(() => { this.pending = null; this.tapAt(x, y, { touch: true }); }, this.cfg.doubleTapMs) };
  }
  tapAt(x, y, { touch = false } = {}) {
    if (!this.resolved) return { hit: null, component: null };
    const hit = touch && this.touchTargets && this.touchTargets.size ? DV().pickNear(x, y, { targets: this.touchTargets, names: this.selectable }) : DV().pickAt(x, y); this.last = hit;
    const id = hit && hit.name ? this.resolved.byFeature.get(hit.name) : null;
    if (id) { if (this.sel.id !== id) this.select(id, { source: 'pick' }); }
    else if (this.sel.id) this.clear({ source: 'pick-empty' });
    return { hit, component: id || null };
  }
  key(e) {
    if (e.key !== 'Escape' || !this.sel.id) return;
    const u = UI();
    if (this.mobile() && u.state().sheet !== 'closed') return;         // the sheet closes first (and that clears the selection)
    const lb = document.getElementById('drawer-lightbox'); if (lb && lb.classList.contains('is-open')) return;
    e.stopPropagation(); e.preventDefault();
    this.clear({ source: 'escape' });
  }

  // ── desktop: component card + explorer in the drawer's info column ──
  // Built once per product; a selection only rewrites text and states, so keyboard focus stays where it is.
  buildDesktop() {
    const scroller = this.drawer.querySelector('.drawer__info-scroll');
    if (!scroller) return false;
    const e = this.deskEl = {
      eyebrow: h('p', { class: 'pc-card__eyebrow' }),
      title: h('h3', { class: 'pc-card__title', id: 'pc-card-title', tabindex: '-1' }),
      short: h('p', { class: 'pc-card__short' }),
      prev: h('button', { type: 'button', class: 'pc-nav__btn', 'data-nav': 'prev' }, h('span', { 'aria-hidden': 'true', text: '‹' }), h('span', { text: 'Previous' })),
      next: h('button', { type: 'button', class: 'pc-nav__btn', 'data-nav': 'next' }, h('span', { text: 'Next' }), h('span', { 'aria-hidden': 'true', text: '›' })),
      countVis: h('span', { 'aria-hidden': 'true' }), countSr: h('span', { class: 'pc-sr' }),
      desc: h('p', { class: 'pc-card__desc' }),
      info: h('dl', { class: 'pc-card__info' }),
      note: h('p', { class: 'pc-card__note', text: 'Not shown at the current level of detail.' }),
      viewText: h('p', { class: 'pc-card__view' }),
      viewBtn: h('button', { type: 'button', class: 'pc-card__view-btn' }),
      frameBtn: h('button', { type: 'button', class: 'pc-card__view-btn pc-card__frame-btn' }),
      media: h('div', { class: 'pc-card__media' }),
      back: h('button', { type: 'button', class: 'pc-card__back', text: '← Back to product information' }),
    };
    e.nav = h('div', { class: 'pc-nav', role: 'group' }, e.prev, h('span', { class: 'pc-nav__count' }, e.countVis, e.countSr), e.next);
    e.actions = h('div', { class: 'pc-card__actions' }, e.viewBtn, e.frameBtn);
    this.deskCard = h('div', { class: 'pc-card', role: 'region', 'aria-labelledby': 'pc-card-title', hidden: true },
      e.eyebrow, e.title, e.short, e.nav, e.viewText, e.actions, e.media, e.desc, e.info, e.note, e.back);
    e.prev.addEventListener('click', () => { if (!isDisabled(e.prev)) this.step(-1); });
    e.next.addEventListener('click', () => { if (!isDisabled(e.next)) this.step(1); });
    e.viewBtn.addEventListener('click', () => { if (this.showInView()) e.title.focus({ preventScroll: true }); });
    e.frameBtn.addEventListener('click', () => this.toggleFraming());
    e.back.addEventListener('click', () => this.clear({ source: 'back' }));
    this.deskList = h('div', { class: 'pc-cats' });
    this.deskWrap = h('section', { class: 'pc-desk', 'aria-labelledby': 'pc-desk-title', hidden: true }, this.deskCard,
      h('h3', { class: 'pc-desk__title', id: 'pc-desk-title', text: 'Interactive components' }),
      h('p', { class: 'pc-desk__hint', text: 'Choose a component, or click it on the model.' }), this.deskList);
    this.deskContent = h('div', { class: 'pc-content', hidden: true });
    const desc = this.drawer.querySelector('#drawer-desc');
    if (desc && desc.parentNode === scroller) desc.after(this.deskContent, this.deskWrap); else scroller.append(this.deskContent, this.deskWrap);
    return true;
  }
  renderDesktop(v = null, source = null) {
    if (!this.deskWrap && !this.buildDesktop()) return;
    const p = this.product, comps = p ? p.components : [], cats = p ? p.componentCategories : [];
    const key = (p ? p.id : '') + '@' + cats.map(k => k.id + ':' + k.components.join(',')).join('|');
    if (key !== this.deskKey) {                                      // the explorer: rebuilt only when the product changes
      this.deskKey = key;
      const byId = new Map(comps.map(c => [c.id, c])), solo = cats.length === 1 && cats[0].implicit;
      this.deskList.replaceChildren(...cats.map(k => h('section', { class: 'pc-cat', 'aria-labelledby': solo ? null : `pc-cat-${k.id}` },
        !solo && h('h4', { class: 'pc-cat__title', id: `pc-cat-${k.id}` }, h('span', { text: k.name }), h('span', { class: 'pc-cat__count', 'aria-hidden': 'true', text: String(k.components.length) })),
        !solo && k.description && h('p', { class: 'pc-cat__desc', text: k.description }),
        h('ul', { class: 'pc-list' }, k.components.map(id => byId.get(id)).filter(Boolean).map(c => {
          const b = h('button', { type: 'button', class: 'pc-list__item', 'aria-pressed': 'false', 'data-component': c.id },
            h('span', { class: 'pc-list__check', 'aria-hidden': 'true' }), h('span', { class: 'pc-list__name', text: c.name }), h('span', { class: 'pc-list__note' }));
          b.addEventListener('click', () => { if (isDisabled(b)) return; if (this.sel.id === c.id) this.clear({ source: 'list' }); else this.select(c.id, { source: 'list' }); });
          return h('li', null, b);
        })))));
    }
    this.deskWrap.hidden = !comps.length;
    for (const b of this.deskList.querySelectorAll('.pc-list__item')) {
      const id = b.dataset.component, c = comps.find(x => x.id === id), ok = this.available(id), want = c && c.camera && c.camera.view;
      b.setAttribute('aria-pressed', String(!!(v && v.id === id)));
      setDisabled(b, !ok);
      b.lastChild.textContent = !ok ? 'Not in this 3D model' : [c.shortDescription, want && this.viewButton(want) ? `Opens in ${this.viewLabel(want)} view` : ''].filter(Boolean).join(' · ');
    }
    const e = this.deskEl;
    if (!v) { this.deskCard.hidden = true; return; }
    e.eyebrow.textContent = 'Component' + (v.category && !v.category.implicit ? ' · ' + v.category.name : '');
    e.title.textContent = v.name;
    e.short.textContent = v.shortDescription; e.short.hidden = !v.shortDescription;
    e.nav.hidden = v.count < 2;
    e.nav.setAttribute('aria-label', 'Components' + (v.category && !v.category.implicit ? ' in ' + v.category.name : ''));
    e.countVis.textContent = `${v.index + 1} / ${v.count}`;
    e.countSr.textContent = `Component ${v.index + 1} of ${v.count}`;
    setDisabled(e.prev, !v.prev); e.prev.setAttribute('aria-label', v.prev ? `Previous component: ${v.prev.name}` : 'Previous component: none');
    setDisabled(e.next, !v.next); e.next.setAttribute('aria-label', v.next ? `Next component: ${v.next.name}` : 'Next component: none');
    e.desc.textContent = v.description; e.desc.hidden = !v.description; e.desc.classList.toggle('is-placeholder', !!v.placeholder);
    e.info.replaceChildren(...v.information.map(r => h('div', null, h('dt', { text: r.key }), h('dd', { text: r.val }))));
    e.info.hidden = !v.information.length;
    e.note.hidden = !v.pending;
    const offView = !!(v.view && !v.view.active);
    e.viewText.hidden = e.viewBtn.hidden = !offView;
    if (v.view) { e.viewText.textContent = `Best seen in ${v.view.label} view.`; e.viewBtn.textContent = `Show in ${v.view.label} view`; }
    e.frameBtn.textContent = v.framing === 'component' ? 'View whole product' : `Focus on ${v.name}`;
    e.media.replaceChildren(...mediaThumbs(v, src => this.openPhoto(src)));
    e.media.hidden = !v.media.length;
    this.deskCard.hidden = false;
    if (source !== 'lod' && source !== 'mode') this.deskCard.scrollIntoView({ block: 'nearest', behavior: this.reduce.matches ? 'auto' : 'smooth' });
  }

  // the page's own photo lightbox (the sheet uses the same one)
  openPhoto(src) {
    const lb = document.getElementById('drawer-lightbox'), img = document.getElementById('drawer-lightbox-img');
    if (!lb || !img) return;
    img.src = src; lb.classList.add('is-open');
    const x = document.getElementById('drawer-lightbox-close'); if (x) x.focus({ preventScroll: true });
  }

  snapshot() {
    return { ready: this.ready, product: this.product ? this.product.id : null,
      components: this.resolved ? this.resolved.components.map(c => ({ id: c.id, features: c.featureNames.length, available: c.available })) : null,
      categories: this.product ? this.product.componentCategories.map(k => ({ id: k.id, name: k.name, components: [...k.components] })) : null,
      issues: this.resolved ? this.resolved.issues : null, dataIssues: this.product ? this.product.dataIssues : null,
      selected: this.sel.id, status: this.sel.status, source: this.sel.source || null, switched: !!this.sel.switched, focusDue: !!this.sel.focusDue,
      presentation: this.sel.presentation || null, framing: this.sel.framing || null,
      highlight: DV() ? DV().getHighlight() : null, lastPick: this.last, lastFocus: this.sel.focus || null, link: this.link };
  }
}

const interaction = new ProductInteraction();
window.ProductInteraction = {
  open: (card, opts) => interaction.open(card, opts),
  close: () => interaction.close(),
  select: (id, opts) => interaction.select(id, opts),
  clear: () => interaction.clear({ source: 'api' }),
  next: () => interaction.step(1),
  previous: () => interaction.step(-1),
  showInView: () => interaction.showInView(),
  toggleFraming: () => interaction.toggleFraming(),
  current: () => interaction.sel.id,
  available: id => interaction.available(id),
  tapAt: (x, y) => interaction.tapAt(x, y),
  state: () => interaction.snapshot(),
  interaction,
};
