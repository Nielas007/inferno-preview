// Phase 84b (+87 three columns, +89 live 3D on the stage) — products showcase stage (owner's ref, 2026-10-07: the Jacket Masters reel; then "still a bit confusing — make it
// easier to move through the products, show what's available per family, product more centred, fewer extra buttons").
// One product centre stage on a hairline horizon; under it the name, one line and "View details"; along the bottom ONE rail with
// every product, grouped by family. Choosing a product grows it out of its rail slot into the stage while the previous one shrinks
// back into its own slot. Copy and the drawer link come from the product cards (kept in the document, hidden).
// Cut-outs: images/showcase/<slug>-{700,1400}.webp (phase84 a_cutouts84.py); the slug is the card image's own name.

const root = document.getElementById('showcase');
if (root) init(root);

function init(root) {
  const section = root.closest('.products-section');
  // the cut-outs as literal paths (the dist trace copies only what it can read; a built-up template path would be missed)
  const CUT = {
    'attac-unit-2cu': ['images/showcase/attac-unit-2cu-700.webp?v=1', 'images/showcase/attac-unit-2cu-1400.webp?v=1'],
    'attac-bakkie-4cu': ['images/showcase/attac-bakkie-4cu-700.webp?v=1', 'images/showcase/attac-bakkie-4cu-1400.webp?v=1'],
    'attac-trailer': ['images/showcase/attac-trailer-700.webp?v=1', 'images/showcase/attac-trailer-1400.webp?v=1'],
    'inferno-beast': ['images/showcase/inferno-beast-700.webp?v=1', 'images/showcase/inferno-beast-1400.webp?v=1'],
    'skiddy': ['images/showcase/skiddy-700.webp?v=1', 'images/showcase/skiddy-1400.webp?v=1'],
    'vss': ['images/showcase/vss-700.webp?v=1', 'images/showcase/vss-1400.webp?v=1'],
    'extinguishers': ['images/showcase/extinguishers-700.webp?v=1', 'images/showcase/extinguishers-1400.webp?v=1'],
    'wall-guard-130l': ['images/showcase/wall-guard-130l-700.webp?v=1', 'images/showcase/wall-guard-130l-1400.webp?v=1'],
    'wall-guard-50l': ['images/showcase/wall-guard-50l-700.webp?v=1', 'images/showcase/wall-guard-50l-1400.webp?v=1'],
    'generator-lss': ['images/showcase/generator-lss-700.webp?v=1', 'images/showcase/generator-lss-1400.webp?v=1'],
    'transformer-lss': ['images/showcase/transformer-lss-700.webp?v=1', 'images/showcase/transformer-lss-1400.webp?v=1'],
    'riteline-box': ['images/showcase/riteline-box-700.webp?v=1', 'images/showcase/riteline-box-1400.webp?v=1'],   // Phase 127
  };
  // each product's own logo (the name, as the brand writes it)
  const LOGO = {
    'attac-unit-2cu': 'images/showcase/logo-attac-unit-2cu.webp?v=1',
    'attac-bakkie-4cu': 'images/showcase/logo-attac-bakkie-4cu.webp?v=1',
    'attac-trailer': 'images/showcase/logo-attac-trailer.webp?v=1',
    'inferno-beast': 'images/showcase/logo-inferno-beast.webp?v=1',
    'skiddy': 'images/showcase/logo-skiddy.webp?v=1',
    'vss': 'images/showcase/logo-vss.webp?v=1',
    'extinguishers': 'images/showcase/logo-extinguishers.webp?v=1',
    'wall-guard-130l': 'images/showcase/logo-wall-guard-130l.webp?v=1',
    'wall-guard-50l': 'images/showcase/logo-wall-guard-50l.webp?v=1',
    'generator-lss': 'images/showcase/logo-generator-lss.webp?v=1',
    'transformer-lss': 'images/showcase/logo-transformer-lss.webp?v=1',
  };
  const slugOf = card => ((card.querySelector('.product-card__img')?.getAttribute('src') || '').match(/cards\/(.+?)-640\.webp/) || [])[1];
  const cards = [...document.querySelectorAll('.products-groups .product-card')].filter(c => CUT[slugOf(c)]);
  if (!cards.length) return;
  section.classList.add('has-showcase');

  // glow per product: red for the red-cylinder rigs, amber for the haul truck, cool mist for generator rooms, copper for transformers
  const GLOW = { 'attac-unit-2cu': '#e4202c', 'attac-bakkie-4cu': '#d81d3a', 'attac-trailer': '#ef3a24', 'inferno-beast': '#c9472a',
    'skiddy': '#e02a2a', 'vss': '#e3a12c', 'extinguishers': '#e5202a', 'wall-guard-130l': '#c8202e', 'wall-guard-50l': '#e2372e',
    'generator-lss': '#3fa6e0', 'transformer-lss': '#d97a3a', 'riteline-box': '#e4202c' };
  // short rail names (the stage shows the full name)
  const SHORT = { 'attac-unit-2cu': 'Attac 2CU', 'attac-bakkie-4cu': 'Attac 4CU', 'attac-trailer': 'Attac Trailer', 'inferno-beast': 'Beast',
    'skiddy': 'Skiddy', 'vss': 'VSS', 'extinguishers': 'Extinguishers', 'wall-guard-130l': 'Wall Guard 130 L', 'wall-guard-50l': 'Wall Guard 50 L',
    'generator-lss': 'Generator', 'transformer-lss': 'Transformer', 'riteline-box': 'Riteline' };
  // three headline numbers, from the card's own specs
  const pickStats = card => {
    let specs = []; try { specs = JSON.parse(card.dataset.productSpecs || '[]'); } catch (e) {}
    const want = ['Cannon Range', 'Agent Weight', 'Capacity', 'Cylinder Capacity', 'Hose Length', 'Spray Time', 'Agent', 'Detection', 'Activation', 'Technology'];
    const out = [];
    for (const w of want) { const x = specs.find(y => y.key.startsWith(w) && !out.includes(y)); if (x) out.push(x); if (out.length === 3) break; }
    for (const x of specs) { if (out.length >= 3) break; if (!out.includes(x) && !/code/i.test(x.key)) out.push(x); }
    return out.map(x => ({ key: x.key.replace(/\s*\(.*?\)/g, ''), val: x.val }));
  };
  // Phase 123 (owner: "replace the Toyota bakkie with our Cruiser, keep an option button to change bakkies; the system must always
  // sit nicely on the back"): a product can come on more than one host vehicle. The first is the default; an option without a glb
  // is the card's own model. Switching rewrites the card's model + configuration, so the stage, Explore in 3D and the drawer all
  // show the chosen vehicle — the same Inferno unit, on its back.
  const VEHICLES = {
    'attac-bakkie-4cu': [
      { id: 'cruiser', label: 'Land Cruiser', glb: 'models/attac-4cu-cruiser.asset.json?v=136', config: 'products/attac-4cu-cruiser.json?v=136' },
      { id: 'hilux', label: 'Hilux' },
    ],
  };
  const items = cards.map((card, i) => {
    const slug = slugOf(card), group = card.closest('.products-group');
    const name = card.querySelector('.product-card__name')?.textContent.trim() || card.dataset.productName;
    return {
      card, slug, i, name, short: SHORT[slug] || name.replace(/^Inferno\s+/, ''),
      desc: card.querySelector('.product-card__desc')?.textContent.trim() || '',
      groupNum: group?.querySelector('.products-group__num')?.textContent.trim() || '',
      groupLabel: group?.querySelector('.products-group__label')?.textContent.trim() || '',
      glow: GLOW[slug] || '#e4202c', src700: CUT[slug][0], src: CUT[slug][1], logo: LOGO[slug], stats: pickStats(card)
    };
  });
  const N = items.length;
  for (const it of items) {
    const V = VEHICLES[it.slug]; if (!V) continue;
    it.own = { glb: it.card.dataset.productGlb, config: it.card.dataset.productConfig };
    setVehicle(it, V[0].id, true);
  }
  function setVehicle(it, id, quiet) {
    const v = (VEHICLES[it.slug] || []).find(x => x.id === id); if (!v) return;
    it.vehicle = id;
    it.card.dataset.productGlb = v.glb || it.own.glb; it.card.dataset.productConfig = v.config || it.own.config;
    if (quiet) return;   // (at start-up, before the caches exist)
    viewCache.delete(it.slug);
    renderVehicles(it);
    if (window.DrawerViewer && root.classList.contains('is-spraying')) { const DV = window.DrawerViewer; DV.setFoam(false); DV.setSystem(false); if (DV.setSpin) DV.setSpin(false); setActive(null); L.view = null; }
    buildActions(it);
    if (it === items[cur] && visibleNow) settle();   // the stage loads the chosen vehicle (the gauge shows while it comes in)
  }
  function renderVehicles(it) {
    const V = VEHICLES[it.slug]; vehEl.hidden = !V; if (!V) { vehEl.innerHTML = ''; return; }
    vehEl.innerHTML = '<span class="showcase__vehicle-label">Vehicle</span><span class="showcase__vehicle-opts">' + V.map(v =>
      `<button type="button" role="radio" aria-checked="${v.id === it.vehicle}" class="showcase__vehicle-opt${v.id === it.vehicle ? ' is-on' : ''}" data-vehicle="${v.id}">${v.label}</button>`).join('') + '</span>';
  }
  const $ = s => root.querySelector(s);
  const stage = $('.showcase__stage'), rail = $('.showcase__rail'), info = $('.showcase__info'), actions = $('.showcase__actions'), statsEl = $('.showcase__stats');
  const logoEl = $('.showcase__logo'), nameEl = $('.showcase__name'), descEl = $('.showcase__desc'), groupEl = $('.showcase__group'), cta = $('.showcase__cta');
  const vehEl = document.createElement('div'); vehEl.className = 'showcase__vehicle'; vehEl.hidden = true;
  vehEl.setAttribute('role', 'radiogroup'); vehEl.setAttribute('aria-label', 'Vehicle');
  cta.before(vehEl);
  vehEl.addEventListener('click', e => { const b = e.target.closest('.showcase__vehicle-opt'); if (!b || b.classList.contains('is-on')) return; setVehicle(items[cur], b.dataset.vehicle); });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // the rail: every product, grouped by family
  const slots = [];
  const families = [];
  items.forEach(it => { let f = families.find(x => x.num === it.groupNum); if (!f) families.push(f = { num: it.groupNum, label: it.groupLabel, items: [] }); f.items.push(it); });
  families.forEach(f => {
    const fam = document.createElement('div'); fam.className = 'showcase__fam';
    const head = document.createElement('div'); head.className = 'showcase__fam-head';
    head.innerHTML = '<span class="showcase__fam-label"></span><span class="showcase__fam-count"></span>';
    head.firstChild.textContent = f.label.replace(/ Systems$/, ''); head.lastChild.textContent = String(f.items.length);
    const row = document.createElement('div'); row.className = 'showcase__fam-items';
    f.items.forEach(it => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'showcase__item';
      b.innerHTML = '<span class="showcase__item-img"><img alt="" decoding="async" draggable="false"></span><span class="showcase__item-name"></span>';
      b.querySelector('img').src = it.src700; b.querySelector('.showcase__item-name').textContent = it.short;
      b.setAttribute('aria-label', it.name);
      b.addEventListener('click', () => go(it.i));
      slots[it.i] = b; row.appendChild(b);
    });
    fam.append(head, row); rail.appendChild(fam);
  });

  const makeFig = it => {
    const fig = document.createElement('figure'); fig.className = 'showcase__product';
    fig.innerHTML = '<div class="showcase__body"><div class="showcase__float"><img alt="" decoding="async" draggable="false"></div><div class="showcase__shadow"></div><img class="showcase__reflect" alt="" aria-hidden="true" decoding="async" draggable="false"></div>';
    const img = fig.querySelector('img');
    img.srcset = `${it.src700} 700w, ${it.src} 1400w`; img.sizes = '(max-width: 900px) 86vw, 50vw'; img.src = it.src700; img.alt = it.name;
    const rf = fig.querySelector('.showcase__reflect'); rf.src = it.src700;
    return fig;
  };
  // the 3D views, right of the product: each opens the 3D viewer straight in that view (product-sheet.js does the opening)
  const ACT = {
    full: ['Explore in 3D', 'Full screen — rotate and zoom', '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="M12 8l4 2.2v4.6L12 17l-4-2.2v-4.6z"/>'],
    system: ['See the system', 'The fire system on its own', '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5l3 8.5M16 7.5l-3 8.5M8.5 6h7"/>'],
    cutaway: ['T-ROTOR® Technology', 'Look inside a cylinder', '<path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/><path d="M4 14l6-6" stroke-dasharray="2 2"/>'],
    activate: ['Activate system', 'Watch it discharge', '<path d="M12 22c4 0 7-2.7 7-6.6 0-3.1-2-5.4-3.6-7.2-.5 1.6-1.5 2.8-2.7 3.1.4-3.2-1-6.3-3.7-8.3.2 3-1.3 5.2-3 7.2C4.8 11.6 5 13.4 5 15.4 5 19.3 8 22 12 22z"/>'],
    photos: ['View photos', 'Product photography', '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 17l-5-5-9 7"/>']
  };
  const viewCache = new Map();
  let actToken = 0;
  async function buildActions(it) {
    const token = ++actToken;
    const sheet = () => new Promise(r => { let k = 0; const t = () => (window.ProductSheet || ++k > 100) ? r(window.ProductSheet) : setTimeout(t, 50); t(); });
    if (!viewCache.has(it.slug)) viewCache.set(it.slug, sheet().then(ps => (ps ? ps.views(it.card) : [])).catch(() => []));
    let v = await viewCache.get(it.slug);
    if (token !== actToken) return;
    if (!v.length) v = ['photos'];
    actions.innerHTML = v.map((k, n) => `<button type="button" class="showcase__act${k === 'activate' ? ' showcase__act--live' : ''}" data-view="${k}" style="--n:${n}">
        <span class="showcase__act-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ACT[k][2]}</svg></span>
        <span class="showcase__act-text"><span class="showcase__act-label">${ACT[k][0]}</span><span class="showcase__act-sub">${ACT[k][1]}</span></span></button>`).join('');
    actions.classList.remove('is-in'); void actions.offsetWidth; actions.classList.add('is-in');
  }
  actions.addEventListener('click', e => {
    const b = e.target.closest('.showcase__act'); if (!b) return;
    const it = items[cur];
    if (b.dataset.view === 'photos' || !window.DrawerViewer) return it.card.click();
    if (b.dataset.view === 'full') return goBig('full');   // owner: "Explore in 3D" is the way to go big — full screen
    live(b.dataset.view);
  });

  // ── Phase 89: the product on the stage IS the live 3D model (owner: "pressing a button must not open another thing and then
  // show — it must happen on the product page; and it must stand on the showroom floor, not float"). For a 3D product the
  // drawer's own 3D stage (canvas + its HUD: fires, discharge labels) is borrowed into the showcase stage as soon as the product
  // is chosen and the section is in view; its cut-out stays only until the model is in, then the two cross-fade. The right-hand
  // buttons then act at once. Scrolling the section away (or a product without a model) hands the stage back and frees the GPU.
  const L = { on: false, url: null, ready: null, view: null, home: null, host: null, token: 0 };
  const cfgCache = new Map();
  const getCfg = url => { if (!cfgCache.has(url)) cfgCache.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null)); return cfgCache.get(url); };
  const is3D = it => it.card.dataset.productModel === 'true' && !!it.card.dataset.productGlb && !!window.DrawerViewer;
  const fsBtn = document.createElement('button');
  fsBtn.type = 'button'; fsBtn.className = 'showcase__fs'; fsBtn.setAttribute('aria-label', 'View full screen');
  fsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg><span>Full screen</span>';
  const hint = document.createElement('div'); hint.className = 'showcase__livehint'; hint.textContent = 'Drag to rotate · pinch or ⌘ + scroll to zoom';
  const spin = document.createElement('div'); spin.className = 'showcase__spin'; spin.setAttribute('aria-hidden', 'true');
  // Phase 104: back to the whole system — stops the spray / discharge and the turning, returns to the opening view
  const resetBtn = document.createElement('button'); resetBtn.type = 'button'; resetBtn.className = 'showcase__reset'; resetBtn.setAttribute('aria-label', 'Reset view');
  resetBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg><span>Reset view</span>';
  resetBtn.addEventListener('click', e => {
    e.stopPropagation();
    const DV = window.DrawerViewer; if (!DV) return;
    DV.setSystem(false); DV.setFoam(false); if (DV.setSpin) DV.setSpin(false);
    if (DV.getMode() !== 'full') DV.setMode('full'); else DV.resetView();
    setActive(null); L.view = null; sprayOff();
  });
  // Phase 121 (owner: "no POV button — Activate goes straight into POV; and a button to see the whole vehicle spraying"): while
  // the cannon sprays you stand behind it (POV); this button glides out to the whole vehicle (turning slowly), and back to POV
  const ICO_WIDE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  const ICO_POV = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const povBtn = document.createElement('button'); povBtn.type = 'button'; povBtn.className = 'showcase__pov';
  let spinT = 0;
  const syncPov = () => { const on = !!(window.DrawerViewer && window.DrawerViewer.getPOV && window.DrawerViewer.getPOV());
    root.classList.toggle('is-pov', on); povBtn.innerHTML = (on ? ICO_WIDE : ICO_POV) + `<span>${on ? 'Whole system' : 'POV'}</span>`; };
  const sprayOff = () => { const DV = window.DrawerViewer; clearTimeout(spinT); if (DV && DV.setPOV) DV.setPOV(false); root.classList.remove('is-spraying'); syncPov(); };
  povBtn.addEventListener('click', e => {
    e.stopPropagation();
    const DV = window.DrawerViewer; if (!DV || !DV.setPOV) return;
    clearTimeout(spinT);
    if (DV.getPOV()) { DV.setPOV(false, { whole: true }); spinT = setTimeout(() => { if (!DV.getPOV() && DV.setSpin) DV.setSpin(true, -0.55); }, 1900); }   // out to the whole vehicle, then a slow turn
    else { if (DV.setSpin) DV.setSpin(false); DV.setPOV(true); }
    syncPov();
  });
  let visibleNow = false;
  const ROOM_PANO = matchMedia('(max-width: 900px)').matches ? 'images/showcase/room-pano-4096.webp?v=2' : 'images/showcase/room-pano.webp?v=2';
  const ROOM_ENV = 'images/showcase/room-env.hdr?v=2', ROOM_ANGLE = 0;
  // ── Phase 101: the room (owner's image: a dark wall of sweeping plates with red neon edges, and a floor). It is laid out so the
  // product's foot stands on the image's floor a little in front of the wall line, and it moves with the camera like a real room:
  // the wall and the floor shift at different rates (parallax), zoom scales it a little, and the orbit is held to ±40° so the
  // view never leaves the room. When nobody touches it the camera sways gently. The neon carries its own bloom and a running pulse.
  const bd = root.querySelector('.showcase__backdrop');
  const BD = { iw: 2720, ih: 1536, hz: 0.75, foot: null, W: 0, H: 0 };
  // Phase 108 (owner: "you keep messing up the wall"): the wall is shown WHOLE, the way the owner's picture is — full width of the
  // section, from its top, never zoomed past cover and never shifted per product. The product is moved onto the image's floor
  // instead (--live-dy), so the room stays put and only the product changes.
  BD.hz = 0.762;   // the floor line in the room image (room-neon-v2)
  const FWD = 0.19;   // Phase 113 (owner: "bring the products a bit forward"): the foot this far below the floor line, in room heights (was 0.15)
  function layoutBackdrop(footY) {
    if (!bd) return;
    if (footY != null) BD.foot = footY;
    const rw = root.clientWidth, rh = root.clientHeight;
    // Phase 109 (owner: "push the wall back so it looks further away and we see more of its detail"): the picture at 78 % of the
    // section width, centred; its sides melt into the page's black (CSS mask), so more of the wall is seen and it reads as deeper
    const ZOOM = matchMedia('(max-width: 900px)').matches ? 1.25 : 0.78;
    let W = rw * ZOOM, H = W * BD.ih / BD.iw;
    // the floor line sits just behind the product's foot; at most a sixth of the picture's top goes under the nav, never more
    if (BD.foot != null && (BD.top == null || BD.lw !== rw)) { BD.top = Math.min(0, Math.max(-H / 4, BD.foot - (BD.hz + FWD) * H)); /* 108b: wall further back, products well forward on the floor */ BD.lw = rw; }   // set once per width: the room never moves between products
    const top = BD.top != null ? BD.top : 0;
    BD.W = W; BD.H = H;
    bd.style.setProperty('--bd-w', W + 'px'); bd.style.setProperty('--bd-h', H + 'px');
    bd.style.setProperty('--bd-x', ((rw - W) / 2) + 'px'); bd.style.setProperty('--bd-y', top + 'px');
    bd.style.setProperty('--bd-bottom', (top + H) + 'px');
    bd.style.setProperty('--bd-hz', (top + BD.hz * H) + 'px');   // Phase 110: where the wall meets the floor (the cove)
    // the product's foot belongs a little in front of the floor line
    if (BD.foot != null) {
      const want = top + (BD.hz + FWD) * H, cur = BD.foot;   // measured before the model is shown (no offset applied yet)
      BD.dy = Math.round(want - cur); root.style.setProperty('--live-dy', BD.dy + 'px');
    }
  }
  const ORB = { az0: null, el0: 0, d0: 1, ax: 0, ay: 0, z: 1, user: 0, drag: false, t0: performance.now() };
  stage.addEventListener('pointerdown', () => { ORB.drag = true; ORB.user = performance.now(); });
  addEventListener('pointerup', () => { if (ORB.drag) { ORB.drag = false; ORB.user = performance.now(); } });
  stage.addEventListener('wheel', () => { ORB.user = performance.now(); }, { passive: true });
  const LIM = 0.7;   // ±40°
  const TILT = matchMedia('(max-width: 900px)').matches ? 76 * Math.PI / 180 : 80 * Math.PI / 180;   // Phase 103b: polar angle that matches the room image
  // Phase 103: a turntable. On the page the product only turns (any amount, round its own axis) and zooms; the camera's tilt is
  // locked to the opening view so the product always stands on the image's floor, there is no pan, and the room image stays
  // perfectly still. Full freedom (tilt, pan, everything) is in "Explore in 3D". The lights follow the camera (drawer-viewer
  // TURN), so the shadow and the light stay put while the product turns.
  function orbitTick(now) {
    requestAnimationFrame(orbitTick);
    if (!visibleNow || !bd) return;
    const v = window.__dv, live = root.classList.contains('is-live') && v && v.camera && v.loaded && !drawerOpen();
    if (live && ORB.az0 == null) {
      // the room image is shot from about eye height, looking almost level: the product is seen from the same angle
      ORB.az0 = 0; ORB.polar = TILT; ORB.saved = { minP: v.controls.minPolarAngle, maxP: v.controls.maxPolarAngle, pan: v.controls.enablePan };
    }
    if (live && ORB.az0 != null) {   // every frame (the product camera re-applies its own limits)
      if (window.DrawerViewer.setPolarLock) window.DrawerViewer.setPolarLock(ORB.polar);
      v.controls.minAzimuthAngle = -Infinity; v.controls.maxAzimuthAngle = Infinity;
      v.controls.enablePan = false;
    }
    bd.style.setProperty('--px1', '0px'); bd.style.setProperty('--px2', '0px'); bd.style.setProperty('--py1', '0px'); bd.style.setProperty('--py2', '0px'); bd.style.setProperty('--bs', '1');
  }
  requestAnimationFrame(orbitTick);
  const resetOrbit = () => { const v = window.__dv; ORB.az0 = null; root.classList.remove('has-room');
    if (v && v.controls) { v.controls.minAzimuthAngle = -Infinity; v.controls.maxAzimuthAngle = Infinity;
      if (window.DrawerViewer && window.DrawerViewer.setPolarLock) window.DrawerViewer.setPolarLock(null);
      if (ORB.saved) { v.controls.minPolarAngle = ORB.saved.minP; v.controls.maxPolarAngle = ORB.saved.maxP; v.controls.enablePan = ORB.saved.pan; ORB.saved = null; } } };
  // Phase 99c (owner: "the background looks like a heavy vignette — too many dark corners"): the 3D layer spans the whole width of
  // the section, edge to edge, so the wall fills the room and needs no fade at the sides
  function sizeHost() {
    if (!L.host) return;
    const sr = stage.getBoundingClientRect(), rr = root.getBoundingClientRect();
    if (matchMedia('(max-width: 900px)').matches) { L.host.style.left = L.host.style.right = ''; return; }
    L.host.style.left = (rr.left - sr.left) + 'px'; L.host.style.right = (sr.right - rr.right) + 'px';
  }
  addEventListener('resize', () => { sizeHost(); if (window.DrawerViewer && L.on) window.DrawerViewer.refreshSize(); layoutBackdrop(); });

  // ── Phase 91: one seamless showroom behind the product (wall glow, floor sheen, a pool of the product's light where it
  // stands) and, while a model loads, a pressure gauge that "pressurises" to the product's own working pressure.
  const room = document.createElement('div'); room.className = 'showcase__room'; room.setAttribute('aria-hidden', 'true');
  stage.prepend(room);
  // Phase 96: the back wall — an abstract relief of interlocking dark frames with rounded openings (owner's references), two
  // layers at different angles for depth; now and then a thin light runs along the edge of one of the shapes, in the product's
  // colour (the same light that lies on the floor). Generated once, deterministic.
  const wall = document.createElement('div'); wall.className = 'showcase__wall'; wall.setAttribute('aria-hidden', 'true');
  wall.innerHTML = buildWall(); stage.prepend(wall);
  // Phase 95: low-lying mist drifting across the floor of the bay (in front of the product's feet)
  const mist = document.createElement('div'); mist.className = 'showcase__mist'; mist.setAttribute('aria-hidden', 'true');
  mist.innerHTML = '<i></i><i></i><i></i>'; stage.appendChild(mist);
  const setFloor = px => {   // px: the product's foot, in stage pixels from the top -> the room's own coordinates
    const H = stage.clientHeight || 1;
    root.style.setProperty('--fy', (((0.4 * H + px) / (1.8 * H)) * 100).toFixed(2) + '%');   // the room spans -40 % .. 140 % of the stage height (Phase 93)
  };
  setFloor((stage.clientHeight || 500) * 0.95);
  // Phase 92 (owner: "the pressure gauge doesn't work like a real one"): a real fire-extinguisher gauge. A numbered 0–30 bar dial
  // with a red RECHARGE zone, a green zone around the product's own working pressure and a red OVERCHARGED zone; the needle is
  // driven by the REAL download (the bytes of this asset's files as they arrive, against the sizes its manifest lists) through a
  // damped spring, trembles a little while pressure builds, and on arrival overshoots and settles in the green. A product with no
  // published working pressure gets an honest 0–100 % "loading" dial instead (no invented pressure).
  const loader = (() => {
    const el = document.createElement('div'); el.className = 'showcase__loader'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.innerHTML = `<div class="showcase__gauge"><svg viewBox="0 0 160 160" aria-hidden="true"></svg><span class="showcase__puff"></span></div>
      <div class="showcase__loader-val"><span class="showcase__loader-num">0</span><span class="showcase__loader-unit">bar</span></div>
      <div class="showcase__loader-label">Pressurising</div>`;
    stage.appendChild(el);
    const svg = el.querySelector('svg'), num = el.querySelector('.showcase__loader-num'), unit = el.querySelector('.showcase__loader-unit'), label = el.querySelector('.showcase__loader-label');
    const C = 80, A0 = -135, SPAN = 270;
    const pt = (f, r) => { const a = (A0 + SPAN * f) * Math.PI / 180; return [(C + r * Math.sin(a)).toFixed(2), (C - r * Math.cos(a)).toFixed(2)]; };
    const arc = (f0, f1, r) => { const [x0, y0] = pt(f0, r), [x1, y1] = pt(f1, r); return `M ${x0} ${y0} A ${r} ${r} 0 ${SPAN * (f1 - f0) > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
    let max = 30, work = 17, dec = 1, needle = null;
    const face = (pressure) => {
      if (pressure) { work = pressure; max = Math.max(10, Math.ceil(pressure * 1.6 / 5) * 5); dec = 1; } else { work = 100; max = 100; dec = 0; }
      const major = pressure ? 5 : 20, minor = pressure ? 1 : 5, g0 = pressure ? work * 0.85 / max : 0.9, g1 = pressure ? Math.min(1, work * 1.15 / max) : 1;
      let ticks = '', nums = '';
      for (let v = 0; v <= max + 1e-6; v += minor) {
        const f = v / max, big = Math.abs(v / major - Math.round(v / major)) < 1e-6, [x0, y0] = pt(f, 66), [x1, y1] = pt(f, big ? 57 : 61);
        ticks += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="${big ? 'mj' : 'mn'}"/>`;
        if (big) { const [tx, ty] = pt(f, 46); nums += `<text x="${tx}" y="${ty}">${v}</text>`; }
      }
      svg.innerHTML = `<defs>
          <radialGradient id="scg-face" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#1b1c22"/><stop offset="1" stop-color="#07080b"/></radialGradient>
          <linearGradient id="scg-bezel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9dde3"/><stop offset=".35" stop-color="#5d6068"/><stop offset=".65" stop-color="#2a2c31"/><stop offset="1" stop-color="#a9adb5"/></linearGradient>
          <linearGradient id="scg-glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".14"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
        </defs>
        <circle cx="80" cy="80" r="76" fill="url(#scg-bezel)"/><circle cx="80" cy="80" r="71" fill="url(#scg-face)"/>
        ${pressure ? `<path d="${arc(0, g0, 68.5)}" class="zr"/>` : ''}<path d="${arc(g0, g1, 68.5)}" class="zg"/>${pressure && g1 < 1 ? `<path d="${arc(g1, 1, 68.5)}" class="zr"/>` : ''}
        <g class="tk">${ticks}</g><g class="nm">${nums}</g>
        <text x="80" y="${pressure ? 112 : 112}" class="un">${pressure ? 'BAR' : '%'}</text>
        ${pressure ? `<text x="80" y="122" class="sub">WORKING ${work}</text>` : ''}
        <g class="nd"><path d="M 77.6 92 L 79.2 18 L 80.8 18 L 82.4 92 Z"/><circle cx="80" cy="80" r="6.5"/><circle cx="80" cy="80" r="2.2" class="pin"/></g>
        <ellipse cx="80" cy="48" rx="58" ry="34" fill="url(#scg-glass)" class="gl"/>`;
      needle = svg.querySelector('.nd');
      unit.textContent = pressure ? 'bar' : '%';
    };
    // the needle: a damped spring towards the target, with a tremble while pressure builds
    let v = 0, vel = 0, tgt = 0, raf = 0, last = 0, mode = 'idle', settleRes = null, prog = 0, track = null;
    const draw = () => {
      const f = Math.max(-0.01, Math.min(1.02, v / max));
      if (needle) needle.setAttribute('transform', `rotate(${(A0 + SPAN * f).toFixed(2)} 80 80)`);
      num.textContent = Math.max(0, v).toFixed(dec);
    };
    const loop = now => {
      const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
      let t = tgt;
      if (mode === 'load') { tgt = work * Math.min(0.94, prog); t = tgt + Math.sin(now / 37) * 0.06 * work / 17 + Math.sin(now / 91) * 0.05 * work / 17; }
      const k = mode === 'done' ? 90 : 38, c = mode === 'done' ? 7.5 : 11;
      vel += (k * (t - v) - c * vel) * dt; v += vel * dt; draw();
      if (mode === 'done' && Math.abs(v - tgt) < work * 0.002 && Math.abs(vel) < work * 0.01) { v = tgt; draw(); mode = 'idle'; raf = 0; const r = settleRes; settleRes = null; r && r(); return; }
      raf = requestAnimationFrame(loop);
    };
    const run = () => { if (!raf) { last = 0; raf = requestAnimationFrame(loop); } };
    // real download progress: bytes of this asset's files as they arrive / the sizes its manifest lists
    const follow = async it => {
      if (track) { track.disconnect(); track = null; }
      prog = 0;
      const url = it.card.dataset.productGlb || '';
      let base = '', expected = 0;
      try {
        const m = await (await fetch(url)).json();
        base = new URL(m.base || '', new URL(url, location.href)).pathname;
        expected = (m.textures || []).reduce((a, t) => a + (t.kb || 0) * 1024, 0) + ((m.metrics && m.metrics.brotliMB && m.metrics.brotliMB.LOD0) || 2) * 1e6;
      } catch (e) {}
      if (!base || !expected) { const t0 = performance.now(); const tick = () => { if (mode !== 'load') return; prog = 1 - Math.exp(-(performance.now() - t0) / 2200); requestAnimationFrame(tick); }; tick(); return; }
      try { performance.setResourceTimingBufferSize(4000); } catch (e) {}
      let got = 0; const seen = new Set();
      const take = list => { for (const e of list) { if (seen.has(e.name)) continue; let p = ''; try { p = new URL(e.name).pathname; } catch (x) { continue; } if (!p.startsWith(base)) continue; seen.add(e.name); got += e.encodedBodySize || e.decodedBodySize || e.transferSize || 0; } prog = Math.min(1, got / expected); };
      take(performance.getEntriesByType('resource'));
      track = new PerformanceObserver(l => take(l.getEntries())); track.observe({ type: 'resource' });
    };
    return {
      reset(it) {
        face(17);   // Phase 114 (owner): every product loads on the same 17 bar gauge
        cancelAnimationFrame(raf); raf = 0; mode = 'idle'; v = vel = tgt = 0; draw();
        el.classList.remove('is-done'); label.textContent = 'Pressurising';
      },
      start(it) { this.reset(it); mode = 'load'; follow(it); run(); },
      finish() {
        if (track) { track.disconnect(); track = null; }
        return new Promise(res => {
          if (reduce) { v = tgt = work; draw(); label.textContent = 'Ready'; el.classList.add('is-done'); return res(); }
          mode = 'done'; tgt = work; settleRes = () => { label.textContent = 'Ready'; el.classList.add('is-done'); setTimeout(res, 380); };
          run();
        });
      }
    };
  })();
  // the floor follows the model's foot once it is in
  const floorToModel = () => {
    const b = window.DrawerViewer && window.DrawerViewer.getProductScreenBox && window.DrawerViewer.getProductScreenBox();
    if (!b || !L.host) return;
    const hr = L.host.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    setFloor(hr.top - sr.top + b.y1 * (hr.height / b.height) - 4);
    // Phase 96: where the back wall meets the floor — a little behind the product, about a third of its height above its foot
    const H = stage.clientHeight || 1, k = hr.height / b.height, foot = hr.top - sr.top + b.y1 * k, top = hr.top - sr.top + b.y0 * k;
    root.style.setProperty('--wy', ((foot - 0.36 * (foot - top)) / H * 100).toFixed(2) + '%');
    layoutBackdrop(sr.top - root.getBoundingClientRect().top + foot);
    // Phase 113 (owner: "that premium glow and reflection on the floor"): the canvas mirrored about the product's foot line
    // (-webkit-box-reflect, offset so the flip axis is the foot), and a pool of the product's light where it stands
    const fh = b.y1 * k - 2, hh = hr.height || 1;
    L.host.style.setProperty('--rf-off', (-2 * (hh - fh)).toFixed(1) + 'px');
    L.host.style.setProperty('--rf-f', (fh / hh * 100).toFixed(2) + '%');
    L.host.style.setProperty('--rf-t', Math.max(0, (fh - 0.2 * (fh - b.y0 * k)) / hh * 100).toFixed(2) + '%');
    L.host.style.setProperty('--pool-x', ((b.x0 + b.x1) / 2 * (hr.width / b.width)).toFixed(1) + 'px');
    L.host.style.setProperty('--pool-y', fh.toFixed(1) + 'px');
    L.host.style.setProperty('--pool-w', ((b.x1 - b.x0) * (hr.width / b.width)).toFixed(1) + 'px');
  };

  // bring the model of the current product onto the stage (quietly: the cut-out holds until the model is in)
  function mount() {
    const DV = window.DrawerViewer, it = items[cur], s3 = document.getElementById('drawer-stage-3d');
    if (!DV || !s3 || !is3D(it)) return null;
    if (!L.host) {
      L.host = document.createElement('div'); L.host.className = 'showcase__live';
      L.host.insertAdjacentHTML('afterbegin', '<div class="showcase__pool" aria-hidden="true"></div>');   // Phase 113: the product's light on the floor
      L.host.addEventListener('wheel', e => { if (window.__dv) window.__dv.controls.enableZoom = !!(e.ctrlKey || e.metaKey); }, { capture: true, passive: true });
    }
    if (!L.on) {
      L.home = { parent: s3.parentElement, next: s3.nextSibling };
      stage.append(L.host, hint, spin, resetBtn, povBtn); L.host.appendChild(s3);
      sizeHost();
      if (DV.setTransparent) DV.setTransparent(true);   // Phase 90: no studio box — the page's showroom shows behind the model
      root.classList.add('is-live'); L.on = true;
    }
    const glb = it.card.dataset.productGlb;
    if (L.url !== glb) {
      const token = ++L.token;
      root.classList.remove('has-3d'); L.view = null; setActive(null); sprayOff();
      if (window.DrawerViewer && window.DrawerViewer.setRiteline) { window.DrawerViewer.setRiteline(false); rlCaptions(false); }   // Phase 127
      L.url = glb;
      loader.start(it);
      L.ready = (async () => {
        const cfg = await getCfg(it.card.dataset.productConfig);
        if (token !== L.token) return false;
        if (cfg && cfg.viewer && cfg.viewer.presentation && DV.setPresentation) DV.setPresentation(glb, cfg.viewer.presentation);
        if (cfg && cfg.viewer && cfg.viewer.camera && DV.setFraming) DV.setFraming(glb, cfg.viewer.camera);   // Phase 127: legacy GLB framing (the Riteline)
        DV.open(glb);
        const t0 = performance.now();
        while (!(window.__dv && window.__dv.loaded && window.__dv.url === glb)) {
          if (token !== L.token || performance.now() - t0 > 60000) return false;
          await new Promise(r => setTimeout(r, 120));
        }
        DV.refreshSize();
        await new Promise(r => setTimeout(r, 300));   // first frames settle (shadows, AO) before the model shows
        if (token !== L.token) return false;
        floorToModel();
        // Phase 96: the product at its full size again (owner's reference); the turntable (Phase 95, DV.setPlinth) is not used
        // Phase 103 (owner: "keep the background I gave you, the product just turns and zooms"): no Blender room on the page (DV.setSkybox unused)
        await loader.finish();
        if (token !== L.token) return false;
        root.classList.add('has-3d'); root.classList.remove('is-loading');
        return true;
      })();
    }
    return L.ready;
  }
  // a button: act on the model now (or as soon as it is in)
  async function live(view) {
    const it = items[cur];
    if (!is3D(it)) return it.card.click();
    setActive(view);
    if (matchMedia('(max-width: 900px)').matches) {   // on a phone the buttons sit below the stage: bring it into view
      const r = stage.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) {
        const y = scrollY + r.top - 70;
        if (window.__lenis) window.__lenis.scrollTo(y, { duration: 0.9 }); else scrollTo({ top: y, behavior: 'smooth' });
      }
    }
    const token = L.token, p = mount();
    if (!p) return;
    if (!root.classList.contains('has-3d')) root.classList.add('is-loading');
    const ok = await p;
    if (!ok || token !== L.token && L.url !== it.card.dataset.productGlb) return;
    apply(view);
  }
  function apply(view) {
    const DV = window.DrawerViewer, vss = /vss/.test(items[cur].card.dataset.productGlb || '');
    if (/riteline/.test(items[cur].card.dataset.productGlb || '') && DV.setRiteline) {   // Phase 127: the Riteline's own sequence
      if (view === 'activate') { const on = !(L.view === 'activate' && DV.getRiteline()); DV.setRiteline(on); setActive(on ? 'activate' : null); L.view = on ? 'activate' : null; rlCaptions(on); return; }
      DV.setRiteline(false); rlCaptions(false);
    }
    if (view === 'activate') {
      const was = L.view === 'activate' && (vss ? DV.getSystem() : DV.getFoam());
      if (was) { if (vss) DV.setSystem(false); else DV.setFoam(false); if (DV.setSpin) DV.setSpin(false); setActive(null); L.view = null; sprayOff(); return; }   // press again: stop
      // Phase 114 (owner: "activate system must not change the view"): the discharge starts where the visitor is looking — no
      // camera jump, no close-up; the scene still turns on its own (Phase 104) so you just aim at the fires
      if (vss) { if (DV.getMode() !== 'system') DV.setMode('system', { keepView: true }); DV.setSystem(true); }
      else { if (DV.getMode() !== 'gun') DV.setMode('gun', { keepView: true }); DV.setFoam(true); if (DV.setSpin) DV.setSpin(false); if (DV.setPOV) DV.setPOV(true); root.classList.add('is-spraying'); syncPov(); }   // Phase 121: straight into POV
    } else {
      DV.setSystem(false); DV.setFoam(false); if (DV.setSpin) DV.setSpin(false); sprayOff();
      if (DV.getMode() !== view) DV.setMode(view);
      else if (view === 'full') DV.resetView();
    }
    L.view = view;
  }
  // Phase 127: the Riteline's steps, captioned as they happen (how it works, in four lines)
  const RL_STEPS = [[0, '01', 'Electrical panel in service'], [1.2, '02', 'A component catches fire'], [3.3, '03', 'The detection tube bursts right above it'],
    [3.7, '04', 'The agent blasts out of the burst onto the fire'], [5.4, '05', 'The whole panel floods — fire out, no power needed']];
  const rlCap = document.createElement('div'); rlCap.className = 'showcase__rlcap'; rlCap.setAttribute('aria-live', 'polite');
  let rlRaf = 0, rlLast = '';
  // Phase 130 (owner: "a rewatch button somewhere"): plays the sequence again from the closed door, while it runs
  const rlReplay = document.createElement('button'); rlReplay.type = 'button'; rlReplay.className = 'showcase__rlreplay';
  rlReplay.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>Rewatch</span>';
  rlReplay.addEventListener('click', e => { e.stopPropagation(); const DV = window.DrawerViewer; if (!DV || !DV.setRiteline) return;
    DV.setRiteline(true); setActive('activate'); L.view = 'activate'; rlCaptions(true); });
  function rlCaptions(on) {
    cancelAnimationFrame(rlRaf); rlLast = ''; root.classList.toggle('is-riteline', !!on);   // the text steps back while the panel opens over it
    if (!on) { rlCap.classList.remove('is-on'); return; }
    if (!rlCap.isConnected) stage.appendChild(rlCap);
    if (!rlReplay.isConnected) stage.appendChild(rlReplay);
    const tick = () => {
      const t = window.DrawerViewer && window.DrawerViewer.getRitelineT ? window.DrawerViewer.getRitelineT() : -1;
      if (t < 0) { rlCap.classList.remove('is-on'); return; }
      const st = RL_STEPS.filter(x => t >= x[0]).pop();
      if (st && st[1] !== rlLast) { rlLast = st[1]; rlCap.innerHTML = `<span class="showcase__rlcap-n">${st[1]}</span><span class="showcase__rlcap-t">${st[2]}</span>`; rlCap.classList.remove('is-on'); void rlCap.offsetWidth; rlCap.classList.add('is-on'); }
      rlRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  function setActive(view) {
    actions.querySelectorAll('.showcase__act').forEach(b => b.classList.toggle('is-on', b.dataset.view === view));
    const a = actions.querySelector('.showcase__act[data-view="activate"] .showcase__act-sub');
    if (a) a.textContent = view === 'activate' ? 'Press again to stop' : ACT.activate[1];
  }
  // between products: hide the model while the cut-outs fly, keep the stage borrowed
  function hold() {
    resetOrbit();
    if (!L.on) return;
    ++L.token; L.url = null; L.view = null;
    const DV = window.DrawerViewer; if (DV) { DV.setSystem(false); DV.setFoam(false); if (DV.setSpin) DV.setSpin(false); if (DV.setRiteline) DV.setRiteline(false); }
    rlCaptions(false); root.classList.remove('has-3d', 'is-loading'); setActive(null);
  }
  function exitLive() {
    resetOrbit();
    if (!L.on) return;
    ++L.token; L.on = false; L.url = null; L.view = null; L.ready = null;
    const DV = window.DrawerViewer, s3 = document.getElementById('drawer-stage-3d');
    if (DV) { DV.setSystem(false); DV.setFoam(false); if (DV.setSpin) DV.setSpin(false); if (DV.setTransparent) DV.setTransparent(false); DV.close(); }
    if (window.__dv) window.__dv.controls.enableZoom = true;
    if (s3 && L.home) L.home.parent.insertBefore(s3, L.home.next && L.home.next.parentNode === L.home.parent ? L.home.next : null);
    L.host.remove(); fsBtn.remove(); hint.remove(); spin.remove(); resetBtn.remove(); povBtn.remove(); sprayOff();
    root.classList.remove('is-live', 'is-loading', 'has-3d');
    setActive(null);
  }
  const settle = () => { if (!visibleNow || drawerOpen()) return; if (is3D(items[cur])) mount(); else exitLive(); };
  const drawerOpen = () => !!document.querySelector('#product-drawer.is-open');
  function goBig(view) {
    const it = items[cur];
    exitLive();
    if (window.ProductSheet) window.ProductSheet.open3D(view, it.card); else it.card.click();
  }
  fsBtn.addEventListener('click', () => goBig(L.view || 'full'));
  new IntersectionObserver(es => {
    visibleNow = es[0].isIntersecting && es[0].intersectionRatio > 0.25;
    if (!es[0].isIntersecting) exitLive(); else settle();
  }, { threshold: [0, 0.25, 0.5] }).observe(root);
  // the full-screen drawer closed: the model comes back to the stage
  const drawerEl = document.getElementById('product-drawer');
  if (drawerEl) new MutationObserver(() => { if (!drawerOpen()) setTimeout(settle, 450); }).observe(drawerEl, { attributes: true, attributeFilter: ['class'] });

  const setText = it => {
    groupEl.textContent = it.groupLabel;
    nameEl.textContent = it.name;
    if (logoEl) { logoEl.src = it.logo || ''; logoEl.hidden = !it.logo; }
    descEl.textContent = it.desc;
    statsEl.innerHTML = '';
    it.stats.forEach(x => { const d = document.createElement('div'); d.innerHTML = '<dt></dt><dd></dd>'; d.firstChild.textContent = x.key; d.lastChild.textContent = x.val; statsEl.appendChild(d); });
    buildActions(it); renderVehicles(it);
    root.classList.toggle('is-3d', is3D(it));
    if (is3D(it)) loader.reset(it);
    root.style.setProperty('--glow', it.glow);
    slots.forEach((b, k) => { b.classList.toggle('is-on', k === it.i); if (k === it.i) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
    cta.setAttribute('aria-label', `View details: ${it.name}`);
  };

  let cur = 0, fig = null, busy = false;
  if (!is3D(items[0])) { fig = makeFig(items[0]); stage.appendChild(fig); }
  setText(items[0]);
  requestAnimationFrame(() => layoutBackdrop(stage.offsetTop + stage.clientHeight * 0.95));

  // where a rail slot sits relative to the product on stage, and how big it is against it
  const slotGeom = (i, el) => {
    const sr = stage.getBoundingClientRect(), r = slots[i].querySelector('.showcase__item-img').getBoundingClientRect();
    const im = el.querySelector('img').getBoundingClientRect();
    const bx = im.left + im.width / 2, by = im.top + im.height / 2;
    return { dx: r.left + r.width / 2 - bx, dy: r.top + r.height / 2 - by, s: Math.max(0.08, Math.min(0.5, r.width / Math.max(1, im.width))), sr };
  };
  const ARC = 'cubic-bezier(0.45, 0, 0.2, 1)', EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)', EASE_IN = 'cubic-bezier(0.55, 0, 0.75, 0.2)';
  function go(to) {
    to = (to + N) % N;
    if (to === cur || busy) return;
    hold();                                  // the current model (if any) fades out
    busy = true;
    const from = cur, it = items[to], old = fig, model = is3D(it);
    const nf = model ? null : makeFig(it);
    if (nf) { nf.style.visibility = 'hidden'; stage.appendChild(nf); }
    const dur = reduce ? 1 : 950;
    const run = () => {
      if (old) {                             // a cut-out goes back into its rail slot
        const g0 = slotGeom(from, old);
        old.animate([
          { transform: 'none', opacity: 1 },
          { transform: `translate(${g0.dx * 0.5}px, ${g0.dy * 0.3 - g0.sr.height * 0.08}px) scale(${0.45 + g0.s * 0.5})`, opacity: 0.85, offset: 0.5 },
          { transform: `translate(${g0.dx}px, ${g0.dy}px) scale(${g0.s})`, opacity: 0 }], { duration: dur * 0.85, easing: ARC, fill: 'forwards' });
      }
      if (nf) {                              // a photo product grows out of its slot onto the floor
        const g1 = slotGeom(to, nf); nf.style.visibility = '';
        nf.animate([
          { transform: `translate(${g1.dx}px, ${g1.dy}px) scale(${g1.s})`, opacity: 0, offset: 0 },
          { transform: `translate(${g1.dx}px, ${g1.dy}px) scale(${g1.s})`, opacity: 1, offset: 0.06 },
          { transform: `translate(${g1.dx * 0.35}px, ${g1.dy * 0.25 - g1.sr.height * 0.1}px) scale(${0.6 + g1.s * 0.4})`, opacity: 1, offset: 0.55 },
          { transform: 'none', opacity: 1, offset: 1 }], { duration: dur, delay: reduce ? 0 : 140, easing: ARC, fill: 'backwards' });
        setFloor(stage.clientHeight * 0.95); layoutBackdrop(stage.getBoundingClientRect().top - root.getBoundingClientRect().top + stage.clientHeight * 0.95);
      }
      info.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px)' }], { duration: reduce ? 1 : 220, easing: EASE_IN, fill: 'forwards' })
        .finished.then(() => {
          setText(it);
          info.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: reduce ? 1 : 560, delay: reduce ? 0 : 260, easing: EASE_OUT, fill: 'both' });
        });
      cur = to;
      // a 3D product: the gauge comes up and the model loads on its own; no picture stands in for it
      setTimeout(() => { if (old) old.remove(); fig = nf; busy = false; settle(); }, reduce ? 20 : (model ? 380 : dur + 180));
    };
    // on a narrow screen bring the chosen slot into view first
    const r = slots[to].getBoundingClientRect(), rr = rail.getBoundingClientRect();
    if (r.left < rr.left || r.right > rr.right) {
      rail.scrollTo({ left: rail.scrollLeft + (r.left + r.width / 2) - (rr.left + rr.width / 2), behavior: reduce ? 'auto' : 'smooth' });
      setTimeout(ready, reduce ? 0 : 280);
    } else ready();
    function ready() { if (!nf) return run(); const im = nf.querySelector('img'); if (im.complete) run(); else { im.addEventListener('load', run, { once: true }); im.addEventListener('error', run, { once: true }); } }
  }

  addEventListener('resize', () => { if (root.classList.contains('has-3d')) floorToModel(); else setFloor(stage.clientHeight * 0.95); });
  // Phase 133: a vehicle in the contact section's garage takes you to that product on the stage
  document.querySelectorAll('.contact-garage__car').forEach(b => b.addEventListener('click', () => {
    const k = items.findIndex(it => it.short === b.dataset.product); if (k < 0) return;
    const top = root.getBoundingClientRect().top + scrollY;
    if (window.__lenis) window.__lenis.scrollTo(top, { duration: 1.2 }); else scrollTo({ top, behavior: 'smooth' });
    setTimeout(() => go(k), 700);
  }));

  // details: the product sheet slides in (product-sheet.js); its buttons lead on to the 3D drawer
  const details = () => { const it = items[cur]; document.dispatchEvent(new CustomEvent('inferno:details', { detail: { card: it.card, img: it.src, glow: it.glow, group: it.groupLabel, logo: it.logo } })); };
  cta.addEventListener('click', details);
  stage.addEventListener('click', e => { if (!root.classList.contains('is-live')) details(); });
  root.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') go(cur + 1);
    else if (e.key === 'ArrowLeft') go(cur - 1);
  });
  // swipe the stage
  let sx = null, sy = 0;
  stage.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; });
  stage.addEventListener('pointerup', e => {
    if (sx == null || root.classList.contains('is-live')) { sx = null; return; }
    const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) { go(cur + (dx < 0 ? 1 : -1)); stage.dataset.swiped = '1'; setTimeout(() => delete stage.dataset.swiped, 50); }
  });
  stage.addEventListener('click', e => { if (stage.dataset.swiped) e.stopImmediatePropagation(); }, true);

  // warm the big cut-outs once the section is near
  new IntersectionObserver((es, io) => {
    if (!es[0].isIntersecting) return; io.disconnect();
    if (matchMedia('(min-width: 901px)').matches) items.forEach(it => { const im = new Image(); im.decoding = 'async'; im.src = it.src; });
  }, { rootMargin: '600px 0px' }).observe(root);

  window.__showcase = { go: i => go(i), get index() { return cur; }, items };
}

// ── Phase 96: the relief wall (SVG) ───────────────────────────────────────────────────────────────────────────────────────────
function buildWall() {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const W = 1800, H = 1000;
  const rr = (x, y, w, h, r) => `M${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}V${y + r}Q${x},${y} ${x + r},${y}Z`;
  // one layer: a slab with rows of rounded openings; openings span 1–3 cells so the bars are irregular, like the reference
  const layer = (cw, ch, bar, rad, rows, cols) => {
    const holes = [];
    for (let r = -rows; r < rows; r++) {
      let c = -cols, off = (r % 2) * cw * 0.45;
      while (c < cols) {
        const span = rnd() < 0.55 ? 1 : rnd() < 0.7 ? 2 : 3;
        const skip = rnd() < 0.12;
        const x = c * cw + off + bar / 2, y = r * ch + bar / 2, w = span * cw - bar, h = ch - bar * (0.8 + rnd() * 0.5);
        if (!skip) holes.push({ x, y, w, h, r: Math.min(rad, w / 2.2, h / 2.2) });
        c += span;
      }
    }
    return holes;
  };
  const back = layer(150, 118, 24, 22, 6, 9), front = layer(260, 190, 40, 34, 4, 6);
  const holePaths = hs => hs.map(h => rr(h.x, h.y, h.w, h.h, h.r)).join('');
  // a few openings of the front layer carry the travelling light
  const lit = [];
  const pick = front.filter(h => Math.abs(h.x + h.w / 2) < 520 && Math.abs(h.y + h.h / 2) < 300);
  for (let i = 0; i < 4 && pick.length; i++) lit.push(pick.splice(Math.floor(rnd() * pick.length), 1)[0]);
  const traces = lit.map((h, i) => `<path class="tr" style="--d:${(i * 3.1).toFixed(1)}s" pathLength="100" d="${rr(h.x, h.y, h.w, h.h, h.r)}"/>`).join('');
  const faint = lit.map(h => `<path class="tf" d="${rr(h.x, h.y, h.w, h.h, h.r)}"/>`).join('');
  const vb = `viewBox="${-W / 2} ${-H / 2} ${W} ${H}" preserveAspectRatio="xMidYMid slice"`;
  // the relief (static, filtered once): two slabs; the front one bevelled by real lighting on its own alpha
  const relief = `<svg class="scw-relief" ${vb}>
    <defs>
      <mask id="scw-mb" maskUnits="userSpaceOnUse" x="-3000" y="-3000" width="6000" height="6000"><rect x="-3000" y="-3000" width="6000" height="6000" fill="#fff"/><path d="${holePaths(back)}" fill="#000"/></mask>
      <mask id="scw-mf" maskUnits="userSpaceOnUse" x="-3000" y="-3000" width="6000" height="6000"><rect x="-3000" y="-3000" width="6000" height="6000" fill="#fff"/><path d="${holePaths(front)}" fill="#000"/></mask>
      <filter id="scw-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="14" dy="26" stdDeviation="14" flood-color="#000" flood-opacity="1"/></filter>
      <filter id="scw-bevel" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b"/>
        <feSpecularLighting in="b" surfaceScale="7" specularConstant="0.9" specularExponent="22" lighting-color="#c9ced8" result="s"><feDistantLight azimuth="235" elevation="38"/></feSpecularLighting>
        <feComposite in="s" in2="SourceAlpha" operator="in" result="sp"/>
        <feDiffuseLighting in="b" surfaceScale="7" diffuseConstant="1" lighting-color="#ffffff" result="d"><feDistantLight azimuth="235" elevation="52"/></feDiffuseLighting>
        <feComposite in="d" in2="SourceAlpha" operator="in" result="dl"/>
        <feBlend in="SourceGraphic" in2="dl" mode="multiply" result="lit"/>
        <feComposite in="sp" in2="lit" operator="arithmetic" k1="0" k2="0.55" k3="1" k4="0" result="out"/>
        <feDropShadow in="out" dx="14" dy="26" stdDeviation="14" flood-color="#000" flood-opacity="1"/>
      </filter>
      <linearGradient id="scw-gb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1c22"/><stop offset="1" stop-color="#121318"/></linearGradient>
      <linearGradient id="scw-gf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a3c45"/><stop offset=".5" stop-color="#2a2c33"/><stop offset="1" stop-color="#1c1d23"/></linearGradient>
    </defs>
    <rect x="${-W}" y="${-H}" width="${W * 2}" height="${H * 2}" fill="#040506"/>
    <g transform="rotate(-24)" filter="url(#scw-sh)"><rect x="-3000" y="-3000" width="6000" height="6000" fill="url(#scw-gb)" mask="url(#scw-mb)"/></g>
    <g transform="rotate(-33) translate(40 -20)"><g filter="url(#scw-bevel)"><rect x="-3000" y="-3000" width="6000" height="6000" fill="url(#scw-gf)" mask="url(#scw-mf)"/></g></g>
  </svg>`;
  // the travelling light: its own layer, so the animation never re-renders the filtered relief
  const light = `<svg class="scw-light" ${vb}><g transform="rotate(-33) translate(40 -20)">${faint}${traces}</g></svg>`;
  return relief + '<div class="scw-tint"></div>' + light;
}
