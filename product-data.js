// Product configuration (Phase 25; component categories Phase 26; production content Phase 28).
//
// One JSON document per product (products/<id>.json), referenced from its card with data-product-config. The shared
// schema knows nothing about any particular product: identity, content, specifications, media, viewer, and components
// that point at the 3D asset's named features.
//   inferno.product/1 (Phase 25): flat content; a field left null falls back to the product card.
//   inferno.product/2 (Phase 28): structured production content — identity, overview, keyFeatures[], applications[],
//     specifications[] (label / value / unit / group / key), media { hero, gallery }, seo, contentRequired[] — where every
//     entry carries a status and a source. Only `published` (the site's own copy) and `derived` (restructured from it)
//     content is shown; `placeholder`, `required` (CONTENT REQUIRED) and `verify` stay in the data and the audit.
// A field that is absent falls back to the card; a field that is present but not publishable shows nothing.

export const PRODUCT_SCHEMA = 'inferno.product/2';
const SCHEMAS = new Set(['inferno.product/1', 'inferno.product/2']);
export const CONTENT_STATUS = ['published', 'derived', 'placeholder', 'required', 'verify'];
const SHOWN = new Set(['published', 'derived']);
/** A content field: a plain value (treated as published) or { value, status, source, note }. */
export function contentField(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return { value: v.value ?? null, status: v.status || 'published', source: v.source || '', note: v.note || '' };
  return v == null ? null : { value: v, status: 'published', source: '', note: '' };
}
export const isShown = x => !!x && SHOWN.has(x.status || 'published');

const cache = new Map();
/** Fetch + validate a product configuration (cached per URL for the page's lifetime). */
export function loadProductConfig(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); })
      .then(j => { if (!j || !SCHEMAS.has(j.schema)) throw new Error(`${url}: not an inferno.product document`); return j; })
      .catch(e => { cache.delete(url); throw e; }));
  }
  return cache.get(url);
}

/**
 * A component with every field present. `features.ids` = asset feature names; `features.groups` = [{ system, group }].
 * `camera` is the component's presentation (Phase 25 fields, Phase 27 use): { view, fill, azimuth, elevation, target,
 * distance } — every field optional; without it the viewer frames the component from its own bounds.
 * `media` (Phase 27): [{ type: 'image', src, alt, caption }] — a plain string is an image src; entries without a src are dropped.
 * `interaction` (Phase 27): { touchTolerancePx } — a small part's invisible touch target (finger taps that miss by up to
 * this many px may still take it; exact hits on any component always win).
 */
export function normalizeComponent(c) {
  const f = c.features || {};
  const media = (Array.isArray(c.media) ? c.media : []).map(m => (typeof m === 'string' ? { src: m } : m || {}))
    .filter(m => typeof m.src === 'string' && m.src).map(m => ({ type: m.type || 'image', src: m.src, alt: m.alt || '', caption: m.caption || '' }));
  return { id: String(c.id), name: c.name || String(c.id), shortDescription: c.shortDescription || '', description: c.description || '',
    placeholder: !!c.placeholder, features: { ids: f.ids || [], groups: f.groups || [] }, camera: c.camera || null,
    information: c.information || [], media, interaction: c.interaction || null };
}

const pick = (v, fallback) => (v === null || v === undefined ? fallback : v);
/** Configuration over card data (the card is the fallback), in the shape the information UI renders. */
export function mergeProduct(card, cfg) {
  if (cfg.schema === 'inferno.product/2') return mergeContent(card, cfg);
  const id = cfg.identity || {}, ct = cfg.content || {}, sp = cfg.specifications || {}, md = cfg.media || {};
  return {
    ...card,
    id: cfg.id || card.id,
    name: pick(id.name, card.name), category: pick(id.category, card.category), logo: pick(id.logo, card.logo),
    summary: pick(ct.summary, card.summary), description: pick(ct.description, card.description),
    features: pick(ct.features, card.features), applications: pick(ct.applications, card.applications),
    keySpecs: pick(sp.key, card.keySpecs), technical: pick(sp.technical, card.technical),
    photos: pick(md.photos, card.photos),
    ...components(cfg),
  };
}

// a description that only repeats its title is not shown twice
const same = (a, b) => !!a && !!b && a.toLowerCase().replace(/[^a-z0-9]+/g, '') === b.toLowerCase().replace(/[^a-z0-9]+/g, '');
// inferno.product/2 → the information UI's shape (+ the structured document itself as `content`)
function mergeContent(card, cfg) {
  const id = cfg.identity || {}, ov = cfg.overview || {}, md = cfg.media || {}, seo = cfg.seo || {}, issues = [];
  const val = (f, fallback) => { if (f === undefined) return fallback; const c = contentField(f); return c && isShown(c) && c.value != null ? c.value : ''; };
  const groups = new Map((cfg.specificationGroups || []).map(g => [g.id, g.title || g.id]));
  const specs = (cfg.specifications || []).filter(isShown).map(s => {
    if (s.group && !groups.has(s.group)) issues.push(`specification ${s.id}: unknown group "${s.group}"`);
    return { id: s.id, key: s.label, val: s.unit ? `${s.value} ${s.unit}` : String(s.value), group: s.group ? groups.get(s.group) || s.group : null, gi: s.group && groups.has(s.group) ? [...groups.keys()].indexOf(s.group) : groups.size, isKey: !!s.key };
  });
  for (const x of [...(cfg.keyFeatures || []), ...(cfg.applications || []), ...(cfg.specifications || [])]) if (x && x.status && !CONTENT_STATUS.includes(x.status)) issues.push(`${x.id}: unknown status "${x.status}"`);
  const src = m => (typeof m === 'string' ? m : m && m.src);
  const shownMedia = [md.hero, ...(md.gallery || [])].filter(m => m && (typeof m === 'string' || isShown(m)) && src(m));
  const photos = shownMedia.map(src), photoItems = shownMedia.map(m => ({ src: src(m), alt: typeof m === 'string' ? '' : m.alt || '' }));
  const comps = components(cfg), compIds = new Set(comps.components.map(c => c.id));
  for (const f of cfg.keyFeatures || []) if (f.componentId && !compIds.has(f.componentId)) issues.push(`feature ${f.id}: unknown component "${f.componentId}"`);
  return {
    ...card,
    id: cfg.id || card.id,
    name: val(id.name, card.name), code: val(id.code, ''), category: val(id.category, card.category), logo: val(id.logo, card.logo),
    summary: val(id.shortDescription, card.summary), description: val(ov.body, card.description),
    features: cfg.keyFeatures ? cfg.keyFeatures.filter(isShown).map(f => ({ id: f.id, title: f.title, text: same(f.description, f.title) ? '' : f.description || '', componentId: f.componentId || null })) : card.features,
    applications: cfg.applications ? cfg.applications.filter(isShown).map(a => ({ id: a.id, title: a.title, text: a.description || '' })) : card.applications,
    keySpecs: cfg.specifications ? specs.filter(s => s.isKey).map(({ key, val: v }) => ({ key, val: v })) : card.keySpecs,
    technical: cfg.specifications ? specs.filter(s => !s.isKey).sort((a, b) => a.gi - b.gi).map(({ key, val: v, group }) => ({ key, val: v, group })) : card.technical,   // groups in their data order
    photos: md.hero !== undefined || md.gallery ? [...new Set(photos)] : card.photos,
    photoItems: md.hero !== undefined || md.gallery ? photoItems.filter((m, i) => photos.indexOf(m.src) === i) : null,
    seo: { title: val(seo.title, ''), description: val(seo.description, '') },
    content: cfg,
    ...comps, dataIssues: comps.dataIssues.concat(issues),
  };
}

// Components (unique ids) and their categories (Phase 26).
function components(cfg) {
  const seen = new Set(), list = [], issues = [];
  for (const c of (cfg.components || []).map(normalizeComponent)) {
    if (seen.has(c.id)) { issues.push(`component id "${c.id}" is used twice (kept the first)`); continue; }
    seen.add(c.id); list.push(c);
  }
  const k = normalizeCategories(cfg.componentCategories, list);
  return { components: list, componentCategories: k.categories, dataIssues: issues.concat(k.issues) };
}

/**
 * Component categories (Phase 26): optional `componentCategories: [{ id, name, description, components: [component ids] }]`,
 * the data-driven grouping of the component explorer. A component listed in no category goes to an automatic
 * "Components" category; unknown ids, repeats and empty categories are reported and left out.
 */
export function normalizeCategories(list, components) {
  const ids = new Set(components.map(c => c.id)), used = new Set(), out = [], issues = [];
  for (const k of list || []) {
    if (!k || k.id == null) { issues.push('a category without an id was ignored'); continue; }
    const mine = [];
    for (const id of k.components || []) {
      if (!ids.has(id)) { issues.push(`category ${k.id}: unknown component "${id}"`); continue; }
      if (used.has(id)) { issues.push(`component ${id} is in more than one category (kept in the first)`); continue; }
      used.add(id); mine.push(id);
    }
    if (!mine.length) { issues.push(`category ${k.id} has no components (hidden)`); continue; }
    out.push({ id: String(k.id), name: k.name || String(k.id), description: k.description || '', components: mine });
  }
  const rest = components.filter(c => !used.has(c.id)).map(c => c.id);
  if (rest.length) out.push({ id: 'components', name: 'Components', description: '', components: rest, implicit: true });
  return { categories: out, issues };
}

/**
 * Resolve component feature references against the asset's feature catalogue ([{ name, system, group }]).
 * One component may claim many features; a feature belongs to at most one component (a second claim is reported and
 * ignored). Unknown names are reported, never invented.
 */
export function resolveComponents(components, catalog) {
  const known = new Set(catalog.map(f => f.name)), byFeature = new Map(), issues = [], out = [];
  for (const c of components) {
    const names = new Set();
    if (!c.features.ids.length && !c.features.groups.length) issues.push(`${c.id}: references no features`);
    for (const n of c.features.ids) { if (known.has(n)) names.add(n); else issues.push(`${c.id}: unknown feature "${n}"`); }
    for (const g of c.features.groups) {
      let hit = 0;
      for (const f of catalog) if (f.group === g.group && (!g.system || f.system === g.system)) { names.add(f.name); hit++; }
      if (!hit) issues.push(`${c.id}: no features in group ${g.system || '*'}/${g.group}`);
    }
    const mine = [];
    for (const n of names) { if (byFeature.has(n)) { issues.push(`"${n}" is claimed by ${byFeature.get(n)} and ${c.id}`); continue; } byFeature.set(n, c.id); mine.push(n); }
    out.push({ ...c, featureNames: mine, available: mine.length > 0 });   // a component with no features in this asset cannot be selected
  }
  return { components: out, byFeature, issues };
}
