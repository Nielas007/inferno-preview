// Production asset loader for the Phase 12 split glTF structure (VSS 830E).
//
//   manifest (.asset.json) ─┬─ rig.gltf     76 Nozzle_### anchors, no geometry, no textures
//                           ├─ LOD0..3.gltf Meshopt geometry + materials, textures by URI
//                           ├─ cutaway      (Phase 67, optional) the host cylinder pre-cut, fetched on first use
//                           └─ textures/    38 KTX2 (Phase 11 UASTC), shared by every LOD
//
// Resources are shared at two levels so the split files never duplicate GPU memory:
//   1. ONE THREE.Texture per KTX2 URL for the whole page (SharedKTX2Loader cache)
//   2. ONE material instance per material signature (name + every parameter + texture
//      identity). A material whose parameters differ is NOT merged.
// Both are reference-counted per LOD, so unloadLOD(n) frees only what no other loaded
// LOD still uses. Textures are additionally owner-counted page-wide (one owner per
// ProductionAsset), so a texture shared by two assets or viewers is disposed only when the
// last owner lets go. The imported glTF materials are authoritative — nothing here rewrites
// Base Color, roughness, metallic or normal data.
// A texture's transcoded mip chain (its CPU copy) is dropped as soon as three has uploaded it (Phase 34); a lost
// WebGL context is recovered by reloading the product (drawer-viewer, 'webglcontextrestored').
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const BASIS_PATH = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/basis/';
const MAP_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap',
  'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'transmissionMap', 'thicknessMap',
  'sheenColorMap', 'sheenRoughnessMap', 'specularIntensityMap', 'specularColorMap', 'iridescenceMap'];
export const LAMP_LEVELS = { off: 0, low: 0.25, on: 1 };   // Phase 6/9 EMISSION_LEVEL presets (a manifest's `lampLevels` overrides)
// Which materials are lamps is product data (Phase 31): the manifest's `lamps.materialPattern`; none when absent.

// ── one Texture per KTX2 URL, page-wide ─────────────────────────────────────
class SharedKTX2Loader extends KTX2Loader {
  constructor(manager) { super(manager); this.cache = new Map(); this.owners = new Map(); }
  load(url, onLoad, onProgress, onError) {
    let e = this.cache.get(url);
    if (!e) {
      e = { texture: null, promise: null };
      e.promise = new Promise((resolve, reject) => {
        super.load(url, (t) => { t.userData.sourceUrl = url; t.onUpdate = releaseUploadedData; e.texture = t; resolve(t); }, onProgress, reject);
      });
      this.cache.set(url, e);
    }
    e.promise.then(onLoad, (err) => { this.cache.delete(url); if (onError) onError(err); });
  }
  forget(texture) { const u = texture && texture.userData.sourceUrl; if (u) this.cache.delete(u); }
  // page-wide ownership: an asset retains a texture once, however many of its LODs use it
  retain(texture) { this.owners.set(texture, (this.owners.get(texture) || 0) + 1); }
  release(texture) {
    const n = (this.owners.get(texture) || 1) - 1;
    if (n > 0) { this.owners.set(texture, n); return false; }
    this.owners.delete(texture); this.forget(texture); texture.dispose();
    return true;
  }
}

// CPU copy after upload (Phase 34). three calls onUpdate right after it has uploaded the texture; from then on only the
// GPU copy is read, because the sampler state is final before the first upload (the viewer sets anisotropy in the task
// that loads the LOD, before any frame can draw it). Re-uploading would need the data again in two cases only:
//   - a lost WebGL context: the viewer reloads the product, so its textures are fetched again (HTTP cache);
//   - a later LOD that uses the same image with another sampler: GLTFLoader writes it onto this shared texture, and
//     keepUploadedSampler() puts the uploaded state back (the first LOD's sampler wins) instead of letting three
//     re-allocate a texture it has no data for.
// 4CU: 74 MB of JS memory while open, VSS 106 MB, Skiddy 30 MB.
const SAMPLER_KEYS = ['wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'flipY', 'colorSpace'];
function releaseUploadedData(t) {
  if (!t.mipmaps || !t.mipmaps.length) return;
  t.userData.cpuReleasedBytes = t.mipmaps.reduce((s, m) => s + m.data.byteLength, 0);
  t.userData.uploadedSampler = SAMPLER_KEYS.map(k => t[k]);
  t.mipmaps = [];
}
function keepUploadedSampler(t) {
  const s = t.userData.uploadedSampler; if (!s) return;
  const changed = SAMPLER_KEYS.filter((k, i) => t[k] !== s[i]); if (!changed.length) return;
  SAMPLER_KEYS.forEach((k, i) => { t[k] = s[i]; });
  console.warn(`[production] ${t.userData.sourceUrl}: a LOD asks another sampler (${changed.join(', ')}); the uploaded one is kept`);
}

// three r160 WebGLShadowMap copies every caster's material.map onto ONE shared depth
// material and only refreshes the uniform when the next caster also has a map. After an
// asset is disposed, the depth pass of the next map-less caster (another product) bound
// our disposed texture again, re-uploading it for good: 0.35 MB lost per product switch.
// Casters without alpha testing never need a map in the depth pass, so production meshes
// hand the shadow system no texture references at all.
function dropShadowTextureRefs(renderer, object, camera, shadowCamera, geometry, depthMaterial) {
  if (depthMaterial.alphaTest > 0) return;              // alpha-tested cut-outs keep their map
  depthMaterial.map = null; depthMaterial.alphaMap = null;
}

let _ktx2 = null, _gltf = null;
let _meshoptWorkers = false;
function loaders(renderer) {
  if (!_ktx2) {
    _ktx2 = new SharedKTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(renderer);
    // Meshopt decoding in two workers (Phase 22): LOD0's 37 MB decode took 22–35 ms on the main thread, inside the
    // frame that switched to it. The workers stay for the page, like the KTX2 transcoder's.
    if (!_meshoptWorkers) { MeshoptDecoder.useWorkers(2); _meshoptWorkers = true; }
    _gltf = new GLTFLoader().setKTX2Loader(_ktx2).setMeshoptDecoder(MeshoptDecoder);
  }
  return { ktx2: _ktx2, gltf: _gltf };
}
// Phase 34: a lost WebGL context reports no compressed-texture support. A transcoder configured then decodes every
// texture to RGBA32 (4x the GPU memory) for the rest of the page. The viewer calls this on 'webglcontextrestored',
// after releasing its production assets, so the next load detects the formats again.
export function resetTextureLoader() {
  if (!_ktx2) return;
  _ktx2.dispose(); _ktx2 = null; _gltf = null;
}

function signature(m) {
  const tex = k => (m[k] ? (m[k].userData.sourceUrl || m[k].uuid) : '');
  const num = v => (v === undefined || v === null ? '' : (+v).toFixed(5));
  return [m.type, m.name, m.color && m.color.getHexString(), m.emissive && m.emissive.getHexString(),
    num(m.emissiveIntensity), num(m.roughness), num(m.metalness), num(m.opacity), m.transparent, m.side,
    num(m.alphaTest), num(m.transmission), num(m.ior), num(m.thickness), num(m.clearcoat),
    num(m.clearcoatRoughness), num(m.specularIntensity), num(m.envMapIntensity), num(m.aoMapIntensity),
    m.normalScale ? m.normalScale.toArray().map(num).join(',') : '', m.vertexColors, m.flatShading,
    ...MAP_KEYS.map(tex)].join('|');
}

export class ProductionAsset {
  constructor(manifestUrl, renderer) {
    this.url = manifestUrl;
    this.renderer = renderer;
    this.root = new THREE.Group(); this.root.name = 'production';   // renamed from the manifest's `asset` in init()
    this.rig = null;                   // gltf scene of the anchor rig
    this.lods = new Map();             // n -> { scene, gltf, ms, stats }
    this.registry = new Map();         // signature -> { material, lods:Set }
    this.texRefs = new Map();          // Texture -> number of registered materials using it
    this.lampLevel = 'off';
    this.components = new Map();       // source component name -> { name, system, group, lods:{n:{featureId, node}} }
    this.nozzles = new Map();          // 'Nozzle_001' -> { id, anchor, axisLocal, component }
    this.log = { materialsCreated: 0, materialsReused: 0, texturesReceived: 0 };
  }

  async init() {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`manifest ${this.url}: ${res.status}`);
    this.manifest = await res.json();
    this.base = new URL(this.manifest.base, new URL(this.url, location.href)).href;
    this.name = this.manifest.asset || 'asset';
    this.root.name = `${this.name}_production`;
    const lp = this.manifest.lamps && this.manifest.lamps.materialPattern;
    this.lampMaterial = lp ? new RegExp(lp) : null;
    this.lampLevels = this.manifest.lampLevels || LAMP_LEVELS;
    return this;
  }

  // With a `signal` (Phase 22) the .gltf and its buffers are fetched here, so the download can be aborted (the viewer
  // closed, or a zoom turned back before a fetched-ahead LOD arrived); the parser takes those buffers instead of
  // requesting them again. KTX2 textures still come through the shared loader.
  async _load(file, signal = null) {
    const { ktx2, gltf } = loaders(this.renderer), url = this.base + file;
    if (!signal) return gltf.loadAsync(url);
    const get = async (u, text) => { const r = await fetch(u, { signal }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return text ? r.text() : r.arrayBuffer(); };
    const src = await get(url, true), json = JSON.parse(src);
    const buffers = await Promise.all((json.buffers || []).map(b => (b.uri && !b.uri.startsWith('data:') ? get(new URL(b.uri, url).href) : null)));
    const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder).register(parser => {
      const load = parser.loadBuffer.bind(parser); parser.loadBuffer = i => (buffers[i] ? Promise.resolve(buffers[i]) : load(i)); return { name: 'fetchedBuffers' }; });
    return loader.parseAsync(src, url.slice(0, url.lastIndexOf('/') + 1));
  }

  async loadRig() {
    if (this.rig) return this.rig;
    const t0 = performance.now();
    const g = await this._load(this.manifest.rig);
    this.rig = g.scene; this.rig.name = `${this.name}_rig`;
    this.root.add(this.rig);
    const axis = s => (/^\+?Y$/i.test(s || '') ? new THREE.Vector3(0, 1, 0)
      : /^-Y$/i.test(s || '') ? new THREE.Vector3(0, -1, 0)
      : /^\+?X$/i.test(s || '') ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1));
    this.rig.traverse(o => {
      if (!/^Nozzle_\d{3}$/.test(o.name)) return;
      // Phase 12: glTF / three.js spray axis is LOCAL +Y (Blender's +Z before the Y-up conversion).
      this.nozzles.set(o.name, { id: o.name, index: o.userData.nozzle_index, anchor: o,
        axisLocal: axis(o.userData.spray_axis_local || this.manifest.sprayAxisLocal), component: null });
    });
    this.rigMs = Math.round(performance.now() - t0);
    return this.rig;
  }

  async loadLOD(n, signal = null) {
    if (this.lods.has(n)) return this.lods.get(n);
    const t0 = performance.now();
    const g = await this._load(this.manifest.lods[n], signal);
    const scene = g.scene; scene.name = `${this.name}_LOD${n}`;
    // share materials: first instance of a signature becomes canonical, later ones are dropped
    const seen = new Set();
    scene.traverse(o => {
      if (!o.isMesh) return;
      o.onBeforeShadow = dropShadowTextureRefs;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const out = mats.map(m => this._adopt(m, n));
      o.material = Array.isArray(o.material) ? out : out[0];
      for (const m of out) seen.add(m);
    });
    this._indexFeatures(n, scene);
    this.root.add(scene);
    const st = { meshes: 0, tris: 0, verts: 0 };
    scene.traverse(o => { if (o.isMesh) { st.meshes++; st.verts += o.geometry.attributes.position.count;
      st.tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
    const rec = { n, scene, ms: Math.round(performance.now() - t0), stats: st, materials: seen.size };
    this.lods.set(n, rec);
    this.applyLamps();
    return rec;
  }

  _adopt(m, n) {
    for (const k of MAP_KEYS) if (m[k]) { this.log.texturesReceived++; keepUploadedSampler(m[k]); }
    const sig = signature(m);
    let e = this.registry.get(sig);
    if (!e) {
      e = { material: m, lods: new Set() };
      if (this.lampMaterial && this.lampMaterial.test(m.name)) m.userData.lampPeak = m.emissiveIntensity;   // exported at LEVEL 1
      this.registry.set(sig, e);
      for (const k of MAP_KEYS) if (m[k]) {
        const c = this.texRefs.get(m[k]) || 0;
        if (c === 0) _ktx2.retain(m[k]);                 // first use by this asset
        this.texRefs.set(m[k], c + 1);
      }
      this.log.materialsCreated++;
    } else if (e.material !== m) {
      m.dispose();                       // textures are the shared ones — never disposed here
      this.log.materialsReused++;
    }
    e.lods.add(n);
    return e.material;
  }

  _indexFeatures(n, scene) {
    scene.traverse(o => {
      if (!o.userData || typeof o.userData.features !== 'string') return;
      let feats; try { feats = JSON.parse(o.userData.features); } catch (_) { return; }
      const meshes = [];
      o.traverse(m => { if (m.isMesh && m.geometry.attributes._feature_id_0) meshes.push(m); });
      o.userData.featureTable = feats;
      for (const f of feats) {
        let c = this.components.get(f.name);
        if (!c) { c = { name: f.name, system: o.userData.system, group: o.userData.group, anchor: f.anchor || null, lods: {} }; this.components.set(f.name, c); }
        c.lods[n] = { featureId: f.id, node: o, meshes };
        if (f.anchor && this.nozzles.has(f.anchor)) this.nozzles.get(f.anchor).component = f.name;
      }
    });
  }

  /** Raycast hit -> logical component (works on any LOD). */
  pick(hit) {
    if (!hit || !hit.object || !hit.face) return null;
    const a = hit.object.geometry.attributes._feature_id_0;
    if (!a) return null;
    const id = Math.round(a.getX(hit.face.a));
    let node = hit.object; while (node && !node.userData.featureTable) node = node.parent;
    if (!node) return null;
    const f = node.userData.featureTable[id];
    return f ? { featureId: id, name: f.name, group: node.userData.group, system: node.userData.system, lod: node.userData.lod, component: this.components.get(f.name) } : null;
  }

  /** Nozzle lookup: anchor, its component and the current world-space spray direction. */
  nozzle(id) {
    const z = this.nozzles.get(id); if (!z) return null;
    z.anchor.updateWorldMatrix(true, false);
    const q = z.anchor.getWorldQuaternion(new THREE.Quaternion());
    return { ...z, position: z.anchor.getWorldPosition(new THREE.Vector3()), direction: z.axisLocal.clone().applyQuaternion(q).normalize() };
  }

  showLOD(n) { for (const [k, r] of this.lods) r.scene.visible = (k === n); this.activeLOD = n; }

  unloadLOD(n) {
    const r = this.lods.get(n); if (!r) return;
    r.scene.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    this.root.remove(r.scene);
    this._release(n);
    for (const c of this.components.values()) delete c.lods[n];
    this.lods.delete(n);
  }
  // registry entries no longer used by `key` (a LOD number, or 'cutaway') and by nothing else: material + its textures freed
  _release(key) {
    for (const [sig, e] of this.registry) {
      if (!e.lods.delete(key) || e.lods.size) continue;        // still used by another LOD
      e.material.dispose();
      for (const k of MAP_KEYS) {
        const t = e.material[k]; if (!t) continue;
        const c = (this.texRefs.get(t) || 1) - 1;
        if (c > 0) this.texRefs.set(t, c);
        else { this.texRefs.delete(t); _ktx2.release(t); }   // disposed only when no other owner holds it
      }
      this.registry.delete(sig);
    }
  }

  // Cutaway (Phase 67): the manifest's `cutaway.gltf` - the host cylinder pre-cut (section, foam and the cylinder's own internal
  // hardware), in the asset frame of the LODs. Fetched on first use only; its materials go through the same registry (key
  // 'cutaway'), so textures it shares with the LODs are not loaded twice and everything is released with the asset. Its feature
  // node names the host's own features (picking and highlight work on it like on a LOD). Hidden until the viewer shows it.
  async loadCutaway() {
    const m = this.manifest && this.manifest.cutaway; if (!m || !m.gltf) return null;
    if (this.cutaway) return this.cutaway;
    if (this._cutLoad) return this._cutLoad;
    const t0 = performance.now(); this._cutAbort = new AbortController();
    this._cutLoad = this._load(m.gltf, this._cutAbort.signal).then(g => {
      const scene = g.scene; scene.name = `${this.name}_cutaway`; scene.visible = false;
      scene.traverse(o => {
        if (o.userData && typeof o.userData.features === 'string') { try { o.userData.featureTable = JSON.parse(o.userData.features); } catch (_) { /* no table */ } }
        if (!o.isMesh) return;
        o.onBeforeShadow = dropShadowTextureRefs;
        const out = (Array.isArray(o.material) ? o.material : [o.material]).map(x => this._adopt(x, 'cutaway'));
        o.material = Array.isArray(o.material) ? out : out[0];
      });
      this.root.add(scene);
      const st = { meshes: 0, tris: 0 };
      scene.traverse(o => { if (o.isMesh) { st.meshes++; st.tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
      this.cutaway = { scene, ms: Math.round(performance.now() - t0), stats: st };
      if (this.disposed) { this.unloadCutaway(); return null; }        // released while it was loading
      return this.cutaway;
    }).finally(() => { this._cutLoad = null; this._cutAbort = null; });
    return this._cutLoad;
  }
  unloadCutaway() {
    if (this._cutAbort) this._cutAbort.abort();
    const c = this.cutaway; if (!c) return;
    c.scene.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    this.root.remove(c.scene);
    this._release('cutaway');
    this.cutaway = null;
  }

  dispose() {
    this.disposed = true;
    this.unloadCutaway();
    for (const n of [...this.lods.keys()]) this.unloadLOD(n);
    if (this.rig) { this.root.remove(this.rig); this.rig = null; }
    this.nozzles.clear(); this.components.clear();
    if (this.root.parent) this.root.parent.remove(this.root);
  }

  setLamps(level) {
    if (!(level in this.lampLevels)) level = 'off';
    this.lampLevel = level; this.applyLamps(); return level;
  }
  applyLamps() {
    const k = this.lampLevels[this.lampLevel];
    for (const { material: m } of this.registry.values())
      if (m.userData.lampPeak !== undefined) m.emissiveIntensity = m.userData.lampPeak * k;
  }

  forEachMesh(fn) { this.root.traverse(o => { if (o.isMesh) fn(o); }); }
  textures() { return [...this.texRefs.keys()]; }
  materials() { return [...this.registry.values()].map(e => e.material); }
  stats() {
    let geometries = 0; for (const r of this.lods.values()) r.scene.traverse(o => { if (o.isMesh) geometries++; });
    const released = this.textures().filter(t => t.userData.uploadedSampler && !t.mipmaps.length);
    if (this.cutaway) this.cutaway.scene.traverse(o => { if (o.isMesh) geometries++; });
    return { lods: [...this.lods.keys()], cutaway: this.cutaway ? { ms: this.cutaway.ms, ...this.cutaway.stats } : null, materials: this.registry.size, textures: this.texRefs.size, geometries,
      texturesCpuReleased: released.length, textureCpuReleasedMB: +(released.reduce((s, t) => s + t.userData.cpuReleasedBytes, 0) / 1048576).toFixed(1),
      components: this.components.size, nozzles: this.nozzles.size, ...this.log,
      pageTextureOwners: _ktx2 ? _ktx2.owners.size : 0, pageKtx2Cache: _ktx2 ? _ktx2.cache.size : 0 };
  }
}
