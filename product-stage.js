// Product presentation stage (Phase 19) — ground contact, ground occlusion and the neutral
// background, for production assets only. Nothing here touches a product material, the HDRI,
// the lights, the shadows or the AO pass.
import * as THREE from 'three';

export const STAGE_CONFIG = {
  // The floor sits immediately below the lowest contact geometry (the tyres) — no fake offset.
  floorGap: 0.0006,                 // × product height below the contact plane (≈ 4.8 mm real for the VSS): no z-fighting at any zoom
  // Contact treatment (§10). 'occlusion' = the floor's ambient light is occluded by the product
  // above it (view factor from the real underside geometry, baked once per product, applied as the
  // floor material's aoMap so it only ever darkens indirect light). 'disc' = the pre-Phase-19 blob.
  contact: 'occlusion',
  occlusion: { res: 96, src: 48, margin: 0.55 },  // output texels, underside-height samples, margin × max(footprint)
  // Presentation background (§11–§12), see BACKGROUNDS. Phase 66: the universal Inferno charcoal studio.
  background: 'inferno',
};

// Backgrounds, all with the unchanged neutral-studio HDRI.
//   domeY:  display-linear luminance of the backdrop dome at the horizon band (display-referred painting)
//   floorK: floor albedo multiplier on the Phase 14 tar texture (median albedo 0.024 × K)
// 'studio' puts backdrop and floor at the level the HDRI itself displays at this exposure (backdrop 0.040,
// floor directions 0.060, measured through the same camera + AgX) — the reflections and the set agree.
// Brighter sets drop the drawer UI's text contrast below WCAG AA (§12), so they stay test presets.
//   Phase 66: the production floor no longer uses the tar texture (plain material + a soft light pool, no download);
//   floorAlbedo sets it directly, the older presets keep their brightness through floorK × the tar's median 0.024.
//   domeTop: display-linear luminance at the top of the dome (default: the Phase 19 profile, 0.72 × domeY).
export const BACKGROUNDS = {
  dark:   null,                               // the Phase 14 "black limbo" set exactly as built (legacy products)
  // Phase 66 default for production assets: deep charcoal studio, lifted only at the horizon band behind the product,
  // a dark floor (albedo 0.03) with a soft light pool; the product silhouette carries the frame (chosen by comparison, §2).
  inferno: { domeY: 0.010, domeTop: 0.0015, floorAlbedo: 0.030 },
  studio: { domeY: 0.045, floorK: 6.2 },      // B — Phase 19 default for production assets (median floor albedo ≈ 0.15, concrete)
  grey18: { domeY: 0.18,  floorK: 22 },       // 18 % grey — yellow edges lose separation, UI below AA
  bright: { domeY: 0.60,  floorK: 40 },       // C — white studio, UI below AA
};

const L2S = y => (y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055);
const domeCache = new Map();
// Same layout as the Phase 14 dome (lift at the horizon band, 0.47), at a studio level.
export function domeTexture(yH, yTop = null) {
  const key = `${yH}|${yTop}`;
  if (domeCache.has(key)) return domeCache.get(key);
  const c = document.createElement('canvas'); c.width = 4; c.height = 512;
  const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 512);
  const s = y => { const v = Math.round(255 * L2S(y)); return `rgb(${v},${v},${Math.min(255, v + 1)})`; };
  if (yTop == null) { g.addColorStop(0, s(yH * 0.72)); g.addColorStop(0.34, s(yH * 0.8)); g.addColorStop(0.47, s(yH)); g.addColorStop(0.62, s(yH * 0.9)); g.addColorStop(1, s(yH * 0.8)); }
  // charcoal profile (Phase 66): near-black above, a narrow lift at the horizon band, falling off below it
  else { g.addColorStop(0, s(yTop)); g.addColorStop(0.3, s(yTop + (yH - yTop) * 0.35)); g.addColorStop(0.47, s(yH)); g.addColorStop(0.58, s(yH * 0.8)); g.addColorStop(1, s(yH * 0.5)); }
  x.fillStyle = g; x.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; domeCache.set(key, t);
  return t;
}

/** Put a background on the stage. `base` = the dark set's own dome map + floor colour (restored for 'dark'). */
export function applyBackground({ dome, floor, base }, name) {
  const b = BACKGROUNDS[name] || null;
  const map = b ? domeTexture(b.domeY, b.domeTop ?? null) : base.domeMap;
  if (dome.material.map !== map) { dome.material.map = map; dome.material.needsUpdate = true; }
  // the production floor is plain (Phase 66): albedo directly; the legacy floor keeps its tar × floorK / base colour
  if (b) floor.material.color.setScalar(floor.userData.plain ? (b.floorAlbedo ?? b.floorK * 0.024) : b.floorK); else floor.material.color.copy(base.floorColor);
  return b ? name : 'dark';
}

// Floor offset for a product whose contact plane is `groundY` and height `height`.
export const floorY = (groundY, height, cfg = STAGE_CONFIG) => groundY - cfg.floorGap * height;

/**
 * Ground occlusion of the floor under a product, from its actual underside.
 * 1. Orthographic render from below: height of the lowest product surface above the ground, per texel.
 * 2. Each floor point sums the cosine-weighted view factor of those underside patches
 *    (a horizontal patch of area A at height h and horizontal offset r: A·h² / (π·(r² + h²)²)),
 *    i.e. the share of its sky hemisphere the product covers. No tuning factor.
 * Returns { texture, rect, stats } — texture: 1 = open sky, 0 = fully covered (aoMap convention).
 */
export function bakeGroundOcclusion(renderer, meshes, { groundY = 0, box, cfg = STAGE_CONFIG.occlusion } = {}) {
  const S = cfg.src, N = cfg.res;
  const size = box.getSize(new THREE.Vector3()), m = cfg.margin * Math.max(size.x, size.z);
  const x0 = box.min.x - m, x1 = box.max.x + m, z0 = box.min.z - m, z1 = box.max.z + m;
  const t0 = performance.now();

  // 1) underside height map (orthographic, looking up from below the ground)
  // camera under the ground at x = z = 0 looking +Y; with up = +Z its screen x = world x and screen y = world z
  const cam = new THREE.OrthographicCamera(x0, x1, z1, z0, 0.001, size.y + 2);
  cam.position.set(0, groundY - 0.5, 0); cam.up.set(0, 0, 1); cam.lookAt(0, groundY + 1, 0); cam.updateMatrixWorld(true);
  const mat = new THREE.ShaderMaterial({ side: THREE.DoubleSide, uniforms: { uG: { value: groundY } },
    vertexShader: 'varying float vY; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform float uG; varying float vY; void main(){ gl_FragColor = vec4(max(vY - uG, 0.0), 0.0, 0.0, 1.0); }' });
  const rt = new THREE.WebGLRenderTarget(S * 4, S * 4, { type: THREE.HalfFloatType });
  const scene = new THREE.Scene();
  // render the meshes in place (world matrices intact) through a proxy scene
  const proxy = []; for (const o of meshes) { const p = new THREE.Mesh(o.geometry, mat); p.matrixAutoUpdate = false; p.matrix.copy(o.matrixWorld); p.matrixWorld.copy(o.matrixWorld); scene.add(p); proxy.push(p); }
  const prevRT = renderer.getRenderTarget(), cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha(), sm = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, cam);
  const W = S * 4, buf = new Uint16Array(W * W * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, W, buf);
  renderer.setRenderTarget(prevRT); renderer.setClearColor(cc, ca); renderer.shadowMap.autoUpdate = sm;
  rt.dispose(); mat.dispose(); for (const p of proxy) scene.remove(p);

  // lowest surface per S×S source cell (min over its 4×4 block; empty = open sky)
  const src = []; const cw = (x1 - x0) / S, ch = (z1 - z0) / S, A = cw * ch;
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    let h = Infinity;
    for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) { const k = ((j * 4 + b) * W + (i * 4 + a)) * 4; if (buf[k + 3]) h = Math.min(h, THREE.DataUtils.fromHalfFloat(buf[k])); }
    // readback row 0 is the bottom of the frustum = world z0
    if (h < Infinity) src.push(x0 + (i + 0.5) * cw, z0 + (j + 0.5) * ch, Math.max(h, 0.25 * Math.min(cw, ch)));
  }

  // 2) view factor per output texel
  const data = new Uint8Array(N * N); let occMax = 0, occSum = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = x0 + (i + 0.5) * (x1 - x0) / N, z = z1 - (j + 0.5) * (z1 - z0) / N;
    let occ = 0;
    for (let k = 0; k < src.length; k += 3) { const dx = src[k] - x, dz = src[k + 1] - z, h = src[k + 2], r2 = dx * dx + dz * dz, q = r2 + h * h; occ += A * h * h / (Math.PI * q * q); }
    occ = Math.min(1, occ);
    // the outermost 8 % fades to open sky so the clamped edge can never show
    const e = Math.min(i, j, N - 1 - i, N - 1 - j) / (0.08 * N); if (e < 1) occ *= e * e * (3 - 2 * e);
    occMax = Math.max(occMax, occ); occSum += occ;
    data[j * N + i] = Math.round(255 * (1 - occ));
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { texture: tex, rect: { x0, x1, z0, z1 }, stats: { ms: Math.round(performance.now() - t0), sourceCells: src.length / 3, occMax, occMean: occSum / (N * N), bytes: N * N } };
}

/**
 * Map a ground-occlusion texture onto the viewer's floor (CircleGeometry of `radius`, rotated −90° about X,
 * uv = (x/2R + ½, −z/2R + ½)) as its aoMap. Returns a function that removes it again (the texture is not disposed).
 */
export function applyGroundOcclusion(floor, occ, radius) {
  const m = floor.material, { x0, x1, z0, z1 } = occ.rect, t = occ.texture, D = 2 * radius;
  t.repeat.set(D / (x1 - x0), D / (z1 - z0));
  t.offset.set(-(radius + x0) / (x1 - x0), (z1 - radius) / (z1 - z0));
  t.updateMatrix();
  const prev = { aoMap: m.aoMap, aoMapIntensity: m.aoMapIntensity };
  m.aoMap = t; m.aoMapIntensity = 1; m.needsUpdate = true;
  return () => { m.aoMap = prev.aoMap; m.aoMapIntensity = prev.aoMapIntensity; m.needsUpdate = true; };   // the texture belongs to the product record
}

// ── Phase 20: ground + environment ──────────────────────────────────────────────────────
// The production ground is the Phase 19 floor itself, as its own mesh: the same geometry buffers, world mapping,
// alpha fade into the backdrop dome, ground occlusion and shadow catcher above it (Phase 66 replaced only its surface:
// plain charcoal + a light pool instead of the tar texture). One presentation rule is added: floor seen within `horizonDeg` of the horizon hands
// over to the backdrop (its alpha → 0). That is exactly where a low eye saw the Phase 19 seam — the floor
// compressed into a few pixels under the horizon, darker than the backdrop, with a grazing-Fresnel rim —
// and the backdrop dome just below the horizon has the same value as just above it, so floor and backdrop
// meet without a line from any camera height: an infinity cove without curved geometry, no camera clamp.
export const ENVIRONMENT_CONFIG = {
  // §8: the smallest band that takes the low-eye seam below visibility at every eye height
  // (grazing rim ≤ 0.02 ΔL, horizon contrast ≤ 0.005 ΔL; Phase 19: 0.16 / 0.07)
  horizonDeg: 7,
};

// Soft light pool under the product (Phase 66): generated, no download. Centre 1.0 → edge ≈ 0.14 linear.
let poolTex = null;
function stagePoolTexture() {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d'), g = x.createRadialGradient(256, 256, 0, 256, 256, 256);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, '#d8d8d8'); g.addColorStop(0.75, '#8a8a8a'); g.addColorStop(1, '#6a6a6a');
  x.fillStyle = g; x.fillRect(0, 0, 512, 512);
  poolTex = new THREE.CanvasTexture(c); poolTex.colorSpace = THREE.SRGBColorSpace;
  return poolTex;
}

/**
 * The production floor: a mesh on the legacy floor's own geometry. Phase 66: its own plain material — no tar texture and no
 * normal map (nothing to download, no road surface under the product), the generated light pool, the legacy floor's alpha
 * fade into the backdrop, and the same roughness / environment response. Ground occlusion and the shadow catcher are unchanged.
 */
export function createStageFloor(legacyFloor, { horizonDeg = ENVIRONMENT_CONFIG.horizonDeg } = {}) {
  const L = legacyFloor.material;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: stagePoolTexture(), roughness: L.roughness, metalness: L.metalness,
    envMapIntensity: L.envMapIntensity, alphaMap: L.alphaMap, transparent: true });
  mat.name = 'ProductStageFloor';
  const U = { uHorizonSin: { value: Math.sin(horizonDeg * Math.PI / 180) },
    // Phase 94: see-through stage (showcase): the floor fades out in screen space, an ellipse around the product, so it melts
    // into the page instead of ending at the canvas rectangle. uSee.x = on, uSee.zw = ellipse radii (share of the canvas).
    uSee: { value: new THREE.Vector4(0, 0, 0.5, 0.5) }, uSeeVP: { value: new THREE.Vector4(0, 0, 1, 1) } };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHorizonSin = U.uHorizonSin; sh.uniforms.uSee = U.uSee; sh.uniforms.uSeeVP = U.uSeeVP;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vStageW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vStageW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vStageW;\nuniform float uHorizonSin;\nuniform vec4 uSee;\nuniform vec4 uSeeVP;')
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
  { vec3 toEye = cameraPosition - vStageW;                                   // sine of the depression angle of this floor point
    diffuseColor.a *= smoothstep(0.0, uHorizonSin, toEye.y / max(length(toEye), 1e-5));
    if (uSee.x > 0.5) { vec2 q = (gl_FragCoord.xy - uSeeVP.xy) / uSeeVP.zw - vec2(0.5, uSee.y); float d = length(q / uSee.zw);
      vec2 e = (gl_FragCoord.xy - uSeeVP.xy) / uSeeVP.zw;                           // and never reaches the canvas edges
      diffuseColor.a *= (1.0 - smoothstep(0.35, 1.0, d)) * smoothstep(0.0, 0.2, e.y) * smoothstep(0.0, 0.12, e.x) * smoothstep(0.0, 0.12, 1.0 - e.x); } }`);
  };
  mat.customProgramCacheKey = () => 'productStageFloor';
  const mesh = new THREE.Mesh(legacyFloor.geometry, mat);
  mesh.name = 'ProductStageFloor'; mesh.userData.plain = true;
  mesh.rotation.copy(legacyFloor.rotation); mesh.position.copy(legacyFloor.position); mesh.renderOrder = legacyFloor.renderOrder;
  mesh.userData.horizon = U;
  return mesh;
}
