// Product-viewer renderer foundation (Phase 14). ONE place for every rendering value of
// the drawer viewer: tone mapping, exposure, environment, lights and shadows. The hero
// (showroom.js) has its own WebGLRenderer and never imports this file.
//
// Two profiles:
//   pbr     — production assets (baked PBR materials). HDR environment, photometrically
//             normalised; key/fill/rim defined as irradiance RATIOS of that environment;
//             exposure from an incident meter (an 18 % grey card renders as middle grey).
//   legacy  — the pre-Phase-14 synthetic studio, value for value, for the GLBs that still
//             rely on MAT_PRESETS (they were tuned under it).
//
// Nothing in this file reads or writes a material. Light units are three.js physical units
// (r155+): a DirectionalLight's intensity is the irradiance E it delivers, and a Lambertian
// surface of albedo ρ returns radiance ρ·E/π — the same units as the environment radiance.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const D2R = Math.PI / 180;
const TONE = { AgX: THREE.AgXToneMapping, ACESFilmic: THREE.ACESFilmicToneMapping, Linear: THREE.LinearToneMapping };

export const RENDER_CONFIG = {
  // Which profile each kind of product uses.
  productProfile: { production: 'pbr', legacy: 'legacy' },

  // Scene-linear value each three.js r160 operator maps to display middle grey
  // (linear 0.18 / sRGB 118), measured on this renderer in Phase 14.
  // (Linear = exposure × colour, clipped at 1.0: the physical reference, not for display.)
  midGreyInput: { AgX: 0.14507, ACESFilmic: 0.15757, Linear: 0.17952 },

  // Incident meter: the card faces the viewer's default camera direction (VIEW_DIR) and
  // is metered once per lighting change, never per frame (no pumping while orbiting).
  meter: { normal: [0.60, 0.40, 0.69], reflectance: 0.18 },

  // Shadow quality (Phase 16, chosen by measurement — PHASE_16_SHADOW_REPORT §4–6).
  // HIGH: the smallest map whose stair-stepping stays sub-pixel at the closest zoom on a DPR-2
  //       screen and keeps ≥ 60 % of thin rail/pipe shadow darkness (3584² ≈ 103 MB).
  // LOW:  the Phase 15 memory (2048² ≈ 34 MB) with the exact fit; its larger texels need a
  //       1-texel normal offset to stay acne-free on faces the key light grazes.
  // Both biases are in texels of the fitted map (world size, so they don't drift when the
  // depth range changes). 0.75 / 1.0 is the smallest pair that clears the faint stripe acne
  // on the fire cylinders without lifting stair/rail contact shadows (report §6).
  shadowQuality: {
    high: { mapSize: 3584, normalBiasTexels: 0.75, depthBiasTexels: 1.0 },
    low:  { mapSize: 2048, normalBiasTexels: 1.0,  depthBiasTexels: 1.0 },
  },

  // Screen-space AO strength presets (Phase 15). Radius/thickness in viewer units
  // (1 unit ≈ 4.6 m on the VSS 830E); intensity = max attenuation — of scene-linear radiance
  // in the HDR path (Phase 18), of the display-linear frame in the direct path;
  // bias = occlusion below this fraction is ignored (facet noise on flat panels).
  // Resolution/sample budgets live in product-ao.js AO_QUALITY (high | low).
  aoLevels: {
    low:    { intensity: 0.45, radius: 0.06, thickness: 0.04, bias: 0.10 },
    medium: { intensity: 0.65, radius: 0.10, thickness: 0.06, bias: 0.08 },
    high:   { intensity: 0.90, radius: 0.16, thickness: 0.10, bias: 0.05 },
  },

  // Environments. HDRs are Poly Haven CC0 (1k: PMREM cube faces are 256², so a larger
  // source would only alias). `neutralize` white-balances the map to its own mean
  // chromaticity; `rotation: 'alignKey'` turns the map about +Y so its dominant light
  // sits on the key light's azimuth (reflections and shadows then agree).
  environments: {
    'neutral-studio':     { type: 'hdr', url: 'textures/studio_small_09_1k.hdr', source: 'Poly Haven studio_small_09 (CC0)', neutralize: true, rotation: 'alignKey' },
    'industrial-neutral': { type: 'hdr', url: 'textures/empty_warehouse_01_1k.hdr', source: 'Poly Haven empty_warehouse_01 (CC0)', neutralize: true, rotation: 'alignKey' },
    'bright-studio':      { type: 'hdr', url: 'textures/white_studio_01_1k.hdr', source: 'Poly Haven white_studio_01 (CC0)', neutralize: true, rotation: 'alignKey' },
    'legacy-studio':      { type: 'scene', build: legacyStudioScene, sigma: 0.04 },
  },

  profiles: {
    pbr: {
      toneMapping: 'AgX',
      exposure: { mode: 'incident', compensationEV: 0 },
      environment: 'neutral-studio',
      environmentIntensity: 1.0,          // × the normalised map (mean radiance 1.0)
      // ratio = light irradiance ÷ the environment's mean irradiance (π × mean radiance).
      // azimuth: degrees from +X toward +Z (the viewer camera sits at ≈ 49°); elevation above the ground.
      // Values chosen by measurement (Phase 14 report §7): key 3 → a 2.6:1 lighting ratio on the
      // front face; the camera-axis fill lifts shadows without flattening form. The rim was kept OFF on the Phase 14–65
      // concrete floor (it lit the floor more than the silhouette); Phase 66 turns it on for the charcoal stage (below).
      key:  { enabled: true,  ratio: 3.0,  azimuth: 80,  elevation: 45, color: 0xffffff, castShadow: true },
      fill: { enabled: true,  ratio: 0.25, azimuth: 49,  elevation: 10, color: 0xffffff },
      // Phase 66: ON for the charcoal stage — on the dark floor (albedo 0.03) it now separates the silhouette (black tyres,
      // frames and cabs) from the backdrop instead of lighting the floor; ratio chosen by comparison (report §2).
      rim:  { enabled: true,  ratio: 0.8,  azimuth: 229, elevation: 35, color: 0xffffff },
      ambient: 0,
      // fit 'casters': orthographic frustum = the exact light-space footprint of the product's
      // casting vertices (camera-independent, so it never swims while orbiting or zooming).
      // Glass and lenses (transmission ≥ 0.5) keep casting, as in Phase 15: excluding them lets the
      // key light into the cab (2.6 % of the frame at the closest cab view) — a look change, not a
      // saving. `false` makes glazing pass the key light (physically closer, pending approval).
      shadow: { enabled: true, quality: 'high', fit: 'casters', margin: 0.02, depthPad: 0.05, transmissiveCasters: true },
      // The fake contact-AO disc under the vehicle. Phase 19 §10: off — 95–99 % of its darkening landed on floor
      // already in the real shadow (it compensated the catcher's opacity). Contact now comes from the real shadow +
      // the product-derived ground occlusion (product-stage.js). `true` restores the Phase 18 disc.
      contactShadow: false,
      // Screen-space AO (product-ao.js). `level` picks an aoLevels preset; any field set here overrides it.
      // hdrResponse (Phase 18 correction): how the HDR pipeline turns the AO buffer into a scene-linear factor.
      // 'phase15' = the factor whose displayed strength equals the approved Phase 15 look of this level
      // (per-pixel, through AgX's local slope); 'linear' = the plain factor (reads 1.1–2.8× stronger).
      ao: { enabled: true, level: 'medium', quality: 'high', distanceExponent: 2, distanceFallOff: 1, power: 1, floorOccludes: true, hdrResponse: 'phase15' },
      // HDR output pipeline (product-post.js, Phase 18): the scene renders scene-linear into an RGBA16F
      // MSAA target, AO attenuates that radiance, then AgX + sRGB. `quality` picks POST_QUALITY
      // (MSAA samples); `look.saturation` is the optional AgX look (1.0 = off, the approved look).
      post: { enabled: true, quality: 'high', look: { saturation: 1.0 } },
    },
    legacy: {
      toneMapping: 'ACESFilmic',
      exposure: { mode: 'manual', value: 1.06 },
      environment: 'legacy-studio',
      contactShadow: true,
      // The exact Phase 13 rig: [type, colour, intensity, position, shadow?]
      lights: [
        ['ambient', 0x2c3038, 0.4],
        ['directional', 0xffffff, 1.5, [3.2, 5.6, 3.4], { mapSize: 2048, near: 0.5, far: 24, extent: 5, bias: -0.0003, normalBias: 0.015, radius: 7 }],
        ['directional', 0xdfe9ff, 1.0, [-3.6, 3.4, -4.4]],
        ['directional', 0xfff0dd, 0.4, [4.2, 2.6, -3.6]],
        ['directional', 0xb8c8e8, 0.45, [-4, 2, 3]],
      ],
    },
  },
};

// The pre-Phase-14 synthetic studio (unchanged): a dark room with emissive panels, PMREM'd.
function legacyStudioScene() {
  const s = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(40, 16, 40), new THREE.MeshBasicMaterial({ color: 0x0b0d10, side: THREE.BackSide }));
  room.position.y = 6; s.add(room);
  const panel = (w, h, x, y, z, rx, ry, i, tint) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial());
    m.material.color.setScalar(i);
    if (tint) m.material.color.multiply(tint);
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0);
    s.add(m); return m;
  };
  panel(40, 40, 0, -1.98, 0, -Math.PI / 2, 0, 0.08);
  panel(14, 3.2, 0, 11, -2.5, Math.PI / 2, 0, 4.6);
  panel(8, 2.0, -6, 10, 3.5, Math.PI / 2, 0, 1.6);
  panel(6, 5, -13, 4, 0, 0, Math.PI / 2, 1.4);
  panel(6, 5, 13, 4, -1, 0, -Math.PI / 2, 1.7);
  panel(12, 6, 0, 4, 16, 0, Math.PI, 0.75);
  panel(10, 4, 0, 5, -16, 0, 0, 0.9, new THREE.Color(0.75, 0.85, 1.0));
  return s;
}

const dirFrom = (az, el) => new THREE.Vector3(Math.cos(az * D2R) * Math.cos(el * D2R), Math.sin(el * D2R), Math.sin(az * D2R) * Math.cos(el * D2R));
const clone = o => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'function' ? undefined : v)));
function merge(dst, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object') merge(dst[k], src[k]);
    else dst[k] = src[k];
  }
  return dst;
}

// ── HDR photometry (CPU, once per map, on a 4× box-downsampled copy) ────────
// Direction convention = three.js equirectUv(): u = atan2(z, x)/2π + 0.5, v = asin(y)/π + 0.5.
function analyseHDR(tex) {
  const { width: W, height: H, data } = tex.image;
  const half = data instanceof Uint16Array, f = half ? THREE.DataUtils.fromHalfFloat : (x => x);
  const S = 4, w = W / S, h = H / S, n = w * h;
  const rgb = new Float32Array(n * 3), dir = new Float32Array(n * 3), dw = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = ((y * S + j) * W + x * S + i) * 4; r += f(data[k]); g += f(data[k + 1]); b += f(data[k + 2]);
    }
    const p = y * w + x;
    rgb[p * 3] = r / (S * S); rgb[p * 3 + 1] = g / (S * S); rgb[p * 3 + 2] = b / (S * S);
    // data row 0 is the top of the image (flipY at upload) -> +Y
    const lat = Math.PI / 2 - (y + 0.5) / h * Math.PI, phi = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
    dir[p * 3] = Math.cos(phi) * Math.cos(lat); dir[p * 3 + 1] = Math.sin(lat); dir[p * 3 + 2] = Math.sin(phi) * Math.cos(lat);
    dw[p] = (2 * Math.PI / w) * (Math.PI / h) * Math.cos(lat);
  }
  const Y = new Float32Array(n); let sY = 0; const sC = [0, 0, 0];
  for (let p = 0; p < n; p++) {
    Y[p] = 0.2126 * rgb[p * 3] + 0.7152 * rgb[p * 3 + 1] + 0.0722 * rgb[p * 3 + 2];
    sY += Y[p] * dw[p]; for (let c = 0; c < 3; c++) sC[c] += rgb[p * 3 + c] * dw[p];
  }
  const meanY = sY / (4 * Math.PI), meanRGB = sC.map(v => v / (4 * Math.PI));
  // dominant light: energy-weighted mean direction of the brightest texels holding 50 % of the energy
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => Y[b] * dw[b] - Y[a] * dw[a]);
  let acc = 0, vx = 0, vy = 0, vz = 0, sa = 0;
  for (const p of order) {
    const e = Y[p] * dw[p]; vx += dir[p * 3] * e; vy += dir[p * 3 + 1] * e; vz += dir[p * 3 + 2] * e; sa += dw[p];
    acc += e; if (acc >= 0.5 * sY) break;
  }
  const vl = Math.hypot(vx, vy, vz);
  return { w, h, rgb, dir, dw, Y, meanY, meanRGB,
    dominant: { azimuth: Math.atan2(vz, vx) / D2R, elevation: Math.asin(vy / vl) / D2R, coherence: vl / acc, solidAnglePct: 100 * sa / (4 * Math.PI) } };
}
// Irradiance of the analysed map on a world normal n, after rotation R (world -> source) and scale.
function irradiance(A, nWorld, rotY, gain) {
  const n = nWorld.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);    // source-space normal (same R as the shader)
  let E = 0;
  for (let p = 0; p < A.dw.length; p++) {
    const c = n.x * A.dir[p * 3] + n.y * A.dir[p * 3 + 1] + n.z * A.dir[p * 3 + 2];
    if (c > 0) E += (gain[0] * 0.2126 * A.rgb[p * 3] + gain[1] * 0.7152 * A.rgb[p * 3 + 1] + gain[2] * 0.0722 * A.rgb[p * 3 + 2]) * c * A.dw[p];
  }
  return E;
}

// Equirect -> cube source for PMREM with rotation, white balance and intensity baked in,
// so the environment's scale never has to touch a material (r160 has no environmentIntensity).
function envSourceScene(tex, rotY, gain) {
  const s = new THREE.Scene();
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { tEquirect: { value: tex }, uRot: { value: new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(rotY)) }, uGain: { value: new THREE.Vector3(...gain) } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tEquirect; uniform mat3 uRot; uniform vec3 uGain; varying vec3 vDir;
      void main(){ vec3 d = normalize(uRot * vDir);
        vec2 uv = vec2(atan(d.z, d.x) * 0.15915494309189535 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.3183098861837907 + 0.5);
        gl_FragColor = vec4(texture2D(tEquirect, uv).rgb * uGain, 1.0); }`,
  });
  s.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), m));
  return { scene: s, dispose() { m.dispose(); s.children[0].geometry.dispose(); } };
}

export class ProductRenderer {
  constructor(renderer, scene, config = RENDER_CONFIG) {
    this.renderer = renderer; this.scene = scene;
    this.config = clone(config);
    this.config.environments = { ...config.environments };           // keep scene builders
    this.profile = null;
    this.env = { id: null, texture: null, target: null, info: null };
    this.envCache = new Map();                                       // cacheKey -> { target, info }
    this.hdr = new Map();                                            // url -> Promise<{ texture, analysis }>
    this.rigs = {};
    this.meterReading = null;
    this.box = null;
    this.casterRoot = null;                                          // product root the shadow frustum is fitted to
    this._casters = new WeakSet();                                    // meshes the shadow policy lets cast
    this._fit = { key: null, footprint: null };
  }

  // ── environment ─────────────────────────────────────────────────────────
  _loadHDR(url) {
    if (!this.hdr.has(url)) this.hdr.set(url, new RGBELoader().loadAsync(url).then(t => ({ texture: t, analysis: analyseHDR(t) })));
    return this.hdr.get(url);
  }
  /** Preload what a profile needs (call while the model downloads). */
  prepare(name) {
    const p = this.config.profiles[name]; const e = p && this.config.environments[p.environment];
    return e && e.type === 'hdr' ? this._loadHDR(e.url) : Promise.resolve();
  }
  async setEnvironment(id) {
    const e = this.config.environments[id];
    if (!e) throw new Error(`unknown environment ${id}`);
    const p = this.config.profiles[this.profile] || {};
    const key = p.key || { azimuth: 0 };
    const cacheKey = e.type === 'scene' ? id : `${id}|${p.environmentIntensity ?? 1}|${key.azimuth}`;
    let entry = this.envCache.get(cacheKey);
    if (!entry) {
      let target, info;
      if (e.type === 'scene') {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const src = e.build();
        target = pmrem.fromScene(src, e.sigma || 0);
        pmrem.dispose();
        src.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
        info = { id, type: 'scene', normalised: false };
      } else {
        const { texture, analysis: A } = await this._loadHDR(e.url);
        if (this.config.profiles[this.profile] !== p) return null;     // profile changed while loading
        entry = this.envCache.get(cacheKey);                            // a concurrent call may have built it
        if (!entry) {
          const rotY = e.rotation === 'alignKey' ? (key.azimuth - A.dominant.azimuth) * D2R : (e.rotation || 0) * D2R;
          const wb = e.neutralize ? A.meanRGB.map(c => A.meanY / c) : [1, 1, 1];
          const k = (p.environmentIntensity ?? 1) / A.meanY;             // mean radiance -> environmentIntensity
          const gain = wb.map(g => g * k);
          const pmrem = new THREE.PMREMGenerator(this.renderer);
          const src = envSourceScene(texture, rotY, gain);
          target = pmrem.fromScene(src.scene, 0, 0.1, 100);
          src.dispose(); pmrem.dispose();
          texture.dispose();                                             // GPU copy only; the CPU data stays for rebuilds
          info = { id, type: 'hdr', source: e.source, url: e.url, normalised: true, rawMeanRadiance: A.meanY, scale: k,
            whiteBalanceGain: wb.map(x => +x.toFixed(4)), rotationDeg: +(rotY / D2R).toFixed(1), dominant: A.dominant, analysis: A, rotY, gain };
        }
      }
      if (!entry) entry = { target, info };
    }
    // small LRU (current + previous): switching between a production and a legacy product costs nothing
    this.envCache.delete(cacheKey); this.envCache.set(cacheKey, entry);
    while (this.envCache.size > 2) { const [k0, e0] = this.envCache.entries().next().value; this.envCache.delete(k0); e0.target.dispose(); }
    this.env = { id, texture: entry.target.texture, target: entry.target, info: entry.info };
    this.scene.environment = entry.target.texture;
    this._afterLightingChange();
    return entry.info;
  }

  // ── lifecycle (Phase 34) ────────────────────────────────────────────────
  /** WebGL context restored: the PMREM targets lost their content. They are rebuilt from the kept HDR data. */
  contextRestored() {
    const id = this.env.id;
    for (const e of this.envCache.values()) e.target.dispose();
    this.envCache.clear(); this.env = { id: null, texture: null, target: null, info: null };
    this.renderer.shadowMap.needsUpdate = true;
    return id ? this.setEnvironment(id) : Promise.resolve(null);
  }
  /** Viewer closed: free the shadow maps (GPU only). three re-creates a map at the next shadow render. */
  releaseShadowMaps() {
    for (const rig of Object.values(this.rigs)) rig.group.traverse(L => { if (L.isLight && L.shadow && L.shadow.map) { L.shadow.map.dispose(); L.shadow.map = null; } });
    this.renderer.shadowMap.needsUpdate = true;
  }

  // ── profiles ────────────────────────────────────────────────────────────
  async useProfile(name, { box, contactShadow, casters } = {}) {
    const p = this.config.profiles[name]; if (!p) throw new Error(`unknown profile ${name}`);
    const changed = this.profile !== name;
    this.profile = name; if (box) this.box = box.clone();
    this.casterRoot = casters || null;
    this.renderer.toneMapping = TONE[p.toneMapping];
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    for (const [k, rig] of Object.entries(this.rigs)) {
      rig.group.visible = (k === name);
      // an inactive rig must not keep its 2048² shadow map alive; three re-creates it on demand
      if (k !== name) rig.group.traverse(L => { if (L.isLight && L.shadow && L.shadow.map) { L.shadow.map.dispose(); L.shadow.map = null; } });
    }
    if (!this.rigs[name]) this.rigs[name] = name === 'legacy' ? this._legacyRig(p) : this._pbrRig();
    this.rigs[name].group.visible = true;
    if (name === 'pbr') this._applyPbrLights();
    if (contactShadow) contactShadow.visible = !!p.contactShadow;
    this.contactShadow = contactShadow || null;
    if (changed || this.env.id !== p.environment) await this.setEnvironment(p.environment);
    else this._afterLightingChange();
  }
  /** Patch the active profile (e.g. { key:{ ratio:1.5 } }) and re-apply. */
  async configure(patch) {
    const p = this.config.profiles[this.profile];
    const envChanged = (patch.environment && patch.environment !== p.environment) || patch.environmentIntensity !== undefined;
    merge(p, clone(patch));
    this.renderer.toneMapping = TONE[p.toneMapping];
    if (this.profile === 'pbr') this._applyPbrLights();
    if (this.contactShadow) this.contactShadow.visible = !!p.contactShadow;
    if (envChanged || (patch.key && patch.key.azimuth !== undefined)) await this.setEnvironment(p.environment);
    else this._afterLightingChange();
  }

  _legacyRig(p) {
    const g = new THREE.Group(); g.name = 'ProductRenderer.legacy';
    for (const [type, color, intensity, pos, sh] of p.lights) {
      const L = type === 'ambient' ? new THREE.AmbientLight(color, intensity) : new THREE.DirectionalLight(color, intensity);
      if (pos) L.position.set(...pos);
      if (sh) {
        L.castShadow = true; L.shadow.mapSize.set(sh.mapSize, sh.mapSize);
        Object.assign(L.shadow.camera, { near: sh.near, far: sh.far, left: -sh.extent, bottom: -sh.extent, right: sh.extent, top: sh.extent });
        L.shadow.bias = sh.bias; L.shadow.normalBias = sh.normalBias; L.shadow.radius = sh.radius;
      }
      g.add(L);
    }
    this.scene.add(g);
    return { group: g };
  }
  _pbrRig() {
    const g = new THREE.Group(); g.name = 'ProductRenderer.pbr';
    const mk = (name) => { const L = new THREE.DirectionalLight(0xffffff, 0); L.name = name; g.add(L); g.add(L.target); return L; };
    const rig = { group: g, key: mk('key'), fill: mk('fill'), rim: mk('rim'), ambient: new THREE.AmbientLight(0xffffff, 0) };
    g.add(rig.ambient);
    this.scene.add(g);
    return rig;
  }
  _applyPbrLights() {
    const p = this.config.profiles.pbr, rig = this.rigs.pbr; if (!rig) return;
    const Emean = Math.PI * (p.environmentIntensity ?? 1);           // mean environment irradiance
    const c = this.box ? this.box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    for (const k of ['key', 'fill', 'rim']) {
      const s = p[k], L = rig[k];
      L.visible = !!(s && s.enabled);
      if (!L.visible) continue;
      L.color.set(s.color ?? 0xffffff);
      L.intensity = s.ratio * Emean;                                 // irradiance, physical units
      L.target.position.copy(c);
      L.position.copy(c).addScaledVector(dirFrom(s.azimuth, s.elevation), 20);
      L.castShadow = !!(s.castShadow && p.shadow.enabled);
    }
    rig.ambient.intensity = p.ambient || 0; rig.ambient.visible = !!p.ambient;
    this.renderer.shadowMap.enabled = true;
    this._fitShadow();
  }
  /** Shadow policy for a production root: every mesh receives; transmissive glazing does not cast. */
  applyShadowPolicy(root) {
    const s = this.config.profiles.pbr.shadow;
    root.traverse(o => {
      if (!o.isMesh || o.userData.pvOverlay) return;   // viewer overlays (highlight, System ghost) never cast (Phase 66)
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const cast = s.transmissiveCasters || !(m && m.transmission >= 0.5);
      o.receiveShadow = true; o.castShadow = cast;
      if (cast) this._casters.add(o); else this._casters.delete(o);
    });
    this._fit.key = null;
    this.renderer.shadowMap.needsUpdate = true;
  }
  /** Refit after the caster set changed (LOD shown/unloaded) and re-render the shadow map once. */
  refitShadow() { if (this.profile === 'pbr') { this._fitShadow(); this.renderer.shadowMap.needsUpdate = true; } }

  // Light-space footprint of the casting geometry. Points on the ground that a caster shadows lie on
  // the same light ray as that caster, so this footprint alone bounds every shadow — including the
  // one on the floor. Mode fades (mesh.visible / castShadow toggles) do not enter the fit, so the
  // frustum stays put through Full ⇄ System; hidden LODs do not count.
  _casterFootprint(view) {
    const meshes = [];
    this.casterRoot.traverse(o => {
      if (!o.isMesh || !this._casters.has(o)) return;
      for (let p = o.parent; p; p = p.parent) if (!p.visible) return;
      meshes.push(o);
    });
    const key = meshes.map(m => m.id).join(',') + '|' + view.elements.map(v => v.toFixed(5)).join(',');
    if (this._fit.key === key) return this._fit.footprint;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], mv = new THREE.Matrix4();
    for (const o of meshes) {
      o.updateWorldMatrix(true, false);
      const e = mv.multiplyMatrices(view, o.matrixWorld).elements, pos = o.geometry.attributes.position;
      for (let i = 0, n = pos.count; i < n; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const lx = e[0] * x + e[4] * y + e[8] * z + e[12], ly = e[1] * x + e[5] * y + e[9] * z + e[13], lz = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (lx < lo[0]) lo[0] = lx; if (lx > hi[0]) hi[0] = lx; if (ly < lo[1]) lo[1] = ly; if (ly > hi[1]) hi[1] = ly; if (lz < lo[2]) lo[2] = lz; if (lz > hi[2]) hi[2] = lz;
      }
    }
    this._fit = { key, footprint: meshes.length ? { lo, hi, vertices: meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0) } : null };
    return this._fit.footprint;
  }
  _boxFootprint(view) {
    const b = this.box, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], q = new THREE.Vector3();
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      q.set(x, y, z).applyMatrix4(view); lo[0] = Math.min(lo[0], q.x); hi[0] = Math.max(hi[0], q.x); lo[1] = Math.min(lo[1], q.y); hi[1] = Math.max(hi[1], q.y); lo[2] = Math.min(lo[2], q.z); hi[2] = Math.max(hi[2], q.z);
    }
    return { lo, hi, vertices: 8 };
  }
  // Orthographic key-light frustum fitted once per product/LOD (never per frame).
  _fitShadow() {
    const p = this.config.profiles.pbr, L = this.rigs.pbr && this.rigs.pbr.key;
    if (!L || !L.castShadow || !this.box) return;
    const s = p.shadow, q = { ...(this.config.shadowQuality[s.quality] || this.config.shadowQuality.high) };
    for (const k of ['mapSize', 'normalBiasTexels', 'depthBiasTexels']) if (s[k] !== undefined && s[k] !== null) q[k] = s[k];
    const size = q.mapSize;
    if (L.shadow.mapSize.x !== size || L.shadow.mapSize.y !== size) { L.shadow.mapSize.set(size, size); if (L.shadow.map) { L.shadow.map.dispose(); L.shadow.map = null; } }
    L.updateMatrixWorld(); L.target.updateMatrixWorld();
    const view = new THREE.Matrix4().lookAt(L.position, L.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(L.position); view.invert();
    const fp = (s.fit === 'casters' && this.casterRoot && this._casterFootprint(view)) || this._boxFootprint(view);
    const m = s.margin * Math.max(fp.hi[0] - fp.lo[0], fp.hi[1] - fp.lo[1]);
    const cam = L.shadow.camera;
    cam.left = fp.lo[0] - m; cam.right = fp.hi[0] + m; cam.bottom = fp.lo[1] - m; cam.top = fp.hi[1] + m;
    // Receivers past the far plane read as lit, and the floor under a high caster lies deeper
    // along the light than any caster vertex: reach far down to where the frustum's corner rays
    // meet the floor (the product stands on box.min.y).
    let far = -fp.lo[2];
    const toWorld = view.clone().invert(), dir = new THREE.Vector3(0, 0, -1).transformDirection(toWorld), c = new THREE.Vector3();
    if (dir.y < -1e-4) for (const [x, y] of [[cam.left, cam.bottom], [cam.left, cam.top], [cam.right, cam.bottom], [cam.right, cam.top]]) {
      c.set(x, y, 0).applyMatrix4(toWorld); far = Math.max(far, (this.box.min.y - c.y) / dir.y);
    }
    cam.near = Math.max(0.01, -fp.hi[2] - s.depthPad); cam.far = far + s.depthPad;
    cam.updateProjectionMatrix();
    const texel = Math.max(cam.right - cam.left, cam.top - cam.bottom) / size;
    L.shadow.normalBias = q.normalBiasTexels * texel * (this.normalBiasScale || 1);   // Phase 132: a per-product scale (thin double-sided panels)
    L.shadow.bias = -q.depthBiasTexels * texel / (cam.far - cam.near);
    this.shadowInfo = { quality: s.quality, mapSize: size, fit: fp.vertices > 8 ? 'casters' : 'box', fitVertices: fp.vertices,
      frustum: [cam.left, cam.right, cam.bottom, cam.top, cam.near, cam.far].map(v => +v.toFixed(3)),
      texelWorld: +texel.toFixed(5), normalBias: +L.shadow.normalBias.toFixed(5), depthBiasWorld: +(q.depthBiasTexels * texel).toFixed(5), bias: +L.shadow.bias.toExponential(3), bytes: size * size * 8 };
  }
  fitToBox(box) { this.box = box.clone(); if (this.profile === 'pbr') { this._applyPbrLights(); this._afterLightingChange(); } }

  // ── metering + exposure ─────────────────────────────────────────────────
  _afterLightingChange() {
    const p = this.config.profiles[this.profile]; if (!p) return;
    if (p.exposure.mode === 'manual') this.renderer.toneMappingExposure = p.exposure.value;
    else {
      const m = this.meter();
      this.renderer.toneMappingExposure = m.exposure;
    }
    this.renderer.shadowMap.needsUpdate = true;
  }
  // What the renderer itself returns for a white Lambertian card lit by the environment
  // alone: three's diffuse IBL is the PMREM's roughest level, which is energy-conserving on
  // average but narrower than a true cosine lobe, so the physical (CPU) irradiance and the
  // rendered one differ per direction. Exposure must calibrate what is actually rendered.
  _envIrradianceGPU(n) {
    const R = this.renderer;
    if (!R.capabilities.isWebGL2 || !R.extensions.has('EXT_color_buffer_float')) return null;
    if (!this._meterRig) {
      const scene = new THREE.Scene();
      const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, specularIntensity: 0 }));
      scene.add(card);
      this._meterRig = { scene, card, cam: new THREE.OrthographicCamera(-0.1, 0.1, 0.1, -0.1, 0.01, 10),
        rt: new THREE.WebGLRenderTarget(4, 4, { type: THREE.FloatType }), px: new Float32Array(4) };
    }
    const m = this._meterRig;
    m.scene.environment = this.scene.environment;
    m.card.lookAt(n); m.cam.position.copy(n).multiplyScalar(2); m.cam.lookAt(0, 0, 0);
    const prev = R.getRenderTarget(); R.setRenderTarget(m.rt); R.render(m.scene, m.cam); R.setRenderTarget(prev);
    R.readRenderTargetPixels(m.rt, 2, 2, 1, 1, m.px);
    return Math.PI * (0.2126 * m.px[0] + 0.7152 * m.px[1] + 0.0722 * m.px[2]);   // radiance × π = E
  }
  /** Incident reading at the meter normal: rendered environment irradiance + every enabled light. */
  meter() {
    const p = this.config.profiles[this.profile], cfg = this.config.meter;
    const n = new THREE.Vector3(...cfg.normal).normalize();
    const i = this.env.info;
    const Ephys = i && i.analysis ? irradiance(i.analysis, n, i.rotY, i.gain) : null;
    const Egpu = this.env.texture ? this._envIrradianceGPU(n) : null;   // works for procedural environments too
    const Eenv = Egpu ?? Ephys;
    const lights = {};
    let Etot = Eenv || 0;
    if (this.profile === 'pbr') for (const k of ['key', 'fill', 'rim']) {
      const s = p[k]; if (!s || !s.enabled) continue;
      const E = s.ratio * Math.PI * (p.environmentIntensity ?? 1) * Math.max(0, n.dot(dirFrom(s.azimuth, s.elevation)));
      lights[k] = E; Etot += E;
    }
    const mid = this.config.midGreyInput[p.toneMapping];
    // grey card radiance = ρ·E/π; exposure maps it onto the operator's middle-grey input
    const exposure = Eenv === null ? this.renderer.toneMappingExposure : mid * Math.PI / (cfg.reflectance * Etot) * Math.pow(2, p.exposure.compensationEV || 0);
    this.meterReading = { normal: n.toArray().map(v => +v.toFixed(3)), E_env: Eenv, E_env_physical: Ephys, E_env_source: Egpu !== null ? 'rendered' : 'physical',
      E_lights: lights, E_total: Etot, exposure, toneMapping: p.toneMapping };
    return this.meterReading;
  }

  /** Effective AO settings for the active profile, or null when AO is off. */
  aoSettings() {
    const p = this.config.profiles[this.profile], a = p && p.ao;
    if (!a || !a.enabled) return null;
    const lv = this.config.aoLevels[a.level] || {};
    const params = { ...lv };
    // a field set on the profile overrides the preset; null means "use the preset"
    for (const k of ['intensity', 'radius', 'thickness', 'bias', 'distanceExponent', 'distanceFallOff', 'power']) if (a[k] !== undefined && a[k] !== null) params[k] = a[k];
    return { level: a.level, quality: a.quality, floorOccludes: a.floorOccludes !== false, hdrResponse: a.hdrResponse || 'phase15', params };
  }

  postSettings() {
    const p = this.config.profiles[this.profile], q = p && p.post;
    if (!q || !q.enabled) return null;
    return { quality: q.quality || 'high', look: { saturation: (q.look && q.look.saturation) ?? 1 } };
  }

  state() {
    const p = this.config.profiles[this.profile], R = this.renderer;
    const env = this.env.info ? Object.fromEntries(Object.entries(this.env.info).filter(([k]) => !['analysis', 'rotY', 'gain'].includes(k))) : null;
    const img = this.env.texture && this.env.texture.image;
    const lights = {};
    if (this.profile === 'pbr') for (const k of ['key', 'fill', 'rim']) { const L = this.rigs.pbr[k]; lights[k] = { visible: L.visible, intensity: +L.intensity.toFixed(4), ratio: p[k].ratio, azimuth: p[k].azimuth, elevation: p[k].elevation, castShadow: L.castShadow }; }
    return { profile: this.profile, toneMapping: p.toneMapping, exposure: +R.toneMappingExposure.toFixed(5), outputColorSpace: R.outputColorSpace,
      environment: env, environmentIntensity: p.environmentIntensity, envTexture: img ? { width: img.width, height: img.height, bytes: img.width * img.height * 8 } : null,
      lights, meter: this.meterReading && { ...this.meterReading }, shadow: this.profile === 'pbr' ? this.shadowInfo : 'legacy fixed frustum', contactShadow: p.contactShadow,
      ao: this.aoSettings(), post: this.postSettings() };
  }
}
