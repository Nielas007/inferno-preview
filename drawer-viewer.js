// Interactive product viewer for the drawer. Own renderer + OrbitControls,
// drag-to-rotate, with a toggle-able T-Rotor cutaway. Lazy singleton: the
// (browser-cached) GLB is loaded on first open and the scene is reused for
// every subsequent open. The hero scroll scene (cinematic.js) is untouched.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';   // Phase 82r: focus blur passes
import { ProductionAsset, resetTextureLoader } from './production-asset.js?v=9';
import { ProductRenderer, RENDER_CONFIG } from './product-renderer.js?v=11';
import { ProductAO } from './product-ao.js?v=4';
import { ProductPost } from './product-post.js?v=12';
import { GroundProjectedSkybox } from 'three/addons/objects/GroundProjectedSkybox.js';   // Phase 102
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ProductCamera, CAMERA_CONFIG, buildHull, dirFromAngles } from './product-camera.js?v=11';
import { STAGE_CONFIG, floorY, bakeGroundOcclusion, applyGroundOcclusion, applyBackground, createStageFloor } from './product-stage.js?v=10';

const lerp = THREE.MathUtils.lerp;
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ── Component-role name matcher ───────────────────────────────────────────
// Every rebuilt product model drops in as long as its parts carry the
// documented ROLE names. Blender appends duplicate suffixes (.001) and varies
// case/separators on export, so we normalise before matching: strip a trailing
// .00N / _00N duplicate suffix, lowercase, and drop every separator.
// So `Gun_Bot`, `gun bot`, `GunBot` and `Gun_Bot.001` all resolve to `gunbot`.
// GLTFLoader strips the dot out of Blender's duplicate suffix, so `Foo.004`
// reaches three.js as `Foo004`. Drop a trailing 3-digit run (never the whole
// name) so a role matches in both spellings — and keep `Cylinder_1` distinct
// from `Cylinder_2`, which a blanket [._]\d+$ strip would collapse together.
const stripDup = s => {
  const t = (s || '').replace(/\.\d{3}$/, '');
  return (t.length > 3 && /\d{3}$/.test(t)) ? t.slice(0, -3) : t;
};
const normName = s => stripDup(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// Cannon-head parts that articulate / stay lit in Gun mode (any case/suffix).
const GUN_ROLES = new Set(['gunbot', 'guntop', 'handelgun', 'handlegun']);
// Every texture slot worth filtering anisotropically on a product material.
const MAP_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'clearcoatRoughnessMap'];
let maxAniso = 8;   // raised to the device's limit once the renderer exists
const isGunPart = n => GUN_ROLES.has(normName(n.name));

// ── Premium studio pass ───────────────────────────────────────────────────
// 28° vertical FOV ≈ a 65–70mm product lens. All hand-tuned framings below
// were authored at 35°, so camera positions are pushed out by ZOOM_K to keep
// the exact same composition with the flatter, more photographic perspective.
const FOV = 28;
const ZOOM_K = Math.tan(THREE.MathUtils.degToRad(35 / 2)) / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const dolly = (pos, tgt) => ({
  x: tgt.x + (pos.x - tgt.x) * ZOOM_K,
  y: tgt.y + (pos.y - tgt.y) * ZOOM_K,
  z: tgt.z + (pos.z - tgt.z) * ZOOM_K,
});

// ── Runtime LOD (Phase 21) ────────────────────────────────────────────────
// Production assets pick their LOD from the projected size of the product: s = diameter, in device
// pixels, of the bounding sphere of the model's bounds (canvas height incl. pixel ratio, vertical FOV,
// camera → sphere-centre distance). Limits are measured (PHASE_21_RUNTIME_LOD_REPORT §6): a LOD is used
// only while its image difference to LOD0 stays within that of a ½-device-pixel camera shift, worst case
// over 5 views × 7 viewports. The manifest's metre ranges (lodRangesM) are not used.
export const LOD_CONFIG = {
  auto: true,
  maxPx: [Infinity, 2000, 850, 460],  // LODn is allowed while s ≤ maxPx[n]
  hysteresis: 0.15,                   // back to a coarser LOD only below (1 − h) × its limit (orbiting at a fixed zoom moves s ≤ 10.5 %)
  coarsest: 2,                        // LOD3 drops 737 of the 777 fittings (feature IDs), so it is never selected
  initial: 'view',                    // LOD loaded on open: 'view' = the one the default view needs (predicted from the
                                      // manifest bounds), or a fixed LOD. Finer LODs load on demand; coarser ones are never fetched.
  boundsToHull: 1.22,                 // projected size of the real hull ÷ that of the manifest bounding box at the default view
                                      // (1.16–1.22 over six viewport aspects): the prediction can only err towards a finer LOD
  progressive: false,                 // true: refine one LOD at a time instead of loading the wanted LOD directly
  predict: 'crossing',                // fetch ahead (Phase 22 §6): 'crossing' = when the zoom target, extrapolated at the visitor's zoom-in
                                      // rate, would need the finer LOD within `horizon`; 'target' = only once the zoom target needs it (Phase 21)
  horizon: 0.5,                       // s; measured against margin / displayed-velocity / 1-s variants (PHASE_22_PERFORMANCE_REPORT §5)
  prepareBytes: 2e6,                  // GPU upload per frame while a loaded LOD is prepared behind the visible one
};
const ZOOM_SPEED = 1.8;               // Phase 82m (owner: "zoom in en uit vinniger"): wheel / pinch step (OrbitControls default 1)
const ZOOM_STEP = -Math.log(0.95) * ZOOM_SPEED;   // one OrbitControls wheel step in ln distance
const geometryBytes = (g) => { const seen = new Set(); let b = 0; for (const k in g.attributes) { const a = g.attributes[k], arr = a.isInterleavedBufferAttribute ? a.data.array : a.array; if (!seen.has(arr)) { seen.add(arr); b += arr.byteLength; } } return b + (g.index ? g.index.array.byteLength : 0); };
const _lodC = new THREE.Vector3(), _lodS = new THREE.Vector3();
function lodPx(r) {
  const R = r.bbox.getSize(_lodS).length() / 2; r.bbox.getCenter(_lodC);
  const d = Math.max(V.camera.position.distanceTo(_lodC), R);
  return R * V.renderer.domElement.height / (Math.tan(THREE.MathUtils.degToRad(V.camera.fov) / 2) * d);
}
// Coarsest LOD whose limit covers s; a coarser one than `cur` only once s is below the hysteresis band.
function wantedLOD(s, cur) {
  const C = LOD_CONFIG; let n = 0;
  while (n < C.coarsest && s <= C.maxPx[n + 1]) n++;
  if (cur == null || n <= cur) return n;
  let m = cur; while (m < C.coarsest && s <= C.maxPx[m + 1] * (1 - C.hysteresis)) m++;
  return m;
}

// Lighting, environment, tone mapping and exposure live in product-renderer.js
// (Phase 14): the `pbr` profile for production assets, the `legacy` profile — the
// former synthetic studio, value for value — for the MAT_PRESETS products.

// Physically-based material presets per component role.
const MAT_PRESETS = {
  // Satin, not wet: broad soft highlights à la the Ducati configurator —
  // clear coat present but matte-ish so the softbox streak spreads wide.
  paint:  { roughness: 0.5,  metalness: 0.1,  clearcoat: 0.55, clearcoatRoughness: 0.18, envMapIntensity: 0.9 },  // satin automotive paint
  powder: { roughness: 0.44, metalness: 0.05, clearcoat: 0.15, clearcoatRoughness: 0.4,  envMapIntensity: 0.7 },  // powder-coated steel cylinders
  steel:  { roughness: 0.38, metalness: 1.0,  envMapIntensity: 0.9 },                                             // brushed stainless pipework
  rubber: { roughness: 0.93, metalness: 0.0,  envMapIntensity: 0.25 },                                            // tyres / hose
  foam:   { roughness: 0.88, metalness: 0.0,  sheen: 0.45, sheenRoughness: 0.9, envMapIntensity: 0.35 },          // baked froth + soft sheen
};
// Bakkie studio (2026-09-29, owner-approved): the Attac 2CU / 4CU GLBs carry physically based materials of their own and are
// shown in the production studio (pbr profile, Inferno stage floor + background, ground occlusion, no contact disc) with a
// catalogue three-quarter framing. They keep every legacy feature (System, Gun, Cutaway, callouts). No MAT_PRESETS for them.
const STUDIO_GLB = /models\/attac-(2|4)cu\.glb/;
function matKind(both, steelName) {
  if (/glass|glas|window|venster|ruit|windscreen|lens|light/i.test(both)) return null; // leave optics alone
  if (/foam|liquid/i.test(both)) return 'foam';
  if (/tyre|tire|rubber|hose_?coil|band_/i.test(both)) return 'rubber';
  if (/carpaint|car_paint|body_|hood|bonnet|fender|cabin|door|tailgate|bumper|mirror|grill/i.test(both)) return 'paint';
  if (steelName || /steel|stainless|chrome|inox|alumin|manifold|pipe|fitting|bracket|frame|reel|nipple/i.test(both)) return 'steel';
  if (/enamel|cylinder|silinder|cyl_|tank|vessel|shell/i.test(both)) return 'powder';
  return null;
}
function toPhysical(src, kind) {
  const p = new THREE.MeshPhysicalMaterial();
  p.name = src.name;
  if (src.color) p.color.copy(src.color);
  p.map = src.map || null;
  p.normalMap = src.normalMap || null;
  if (src.normalScale && p.normalScale) p.normalScale.copy(src.normalScale);
  p.roughnessMap = src.roughnessMap || null;
  p.metalnessMap = src.metalnessMap || null;
  p.aoMap = src.aoMap || null; p.aoMapIntensity = src.aoMapIntensity ?? 1;
  if (src.emissive) p.emissive.copy(src.emissive);
  p.emissiveMap = src.emissiveMap || null; p.emissiveIntensity = src.emissiveIntensity ?? 1;
  p.alphaMap = src.alphaMap || null;
  p.transparent = !!src.transparent; p.opacity = src.opacity ?? 1;
  p.side = src.side ?? THREE.FrontSide;
  p.roughness = src.roughness ?? 0.5; p.metalness = src.metalness ?? 0;
  Object.assign(p, MAT_PRESETS[kind]);
  if (kind === 'foam') p.sheenColor.set(0xffffff);
  return p;
}

// Cutaway cut-face treatment, injected into the sliced shell materials:
//  • back faces darken → the vessel reads as solid steel, not a hollow film
//  • a thin machined "cut edge" band lights up right at the clip plane
const _cutU = { c: { value: 100 }, on: { value: 0 } };
function injectCutShader(mt) {
  mt.onBeforeCompile = (sh) => {
    sh.uniforms.uCutC = _cutU.c;
    sh.uniforms.uCutOn = _cutU.on;
    sh.vertexShader = sh.vertexShader
      .replace('#include <clipping_planes_pars_vertex>', '#include <clipping_planes_pars_vertex>\nvarying vec3 vDvWp;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvDvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>\nvarying vec3 vDvWp;\nuniform float uCutC;\nuniform float uCutOn;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (!gl_FrontFacing) gl_FragColor.rgb *= 0.45;
        float dvB = (1.0 - smoothstep(0.0, 0.016, uCutC - vDvWp.x)) * uCutOn;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.75, 0.78, 0.81), clamp(dvB, 0.0, 1.0));`);
  };
  mt.customProgramCacheKey = () => 'dvcut';
}

// Engineering callouts: thin leader lines + minimal uppercase labels, only in
// cutaway. Anchors are real component positions on the kept half of the cut.
function buildCallouts(anchors) {
  const wrap = document.getElementById('drawer-stage-3d');
  if (!wrap || !V) return;
  // Switching products must drop the previous product's labels — otherwise the
  // old host stays in the DOM and both sets track the cut at once.
  wrap.querySelectorAll('#dv-callouts').forEach(n => n.remove());
  V.callouts = []; V.calloutHost = null; V.calloutShown = false;
  if (!anchors || !anchors.length) return;
  const host = document.createElement('div');
  host.id = 'dv-callouts';
  host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;opacity:0;transition:opacity .5s ease;';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
  svg.style.cssText = 'position:absolute;inset:0;overflow:visible;';
  host.appendChild(svg);
  V.callouts = [];
  for (const a of anchors) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('stroke', 'rgba(236,241,246,0.42)'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('r', '2.4'); dot.setAttribute('fill', 'rgba(236,241,246,0.9)');
    svg.appendChild(dot);
    const el = document.createElement('div');
    el.textContent = a.label;
    el.style.cssText = 'position:absolute;font-size:10px;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;color:rgba(236,241,246,0.88);padding:2px 0 4px;border-bottom:1px solid rgba(236,241,246,0.3);transform:translateY(-100%);';
    host.appendChild(el);
    V.callouts.push({ p: a.p.clone(), dx: a.dx, dy: a.dy, line, dot, el });
  }
  wrap.appendChild(host);
  V.calloutHost = host; V.calloutShown = false;
}
const _cv = new THREE.Vector3();
function updateCallouts(showWanted) {
  if (!V || !V.calloutHost) return;
  const show = !!showWanted;
  if (show !== V.calloutShown) { V.calloutHost.style.opacity = show ? '1' : '0'; V.calloutShown = show; }
  if (!show) return;
  const canvas = V.renderer.domElement;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  for (const c of V.callouts) {
    _cv.copy(c.p).project(V.camera);
    const behind = _cv.z > 1;
    const sx = (_cv.x * 0.5 + 0.5) * w, sy = (-_cv.y * 0.5 + 0.5) * h;
    const lx = sx + c.dx, ly = sy + c.dy;
    c.dot.setAttribute('cx', sx.toFixed(1)); c.dot.setAttribute('cy', sy.toFixed(1));
    c.line.setAttribute('x1', sx.toFixed(1)); c.line.setAttribute('y1', sy.toFixed(1));
    c.line.setAttribute('x2', lx.toFixed(1)); c.line.setAttribute('y2', ly.toFixed(1));
    const vis = behind ? 'hidden' : 'visible';
    if (c.el.style.visibility !== vis) { c.el.style.visibility = vis; c.line.style.visibility = vis; c.dot.style.visibility = vis; }
    c.el.style.left = lx + 'px';
    c.el.style.top = ly + 'px';
    c.el.style.transform = c.dx >= 0 ? 'translateY(-100%)' : 'translate(-100%,-100%)';
  }
}

let V = null;          // viewer singleton state
const _panV = new THREE.Vector3(), _panT = new THREE.Vector3(), _panA = new THREE.Vector3(), _panB = new THREE.Vector3();
// Power (Phase 82h, owner: "phone warm raak as ek rukkie op dit is"): the viewer drew the full HDR + AO frame 60 times a second
// even with nothing moving and with the canvas scrolled out of view. Now a frame is drawn only when something changed (camera,
// an easing mode amount, an active effect, a model / mode / LOD change, recent input) plus a short tail for the post to settle
// and a 2 fps keep-alive; nothing while the canvas is off screen. Phones (coarse pointer): 30 fps unless a finger is on the
// model, the idle spin stops after 45 s, and the Gun effects are lighter (fewer particles, 3-octave flames).
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const PWR = { cam: null, proj: null, key: '', lastDraw: 0, tail: 0, visible: true, lastInput: 0, spinStart: 0, draws: 0, skips: 0 };
let running = false;   // render loop active?
let visible = false;   // drawer open?
let userInteracting = false;   // pointer currently dragging the model?
let lastInteract = 0;          // timestamp of the last drag release
const IDLE_RESUME_MS = 10000;  // resume the gentle spin after 10s of no input
let truckFloor = 0;            // truck fade target: 0 = hidden, >0 = ghosted

// View state. mode ∈ 'full' | 'system' | 'cutaway'. Each drives three
// animated amounts eased in the render loop:
//   cutAmt   — cylinder slice (0 closed → 1 open)
//   truckAmt — truck body fade (0 visible → 1 hidden)
//   dimAmt   — the rest of the rig ghosted (0 solid → 1 faint)
let mode = 'full';
let cutAmt = 0, cutTarget = 0;
let truckAmt = 0, truckTarget = 0;
let dimAmt = 0, dimTarget = 0;        // cutaway: ghost everything but the sliced cylinder
let gunDimAmt = 0, gunDimTarget = 0;  // gun: ghost everything but the cannon head
// Production Cutaway (Phase 67): 0 = the host cylinder solid → 1 = the pre-cut cylinder (manifest.cutaway, fetched on first use)
// in its place. Eased like the other amounts, and only once the cut geometry is resident.
const PCUT = { amt: 0 };
let cutPlane, cutConst = 0, cutStart = 100, cylGlow = null;

// Gun (aimable cannon) state.
let aimYaw = null, aimPitch = null;      // reparent pivots for the barrel
let gunYaw = 0, gunPitch = 0;            // current eased angles
let gunYawT = 0, gunPitchT = 0;          // mouse-driven targets
let foamOn = false;                      // spray on/off
let systemOn = false;                    // VSS discharge on/off (system mode)
let keepView = false;                    // Phase 114: the current mode was entered with { keepView } — the discharge moves no camera
let spray = null;                        // { points, geom, vel, life, max, count }
const _prevTs = { t: 0 };                // last frame timestamp for spray dt
let zoomEl = null, zoomDragging = false; // zoom slider + drag guard

// Zoom = camera distance along the view direction, mapped to a 0..1 slider
// (1 = fully zoomed in). Respects the OrbitControls min/max distance.
function setZoom(t) {
  if (!V) return;
  if (V.pcam && V.pcam.active) { V.pcam.setZoom(t); return; }
  t = Math.max(0, Math.min(1, t));
  const dist = lerp(V.controls.maxDistance, V.controls.minDistance, t);
  const dir = new THREE.Vector3().subVectors(V.camera.position, V.controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  dir.normalize();
  V.camera.position.copy(V.controls.target).addScaledVector(dir, dist);
  V.controls.update();
}
function getZoom() {
  if (!V) return 0.5;
  if (V.pcam && V.pcam.active) return V.pcam.getZoom();
  const d = V.camera.position.distanceTo(V.controls.target);
  const { minDistance: mn, maxDistance: mx } = V.controls;
  return Math.max(0, Math.min(1, (mx - d) / (mx - mn)));
}

function build() {
  const canvas = document.getElementById('drawer-canvas');
  const wrap = document.getElementById('drawer-stage-3d');
  if (!canvas || !wrap) return null;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  // Tone mapping + exposure are set per product by ProductRenderer.useProfile().
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // The set is static (camera orbits, model doesn't move): render the 2048²
  // shadow map ON DEMAND only. Re-rendering it every frame costs a full
  // scene depth pass — the single biggest per-frame waste with a 4M-tri CAD
  // model. fadeRec() flips needsUpdate whenever shadow casters change.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  camera.position.set(4.4, 2.4, 5.1);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomSpeed = ZOOM_SPEED;
  controls.enablePan = true;              // Phase 82l (owner: "click en drag om die model te skuif"): right-drag / shift-drag / two fingers move the view
  controls.screenSpacePanning = true; controls.panSpeed = 0.8;
  controls.minDistance = 1.8 * ZOOM_K;   // allow the closer system / cutaway framings
  controls.maxDistance = 9.0 * ZOOM_K;   // (scaled with the longer product lens)
  controls.maxPolarAngle = Math.PI * 0.52;   // don't dip under the floor
  controls.minPolarAngle = Math.PI * 0.12;
  controls.target.set(0, 0.85, 0);
  controls.autoRotate = true;
  controls.autoRotateSpeed = -0.9;
  // Pause the spin while dragging; the render loop resumes it after 10s idle.
  controls.addEventListener('start', () => { userInteracting = true; controls.autoRotate = false; movedSinceFrame = true; });
  controls.addEventListener('end',   () => { userInteracting = false; lastInteract = performance.now(); });
  // Legacy products keep these exact controls settings; production assets hand the camera to
  // ProductCamera (Phase 19: product-derived framing, limits, clearance and damped motion).
  const LEGACY_CAM = { minDistance: controls.minDistance, maxDistance: controls.maxDistance, minPolarAngle: controls.minPolarAngle, maxPolarAngle: controls.maxPolarAngle, dampingFactor: controls.dampingFactor, near: camera.near, far: camera.far };
  const pcam = new ProductCamera(camera, controls, CAMERA_CONFIG);

  // Gun mode is a STATIC connected view: the cannon can't articulate without
  // breaking (the feed pipes + head are one rigid mesh), so we don't rotate
  // any gun parts. You orbit the whole model and toggle the mist spray.
  // Phase 82: production assets with a measured cannon rig (manifest.gun.rig) DO aim: a mouse aims by hovering; on touch a tap
  // aims (a drag still orbits).
  { let tap = null;
    canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && e.buttons === 0) aimProdGun(e.clientX, e.clientY); });
    canvas.addEventListener('pointermove', (e) => {   // Phase 119: in POV a mouse drag looks around, a finger aims as it moves
      if (!POV.on) return;
      if (e.pointerType === 'mouse') { if (e.buttons) POV.yawOff = THREE.MathUtils.clamp(POV.yawOff - e.movementX * 0.0035, -1.3, 1.3); }
      else aimProdGun(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointerdown', (e) => { tap = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    canvas.addEventListener('pointerup', (e) => {
      if (tap && e.pointerType !== 'mouse' && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10 && performance.now() - tap.t < 450) aimProdGun(e.clientX, e.clientY);
      tap = null;
    }); }
  // Phase 82h: any input in the drawer (hover highlights, list clicks, keys) keeps frames coming for a moment; an off-screen
  // canvas (scrolled away in the drawer, page in the background) draws nothing.
  { const touch = () => { PWR.lastInput = performance.now(); };
    for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'click', 'touchmove']) document.addEventListener(ev, touch, { passive: true, capture: true });
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { for (const e of es) PWR.visible = e.isIntersecting; }, { threshold: 0.02 }).observe(canvas); }

  // ── Zoom bar ────────────────────────────────────────────────────
  // Vertical slider (+ / −) synced two-way with the wheel/pinch zoom.
  zoomEl = document.getElementById('drawer-zoom');
  if (zoomEl) {
    zoomEl.addEventListener('input', () => { zoomDragging = true; setZoom(zoomEl.value / 100); });
    const stopDrag = () => { zoomDragging = false; };
    zoomEl.addEventListener('change', stopDrag);
    zoomEl.addEventListener('pointerup', stopDrag);
    zoomEl.addEventListener('blur', stopDrag);
  }
  const zin = document.getElementById('drawer-zoom-in');
  const zout = document.getElementById('drawer-zoom-out');
  if (zin) zin.addEventListener('click', () => setZoom(getZoom() + 0.2));
  if (zout) zout.addEventListener('click', () => setZoom(getZoom() - 0.2));
  // Desktop Reset (Phase 58): the same reset + event as the phone viewer's Reset button
  // (a presented component stays selected and the whole product comes back into view).
  const zreset = document.getElementById('drawer-zoom-reset');
  if (zreset) zreset.addEventListener('click', () => {
    DrawerViewer.resetView({ animate: !matchMedia('(prefers-reduced-motion: reduce)').matches });
    zreset.dispatchEvent(new CustomEvent('productviewer:reset', { bubbles: true }));
  });

  // Lights + IBL environment: one ProductRenderer, profile chosen per product in showOnly().
  const pr = new ProductRenderer(renderer, scene, RENDER_CONFIG);
  // Screen-space AO, composited after the frame; the active profile decides whether it runs.
  const ao = new ProductAO(renderer);
  // HDR output pipeline (Phase 18): scene-linear render target → AO → AgX → sRGB, production profile only.
  const post = new ProductPost(renderer);

  // Floor: dark-charcoal studio concrete (Ducati "black limbo" look). Fine
  // speckle so the surface lives, satin response so the softbox smears wide,
  // and an ELLIPTICAL light pool sitting slightly behind the vehicle — the
  // pool is a stage for the silhouette, not a spotlight on it. Radial alpha
  // dissolve keeps the horizon invisible at low camera angles.
  // The floor is UNLIT (painted, like a matte-painting): scene lights can't
  // wash it out, so the pool brightness is exactly what's authored here — the
  // same reason Ducati flags their subject lights off the set floor.
  // Surface: REAL tar — Poly Haven "Asphalt Pit Lane" (CC0), tone-neutralised
  // (the source leans warm-brown), tiled seam-safe, with the studio light
  // pool MULTIPLIED over it so the pool stays a light, not a texture.
  const FS = 3072;
  const floorCan = document.createElement('canvas'); floorCan.width = floorCan.height = FS;
  const floorCtx = floorCan.getContext('2d');
  const drawPool = (c, S) => {
    c.globalCompositeOperation = 'multiply';
    c.save(); c.translate(S / 2, S * 0.445); c.scale(1, 0.8);   // ellipse, nudged behind the truck
    const g = c.createRadialGradient(0, 0, 0, 0, 0, S * 0.42);
    g.addColorStop(0.0, '#ffffff');
    g.addColorStop(0.35, '#b2b4b8');
    g.addColorStop(0.7, '#4c4e52');
    g.addColorStop(1.0, '#212226');
    c.fillStyle = g; c.fillRect(-S, -S, S * 2, S * 2.5);
    c.restore();
    // Multiply can only darken — SCREEN the pool core back up so the light
    // pool reads like a flagged studio light while the tar grain survives.
    c.globalCompositeOperation = 'screen';
    c.save(); c.translate(S / 2, S * 0.445); c.scale(1, 0.8);
    const sh = c.createRadialGradient(0, 0, 0, 0, 0, S * 0.34);
    sh.addColorStop(0.0, 'rgba(142,150,162,0.26)');
    sh.addColorStop(0.5, 'rgba(90,96,106,0.12)');
    sh.addColorStop(1.0, 'rgba(0,0,0,0)');
    c.fillStyle = sh; c.fillRect(-S, -S, S * 2, S * 2.5);
    c.restore();
    c.globalCompositeOperation = 'source-over';
  };
  // Instant placeholder (flat charcoal + pool) — swapped for the tar composite
  // the moment the texture decodes.
  floorCtx.fillStyle = '#3a3d41'; floorCtx.fillRect(0, 0, FS, FS);
  drawPool(floorCtx, FS);
  const floorTex = new THREE.CanvasTexture(floorCan);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tar = new Image();
  // Phase 66: the tar textures (8.5 MB) are fetched only when a legacy product is first shown — production products
  // stand on their own plain floor (product-stage.js). The legacy floor looks exactly as before once they arrive.
  let legacyFloorRequested = false;
  const requestLegacyFloor = () => {
    if (legacyFloorRequested) return; legacyFloorRequested = true;
    tar.src = 'textures/asphalt_pit_lane_diff_2k.jpg?v=1';
    const norTex = new THREE.TextureLoader().load('textures/asphalt_pit_lane_nor_gl_2k.jpg?v=1', () => { floor.material.normalMap = norTex; floor.material.needsUpdate = true; });
    norTex.wrapS = norTex.wrapT = THREE.RepeatWrapping; norTex.repeat.set(8, 8);
    norTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  };
  tar.onload = () => {
    const T = FS / 8;                                   // 8×8 tiles ≈ 4 m of tar per tile
    floorCtx.filter = 'saturate(0.22) brightness(0.68) contrast(1.06)';
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) floorCtx.drawImage(tar, i * T, j * T, T, T);
    // Second pass at a different scale, whole layer rotated 90°: breaks the
    // tile repetition without breaking any seams (both layers tile cleanly).
    floorCtx.save();
    floorCtx.globalAlpha = 0.4;
    floorCtx.translate(FS / 2, FS / 2); floorCtx.rotate(Math.PI / 2); floorCtx.translate(-FS / 2, -FS / 2);
    const T2 = FS / 5;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) floorCtx.drawImage(tar, i * T2, j * T2, T2, T2);
    floorCtx.restore();
    floorCtx.filter = 'none';
    drawPool(floorCtx, FS);
    floorTex.needsUpdate = true;
  };
  const fadeCan = document.createElement('canvas'); fadeCan.width = fadeCan.height = 256;
  { const c = fadeCan.getContext('2d');
    c.fillStyle = '#000000'; c.fillRect(0, 0, 256, 256);
    c.save(); c.translate(128, 114); c.scale(1, 0.8);    // ellipse, matching the pool
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 120);
    g.addColorStop(0.0, '#ffffff');
    g.addColorStop(0.55, '#e2e2e2');
    g.addColorStop(0.85, '#4a4a4a');
    g.addColorStop(1.0, '#000000');
    c.fillStyle = g; c.fillRect(-200, -220, 420, 460);
    c.restore(); }
  const fadeTex = new THREE.CanvasTexture(fadeCan);
  // Lit tar with real relief: the aggregate normal map (tiled to match the
  // baked diffuse tiles) lets the key + softboxes catch the stone tips — attached
  // by requestLegacyFloor() when it has loaded.
  // Roughness ~0.95 kills the grazing specular wash that plagued the earlier
  // lit floor; the dark composited albedo keeps overall levels in check.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(16, 64),
    new THREE.MeshStandardMaterial({
      map: floorTex, normalMap: null, normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.95, metalness: 0.0, envMapIntensity: 0.25,
      alphaMap: fadeTex, transparent: true,
    })
  );
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.012; floor.renderOrder = -10; scene.add(floor);
  const LEGACY_FLOOR_Y = floor.position.y;   // production products sit the floor on their own contact plane (Phase 19)
  let floorOcc = null;                        // remover of the current product's ground occlusion (floor aoMap)
  const shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.ShadowMaterial({ opacity: 0.48 }));
  shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.receiveShadow = true; shadowCatcher.renderOrder = -8; scene.add(shadowCatcher);

  // Backdrop dome: not-quite-black room with a 2–3% glow band just above the
  // horizon behind the model — the depth "breath" in the Ducati reference.
  const domeCan = document.createElement('canvas'); domeCan.width = 4; domeCan.height = 512;
  { const c = domeCan.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0.0, '#000000');
    g.addColorStop(0.34, '#000000');
    g.addColorStop(0.41, '#030304');
    g.addColorStop(0.47, '#08090b');   // subtle lift just above the floor line
    g.addColorStop(0.53, '#040405');
    g.addColorStop(0.62, '#000000');
    g.addColorStop(1.0, '#000000');
    c.fillStyle = g; c.fillRect(0, 0, 4, 512); }
  const domeTex = new THREE.CanvasTexture(domeCan); domeTex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(26, 32, 24),
    new THREE.MeshBasicMaterial({ map: domeTex, side: THREE.BackSide, depthWrite: false, toneMapped: false })
  );
  dome.renderOrder = -20; scene.add(dome);
  // Stage per product type: production assets get the Phase 19 presentation background, legacy the dark set.
  const STAGE = { dome, floor, base: { domeMap: dome.material.map, floorColor: floor.material.color.clone() } };
  // Production ground (Phase 20): the same floor as its own mesh (shared geometry + textures) with the
  // horizon hand-over into the backdrop. Legacy products keep `floor` exactly.
  const stageFloor = createStageFloor(floor); stageFloor.visible = false; scene.add(stageFloor);

  // Static film grain over the stage — unifies the render and kills banding
  // in the dark gradients (DOM overlay, beneath the callouts).
  { const n = document.createElement('canvas'); n.width = n.height = 128;
    const nx = n.getContext('2d');
    const id = nx.createImageData(128, 128);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = (105 + Math.random() * 70) | 0;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255;
    }
    nx.putImageData(id, 0, 0);
    const grain = document.createElement('div');
    grain.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:5;opacity:.05;mix-blend-mode:overlay;background-image:url(${n.toDataURL()});background-size:128px;`;
    wrap.appendChild(grain); }

  cutPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 100);

  const root = new THREE.Group(); scene.add(root);
  V = { renderer, scene, camera, controls, root, loaded: false, pr, ao, post, floor, dome, stageFloor, aoTargets: null, renderAO, renderFrame, pcam, stage: STAGE, stageState: null, legacyCam: LEGACY_CAM };
  window.__dv = V;

  // Per-product models. Each GLB is loaded once and kept in the scene; opening a
  // product just toggles which one is visible, so there is no teardown to get wrong.
  const loaderEl = document.getElementById('drawer-viewer-loading');
  V.models = Object.create(null);
  V.url = null;
  function frameRecord(r) {
    if (!r || !r.bbox) return;
    if (r.production && r.hulls) { pcam.snap(pcam.framing('full')); return; }
    const f = r.studio && r.studioFrame ? fitStudio(r.studioFrame) : fitBox(r.bbox, legacyFill());
    movedSinceFrame = false;
    V.camera.position.copy(f.pos);
    V.controls.target.copy(f.tgt);
    V.controls.update();
  }
  V.frameRecord = frameRecord;
  // Which view modes the CURRENT product supports.
  function caps() {
    const r = V.models[V.url];
    if (!r) return { url: V.url, system: false, gun: false, cutaway: false, nozzles: false };
    // Phase 66: a mode is offered only when the product configuration declares it (viewer.presentation.modes; products
    // without a declaration keep the model's own capabilities) AND the model can actually show it.
    const d = PRESENTATION[V.url] && PRESENTATION[V.url].modes, allow = k => !d || d[k] !== false;
    return { url: V.url, system: !!r.hasCarrier && allow('system'), gun: !!r.hasGun && allow('gun'), cutaway: !!r.hasCut && allow('cutaway'), nozzles: !!r.hasNozzles,
             foam: !!(r.hasGun && ((r.gunRig && r.gunRig.spray) || gunRigOf(r))) && allow('gun'),   // Phase 80: the spray toggle only where a spray rig exists
             gunActivate: !!(r.hasGun && gunRigOf(r)) && allow('gun') };                         // Phase 82: production cannon -> "Activate system"
  }
  function showOnly(url) {
    for (const k in V.models) {
      const r = V.models[k], on = (k === url);
      r.group.visible = on;
      if (r.aoBlob) r.aoBlob.visible = on && !r.studio;
      if (r.cylGlow) r.cylGlow.visible = on;
      // The cannon lives in scene-space pivots, outside the model group.
      if (r.gunRig) r.gunRig.aimYaw.visible = on;
    }
    const r = V.models[url];
    if (!r) return;
    V.truckMeshes = r.truckMeshes; V.allRig = r.allRig;
    V.cylFocal = r.cylFocal; cylGlow = r.cylGlow || null;
    // Renderer profile for this product: production assets get the PBR foundation,
    // legacy GLBs keep the synthetic studio their MAT_PRESETS were tuned under.
    const pbrStage = !!(r.production || r.studio);
    pr.useProfile(RENDER_CONFIG.productProfile[pbrStage ? 'production' : 'legacy'], { box: r.bbox, contactShadow: r.aoBlob, casters: pbrStage ? r.group : null })
      .catch(err => console.error('[drawer-viewer] renderer profile failed', err));
    ao.setBox(r.bbox);
    cutStart = r.cutStart; cutConst = r.cutConst;
    aimYaw = r.gunRig ? r.gunRig.aimYaw : null;
    aimPitch = r.gunRig ? r.gunRig.aimPitch : null;
    spray = r.gunRig ? r.gunRig.spray : null;
    systemOn = false;                    // every product swap starts un-discharged
    buildCallouts(r.anchors);            // empty list clears the 4CU's callouts
    V.url = url; V.loaded = true;
    if (floorOcc) { floorOcc(); floorOcc = null; }
    if (r.production && r.hulls) {
      pcam.setProduct(r.hulls);
      floor.visible = false; stageFloor.visible = true; V.floor = stageFloor;
      const g = r.hulls.full; stageFloor.position.y = floorY(g.box.min.y, g.height);
      // Phase 67: the shadow catcher stays just above the stage floor. A product whose hull starts a hair above y = 0 (the
      // Phase 67 Skiddy / 4CU: +0.002) lifts the floor over the catcher at y = 0 and hides the key-light shadow; floors below
      // y = -0.001 (every product before Phase 67) keep the catcher at 0, unchanged.
      shadowCatcher.position.y = Math.max(0, stageFloor.position.y + 0.001);
      if (r.groundOcc) floorOcc = applyGroundOcclusion(stageFloor, r.groundOcc, floor.geometry.parameters.radius);
      V.stageState = { background: applyBackground({ ...STAGE, floor: stageFloor }, STAGE_CONFIG.background), floorY: stageFloor.position.y, contact: r.groundOcc ? 'occlusion' : 'none', environment: 'horizon' };
    } else if (r.studio) {
      // the production studio for a legacy GLB: stage floor + Inferno background + its own baked ground occlusion
      floor.visible = false; stageFloor.visible = true; V.floor = stageFloor;
      stageFloor.position.y = floorY(r.bbox.min.y, r.bbox.max.y - r.bbox.min.y);
      shadowCatcher.position.y = Math.max(0, stageFloor.position.y + 0.001);
      if (r.groundOcc) floorOcc = applyGroundOcclusion(stageFloor, r.groundOcc, floor.geometry.parameters.radius);
      V.stageState = { background: applyBackground({ ...STAGE, floor: stageFloor }, STAGE_CONFIG.background), floorY: stageFloor.position.y, contact: r.groundOcc ? 'occlusion' : 'none', environment: 'horizon' };
      pcam.clear();
      Object.assign(controls, { minDistance: LEGACY_CAM.minDistance, maxDistance: LEGACY_CAM.maxDistance, minPolarAngle: LEGACY_CAM.minPolarAngle, maxPolarAngle: LEGACY_CAM.maxPolarAngle, dampingFactor: LEGACY_CAM.dampingFactor });
      if (camera.near !== LEGACY_CAM.near || camera.far !== LEGACY_CAM.far) { camera.near = LEGACY_CAM.near; camera.far = LEGACY_CAM.far; camera.updateProjectionMatrix(); }
    } else {
      requestLegacyFloor();
      stageFloor.visible = false; floor.visible = true; V.floor = floor;
      floor.position.y = LEGACY_FLOOR_Y; shadowCatcher.position.y = 0;
      V.stageState = { background: applyBackground(STAGE, 'dark'), floorY: floor.position.y, contact: 'disc', environment: 'legacy' };
      pcam.clear();
      Object.assign(controls, { minDistance: LEGACY_CAM.minDistance, maxDistance: LEGACY_CAM.maxDistance, minPolarAngle: LEGACY_CAM.minPolarAngle, maxPolarAngle: LEGACY_CAM.maxPolarAngle, dampingFactor: LEGACY_CAM.dampingFactor });
      if (camera.near !== LEGACY_CAM.near || camera.far !== LEGACY_CAM.far) { camera.near = LEGACY_CAM.near; camera.far = LEGACY_CAM.far; camera.updateProjectionMatrix(); }
    }
    V.aoTargets = [r.group, V.floor];             // AO sees this product and the floor it stands on
    // Size the camera to the canvas BEFORE fitting: the fit solves against the
    // aspect ratio, so framing on a stale aspect crops the product.
    resize();
    frameRecord(r);                      // fit the product to the frame on every swap
    V.renderer.shadowMap.needsUpdate = true;
    if (loaderEl) loaderEl.classList.add('is-hidden');
    // Tell the page which tabs this product can actually show. Fires on every
    // swap, including cached ones, so the mode bar always matches the model.
    const stageEl = document.getElementById('drawer-stage-3d');
    if (stageEl) { const c = caps(); V.capsKey = JSON.stringify(c); stageEl.dispatchEvent(new CustomEvent('dv:ready', { bubbles: true, detail: c })); }
  }
  V.showOnly = showOnly;
  V.caps = caps;
  // A model that could not be loaded, for page UI that shows its own loading state (Phase 23).
  const loadFailed = (url) => { const s = document.getElementById('drawer-stage-3d'); if (s) s.dispatchEvent(new CustomEvent('dv:error', { bubbles: true, detail: { url } })); };
  const _draco = new DRACOLoader();
  _draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
  const _gltf = new GLTFLoader(); _gltf.setDRACOLoader(_draco);

  // ── Production asset path (Phase 12 split glTF: rig + LODs + shared KTX2) ───
  // The imported materials are AUTHORITATIVE: no clone, no MAT_PRESETS, no
  // toPhysical(). Only renderer-side settings are touched (shadows, anisotropy).
  // Roles come from the exported hierarchy (LODn_Vehicle / LODn_FireSuppression),
  // not from name heuristics.
  // LODs share their materials: existing records are kept, and a newly loaded LOD's mesh takes the
  // un-faded values (and fade state) of the material it shares, so a LOD switch during a Full ⇄ System
  // fade can never record a faded opacity as the original (Phase 21).
  function productionRoles(asset, prev = { veh: [], fs: [] }) {
    const truck = [], rig = [], byMesh = new Map(), byMat = { veh: new Map(), fs: new Map() };
    for (const k of ['veh', 'fs']) for (const r of prev[k]) { byMesh.set(r.mesh, r); if (!byMat[k].has(r.mat)) byMat[k].set(r.mat, r); }
    const cut = asset.manifest && asset.manifest.cutaway, hostRe = cut && cut.hostGroups && cut.hostGroups.length ? new RegExp(`^LOD\\d_(${cut.hostGroups.join('|')})$`) : null;
    const gun = asset.manifest && asset.manifest.gun, gunRe = gun && gun.groups && gun.groups.length ? new RegExp(`^LOD\\d_(${gun.groups.join('|')})$`) : null;   // Phase 80
    asset.root.traverse(n => {
      if (!n.isMesh || !n.material || n.userData.pvOverlay) return;   // component highlight overlays (Phase 25) are not product meshes
      let p = n, sys = null, host = false, isGun = false;
      while (p && !sys) { if (hostRe && hostRe.test(p.name)) host = true; if (gunRe && gunRe.test(p.name)) isGun = true; if (/^LOD\d_Vehicle$/.test(p.name)) sys = 'veh'; else if (/^LOD\d_FireSuppression$/.test(p.name)) sys = 'fs'; p = p.parent; }
      const m = sys && byMat[sys].get(n.material);
      const rec = byMesh.get(n) || (m ? { mesh: n, mat: n.material, o0: m.o0, t0: m.t0, d0: m.d0, c0: n.castShadow, on: m.on }
        : { mesh: n, mat: n.material, o0: (n.material.opacity ?? 1), t0: !!n.material.transparent, d0: (n.material.depthWrite !== false), c0: n.castShadow, on: false });
      if (sys === 'veh') truck.push(rec);
      else if (sys === 'fs') { rec.isFocus = false; rec.isGun = isGun; rec.isCutHost = host; rig.push(rec); }
    });
    // the host fades by its materials: the asset gives it materials of its own (Phase 67 export), never shared with a mesh that stays
    const hostMats = new Set(rig.filter(r => r.isCutHost).map(r => r.mat));
    if (hostMats.size && [...truck, ...rig].some(r => !r.isCutHost && hostMats.has(r.mat))) console.warn('[drawer-viewer] cutaway host shares a material with a mesh that stays visible');
    return { truck, rig };
  }
  function productionPrepare(asset) {
    pr.applyShadowPolicy(asset.root);           // receive everywhere; transmissive glazing does not cast
    for (const t of asset.textures()) if (t.anisotropy !== maxAniso) { t.anisotropy = maxAniso; t.needsUpdate = true; }
  }
  function refreshProductionRoles(url) {
    const r = V.models[url]; if (!r || !r.production) return;
    const { truck, rig } = productionRoles(r.production, { veh: r.truckMeshes, fs: r.allRig });
    r.truckMeshes = truck; r.allRig = rig;
    if (r.ghosts) syncGhosts(r);                  // Phase 66: ghosts follow the carrier meshes of the loaded levels
    if (V.url === url) { V.truckMeshes = truck; V.allRig = rig; V.pr.refitShadow(); }   // caster set changed (LOD)
    if (V.url === url) { if (HL.names.length) buildHighlight(); const st = document.getElementById('drawer-stage-3d'); if (st) st.dispatchEvent(new CustomEvent('dv:lod', { bubbles: true, detail: { url, lod: r.production.activeLOD } })); }
    V.renderer.shadowMap.needsUpdate = true;
  }
  V.refreshProductionRoles = refreshProductionRoles;
  // GPU preparation of a loaded LOD (Phase 22 §5): each call renders one chunk of its meshes — real scene, lights and
  // materials, shadows untouched — into a 1×1 target, so its buffers and vertex arrays exist before the switch and no
  // program is compiled. Every visibility flag is restored before returning; nothing of this reaches the screen.
  V.prepareLOD = (r, n) => {
    const a = r.production, sc = a.lods.get(n).scene;
    if (!r.lodPrep || r.lodPrep.n !== n) { const meshes = []; sc.traverse(o => { if (o.isMesh) meshes.push(o); }); r.lodPrep = { n, meshes, i: 0 }; }
    const P = r.lodPrep, chunk = new Set(); let bytes = 0;
    while (P.i < P.meshes.length && (bytes < LOD_CONFIG.prepareBytes || !chunk.size)) { const m = P.meshes[P.i++]; chunk.add(m); bytes += geometryBytes(m.geometry); }
    const saved = [[sc, 'visible', sc.visible]];
    scene.traverse(o => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.visible && !chunk.has(o)) { saved.push([o, 'visible', true]); o.visible = false; } });
    sc.visible = true;
    for (const m of chunk) { saved.push([m, 'visible', m.visible], [m, 'frustumCulled', m.frustumCulled]); m.visible = true; m.frustumCulled = false; }
    if (!V.prepRT) V.prepRT = new THREE.WebGLRenderTarget(1, 1);
    const sm = renderer.shadowMap.needsUpdate, target = renderer.getRenderTarget();
    renderer.shadowMap.needsUpdate = false; renderer.setRenderTarget(V.prepRT); renderer.render(scene, camera); renderer.setRenderTarget(target);
    renderer.shadowMap.needsUpdate = sm;
    for (let i = saved.length - 1; i >= 0; i--) saved[i][0][saved[i][1]] = saved[i][2];
    if (P.i >= P.meshes.length) { r.lodGpu.add(n); r.lodPrep = null; }
  };
  // On-demand LOD load (Phase 21). The new LOD stays hidden until the selector shows it; if the product
  // was closed or swapped meanwhile, the LOD is released again. Phase 22: the download is abortable.
  V.requestLOD = (url, n) => {
    const r = V.models[url], a = r && r.production;
    if (!a || r.lodLoading || a.lods.has(n)) return;
    const t0 = performance.now(), ctl = new AbortController();
    r.lodAbort = ctl; r.lodLoadingN = n;
    r.lodLoading = a.loadLOD(n, ctl.signal).then(() => {
      a.showLOD(a.activeLOD);
      if (V.models[url] !== r) { a.unloadLOD(n); return; }
      productionPrepare(a);
      r.lodLog.push({ lod: n, ms: Math.round(performance.now() - t0) });
    }).catch(err => { if (err.name !== 'AbortError') console.error('[drawer-viewer] LOD load failed', n, err); else r.lodLog.push({ lod: n, aborted: Math.round(performance.now() - t0) }); })
      .finally(() => { r.lodLoading = null; r.lodAbort = null; r.lodLoadingN = null; });
  };
  // Initial LOD before any geometry exists (Phase 21 §8): frame the manifest's bounding box the way the
  // product camera frames the product and take its projected size, scaled by boundsToHull.
  function predictLOD(manifest) {
    const ws = manifest.worldSizeM; if (!ws) return LOD_CONFIG.coarsest;
    const k = 3.4 / Math.max(...ws), size = [ws[0] * k, ws[2] * k, ws[1] * k];   // metres (Blender X, Y, Z) → viewer x, y (up), z
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]).translate(0, size[1] / 2, 0);
    const hull = buildHull({ meshes: [new THREE.Mesh(geo)], stride: 1 }); geo.dispose();
    const pc = new ProductCamera(camera, { addEventListener() {} }); pc.setProduct({ full: hull });
    const R = Math.hypot(...size) / 2, d = Math.max(pc.framing('full').position.distanceTo(new THREE.Vector3(0, size[1] / 2, 0)), R);
    const s = R * renderer.domElement.height / (Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * d) * LOD_CONFIG.boundsToHull;
    return wantedLOD(s, null);
  }
  V.prodToken = 0;
  async function loadProduction(url) {
    const token = ++V.prodToken;
    V.loadingUrl = url;                      // until it is shown (a context restore restarts a load in flight)
    const t0 = performance.now();
    if (loaderEl) { loaderEl.classList.remove('is-hidden'); loaderEl.textContent = 'Loading model…'; }
    const asset = new ProductionAsset(url, renderer);
    try {
      await asset.init();
      const L = LOD_CONFIG.initial === 'view' ? predictLOD(asset.manifest) : (LOD_CONFIG.initial ?? asset.manifest.defaultLOD ?? 0);
      await Promise.all([asset.loadRig(), asset.loadLOD(L), pr.prepare(RENDER_CONFIG.productProfile.production)]);
      asset.showLOD(L);
      if (token !== V.prodToken) { asset.dispose(); return; }      // closed / swapped while loading
      const model = asset.root;
      productionPrepare(asset);
      // Same normalisation as every other product: 3.4-unit box, turned to face us.
      model.updateMatrixWorld(true);
      const probe = new THREE.Box3().setFromObject(asset.lods.get(L).scene);
      const size = new THREE.Vector3(); probe.getSize(size);
      model.scale.setScalar(3.4 / Math.max(size.x, size.y, size.z));
      model.rotation.y = Math.PI + (asset.manifest.viewerYaw || 0);   // the product's turn is manifest data (Phase 31)
      model.updateMatrixWorld(true);
      const nb = new THREE.Box3().setFromObject(asset.lods.get(L).scene);
      model.position.x -= (nb.min.x + nb.max.x) / 2;
      model.position.z -= (nb.min.z + nb.max.z) / 2;
      model.position.y -= nb.min.y;
      model.updateMatrixWorld(true);
      root.add(model);

      const fp = new THREE.Box3().setFromObject(asset.lods.get(L).scene);
      const aoCan = document.createElement('canvas'); aoCan.width = aoCan.height = 256;
      { const c = aoCan.getContext('2d');
        const g = c.createRadialGradient(128, 128, 0, 128, 128, 128);
        g.addColorStop(0, 'rgba(0,0,0,0.6)'); g.addColorStop(0.55, 'rgba(0,0,0,0.32)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(0, 0, 256, 256); }
      const aoBlob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(aoCan), transparent: true, depthWrite: false }));
      aoBlob.rotation.x = -Math.PI / 2; aoBlob.position.y = 0.0015; aoBlob.renderOrder = -9;
      aoBlob.scale.set((fp.max.x - fp.min.x) * 1.06, (fp.max.z - fp.min.z) * 1.18, 1);
      aoBlob.position.x = (fp.min.x + fp.max.x) / 2; aoBlob.position.z = (fp.min.z + fp.max.z) / 2;
      scene.add(aoBlob);
      V.aoBlob = aoBlob;                  // same convention as the legacy path

      const { truck, rig } = productionRoles(asset);
      // Convex hulls for the product camera: exact silhouette extents + a watertight outside.
      const tH = performance.now();
      const hulls = { full: buildHull({ root: asset.lods.get(L).scene }), system: buildHull({ meshes: rig.map(r => r.mesh) }) };
      const tO = performance.now();
      // Ground occlusion of the floor's ambient light by the product above it (Phase 19 §10).
      let groundOcc = null;
      if (STAGE_CONFIG.contact === 'occlusion') { const ms = []; asset.lods.get(L).scene.traverse(o => { if (o.isMesh) ms.push(o); }); groundOcc = bakeGroundOcclusion(renderer, ms, { groundY: hulls.full.box.min.y, box: fp }); }
      const stageMs = { hull: Math.round(tO - tH), groundOcclusion: Math.round(performance.now() - tO) };
      const sysBox = new THREE.Box3();
      for (const r of rig) sysBox.expandByObject(r.mesh);
      if (sysBox.isEmpty()) sysBox.copy(fp);
      const frames = { rig: sysBox.getCenter(new THREE.Vector3()), gun: null,
        sysRadius: sysBox.getSize(new THREE.Vector3()).length() * 0.5, gunRadius: 0.45, cutRadius: 1, sysBox: sysBox.clone() };
      const nozzles = [...asset.nozzles.values()].map(z => z.anchor);
      const disc = asset.manifest.discharge;                                   // Phase 82j
      const mist = buildMist(nozzles, Math.max(0.001, fp.getSize(new THREE.Vector3()).length() * 0.55), disc && disc.hits, asset.lods.get(L).scene.matrixWorld);
      V.models[url] = { group: model, aoBlob, cylGlow: null, cylFocal: null, bbox: fp.clone(),
                        truckMeshes: truck, allRig: rig, anchors: [], gunRig: null, frames,
                        nozzles, mist, hasNozzles: nozzles.length > 0,
                        hasGun: !!(asset.manifest.gun && asset.manifest.gun.focusFeatures && asset.manifest.gun.focusFeatures.length), hasCut: !!(asset.manifest.cutaway && asset.manifest.cutaway.gltf), hasCarrier: truck.length > 0, authored: false,
                        cutStart: fp.max.x + 0.35, cutConst: 0, production: asset, hulls, groundOcc,
                        loadMs: Math.round(performance.now() - t0), stageMs,
                        lodWant: null, lodPx: null, lodLoading: null, lodLog: [{ lod: L, ms: Math.round(performance.now() - t0) }],
                        lodGpu: new Set([L]), lodPrep: null, lodT: null, lodZD: null, lodRateT: 0, lodAbort: null, lodLoadingN: null };
      V.renderer.shadowMap.needsUpdate = true;
      showOnly(url);
    } catch (err) {
      console.error('[drawer-viewer] production asset failed', url, err);
      asset.dispose();
      if (loaderEl) loaderEl.textContent = 'Model unavailable';
      if (token === V.prodToken) loadFailed(url);
    } finally {
      if (token === V.prodToken) V.loadingUrl = null;
    }
  }
  // Free every GPU resource of a production record (geometry, shared materials and
  // KTX2 textures via the asset's reference counts, the mist and the AO pool).
  function releaseProduction(url) {
    const r = V.models[url]; if (!r || !r.production) return;
    if (r.lodAbort) r.lodAbort.abort();          // stop an on-demand LOD download (Phase 22)
    if (r.mist) { V.scene.remove(r.mist.points); r.mist.points.geometry.dispose(); r.mist.points.material.dispose(); }
    if (r.aoBlob) { V.scene.remove(r.aoBlob); r.aoBlob.geometry.dispose(); r.aoBlob.material.map.dispose(); r.aoBlob.material.dispose(); }
    if (V.url === url && floorOcc) { floorOcc(); floorOcc = null; }
    if (r.groundOcc) r.groundOcc.texture.dispose();
    r.production.dispose();
    delete V.models[url];
    if (V.aoBlob === r.aoBlob) V.aoBlob = null;
    if (V.url === url) { V.url = null; V.loaded = false; V.truckMeshes = []; V.allRig = []; pcam.clear(); }
  }
  V.releaseProduction = () => { ++V.prodToken; V.loadingUrl = null; for (const k of Object.keys(V.models)) releaseProduction(k); };
  // WebGL context restore (Phase 34). three re-uploads whatever still has CPU data; render-target contents are gone and
  // production textures keep no CPU copy after their upload. So the environment is rebuilt from the kept HDR data and
  // the open production product, or one still loading, is reloaded (textures from the HTTP cache, ground occlusion
  // re-baked, shadow re-rendered) through a fresh texture transcoder: one configured while the context was lost would
  // decode to RGBA32. The visitor's view survives the reload: camera pose, mode framing, discharge, component highlight.
  canvas.addEventListener('webglcontextrestored', async () => {
    pr.contextRestored().catch(err => console.error('[drawer-viewer] environment rebuild failed', err));
    const r = V.url && V.models[V.url], shown = !!(r && r.production);
    const url = shown ? V.url : V.loadingUrl;
    const view = shown ? { mode: pcam.mode || 'full', target: controls.target.clone(), position: camera.position.clone(), pristine: pcam.pristine, systemOn } : null;
    if (url) V.releaseProduction();                          // also abandons a load in flight
    resetTextureLoader();
    if (!url) return;
    await loadProduction(url);
    if (!view || V.url !== url || !V.models[url]) return;   // nothing to restore, or closed / swapped meanwhile
    pcam.snap({ ...pcam.framing(view.mode), target: view.target, position: view.position, distance: view.position.distanceTo(view.target) });
    pcam.pristine = view.pristine; systemOn = view.systemOn;
    if (HL.names.length) buildHighlight();
  });

  V.loadUrl = function (url) {
    if (V.models[url]) { showOnly(url); return; }
    if (/\.asset\.json(\?|$)/.test(url)) { loadProduction(url); return; }
    if (loaderEl) { loaderEl.classList.remove('is-hidden'); loaderEl.textContent = 'Loading model…'; }
    _gltf.load(url, (gltf) => {
    const model = gltf.scene;
    const studio = STUDIO_GLB.test(url);
    model.updateMatrixWorld(true);
    // Baked-in cavity/edge-wear vertex colours (see export_vss_web.py) — turn
    // them on per-mesh, only where the geometry actually carries the
    // attribute, so a model without it (the hand-authored Attac units) is
    // untouched. Multiplies straight into the base colour, once, at load.
    model.traverse(n => {
      if (n.isMesh && n.geometry && n.geometry.hasAttribute('color')) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        for (const m of mats) if (m) m.vertexColors = true;
        // Blender's baked dirt map is deliberately mild (0.42..1.0) so it never
        // clips; push the contrast up here, once, so creases read as real grime
        // instead of a faint tint. (2.0, 0.5) sends the 0.42 floor to ~0.18.
        const c = n.geometry.attributes.color;
        const CONTRAST = 2.0, PIVOT = 0.5;
        for (let i = 0; i < c.count; i++) {
          for (let k = 0; k < 3; k++) {
            const v = c.getComponent(i, k);
            c.setComponent(i, k, Math.min(1, Math.max(0, (v - PIVOT) * CONTRAST + PIVOT)));
          }
        }
        c.needsUpdate = true;
      }
    });
    const probe = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); probe.getSize(size);
    model.scale.setScalar(3.4 / Math.max(size.x, size.y, size.z));
    // Rotate FIRST, then centre. Centring before the 180 deg turn pivots the model about its
    // own origin and throws it back off-centre by twice its local centroid.
    model.rotation.y = Math.PI;
    // CAD exports do not agree on which way is forward. A per-product nudge
    // lands the default three-quarter view on the product's FRONT.
    for (const [re, extra] of FRONT_YAW) if (re.test(url)) model.rotation.y += extra;
    model.updateMatrixWorld(true);
    const nb = new THREE.Box3().setFromObject(model);
    model.position.x -= (nb.min.x + nb.max.x) / 2;
    model.position.z -= (nb.min.z + nb.max.z) / 2;
    model.position.y -= nb.min.y;
    model.updateMatrixWorld(true);

    const norm = normName;   // shared role matcher (tolerates .001 / case / separators)
    let mainGroup = null, rotoGroup = null, systemGroup = null, systemPivot = null, pickupGroup = null, baseGroup = null;
    model.traverse(n => {
      const m = norm(n.name);
      if (m === 'main' && !mainGroup) mainGroup = n;
      else if (m === 'roto' && !rotoGroup) rotoGroup = n;
      else if (m === 'system' && !systemGroup) systemGroup = n;
      else if (m === 'systempivot' && !systemPivot) systemPivot = n;
      else if (m === 'pickupfull' && !pickupGroup) pickupGroup = n;
      else if (m === 'baseplate' && !baseGroup) baseGroup = n;
    });
    const isDesc = (node, anc) => { if (!anc) return false; let p = node; while (p) { if (p === anc) return true; p = p.parent; } return false; };
    const hasMeshes = n => { let c = 0; if (n) n.traverse(x => { if (x.isMesh) c++; }); return c > 0; };
    // A fresh showroom export also carries EMPTY `main` / `System` leftovers
    // that sit in the vehicle branch and hold no geometry at all. Trusting them
    // puts the entire rig in the carrier, so an empty role name counts for
    // nothing and we fall through to the structural resolution below.
    if (!hasMeshes(mainGroup)) mainGroup = null;
    if (!hasMeshes(systemGroup)) systemGroup = null;

    // ── Role resolution ────────────────────────────────────────────────────
    // The hand-authored 4CU carries explicit role names (main / System /
    // Base_Plate). The showroom exports do not — they keep the CAD naming — so
    // fall back to structure, which every product shares: `Cylinder_1` is the
    // pressure vessel, the branch holding it is the suppression system, and its
    // sibling branches are the carrier (trailer chassis, trolley, bed frame).
    let cylNode = null;
    model.traverse(n => { if (!cylNode && norm(n.name) === 'cylinder1') cylNode = n; });
    const mainRoots = [];
    if (mainGroup) mainRoots.push(mainGroup);
    else if (cylNode) {
      mainRoots.push(cylNode);
      // The foam column and dome sit BESIDE the vessel in the CAD trees, not
      // inside it — without them the cutaway would open onto an empty shell.
      // Only the un-suffixed ones: _C2/_C3/_C4 belong to the other cylinders.
      if (cylNode.parent) for (const c of cylNode.parent.children) {
        const m = norm(c.name);
        if (m === 'foamliquid' || m === 'foamhead' || m === 'labelcylinder1') mainRoots.push(c);
      }
    }
    // A `System` empty also survives deep inside the imported CAD assembly, well
    // below the rig. Only trust the name when that node actually contains the
    // vessel; otherwise fall through to the structural climb.
    if (systemGroup && mainRoots.length && !isDesc(mainRoots[0], systemGroup)) systemGroup = null;
    if (!systemGroup && mainRoots.length) {
      // Climb from the vessel to the branch that hangs directly off the product
      // root: that whole branch is the rig, its siblings are the carrier.
      let branch = mainRoots[0], p = branch;
      while (p.parent && p.parent !== model) { branch = p; p = p.parent; }
      systemGroup = branch;
    }
    const isDescAny = (node, list) => { for (const a of list) if (isDesc(node, a)) return true; return false; };
    const inMain = n => isDescAny(n, mainRoots);
    // Base_Plate is the truck-bed mounting platform → it hides WITH the truck
    // (system/gun/cutaway), not with the suppression rig.
    const inBase = n => isDesc(n, baseGroup);

    // The carrier is the VEHICLE, and the one thing every carrier has is wheels
    // — bakkie, trailer, trolley alike. Find the branch they sit in and call
    // everything else the system. Deriving it the other way round, from the
    // cylinder's ancestry, put the 2CU's mounting frame and hose reel on the
    // truck's side of the line, so SYSTEM left the cylinders hanging in mid-air.
    let productRoot = model;
    while (productRoot.children.length === 1 && !productRoot.children[0].isMesh) productRoot = productRoot.children[0];
    const carrierRoots = [];
    for (const b of productRoot.children) {
      let wheels = 0;
      b.traverse(n => { if (n.isMesh && /wheel|tyre|tire/i.test(n.name)) wheels++; });
      if (wheels) carrierRoots.push(b);
    }
    // Lamps and number plates are hung directly off the product root rather than
    // inside the vehicle branch, so the wheel test misses them and they were
    // left floating in mid-air once the truck was hidden. They are vehicle trim,
    // never rig — no suppression part is named anything like this.
    const CARRIER_TRIM = /headlight|headlamp|taillight|rearlight|blinker|plate_art|plate_holder|numberplate/i;
    const inCarrier = n => isDescAny(n, carrierRoots) || CARRIER_TRIM.test(n.name);
    const inSystem = carrierRoots.length
      ? (n => !inBase(n) && !inCarrier(n))
      : (n => !inBase(n) && (inMain(n) || isDesc(n, rotoGroup) || isDesc(n, systemGroup) || isDesc(n, systemPivot)));
    const inFocus = n => inMain(n) || isDesc(n, rotoGroup);

    let liquidSrc = null, modelGlow = null, modelFocal = null;
    model.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      node.castShadow = true; node.receiveShadow = true;
      if (Array.isArray(node.material)) return;
      let mt = node.material.clone();
      const nm = node.name || '';
      const steel = /handel|handle|hendel|nozel|nozzle|valve|outlet|lever|gauge|spout|hex|bolt|kraan|kop|cap(?!sule)/i.test(nm);
      // PBR upgrade by component role (node OR material name). Keeps every
      // map (the baked wrap, froth bake…) — only the response model improves.
      const kind = matKind(nm + '|' + (mt.name || ''), steel);
      if (kind && !studio) mt = toPhysical(mt, kind);   // studio GLBs: their own authored materials
      // Anisotropic filtering. Without it every map samples at 1x, and a vehicle
      // flank seen at a glancing angle — which is most of the time — smears the
      // wrap into mush no matter how sharp the texture is. The showroom hero has
      // always set this; the drawer never did, and that was the "blurry artwork".
      for (const k of MAP_KEYS) {
        const t = mt[k];
        if (t && t.anisotropy !== maxAniso) { t.anisotropy = maxAniso; t.needsUpdate = true; }
      }
      node.material = mt;
      const shell = inMain(node) && !isDesc(node, rotoGroup) && !steel;
      if (shell) {
        if (/liquid|foam/i.test(nm)) {
          // use the model's own foam mesh as-is — just cut it on the shell's plane
          liquidSrc = node;
          node.visible = true;
          mt.side = THREE.DoubleSide;
          mt.clippingPlanes = [cutPlane];
          mt.needsUpdate = true;
        }
        else {
          // Solid engineering section: double-sided so the vessel interior is
          // a real dark wall (not a see-through film), plus a machined
          // cut-edge band that lights up exactly at the clip plane.
          mt.side = THREE.DoubleSide;
          mt.clippingPlanes = [cutPlane];
          injectCutShader(mt);
          mt.needsUpdate = true;
        }
      }
    });
    root.add(model);

    // Contact AO pool under the vehicle footprint — grounds it on the epoxy.
    const fp = new THREE.Box3().setFromObject(model);
    cutStart = fp.max.x + 0.35;   // cutaway sweep starts just past the nose
    const aoCan = document.createElement('canvas'); aoCan.width = aoCan.height = 256;
    { const c = aoCan.getContext('2d');
      const g = c.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, 'rgba(0,0,0,0.6)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.32)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, 256, 256); }
    const aoBlob = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(aoCan), transparent: true, depthWrite: false })
    );
    aoBlob.rotation.x = -Math.PI / 2; aoBlob.position.y = 0.0015; aoBlob.renderOrder = -9;
    aoBlob.scale.set((fp.max.x - fp.min.x) * 1.06, (fp.max.z - fp.min.z) * 1.18, 1);
    aoBlob.position.x = (fp.min.x + fp.max.x) / 2; aoBlob.position.z = (fp.min.z + fp.max.z) / 2;
    scene.add(aoBlob);
    V.aoBlob = aoBlob;
    let groundOcc = null, studioFrame = null;
    if (studio) {
      aoBlob.visible = false;
      const ms = []; model.traverse(o => { if (o.isMesh && o.visible) ms.push(o); });
      groundOcc = bakeGroundOcclusion(renderer, ms, { groundY: fp.min.y, box: fp });
      studioFrame = buildStudioFrame(model);
    }

    let modelAnchors = [], mainRadius = 1;
    if (mainRoots.length) {
      const mb = new THREE.Box3();
      for (const r of mainRoots) mb.union(new THREE.Box3().setFromObject(r));
      mainRadius = mb.getSize(new THREE.Vector3()).length() * 0.5;
      const focal = mb.getCenter(new THREE.Vector3());
      let shellMesh = null, shellBox = null;
      for (const r of mainRoots) r.traverse(n => { if (n.isMesh && !/liquid|foam|handel|handle|nozel|nozzle|label/i.test(n.name) && !shellMesh) shellMesh = n; });
      if (shellMesh) {
        // Shell centre from the shell's OWN geometry. setFromObject would also
        // include the rotor group's cross-cylinder parts (Bottom_C2, Roto_C3…),
        // skewing the centre ~+2 units so the cut lands past the rotor middle.
        shellMesh.geometry.computeBoundingBox();
        shellBox = shellMesh.geometry.boundingBox.clone().applyMatrix4(shellMesh.matrixWorld);
        const sc = shellBox.getCenter(new THREE.Vector3());
        focal.copy(sc);        // recentre the cut on the true cylinder-1 axis
        cutConst = focal.x;    // cut the shell (and the model foam) at the rotor centre
        // The foam is the model's own mesh, cut on this same plane — no JS drawing.
      }
      modelGlow = new THREE.PointLight(0xeef4ff, 0, 2.2, 1.6); modelGlow.position.copy(focal); scene.add(modelGlow);
      modelFocal = focal.clone();

      // Engineering callouts — anchored to the real components, sitting just
      // behind the cut face on the kept half so the dots land on material.
      const ax = cutConst - 0.14;
      const anchors = [{ p: new THREE.Vector3(ax, focal.y, focal.z), label: 'T-Rotor · Mist Generator', dx: 86, dy: -58 }];
      if (shellBox) {
        anchors.push({ p: new THREE.Vector3(ax, shellBox.max.y - (shellBox.max.y - shellBox.min.y) * 0.1, focal.z), label: 'Steel Pressure Vessel', dx: -92, dy: -46 });
      }
      if (liquidSrc) {
        const fb = new THREE.Box3().setFromObject(liquidSrc);
        anchors.push({ p: new THREE.Vector3(ax, lerp(fb.min.y, fb.max.y, 0.45), focal.z), label: 'Foam Concentrate', dx: 96, dy: 42 });
        if (shellBox && shellBox.max.y - fb.max.y > 0.05) {
          anchors.push({ p: new THREE.Vector3(ax, (fb.max.y + shellBox.max.y) / 2, focal.z), label: 'Gas Headspace', dx: -96, dy: 34 });
        }
      }
      modelAnchors = anchors;
    }

    // Collect fade groups: truck body (hidden in system/cutaway) and the rest
    // of the rig (ghosted only in cutaway). The focus (main cylinder + rotor)
    // and the added liquid/cap/dark-shell are never touched.
    // ONLY the cannon head (silver T-barrel + elbow + handle) stays lit in
    // Gun mode. The feed pipes, valves and reel hose ghost with everything else.
    // Cannon head lit in Gun mode — role-matched so rebuilt models just work.
    // Delivery head for Gun mode — the Attac cannon (Gun_Bot + Gun_Top). The
    // Skiddy has no cannon, only a reel nozzle, so it reports no gun and the UI
    // drops that tab rather than zooming in on nothing.
    const gunSet = new Set();
    model.traverse(n => { if (n.isMesh && isGunPart(n)) gunSet.add(n); });

    const truckMeshes = [], allRig = [];
    model.traverse(n => {
      if (!n.isMesh || !n.material || Array.isArray(n.material)) return;
      const rec = { mesh: n, mat: n.material, o0: (n.material.opacity ?? 1), t0: !!n.material.transparent, d0: (n.material.depthWrite !== false), c0: n.castShadow, on: false };
      if (!inSystem(n)) { truckMeshes.push(rec); return; }
      rec.isFocus = inFocus(n);              // sliced cylinder + rotor (cutaway focus)
      rec.isGun = gunSet.has(n);             // cannon head (gun focus)
      allRig.push(rec);
    });

    // Per-product framing, measured while the cannon is still under the model.
    // Every GLB is normalised to the same 3.4-unit box, so the authored 4CU
    // offsets carry over — only the centres differ.
    // Frame SYSTEM on what SYSTEM actually shows, not on a named group that may
    // cover more or less than the rig.
    const sysBox = new THREE.Box3();
    for (const r of allRig) sysBox.expandByObject(r.mesh);
    if (sysBox.isEmpty()) sysBox.copy(fp);
    const gunBox = gunSet.size ? boxOfSet(gunSet) : null;
    const frames = {
      rig: sysBox.getCenter(new THREE.Vector3()),
      gun: gunBox ? gunBox.getCenter(new THREE.Vector3()) : null,
      sysRadius: sysBox.getSize(new THREE.Vector3()).length() * 0.5,
      gunRadius: gunBox ? gunBox.getSize(new THREE.Vector3()).length() * 0.5 : 0.45,
      cutRadius: mainRadius,
      sysBox: sysBox.clone(),
    };

    // Aimable gun rig — re-parent the barrel head into yaw/pitch pivots.
    // Kept per product: the pivots live in the scene, not under the model, so
    // they must be toggled with it or one product's cannon floats over another.
    const gunRig = buildGunRig(model, gunSet, url);

    // Vehicle-system discharge: Nozzle_### empties from Blender become emitters.
    // Built after the model transform is final so the baked world origins match.
    model.updateMatrixWorld(true);
    const nozzles = collectNozzles(model);
    const mist = buildMist(nozzles, Math.max(0.001, fp.getSize(new THREE.Vector3()).length() * 0.55));

    V.models[url] = { group: model, aoBlob, cylGlow: modelGlow, cylFocal: modelFocal, bbox: fp.clone(),
                      truckMeshes, allRig, anchors: modelAnchors, gunRig, frames,
                      nozzles, mist, hasNozzles: nozzles.length > 0,
                      hasGun: gunSet.size > 0, hasCut: !!modelFocal, hasCarrier: truckMeshes.length > 0,
                      authored: /inferno-attac-4cu/.test(url),
                      cutStart: cutStart, cutConst: cutConst, studio, groundOcc, studioFrame };
    showOnly(url);
    }, undefined, (err) => { console.error('[drawer-viewer] GLB failed', url, err); if (loaderEl) loaderEl.textContent = 'Model unavailable'; loadFailed(url); });
  };

  return V;
}

function resize() {
  if (!V) return;
  const canvas = V.renderer.domElement;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight;
  if (!w || !h) return;
  V.renderer.setSize(w, h, false);
  const a0 = V.camera.aspect;
  V.camera.aspect = w / h;
  V.camera.updateProjectionMatrix();
  if (V.pcam && V.pcam.active && V.pcam.limits && Math.abs(a0 - V.camera.aspect) > 1e-3) V.pcam.refit();
}
window.addEventListener('resize', resize);

// ── Gun rig + mist spray ─────────────────────────────────────────
function sprayTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.5)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Standard three-quarter product angle, pushed back far enough that a sphere of
// `radius` about `c` fills the frame. Same direction vector as fitBox, so mode
// changes glide instead of jumping to a different side of the model.
const VIEW_DIR = new THREE.Vector3(0.60, 0.40, 0.69).normalize();
function orbitPos(c, radius, k) {
  const d = radius / Math.sin(THREE.MathUtils.degToRad(FOV * 0.5)) * k;
  return { x: c.x + VIEW_DIR.x * d, y: c.y + VIEW_DIR.y * d, z: c.z + VIEW_DIR.z * d };
}

// Fit a box to the frame for real: a bounding SPHERE leaves a long vehicle
// swimming in empty space, so project the eight corners and solve for the
// distance and target that make the silhouette fill `fill` of the viewport.
// Two refinement passes are plenty — the third never moves it a visible pixel.
// Per-product framing for legacy GLBs (Phase 29): a product configuration may give { fill, fillPortrait } — the share
// of the frame the product fills (default 0.80), and a value for portrait canvases (the Phase 23 phone viewer, where the
// sheet takes the lower part of the screen). The same ratio scales the System shot. Products without it: unchanged.
const LEGACY_FILL = 0.80;
let movedSinceFrame = false;
function legacyFill(base = LEGACY_FILL) {
  const f = V && V.framing && V.framing[V.url]; if (!f) return base;
  const v = V.camera.aspect < 1 && f.fillPortrait != null ? f.fillPortrait : f.fill;
  return v != null ? base * v / LEGACY_FILL : base;
}

function fitBox(box, fill) {
  const c = box.getCenter(new THREE.Vector3());
  const tgt = c.clone();
  let d = box.getSize(new THREE.Vector3()).length() * 0.5 / Math.sin(THREE.MathUtils.degToRad(FOV * 0.5));
  const cam = V.camera.clone();
  const right = new THREE.Vector3(), up = new THREE.Vector3(), v = new THREE.Vector3();
  for (let pass = 0; pass < 3; pass++) {
    cam.position.copy(tgt).addScaledVector(VIEW_DIR, d);
    cam.lookAt(tgt);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          v.set(x, y, z).project(cam);
          minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x);
          miny = Math.min(miny, v.y); maxy = Math.max(maxy, v.y);
        }
    d *= Math.max((maxx - minx) / 2, (maxy - miny) / 2) / fill;
    // Slide the target so the silhouette sits dead centre, not the box origin.
    const halfH = Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * d;
    right.setFromMatrixColumn(cam.matrixWorld, 0);
    up.setFromMatrixColumn(cam.matrixWorld, 1);
    tgt.addScaledVector(right, ((minx + maxx) / 2) * halfH * cam.aspect)
       .addScaledVector(up,    ((miny + maxy) / 2) * halfH);
  }
  // the legacy orbit may always reach its own framing (Phase 29: on a portrait canvas a tall product needs more distance
  // than the fixed limit, which used to clamp the framing and crop it); the limit only ever grows, never shrinks
  if (V && V.legacyCam && V.controls) V.controls.maxDistance = Math.max(V.legacyCam.maxDistance, d * 1.02);
  return { pos: tgt.clone().addScaledVector(VIEW_DIR, d), tgt };
}

// Bakkie studio framing (2026-09-29): an ORIENTED box (the 2CU GLB stands at ~45 deg to the axes) with forward = centre ->
// headlights; the catalogue camera looks at the front three-quarter from 20 deg up, and the distance is solved so the vehicle
// fills 76 % of the frame width (at most 80 % of its height) on any canvas aspect.
function buildStudioFrame(model) {
  model.updateMatrixWorld(true);
  const pts = [], hp = [], v = new THREE.Vector3();
  model.traverse(o => { if (!o.isMesh || !o.visible) return; const pa = o.geometry.attributes.position, st = Math.max(1, Math.floor(pa.count / 3000)), head = /headlight/i.test(o.name);
    for (let i = 0; i < pa.count; i += st) { v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld); pts.push(v.clone()); if (head) hp.push(v.clone()); } });
  if (!pts.length) return null;
  const c = new THREE.Vector3(); for (const q of pts) c.add(q); c.multiplyScalar(1 / pts.length);
  const f = new THREE.Vector3();
  if (hp.length) { for (const q of hp) f.add(q); f.multiplyScalar(1 / hp.length).sub(c); } else f.copy(VIEW_DIR);
  f.y = 0; f.normalize();
  const s = new THREE.Vector3(-f.z, 0, f.x); if (s.dot(VIEW_DIR) < 0) s.negate();          // the side the default view already favours
  const fa = [Infinity, -Infinity], sa = [Infinity, -Infinity], ya = [Infinity, -Infinity], rel = new THREE.Vector3();
  for (const q of pts) { rel.copy(q).sub(c); const a = rel.dot(f), b = rel.dot(s);
    fa[0] = Math.min(fa[0], a); fa[1] = Math.max(fa[1], a); sa[0] = Math.min(sa[0], b); sa[1] = Math.max(sa[1], b); ya[0] = Math.min(ya[0], q.y); ya[1] = Math.max(ya[1], q.y); }
  const corners = [];
  for (const a of fa) for (const b of sa) for (const y of ya) { const q = c.clone().addScaledVector(f, a).addScaledVector(s, b); q.y = y; corners.push(q); }
  const center = c.clone().addScaledVector(f, (fa[0] + fa[1]) / 2).addScaledVector(s, (sa[0] + sa[1]) / 2); center.y = ya[0] + (ya[1] - ya[0]) * 0.42;
  const e = THREE.MathUtils.degToRad(20), dir = f.clone().multiplyScalar(Math.SQRT1_2).addScaledVector(s, Math.SQRT1_2).multiplyScalar(Math.cos(e)); dir.y = Math.sin(e); dir.normalize();
  return { corners, center, dir };
}
function fitStudio(sf) {
  const cam = V.camera.clone(), tgt = sf.center.clone(), v = new THREE.Vector3();
  const span = d => { cam.position.copy(tgt).addScaledVector(sf.dir, d); cam.lookAt(tgt); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
    let x0 = 9, x1 = -9, y0 = 9, y1 = -9; for (const q of sf.corners) { v.copy(q).project(cam); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
    return [(x1 - x0) / 2, (y1 - y0) / 2]; };
  let lo = 0.3, hi = 200; for (let i = 0; i < 48; i++) { const m = (lo + hi) / 2, [w, h] = span(m); if (w > 0.76 || h > 0.8) lo = m; else hi = m; }
  if (V.legacyCam && V.controls) V.controls.maxDistance = Math.max(V.legacyCam.maxDistance, hi * 1.25);
  return { pos: tgt.clone().addScaledVector(sf.dir, hi), tgt };
}

// Cutaway shot: square onto the cut face, matching the 4CU's authored angle
// (2.0 : 0.4 : 0.65) but scaled to the vessel actually being sliced.
function cutPos(f, radius) {
  const d = radius / Math.sin(THREE.MathUtils.degToRad(FOV * 0.5)) * 1.45;
  const L = Math.hypot(2.0, 0.4, 0.65);
  return { x: f.x + d * (2.0 / L), y: f.y + d * (0.4 / L), z: f.z + d * (0.65 / L) };
}

function boxOfSet(set) {
  const b = new THREE.Box3();
  for (const m of set) b.union(new THREE.Box3().setFromObject(m));
  return b;
}

function buildGunRig(model, gunSet, url) {
  // Cannon anatomy (verified with a colour-coded part audit):
  //   Gun_Bot    — the swivel elbow atop the BLACK riser column
  //   Gun_Top    — the silver T-barrel arms
  //   Handel_Gun — the aiming handle on the T
  // ONLY these rotate. Yaw spins the whole silver head about the riser's
  // vertical axis (so the elbow stays seated on the black pipe); pitch tilts
  // just the T + handle at the junction above the elbow. The cylinder valves
  // (Nozel), copper feed pipes (Pipes) and reel plumbing never move.
  // The silver gun = elbow + T-barrel + handle. It rotates as ONE rigid unit.
  const gunParts = [...(gunSet || [])];
  if (!gunParts.length) return null;
  // Swivel JOINT on the authored 4CU = top of the black riser (part of Frame),
  // measured at (0.032, 1.288, -0.78) — exactly where the silver elbow's
  // underside meets it. BOTH yaw and pitch pivot here, so the gun's bottom
  // never leaves the black pipe. Other products get the same joint derived from
  // the head's own bounds: bottom-centre of the cannon, muzzle at its +Z end.
  const gb = boxOfSet(gunSet);
  const authored = /inferno-attac-4cu/.test(url || '');
  const joint = authored ? new THREE.Vector3(0.032, 1.288, -0.78)
                         : new THREE.Vector3((gb.min.x + gb.max.x) / 2, gb.min.y, (gb.min.z + gb.max.z) / 2);
  const muzzle = authored ? new THREE.Vector3(0.04, 0.11, 0.21)
                          : new THREE.Vector3(0, (gb.max.y - gb.min.y) * 0.6, (gb.max.z - joint.z) + 0.05);
  aimYaw = new THREE.Group(); aimYaw.position.copy(joint); V.scene.add(aimYaw);
  aimPitch = new THREE.Group(); aimPitch.position.set(0, 0, 0); aimYaw.add(aimPitch);
  // attach() preserves world transforms → nothing shifts at rest.
  gunParts.forEach(m => aimPitch.attach(m));
  buildSpray(muzzle);
  return { aimYaw, aimPitch, spray };
}

function buildSpray(muzzle) {
  // Ultra-fine atomised water droplets: many small cool-white points in a
  // tight cone with gravity droop — mist, not smoke.
  const count = 520;
  const positions = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const max = new Float32Array(count);
  const spawn = (i, stagger) => {
    positions[i * 3] = muzzle.x; positions[i * 3 + 1] = muzzle.y; positions[i * 3 + 2] = muzzle.z;
    const spread = 0.24, speed = 2.0 + Math.random() * 1.9;
    vel[i * 3]     = (Math.random() * 2 - 1) * spread * speed;
    vel[i * 3 + 1] = (Math.random() * 2 - 1) * spread * speed + 0.22; // slight lift
    vel[i * 3 + 2] = speed;                                            // +Z forward
    max[i] = 0.5 + Math.random() * 0.55;
    life[i] = stagger ? Math.random() * max[i] : 0;
  };
  for (let i = 0; i < count; i++) spawn(i, true);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    map: sprayTexture(), color: 0xf2f8ff, size: 0.055, sizeAttenuation: true,
    transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.visible = false;
  aimPitch.add(points);
  spray = { points, geom, positions, vel, life, max, count, spawn };
}

function updateSpray(dt) {
  if (!spray) return;
  const active = foamOn && mode === 'gun';
  if (!active) { if (spray.points.visible) spray.points.visible = false; return; }
  if (!spray.points.visible) spray.points.visible = true;
  const d = Math.min(dt, 0.05);
  const { positions, vel, life, max, count, spawn } = spray;
  for (let i = 0; i < count; i++) {
    life[i] += d;
    if (life[i] >= max[i]) { spawn(i, false); continue; }
    vel[i * 3 + 1] -= 1.1 * d;   // fine droplets arc down under gravity
    positions[i * 3]     += vel[i * 3] * d;
    positions[i * 3 + 1] += vel[i * 3 + 1] * d;
    positions[i * 3 + 2] += vel[i * 3 + 2] * d;
  }
  spray.geom.attributes.position.needsUpdate = true;
}

// ── Production cannon: aim + foam stream (Phase 82) ──────────────
// manifest.gun.rig (asset frame, glTF Y up, measured from the model): joint = the swivel on the riser, headPivot = where the head
// (barrel + handles + nozzle) hinges on the swivel elbow, muzzle = the nozzle tip, direction = the nozzle tube at rest, head = per
// LOD the head's vertex runs in the LODn_<group> primitive. The cannon ships as one mesh; on first sight the viewer splits it into
// the base (the original mesh, its index narrowed) and the head (a child mesh on the same vertex buffers). The whole cannon swings
// 360 deg about the joint; only the head pitches, about its hinge. Aiming = "spray where you point": the pointer ray meets the
// floor, the cannon swings toward that point and lifts the barrel to the ballistic angle that lands the stream there (above the
// horizon it aims along the ray). A ring on the floor marks the point. Outside Gun mode it eases back to rest. With the system
// activated a foam stream leaves the muzzle along the nozzle: a dense core jet, a foam body and mist, ballistic, world-space.
const PGUN = { yaw: 0, pitch: 0, yawT: 0, pitchT: 0, speed: 1, speedT: 1, dirty: false, rest: new WeakMap(), stream: null, tube: null, reticle: null, aimed: 0 };
const PGUN_LIM = { up: THREE.MathUtils.degToRad(45), down: THREE.MathUtils.degToRad(-15) };
const PGUN_UP = new THREE.Vector3(0, 1, 0);
const gunRigOf = r => !!(r && r.production && r.production.manifest.gun && r.production.manifest.gun.rig);
const _pg = { M: new THREE.Matrix4(), H: new THREE.Matrix4(), HT: new THREE.Matrix4(), A: new THREE.Matrix4(), T: new THREE.Matrix4(), Si: new THREE.Matrix4(), q: new THREE.Quaternion(),
              ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), a: new THREE.Vector3(), b: new THREE.Vector3(),
              mz: new THREE.Vector3(), dir: new THREE.Vector3(), u: new THREE.Vector3(), w: new THREE.Vector3(), s: new THREE.Vector3() };
const wrapPi = x => Math.atan2(Math.sin(x), Math.cos(x));
function prodGunRig() {
  const r = V && V.models && V.models[V.url], a = r && r.production, g = a && a.manifest.gun;
  if (!g || !g.rig) return null;
  if (!r.pgun) {
    const R = g.rig, d = new THREE.Vector3().fromArray(R.direction).normalize(), dh = new THREE.Vector3(d.x, 0, d.z).normalize();
    r.pgun = { a, j: new THREE.Vector3().fromArray(R.joint), hp: new THREE.Vector3().fromArray(R.headPivot || R.joint), mz: new THREE.Vector3().fromArray(R.muzzle),
               d, dh, right: new THREE.Vector3().crossVectors(dh, PGUN_UP).normalize(), elev0: Math.atan2(d.y, Math.hypot(d.x, d.z)),
               head: R.head || null, nodes: new Set(g.groups || []) };
  }
  return r.pgun;
}
function prodGunFrame(P) {                     // asset frame -> world (every LOD scene shares it)
  for (const L of P.a.lods.values()) { L.scene.updateMatrixWorld(); return L.scene.matrixWorld; }
  return null;
}
function prodGunYaw(P, yaw, out) {             // T(joint) Ry(yaw) T(-joint), asset frame
  return out.makeTranslation(P.j.x, P.j.y, P.j.z).multiply(_pg.T.makeRotationY(yaw)).multiply(_pg.A.makeTranslation(-P.j.x, -P.j.y, -P.j.z));
}
function prodGunPitch(P, pitch, out) {         // T(headPivot) R_right(pitch) T(-headPivot), asset frame
  _pg.q.setFromAxisAngle(P.right, pitch);
  return out.makeTranslation(P.hp.x, P.hp.y, P.hp.z).multiply(_pg.T.makeRotationFromQuaternion(_pg.q)).multiply(_pg.A.makeTranslation(-P.hp.x, -P.hp.y, -P.hp.z));
}
// The head as a child mesh on the base's vertex buffers (triangles whose vertices lie in the manifest's head runs).
function splitCannon(o, runs) {
  if (!o.isMesh || !runs || !o.geometry.index) return null;
  const inHead = i => runs.some(([s, n]) => i >= s && i < s + n), idx = o.geometry.index.array, hi = [], bi = [];
  for (let t = 0; t < idx.length; t += 3) (inHead(idx[t]) ? hi : bi).push(idx[t], idx[t + 1], idx[t + 2]);
  if (!hi.length || !bi.length) return null;
  const hg = new THREE.BufferGeometry();
  for (const k in o.geometry.attributes) hg.setAttribute(k, o.geometry.attributes[k]);
  const Arr = idx.constructor; hg.setIndex(new THREE.BufferAttribute(new Arr(hi), 1)); o.geometry.setIndex(new THREE.BufferAttribute(new Arr(bi), 1));
  hg.computeBoundingBox(); hg.computeBoundingSphere(); o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere();
  const head = new THREE.Mesh(hg, o.material); head.name = `${o.name}_Head`; head.castShadow = o.castShadow; head.receiveShadow = o.receiveShadow;
  head.userData = { ...o.userData }; head.matrixAutoUpdate = false; o.add(head);
  return head;
}
function poseProdGun(P, yaw, pitch) {
  const MY = prodGunYaw(P, yaw, _pg.M), HP = prodGunPitch(P, pitch, _pg.H);
  for (const L of P.a.lods.values()) {
    const S = L.scene; let rest = PGUN.rest.get(S);
    if (!rest) {                                // first sight of this LOD: its cannon nodes at rest (+ the head split)
      rest = []; S.updateMatrixWorld(true); _pg.Si.copy(S.matrixWorld).invert();
      S.traverse(o => {
        if (o === S || ![...P.nodes].some(n => o.name === `LOD${L.n}_${n}`)) return;
        o.updateMatrix(); const Pm = _pg.Si.clone().multiply(o.parent.matrixWorld), R0 = Pm.clone().multiply(o.matrix);   // parent / node rest, asset frame
        const head = splitCannon(o, P.head && P.head[L.n]);
        rest.push({ o, L0: o.matrix.clone(), P: Pm, Pi: Pm.clone().invert(), R0, R0i: R0.clone().invert(), head });
      });
      PGUN.rest.set(S, rest);
    }
    for (const e of rest) {
      _pg.A.copy(e.Pi).multiply(MY).multiply(e.P).multiply(e.L0).decompose(e.o.position, e.o.quaternion, e.o.scale);
      if (e.head) { e.head.matrix.copy(e.R0i).multiply(HP).multiply(e.R0); e.head.matrixWorldNeedsUpdate = true; }
    }
  }
}
const PSTREAM = [   // per layer: particles, cone spread (rad), speed (m/s), life (s), point size (m), opacity - core jet / foam body / mist
  { n: COARSE ? 2000 : 5200, spread: 0.022, speed: 14.0, speedVar: 0.4, life: 1.25, size: 0.13, opacity: 0.42, wet: 0.05 },   // dense droplets on the rope
  { n: COARSE ? 1200 : 3200, spread: 0.055, speed: 13.6, speedVar: 1.0, life: 1.2,  size: 0.06, opacity: 0.55, drop: true, wet: 0.04 },   // distinct droplets peeling off
  { n: COARSE ? 500 : 1400, spread: 0.035, speed: 13.6, speedVar: 0.7, life: 1.2,  size: 0.34, opacity: 0.05 },   // foam body haze
  { n: COARSE ? 350 : 1000, spread: 0.06,  speed: 13.0, speedVar: 1.2, life: 1.0,  size: 0.30, opacity: 0.035 },  // fine mist haze
];
// The pointer -> the aim point: the floor under the pointer; above the horizon, far along the ray.
function aimProdGun(cx, cy) {
  if (mode !== 'gun' || !V) return false;
  const P = prodGunRig(), S = P && prodGunFrame(P); if (!S) return false;
  const rect = V.renderer.domElement.getBoundingClientRect(); if (!rect.width || !rect.height) return false;
  _pg.ndc.set((cx - rect.left) / rect.width * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
  _pg.ray.setFromCamera(_pg.ndc, V.camera);
  const ray = _pg.ray.ray, s = _pg.s.setFromMatrixScale(S).x, fy = V.stageState && Number.isFinite(V.stageState.floorY) ? V.stageState.floorY : 0;
  let ground = false;
  if (ray.direction.y < -1e-4) { const t = (fy - ray.origin.y) / ray.direction.y; if (t > 0 && t < 80 * s) { ray.at(t, _pg.a); ground = true; } }
  if (!ground) ray.at(60 * s, _pg.a);
  const hitW = _pg.b.copy(_pg.a);
  const T = _pg.a.applyMatrix4(_pg.Si.copy(S).invert());                  // the aim point, asset frame
  const vx = T.x - P.j.x, vz = T.z - P.j.z, D = Math.hypot(T.x - P.hp.x, T.z - P.hp.z);
  if (Math.hypot(vx, vz) > 0.25) PGUN.yawT = PGUN.yaw + wrapPi(Math.atan2(P.dh.z * vx - P.dh.x * vz, P.dh.x * vx + P.dh.z * vz) - PGUN.yaw);
  let th; PGUN.speedT = 1;
  if (ground && D > 0.05) {                    // the low ballistic angle that lands the stream on the point
    const v = PSTREAM[0].speed, g = 9.81, H = T.y - P.mz.y, disc = v ** 4 - g * (g * D * D + 2 * H * v * v);
    th = disc >= 0 ? Math.atan((v * v - Math.sqrt(disc)) / (g * D)) : Math.PI / 4;
    const thMin = P.elev0 + PGUN_LIM.down, lift = D * Math.tan(thMin) - H;
    if (th < thMin && lift > 1e-3) {           // closer than the barrel can depress: throttle the stream so it still lands there
      th = thMin; PGUN.speedT = THREE.MathUtils.clamp(Math.sqrt(g * D * D / (2 * Math.cos(th) ** 2 * lift)) / v, 0.3, 1);
    }
  } else th = Math.atan2(T.y - P.mz.y, Math.max(D, 0.05));
  PGUN.pitchT = THREE.MathUtils.clamp(th - P.elev0, PGUN_LIM.down, PGUN_LIM.up);
  PGUN.aimed = performance.now();
  if (ground) showReticle(hitW, s, fy); else if (PGUN.reticle) PGUN.reticle.visible = false;
  V.controls.autoRotate = false; lastInteract = performance.now();
  return true;
}
function showReticle(p, s, fy) {
  if (!PGUN.reticle) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 48), new THREE.MeshBasicMaterial({ color: 0xff2030, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.renderOrder = 6; V.scene.add(m); PGUN.reticle = m;
  }
  const r = PGUN.reticle; r.position.set(p.x, fy + 0.004, p.z); r.scale.setScalar(0.22 * s); r.visible = true;
}
function dropTexture() {                       // a crisp droplet (sprayTexture is a soft puff)
  const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d');
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.45, 'rgba(255,255,255,0.85)'); g.addColorStop(0.7, 'rgba(255,255,255,0.2)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c);
}
function buildProdStream() {
  const tex = sprayTexture(), dtex = dropTexture();
  const layers = PSTREAM.map(o => {
    const pos = new Float32Array(o.n * 3).fill(-1e4), geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geom, new THREE.PointsMaterial({ map: o.drop ? dtex : tex, color: 0xf4f8fc, size: o.size, sizeAttenuation: true, transparent: true,
      opacity: o.opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
    pts.frustumCulled = false; pts.visible = false; pts.renderOrder = 5; V.scene.add(pts);
    return { o, pts, geom, pos, vel: new Float32Array(o.n * 3), life: new Float32Array(o.n), max: new Float32Array(o.n), next: 0, acc: 0 };
  });
  return { layers };
}
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
// Phase 122 (owner: "you must not be able to spray through the bakkies"): a height map of the vehicle and its unit, seen from
// above (every triangle except the cannon's own raises the cells under it to its highest point). The foam jet ends, and its
// droplets stop, where they come down on the vehicle instead of passing through it.
const VH = { key: null, N: 128, h: null, x0: 0, z0: 0, sx: 1, sz: 1 };
function vehicleHeights() {
  const P = prodGunRig(); if (!P) return null;
  const L = [...P.a.lods.values()].sort((a, b) => a.n - b.n).pop();   // the coarsest loaded LOD is plenty for this
  if (!L) return null;
  const key = V.url + '|' + L.n; if (VH.key === key) return VH.h ? VH : null;
  VH.key = key; VH.h = null;
  L.scene.updateMatrixWorld(true);
  const box = new THREE.Box3(), meshes = [], isGun = o => [...P.nodes].some(n => o.name.includes(n));
  L.scene.traverse(o => { if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return; for (let q = o; q; q = q.parent) if (isGun(q)) return; meshes.push(o); box.expandByObject(o); });
  if (!meshes.length || box.isEmpty()) return null;
  const N = VH.N, h = new Float32Array(N * N).fill(-Infinity);
  VH.x0 = box.min.x; VH.z0 = box.min.z; VH.sx = (N - 1) / Math.max(1e-6, box.max.x - box.min.x); VH.sz = (N - 1) / Math.max(1e-6, box.max.z - box.min.z);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const o of meshes) {
    const pos = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : pos.count, M = o.matrixWorld;
    for (let t = 0; t < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(M); b.fromBufferAttribute(pos, i1).applyMatrix4(M); c.fromBufferAttribute(pos, i2).applyMatrix4(M);
      const y = Math.max(a.y, b.y, c.y);
      const u0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - VH.x0) * VH.sx)), u1 = Math.min(N - 1, Math.ceil((Math.max(a.x, b.x, c.x) - VH.x0) * VH.sx));
      const v0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - VH.z0) * VH.sz)), v1 = Math.min(N - 1, Math.ceil((Math.max(a.z, b.z, c.z) - VH.z0) * VH.sz));
      if ((u1 - u0) * (v1 - v0) > 400) continue;            // a huge flat triangle (a ground plane): not the vehicle
      for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) { const k = v * N + u; if (y > h[k]) h[k] = y; }
    }
  }
  VH.h = h; return VH;
}
function vehicleHit(x, y, z) {               // is this point inside the vehicle (below its surface, over its footprint)?
  const H = VH.h; if (!H) return false;
  const u = Math.round((x - VH.x0) * VH.sx), v = Math.round((z - VH.z0) * VH.sz);
  if (u < 0 || v < 0 || u >= VH.N || v >= VH.N) return false;
  return y < H[v * VH.N + u];
}
function stepProdStream(dt, emit, mz, dir, s, fy) {
  if (!PGUN.stream) { if (!emit) return; PGUN.stream = buildProdStream(); }
  const veh = vehicleHeights();
  _pg.u.crossVectors(dir, Math.abs(dir.y) < 0.95 ? PGUN_UP : _pg.w.set(1, 0, 0)).normalize(); _pg.w.crossVectors(dir, _pg.u).normalize();
  const g = 9.81 * s;
  for (const Lr of PGUN.stream.layers) {
    const { o, pos, vel, life, max } = Lr; let alive = 0;
    for (let i = 0; i < o.n; i++) {
      if (life[i] >= max[i]) continue;
      life[i] += dt;
      if (life[i] >= max[i] || pos[i * 3 + 1] < fy) { if (pos[i * 3 + 1] < fy && pos[i * 3 + 1] > fy - 1e3 && o.wet) wetStamp(pos[i * 3], pos[i * 3 + 2], o.wet, s); life[i] = max[i]; pos[i * 3 + 1] = -1e4; continue; }   // ends on the floor (Phase 119: and wets it)
      vel[i * 3 + 1] -= g * dt;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (veh && life[i] > 0.06 && vehicleHit(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])) {   // Phase 122: it hits the vehicle — splashes off it
        const H = VH.h[Math.round((pos[i * 3 + 2] - VH.z0) * VH.sz) * VH.N + Math.round((pos[i * 3] - VH.x0) * VH.sx)];
        pos[i * 3 + 1] = H + 0.01 * s; vel[i * 3 + 1] = Math.abs(vel[i * 3 + 1]) * (0.12 + Math.random() * 0.18);
        vel[i * 3] = vel[i * 3] * 0.3 + (Math.random() - 0.5) * 1.6 * s; vel[i * 3 + 2] = vel[i * 3 + 2] * 0.3 + (Math.random() - 0.5) * 1.6 * s;
        max[i] = Math.min(max[i], life[i] + 0.22 + Math.random() * 0.25);
      }
      alive++;
    }
    if (emit) {
      Lr.acc += o.n / o.life * dt; let k = Math.floor(Lr.acc); Lr.acc -= k;
      while (k-- > 0) {
        const i = Lr.next; Lr.next = (Lr.next + 1) % o.n;
        const sp = (o.speed + (Math.random() * 2 - 1) * o.speedVar) * s * PGUN.speed, a = gauss() * o.spread, b = gauss() * o.spread, lead = Math.random() * dt;
        for (let c = 0; c < 3; c++) {
          const dv = dir.getComponent(c) + _pg.u.getComponent(c) * a + _pg.w.getComponent(c) * b;
          vel[i * 3 + c] = dv * sp; pos[i * 3 + c] = mz.getComponent(c) + dv * sp * lead;
        }
        life[i] = 0; max[i] = o.life * (0.75 + Math.random() * 0.5); alive++;
      }
    }
    Lr.pts.material.size = o.size * s;
    Lr.pts.visible = alive > 0;
    if (alive > 0) Lr.geom.attributes.position.needsUpdate = true;
  }
}
// The jet body (Phase 82c/e, owner: "straal moet dikker voel" / "fix die spray"): a tube along the path of the foam that has ACTUALLY
// left the nozzle - every frame's emission (muzzle, velocity, time) is kept, and the tube's point at age tau is where the parcel
// emitted tau ago is now (m + v tau + g tau^2 / 2). So the jet whips and lags like water when the cannon turns, exactly with its
// droplets; it shoots out on activation (the history grows) and its tail runs off on stop. White foam rope at the nozzle (3 cm),
// widening (16 cm) and breaking up with age, streaks running down it; it ends where the parcels reach the floor.
const TUBE = { seg: 64, rad: 10, r0: 0.04, r1: 0.22 };
function buildStreamTube() {
  const S = TUBE.seg, R = TUBE.rad, n = (S + 1) * (R + 1), g = new THREE.BufferGeometry(), ix = [];
  for (let i = 0; i < S; i++) for (let j = 0; j < R; j++) { const a = i * (R + 1) + j, b = a + R + 1; ix.push(a, b, a + 1, b, b + 1, a + 1); }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2)); g.setIndex(ix);
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uEnd: { value: 1 }, uStart: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,                        // light, white, translucent foam - never a grey hose
    vertexShader: `varying vec2 vUv; varying float vFacing; varying float vTop;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vec3 n = normalize(normalMatrix * normal);
        vFacing = abs(dot(n, normalize(-mv.xyz))); vTop = normal.y; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime, uEnd, uStart; varying vec2 vUv; varying float vFacing; varying float vTop;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y); }
      void main() {
        float x = vUv.x;
        float st = n2(vec2(x * 30.0 - uTime * 10.0, vUv.y * 7.0)) * 0.55 + n2(vec2(x * 85.0 - uTime * 24.0, vUv.y * 17.0)) * 0.45;
        float core = pow(vFacing, 1.15), br = smoothstep(0.1, 0.85, x);                            // soft edges: no tube silhouette
        float pulse = n2(vec2(x * 16.0 - uTime * 13.0, 0.5)) * 0.6 + n2(vec2(x * 44.0 - uTime * 27.0, vUv.y * 5.0)) * 0.4;
        float clump = smoothstep(0.3, 0.8, mix(st, pulse, 0.5) + 0.4 * (1.0 - br));               // a coherent rope at the nozzle, foam clumps downstream
        float a = min(1.0, core * mix(1.25, 0.6, br) * mix(1.0, clump, 0.3 + 0.6 * br));
        a *= smoothstep(uStart, uStart + 0.03, x) * (1.0 - smoothstep(uEnd - 0.06, uEnd, x));
        vec3 c = mix(vec3(0.80, 0.85, 0.92), vec3(1.0), clamp(0.55 + 0.45 * vTop, 0.0, 1.0));   // foam lit from above
        gl_FragColor = vec4(c * (1.05 + 0.15 * st), a);
      }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 4; mesh.visible = false; V.scene.add(mesh);
  return { mesh, g, m, t: 0, hist: [], lastEmit: -1 };
}
function stepStreamTube(dt, emit, mz, dir, s, fy) {
  if (!PGUN.tube) { if (!emit) return; PGUN.tube = buildStreamTube(); }
  const T = PGUN.tube, life = PSTREAM[0].life, g = 9.81 * s; T.t += dt; T.m.uniforms.uTime.value = T.t;
  if (emit) {                                              // this frame's parcel: where it left and how fast
    const v = PSTREAM[0].speed * s * PGUN.speed;
    T.hist.push({ t: T.t, m: mz.clone(), v: dir.clone().multiplyScalar(v) }); T.lastEmit = T.t;
  }
  while (T.hist.length && T.t - T.hist[0].t > life + 0.1) T.hist.shift();
  PGUN.path = null;
  if (!T.hist.length) { T.mesh.visible = false; return; }
  const H = T.hist, tau0 = emit ? 0 : T.t - T.lastEmit, tau1 = Math.min(life, T.t - H[0].t);
  if (tau1 - tau0 < 0.02) { T.mesh.visible = false; return; }
  const parcel = (tau, out) => {                           // the parcel emitted tau ago, now
    const te = T.t - tau; let lo = 0, hi = H.length - 1;
    while (hi - lo > 1) { const mi = (lo + hi) >> 1; if (H[mi].t < te) lo = mi; else hi = mi; }
    const e = Math.abs(H[lo].t - te) < Math.abs(H[hi].t - te) ? H[lo] : H[hi];
    return out.set(e.m.x + e.v.x * tau, e.m.y + e.v.y * tau - 0.5 * g * tau * tau, e.m.z + e.v.z * tau);
  };
  const S = TUBE.seg, R = TUBE.rad, P = T.g.attributes.position.array, N = T.g.attributes.normal.array, UV = T.g.attributes.uv.array;
  const pts = []; let end = tau1;
  for (let i = 0; i <= S; i++) { const tau = tau0 + (tau1 - tau0) * i / S, q = parcel(tau, new THREE.Vector3());
    if (q.y < fy) { end = Math.min(end, tau); q.y = fy; } else if (tau > 0.06 && tau < end && VH.h && vehicleHit(q.x, q.y, q.z)) end = tau;   // Phase 122: the jet ends on the vehicle
    pts.push([tau, q]); }
  const tan = _pg.u, side = _pg.w, up = _pg.a;
  for (let i = 0; i <= S; i++) {
    const [tau, c] = pts[i], q0 = pts[Math.max(0, i - 1)][1], q1 = pts[Math.min(S, i + 1)][1];
    tan.subVectors(q1, q0); if (tan.lengthSq() < 1e-12) tan.copy(dir); tan.normalize();
    side.crossVectors(tan, Math.abs(tan.y) < 0.95 ? PGUN_UP : up.set(1, 0, 0)).normalize(); up.crossVectors(side, tan).normalize();
    const x = tau / life, r = (TUBE.r0 + (TUBE.r1 - TUBE.r0) * Math.pow(x, 0.8)) * s;
    for (let j = 0; j <= R; j++) {
      const a = j / R * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), k = i * (R + 1) + j;
      const nx = side.x * ca + up.x * sa, ny = side.y * ca + up.y * sa, nz = side.z * ca + up.z * sa;
      N[k * 3] = nx; N[k * 3 + 1] = ny; N[k * 3 + 2] = nz; P[k * 3] = c.x + nx * r; P[k * 3 + 1] = c.y + ny * r; P[k * 3 + 2] = c.z + nz * r;
      UV[k * 2] = x; UV[k * 2 + 1] = j / R;
    }
  }
  T.m.uniforms.uStart.value = tau0 / life; T.m.uniforms.uEnd.value = end / life; T.mesh.visible = true;
  T.g.attributes.position.needsUpdate = true; T.g.attributes.normal.needsUpdate = true; T.g.attributes.uv.needsUpdate = true;
  if (emit && tau1 > 0.3) { PGUN.path = []; for (let i = 4; i <= S; i += 4) if (pts[i][0] <= end) PGUN.path.push(pts[i][1]); }   // for the fire targets
}
// ── Fire targets (Phase 82d, owner: "dalk fire targets om uit te sit" -> 3 realistic fires around the product) ──────────────
// Gun mode only. Three fires stand on the floor around the product (placed from the manifest's gun view: one each side, one
// beyond), each a pair of camera-facing flame cards (procedural fbm flame shader: dark-red base, orange body, yellow tips,
// white-hot core, flicker), a warm glow on the floor and rising smoke. Where the foam stream comes down on a fire it shrinks
// (about 2 s of foam); at zero it is out - a burst of steam - and the counter goes up. A fire relights 6 s after it went out.
const FIRE = { list: null, key: null, dom: null, glowTex: null, smokeTex: null, t: 0, cam: null, still: 0 };
const FIRE_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FIRE_FS = `uniform float uTime, uSeed, uAmt; varying vec2 vUv;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y); }
  float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < OCT; i++) { v += a * n2(p); p *= 2.03; a *= 0.5; } return v; }
  void main() {
    float t = uTime * 1.5 + uSeed * 17.0; vec2 uv = vUv;
    float n = fbm(vec2(uv.x * 3.2 + uSeed, uv.y * 2.4 - t * 1.9)), m = fbm(vec2(uv.x * 7.0 - uSeed, uv.y * 5.0 - t * 3.4));
    float x = (uv.x - 0.5) * 2.0 + (n - 0.5) * 0.7 * uv.y;
    float w = mix(0.62, 0.06, pow(uv.y, 0.85));
    float shape = 1.0 - smoothstep(0.45, 1.0, abs(x) / w);
    float top = mix(0.25, 0.95, uAmt) + (m - 0.5) * 0.3;
    shape *= 1.0 - smoothstep(top * 0.55, top, uv.y);
    shape *= smoothstep(0.0, 0.07, uv.y);
    float heat = shape * (1.05 - uv.y * 0.75) * (0.55 + 0.7 * m);
    vec3 c = mix(vec3(0.45, 0.04, 0.0), vec3(1.0, 0.32, 0.02), smoothstep(0.08, 0.4, heat));
    c = mix(c, vec3(1.0, 0.72, 0.18), smoothstep(0.4, 0.75, heat));
    c = mix(c, vec3(1.0, 0.95, 0.8), smoothstep(0.78, 1.05, heat));
    gl_FragColor = vec4(c * 1.35, clamp(shape * smoothstep(0.03, 0.3, heat) * min(1.0, uAmt * 3.0), 0.0, 1.0));
  }`;
function radialTex(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); stops.forEach(([o, col]) => g.addColorStop(o, col));
  x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
}
// A random spot (owner: "random plekke ... ver naby nie teen die bakkie nie"): the floor under a random point of the current view,
// at least 2.3 m clear of the product, within the stream's reach (16 m of the cannon) and 1.8 m from the other fires.
const _fray = new THREE.Raycaster();
function randomFireSpot(P, S, s, fy, box, others) {
  const hb = box.clone().expandByScalar(2.3 * s), mid = (hb.min.y + hb.max.y) / 2, jW = P.j.clone().applyMatrix4(S);
  for (let k = 0; k < 80; k++) {
    const xr = TRANSP ? 0.34 : 0.85;   // Phase 104: on the showcase page the canvas spans the section; fires stay in the open middle, clear of the text
    _fray.setFromCamera(new THREE.Vector2((Math.random() * 2 - 1) * xr, Math.random() * 1.2 - 0.88), V.camera);
    const d = _fray.ray.direction, o = _fray.ray.origin; if (d.y > -1e-3) continue;
    const q = _fray.ray.at((fy - o.y) / d.y, new THREE.Vector3());
    if (hb.containsPoint(q.clone().setY(mid)) || Math.hypot(q.x - jW.x, q.z - jW.z) > 16 * s) continue;
    if (others.some(f => f && f.p && Math.hypot(f.p.x - q.x, f.p.z - q.z) < 1.8 * s)) continue;
    return q;
  }
  return null;
}
function buildFires(P, S, s, fy, box) {
  const spots = [];
  for (let i = 0; i < 3; i++) spots.push(randomFireSpot(P, S, s, fy, box, spots.map(p => ({ p }))) || P.j.clone().applyMatrix4(S).setY(fy).addScalar(3 * s * (i - 1)));
  if (!FIRE.glowTex) {
    FIRE.glowTex = radialTex([[0, 'rgba(255,150,60,0.9)'], [0.35, 'rgba(255,90,20,0.35)'], [1, 'rgba(255,60,0,0)']]);
    FIRE.smokeTex = radialTex([[0, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]);
  }
  return spots.map((p, i) => {
    p.y = fy;
    const grp = new THREE.Group(); grp.position.copy(p); grp.visible = false; V.scene.add(grp);
    const cards = [0, 1].map(k => {
      const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uSeed: { value: i * 3.7 + k * 1.9 }, uAmt: { value: 1 } }, vertexShader: FIRE_VS, fragmentShader: FIRE_FS, defines: { OCT: COARSE ? 3 : 5 },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const w = (k ? 0.75 : 0.95) * s, hgt = (k ? 1.05 : 1.3) * s, geo = new THREE.PlaneGeometry(w, hgt); geo.translate(0, hgt / 2, 0);
      const mesh = new THREE.Mesh(geo, m); mesh.position.x = (k ? 0.12 : -0.05) * s; mesh.renderOrder = 7; grp.add(mesh); return mesh;
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.6 * s, 2.6 * s), new THREE.MeshBasicMaterial({ map: FIRE.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.006 * s; glow.renderOrder = 3; grp.add(glow);
    const SN = 46, sp = new Float32Array(SN * 3).fill(-1e4), sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const smoke = new THREE.Points(sg, new THREE.PointsMaterial({ map: FIRE.smokeTex, color: 0x4a4744, size: 0.9 * s, transparent: true, opacity: 0.16, depthWrite: false }));
    smoke.frustumCulled = false; smoke.renderOrder = 2; V.scene.add(smoke); smoke.visible = false;
    return { grp, cards, glow, smoke, sp, sage: new Float32Array(SN).fill(9), svel: new Float32Array(SN * 3), p, hp: 1, out: false, outAt: 0, relight: 4 + Math.random() * 3, steam: 0, shown: 0, s };
  });
}
function fireCounter(list, show) {
  if (!FIRE.dom) {
    const st = document.getElementById('drawer-stage-3d'); if (!st) return;
    FIRE.dom = document.createElement('div'); FIRE.dom.className = 'drawer__fires'; FIRE.dom.setAttribute('aria-live', 'polite'); st.appendChild(FIRE.dom);
  }
  const n = list ? list.filter(f => f.out).length : 0, all = list && n === list.length;
  const txt = all ? 'All fires out' : `Fires out ${n} / ${list ? list.length : 0}`;
  if (FIRE.dom.textContent !== txt) FIRE.dom.textContent = txt;
  FIRE.dom.classList.toggle('is-on', !!show); FIRE.dom.classList.toggle('is-done', !!all);
}
function updateFires(dt, P, S, s, fy, inGun, path) {
  const r = V.models[V.url], key = V.url;
  if (FIRE.key !== key) {                                  // another product: its own fires
    if (FIRE.list) for (const f of FIRE.list) { V.scene.remove(f.grp); V.scene.remove(f.smoke); f.cards.forEach(c => { c.geometry.dispose(); c.material.dispose(); }); f.glow.geometry.dispose(); f.smoke.geometry.dispose(); }
    FIRE.list = null; FIRE.key = key;
  }
  if (!FIRE.list) {                                        // built once the Gun view has settled
    const c = V.camera.position, moving = !FIRE.cam || FIRE.cam.distanceToSquared(c) > 1e-8;
    FIRE.cam = (FIRE.cam || new THREE.Vector3()).copy(c); FIRE.still = moving || !inGun ? 0 : (FIRE.still || 0) + dt;
    if (!inGun || FIRE.still < 0.35) { fireCounter(null, false); return; }   // the camera has to have settled on the Gun view
    FIRE.list = buildFires(P, S, s, fy, r.bbox);
  }
  FIRE.t += dt; const now = FIRE.t, cam = V.camera.position;
  for (const f of FIRE.list) {
    f.shown += ((inGun ? 1 : 0) - f.shown) * Math.min(1, dt * 4);
    const vis = f.shown > 0.01; f.grp.visible = vis;
    // foam coming down on the fire (the stream path's low samples within the fire's radius)
    let hit = false;
    if (inGun && path && !f.out) for (const q of path) { if (q.y < fy + 1.4 * s && Math.hypot(q.x - f.p.x, q.z - f.p.z) < 0.6 * s) { hit = true; break; } }
    if (hit) { f.hp = Math.max(0, f.hp - dt / 2.0); f.steam = Math.min(1, f.steam + dt * 3); } else f.steam = Math.max(0, f.steam - dt * 1.5);
    if (!f.out && f.hp <= 0) { f.out = true; f.outAt = now; f.steam = 1.6; }
    if (f.out && now - f.outAt > f.relight && f.steam < 0.05) {       // pops up again somewhere else in view
      const q = inGun && randomFireSpot(P, S, s, fy, r.bbox, FIRE.list.filter(o => o !== f && !o.out));
      if (q) { f.p.copy(q); f.grp.position.copy(q); }
      f.out = false; f.hp = 0.02; f.relight = 4 + Math.random() * 3;
    }
    if (!f.out && !hit) f.hp = Math.min(1, f.hp + dt / 1.5 * (f.hp < 1 ? 1 : 0));
    const amt = f.out ? 0 : f.hp, fl = 0.85 + 0.15 * Math.sin(now * 13 + f.p.x * 7) * Math.sin(now * 7.3 + f.p.z * 5);
    for (const c of f.cards) { c.material.uniforms.uTime.value = now; c.material.uniforms.uAmt.value = amt * f.shown; c.rotation.y = Math.atan2(cam.x - f.p.x, cam.z - f.p.z); c.visible = amt > 0.01; }
    f.glow.material.opacity = amt * f.shown * fl * 0.85;
    // smoke (grey) / steam (white) - rising, drifting, fading
    const steamy = Math.min(1, f.steam), emit = vis && f.steam > 0.05;            // steam only (idle dark smoke read as black specks)
    f.smoke.visible = vis; f.smoke.material.color.setRGB(0.92, 0.93, 0.95);
    f.smoke.material.opacity = 0.3 * steamy * f.shown;
    for (let i = 0; i < f.sage.length; i++) {
      f.sage[i] += dt;
      if (f.sage[i] > 2.4) {
        if (!emit || Math.random() > dt * 22) { f.sp[i * 3 + 1] = -1e4; continue; }
        f.sage[i] = 0; f.sp[i * 3] = f.p.x + (Math.random() - 0.5) * 0.4 * s; f.sp[i * 3 + 1] = fy + (0.5 + 0.6 * amt) * s; f.sp[i * 3 + 2] = f.p.z + (Math.random() - 0.5) * 0.4 * s;
        f.svel[i * 3] = (Math.random() - 0.5) * 0.25 * s; f.svel[i * 3 + 1] = (0.7 + Math.random() * 0.5 + steamy) * s; f.svel[i * 3 + 2] = (Math.random() - 0.5) * 0.25 * s;
      }
      f.sp[i * 3] += f.svel[i * 3] * dt; f.sp[i * 3 + 1] += f.svel[i * 3 + 1] * dt; f.sp[i * 3 + 2] += f.svel[i * 3 + 2] * dt;
    }
    f.smoke.geometry.attributes.position.needsUpdate = true;
  }
  fireCounter(FIRE.list, inGun);
}
function updateProdGun(dt) {
  const P = prodGunRig();
  if (!P) { if (PGUN.stream) for (const Lr of PGUN.stream.layers) Lr.pts.visible = false; if (PGUN.reticle) PGUN.reticle.visible = false; if (PGUN.tube) PGUN.tube.mesh.visible = false;
    if (FIRE.list) for (const f of FIRE.list) { f.grp.visible = false; f.smoke.visible = false; } fireCounter(null, false); return; }
  const inGun = mode === 'gun';
  if (!inGun) { PGUN.yawT = Math.round(PGUN.yaw / (2 * Math.PI)) * 2 * Math.PI; PGUN.pitchT = 0; if (PGUN.reticle) PGUN.reticle.visible = false; }
  const d = Math.min(dt, 0.05), k = 1 - Math.pow(POV.on ? 0.95 : 0.86, d * 60);   // Phase 121: in POV the cannon turns slower, like a real monitor
  const y0 = PGUN.yaw, p0 = PGUN.pitch;
  PGUN.yaw += (PGUN.yawT - PGUN.yaw) * k; PGUN.pitch += (PGUN.pitchT - PGUN.pitch) * k; PGUN.speed += (PGUN.speedT - PGUN.speed) * k;
  if (Math.abs(PGUN.yawT - PGUN.yaw) < 1e-4) PGUN.yaw = PGUN.yawT;
  if (Math.abs(PGUN.pitchT - PGUN.pitch) < 1e-4) PGUN.pitch = PGUN.pitchT;
  if (!inGun && PGUN.yaw === PGUN.yawT) PGUN.yaw = PGUN.yawT = 0;              // at rest: drop the whole turns
  const moved = PGUN.dirty || PGUN.yaw !== y0 || PGUN.pitch !== p0;
  if (moved || PGUN.yaw || PGUN.pitch || !P.a.lods.size || [...P.a.lods.values()].some(L => !PGUN.rest.has(L.scene))) poseProdGun(P, PGUN.yaw, PGUN.pitch);
  if (moved) { V.renderer.shadowMap.needsUpdate = true; PGUN.dirty = false; }
  const S = prodGunFrame(P); if (!S) return;
  const s = _pg.s.setFromMatrixScale(S).x, fy = V.stageState && Number.isFinite(V.stageState.floorY) ? V.stageState.floorY : -1e3;
  const HP = prodGunPitch(P, PGUN.pitch, _pg.H), HT = _pg.HT.copy(prodGunYaw(P, PGUN.yaw, _pg.M)).multiply(HP);   // the head, asset frame
  _pg.mz.copy(P.mz).applyMatrix4(HT).applyMatrix4(S);
  _pg.dir.copy(P.d).transformDirection(HT).transformDirection(S);
  stepProdStream(d, foamOn && inGun, _pg.mz, _pg.dir, s, fy);
  stepStreamTube(d, foamOn && inGun, _pg.mz, _pg.dir, s, fy);
  updateFires(d, P, S, s, fy, inGun, PGUN.path);
}

// ── Suppression-system mist: one emitter per Nozzle_### anchor ────────────
// A vehicle system discharges from every nozzle at once, so instead of one
// cannon plume this is a single Points cloud whose particles are assigned
// round-robin to the anchor empties exported from Blender. Each anchor's
// local +Z is the spray direction. The model never animates (only the camera
// moves), so world origins/directions are baked once at load.
// Extra yaw applied on top of the standard 180° turn, per product URL.
// Legacy GLBs only (production assets carry `viewerYaw` in their manifest): the legacy vss-830e.glb arrives tail-on.
const FRONT_YAW = [
  [/vss-830e\.glb/, Math.PI],
];

const MIST_BUDGET = 9000;   // total particles shared across every nozzle

// Spray axis in the anchor's LOCAL frame. The Phase 12 production export declares it
// in the anchor extras ("+Y": Blender's +Z after the glTF Y-up conversion); anchors
// without the tag (the legacy vss-830e.glb) keep the original +Z convention.
function sprayAxis(n) {
  const s = (n.userData && n.userData.spray_axis_local) || '+Z';
  return /^\+?Y$/i.test(s) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
}

function collectNozzles(model) {
  const out = [];
  model.traverse(n => { if (normName(n.name) === 'nozzle') out.push(n); });
  return out;
}

// `span` is the model's longest side in VIEWER units (every GLB is normalised
// to the same 3.4-unit box). Sizing off that instead of group.scale keeps the
// mist right whatever unit mess the CAD export arrived in.
// Phase 82j: `hits` (manifest.discharge.hits, asset frame: per nozzle name the first vehicle surface along its spray axis) and
// `AF` (asset frame -> world) make the spray strike that surface - it splashes off (reflected, slowed, spread) and drips.
const MIST_SPLASH = [];                  // world points where droplets struck a surface / the ground this frame (wet ground)
function buildMist(nozzles, span, hits = null, AF = null) {
  if (!nozzles.length) return null;
  const per = Math.max(6, Math.floor(MIST_BUDGET / nozzles.length));
  const count = per * nozzles.length;
  const org = [], dir = [];
  const q = new THREE.Quaternion();
  for (const n of nozzles) {
    n.updateWorldMatrix(true, false);
    org.push(n.getWorldPosition(new THREE.Vector3()));
    dir.push(sprayAxis(n).applyQuaternion(n.getWorldQuaternion(q)).normalize());
  }
  const hitD = new Float32Array(nozzles.length), hitN = new Float32Array(nozzles.length * 3);
  if (hits && AF) {
    const sc = new THREE.Vector3().setFromMatrixScale(AF).x, nv = new THREE.Vector3();
    nozzles.forEach((n, k) => { const h = hits[n.name]; if (!h) return;
      hitD[k] = h[0] * sc; nv.set(h[1], h[2], h[3]).transformDirection(AF); hitN[k * 3] = nv.x; hitN[k * 3 + 1] = nv.y; hitN[k * 3 + 2] = nv.z; });
  }
  // The Blender render throws 2.7 m on a 16 m machine — 17% of its length —
  // in a 27° full cone. Expressed against `span` that holds for any model.
  const LIFE = 0.62, REACH = 0.17 * span;
  const speed0 = REACH / LIFE;
  const SPREAD = Math.tan(THREE.MathUtils.degToRad(13.5));
  const positions = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count), max = new Float32Array(count);
  const tmp = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3();
  const spawn = (i, stagger) => {
    const k = i % nozzles.length, o = org[k], d = dir[k];
    positions[i * 3] = o.x; positions[i * 3 + 1] = o.y; positions[i * 3 + 2] = o.z;
    side.set(-d.y, d.x, 0);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    up.crossVectors(d, side);
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * SPREAD;
    const s = speed0 * (0.72 + Math.random() * 0.5);
    tmp.copy(d).addScaledVector(side, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).multiplyScalar(s);
    vel[i * 3] = tmp.x; vel[i * 3 + 1] = tmp.y; vel[i * 3 + 2] = tmp.z;
    max[i] = LIFE * (0.7 + Math.random() * 0.6);
    life[i] = stagger ? Math.random() * max[i] : 0;
    if (splashed) splashed[i] = 0;
  };
  let splashed = null;
  for (let i = 0; i < count; i++) spawn(i, true);
  splashed = new Uint8Array(count);
  const age = new Float32Array(count);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aT', new THREE.BufferAttribute(age, 1));
  // Per-particle age drives size AND alpha, which is what makes this read as
  // the Blender volume cone rather than a cloud of equal dots: tight and
  // bright at the orifice, spreading and dissolving toward the end of the throw.
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 0.030 * span },
      uScale: { value: 600 },
      uColor: { value: new THREE.Color(0xeaf4ff) },
      uOpacity: { value: 0.85 },
    },
    vertexShader: `
      attribute float aT;
      uniform float uSize; uniform float uScale;
      varying float vT;
      void main() {
        vT = aT;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * (0.30 + 2.1 * aT) * (uScale / max(0.0001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity;
      varying float vT;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, r);
        a *= a;
        gl_FragColor = vec4(uColor, a * pow(1.0 - vT, 1.25) * uOpacity);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.visible = false;
  V.scene.add(points);
  return { points, geom, positions, vel, life, max, age, count, spawn, grav: 0.16 * span, org, dir, hitD, hitN, splashed, nz: nozzles.length };
}

function updateMist(dt) {
  if (!V || !V.models) return;
  for (const k in V.models) {
    const r = V.models[k];
    if (r.mist && k !== V.url) r.mist.points.visible = false;
  }
  const cur = V.models[V.url], m = cur && cur.mist;
  if (!m) return;
  if (!(systemOn && mode === 'system')) {
    if (m.points.visible) m.points.visible = false;
    return;
  }
  if (!m.points.visible) m.points.visible = true;
  { const want = FOCUS.want ? 0.3 : 0.85, u = m.points.material.uniforms.uOpacity; u.value += (want - u.value) * Math.min(1, dt * 4); }   // Phase 82s: quieter close-ups
  // Point sizes are in world units, so they need the projection scale for the
  // live canvas height — refreshed here so a resize cannot desync them.
  const h = V.renderer.domElement.height || 720;
  m.points.material.uniforms.uScale.value =
    h * 0.5 / Math.tan(THREE.MathUtils.degToRad(V.camera.fov * 0.5));
  const d = Math.min(dt, 0.05);
  const { positions, vel, life, max, age, count, spawn, grav, org, dir, hitD, hitN, splashed, nz } = m;
  const fy = V.stageState && Number.isFinite(V.stageState.floorY) ? V.stageState.floorY : -1e9;
  MIST_SPLASH.length = 0;
  for (let i = 0; i < count; i++) {
    life[i] += d;
    if (life[i] >= max[i]) { spawn(i, false); age[i] = 0; continue; }
    const k = i % nz, x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!splashed[i] && hitD[k] > 0) {                    // Phase 82j: the droplet reaches the surface in front of its nozzle
      const o = org[k], dv = dir[k];
      if ((x - o.x) * dv.x + (y - o.y) * dv.y + (z - o.z) * dv.z >= hitD[k]) {
        const nx = hitN[k * 3], ny = hitN[k * 3 + 1], nzz = hitN[k * 3 + 2];
        const vx = vel[i * 3], vy = vel[i * 3 + 1], vz = vel[i * 3 + 2], vn = vx * nx + vy * ny + vz * nzz, sp = Math.hypot(vx, vy, vz);
        vel[i * 3]     = (vx - 1.3 * vn * nx) * 0.45 + (Math.random() - 0.5) * 0.5 * sp;
        vel[i * 3 + 1] = (vy - 1.3 * vn * ny) * 0.45 + (Math.random() - 0.5) * 0.3 * sp;
        vel[i * 3 + 2] = (vz - 1.3 * vn * nzz) * 0.45 + (Math.random() - 0.5) * 0.5 * sp;
        splashed[i] = 1; max[i] = Math.min(max[i], life[i] + 0.18 + Math.random() * 0.25);
        if (MIST_SPLASH.length < 90 && Math.random() < 0.25) MIST_SPLASH.push(x, y, z);
      }
    }
    if (y < fy) { if (MIST_SPLASH.length < 120) MIST_SPLASH.push(x, fy, z); life[i] = max[i]; continue; }
    vel[i * 3 + 1] -= grav * d * (splashed[i] ? 2.6 : 1);   // fine droplets droop as they slow; splashed ones drip
    positions[i * 3]     += vel[i * 3] * d;
    positions[i * 3 + 1] += vel[i * 3 + 1] * d;
    positions[i * 3 + 2] += vel[i * 3 + 2] * d;
    age[i] = life[i] / max[i];
  }
  m.geom.attributes.position.needsUpdate = true;
  m.geom.attributes.aT.needsUpdate = true;
}

// ── VSS discharge presentation (Phase 82j) ───────────────────────
// Owner 2026-10-05: in-cab protection, an escape route at the front of the truck that only shows when the system goes off, the
// camera pulling back so truck + system are seen, spray striking the surfaces (buildMist hits), the ground getting wet.
// Data: manifest.discharge (asset frame, glTF Y up). Everything lives in one group carrying the asset frame, so it follows the
// product's placement. Active while the system discharges in System mode; the wet ground dries over ~15 s afterwards.
const DIS = { key: null, g: null, cab: null, route: null, wet: null, labels: null, on: 0, t: 0, was: false, wetUntil: 0, inv: new THREE.Matrix4(), v: new THREE.Vector3() };
function disAssetFrame(r) { const a = r && r.production; if (!a) return null; for (const L of a.lods.values()) { L.scene.updateMatrixWorld(); return L.scene.matrixWorld; } return null; }
function mistShader(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 0.1 }, uScale: { value: 600 }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
    vertexShader: `attribute float aT; uniform float uSize; uniform float uScale; varying float vT;
      void main() { vT = aT; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * (0.35 + 2.0 * aT) * (uScale / max(0.0001, -mv.z)); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vT;
      void main() { float r = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, r); a *= a;
        gl_FragColor = vec4(uColor, a * pow(1.0 - vT, 1.1) * uOpacity); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}
function buildCabMist(c) {                       // fine mist from the cab ceiling, contained by the cab (bounces off walls / glass)
  const n = COARSE ? 320 : 900, pos = new Float32Array(n * 3).fill(-1e4), vel = new Float32Array(n * 3), life = new Float32Array(n).fill(9), max = new Float32Array(n).fill(1), age = new Float32Array(n);
  const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geom.setAttribute('aT', new THREE.BufferAttribute(age, 1));
  const pts = new THREE.Points(geom, mistShader(0xeaf4ff, 0.32)); pts.frustumCulled = false; pts.renderOrder = 5;
  return { pts, geom, pos, vel, life, max, age, n, box: c.box, noz: c.nozzles, acc: 0, next: 0 };
}
function stepCabMist(C, dt, emit) {
  const { pos, vel, life, max, age, n, box } = C; let alive = 0;
  if (emit) { C.acc += n / 1.4 * dt; let k = Math.floor(C.acc); C.acc -= k;
    while (k-- > 0) { const i = C.next, o = C.noz[(Math.random() * C.noz.length) | 0]; C.next = (C.next + 1) % n;
      pos[i * 3] = o[0] + (Math.random() - 0.5) * 0.06; pos[i * 3 + 1] = o[1]; pos[i * 3 + 2] = o[2] + (Math.random() - 0.5) * 0.06;
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.75, sp = 1.5 + Math.random() * 0.9;
      vel[i * 3] = Math.cos(a) * r * sp; vel[i * 3 + 1] = -sp; vel[i * 3 + 2] = Math.sin(a) * r * sp; life[i] = 0; max[i] = 1.1 + Math.random() * 0.6; } }
  for (let i = 0; i < n; i++) {
    if (life[i] >= max[i]) { pos[i * 3 + 1] = -1e4; continue; }
    life[i] += dt; vel[i * 3 + 1] -= 0.5 * dt;
    for (let c = 0; c < 3; c++) {
      vel[i * 3 + c] *= 1 - 0.9 * dt; let p = pos[i * 3 + c] + vel[i * 3 + c] * dt;
      if (p < box[c]) { p = box[c]; vel[i * 3 + c] = Math.abs(vel[i * 3 + c]) * 0.3; } else if (p > box[c + 3]) { p = box[c + 3]; vel[i * 3 + c] = -Math.abs(vel[i * 3 + c]) * 0.3; }
      pos[i * 3 + c] = p;
    }
    age[i] = Math.min(1, life[i] / max[i]); alive++;
  }
  C.pts.visible = alive > 0;
  if (alive) { C.geom.attributes.position.needsUpdate = true; C.geom.attributes.aT.needsUpdate = true; }
}
function buildRoute(e) {                         // Phase 82l: a flowing light ribbon on the walking line + sleek chevrons + safe-point beacon
  const curve = new THREE.CatmullRomCurve3(e.points.map(p => new THREE.Vector3(...p)), false, 'centripetal', 0.5), L = curve.getLength();
  const col = new THREE.Color(0x35ffa0);
  // ribbon: flat strip laid along the path (side = tangent x up), lifted 3 cm; light pulses run along it toward the exit
  const S = Math.max(80, Math.round(L * 14)), W = 0.16, pos = new Float32Array((S + 1) * 2 * 3), uv = new Float32Array((S + 1) * 2 * 2), ix = [];
  const p = new THREE.Vector3(), tn = new THREE.Vector3(), sd = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= S; i++) {
    const u = i / S; curve.getPointAt(u, p); curve.getTangentAt(u, tn); sd.crossVectors(tn, UP); if (sd.lengthSq() < 1e-6) sd.set(1, 0, 0); sd.normalize();
    for (let j = 0; j < 2; j++) { const k = i * 2 + j, sg = j ? 1 : -1; pos[k * 3] = p.x + sd.x * W * sg; pos[k * 3 + 1] = p.y + 0.03 + sd.y * W * sg; pos[k * 3 + 2] = p.z + sd.z * W * sg; uv[k * 2] = u * L; uv[k * 2 + 1] = j; }
    if (i < S) { const a = i * 2; ix.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); rg.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); rg.setIndex(ix);
  const rm = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uShow: { value: 0 }, uLen: { value: L }, uCol: { value: col } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime, uShow, uLen; uniform vec3 uCol; varying vec2 vUv;
      void main() {
        float edge = 1.0 - abs(vUv.y * 2.0 - 1.0);                       // soft-edged strip, bright core line
        float core = smoothstep(0.55, 1.0, edge), body = smoothstep(0.0, 0.9, edge);
        float s = vUv.x - uTime * 2.2;                                     // pulses travel toward the exit (2.2 m/s)
        float pulse = pow(0.5 + 0.5 * cos(6.2832 * s / 1.6), 6.0);
        float ends = smoothstep(0.0, 0.6, vUv.x) * smoothstep(0.0, 1.2, uLen - vUv.x);
        float reveal = smoothstep(uShow * (uLen + 2.0) - 2.0, uShow * (uLen + 2.0) - 0.5, vUv.x);   // draws itself from the cab out
        float a = (0.16 * body + 0.55 * core + 0.75 * pulse * body) * ends * (1.0 - reveal) * min(1.0, uShow * 2.0);
        gl_FragColor = vec4(uCol * (1.0 + 1.4 * pulse * core), a);
      }`, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
  const ribbon = new THREE.Mesh(rg, rm); ribbon.frustumCulled = false; ribbon.renderOrder = 7;
  // chevrons: thin, sharp, flat on the walking line (tip toward -Z for Matrix4.lookAt)
  const sh = new THREE.Shape(); [[0, 0.13], [0.15, -0.02], [0.15, -0.075], [0, 0.075], [-0.15, -0.075], [-0.15, -0.02]].forEach(([x, y], i) => i ? sh.lineTo(x, y) : sh.moveTo(x, y));
  const cg = new THREE.ShapeGeometry(sh); cg.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
  const N = Math.max(8, Math.round(L / 1.1)), inst = new THREE.InstancedMesh(cg, mat, N); inst.frustumCulled = false; inst.renderOrder = 8;
  // safe point: two expanding rings + a soft disc
  const end = curve.getPointAt(1), beacon = new THREE.Group(); beacon.position.set(end.x, end.y + 0.03, end.z);
  const ringM = () => new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
  const rings = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), ringM()); m.rotation.x = -Math.PI / 2; m.renderOrder = 7; beacon.add(m); return m; });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 48), ringM()); disc.rotation.x = -Math.PI / 2; disc.renderOrder = 7; beacon.add(disc);
  return { curve, L, N, inst, ribbon, beacon, rings, disc, line: ribbon, ring: beacon, phase: 0, m: new THREE.Matrix4(), p: new THREE.Vector3(), tn: new THREE.Vector3(), tg: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), sv: new THREE.Vector3() };
}
function stepRoute(R, dt, show) {
  R.phase = (R.phase + dt * 1.1 / R.L) % 1;
  const vis = show > 0.01; R.inst.visible = R.ribbon.visible = R.beacon.visible = vis; if (!vis) return;
  R.ribbon.material.uniforms.uTime.value = DIS.t; R.ribbon.material.uniforms.uShow.value = show;
  R.inst.material.opacity = 0.9 * show;
  R.rings.forEach((m, i) => { const k = (DIS.t * 0.6 + i * 0.5) % 1; m.scale.setScalar(0.4 + 0.9 * k); m.material.opacity = (1 - k) * 0.8 * show; });
  R.disc.material.opacity = (0.16 + 0.08 * Math.sin(DIS.t * 3)) * show;
  for (let j = 0; j < R.N; j++) {
    const u = (j / R.N + R.phase) % 1; R.curve.getPointAt(u, R.p); R.curve.getTangentAt(u, R.tn);
    const sc = Math.min(1, u * 12, (1 - u) * 12) * Math.min(1, show * 1.5);
    R.p.y += 0.05; R.tg.copy(R.p).add(R.tn);
    R.m.lookAt(R.p, R.tg, R.up); R.m.scale(R.sv.setScalar(Math.max(0.001, sc))); R.m.setPosition(R.p);
    R.inst.setMatrixAt(j, R.m);
  }
  R.inst.instanceMatrix.needsUpdate = true;
}
function buildWet() {                            // Phase 82n: damp ground = darkening only (no reflection), organic edges
  const W = 512, H = 896, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const ext = { x0: -8, x1: 8, z0: -12, z1: 16 }, w = ext.x1 - ext.x0, h = ext.z1 - ext.z0;
  const geo = new THREE.PlaneGeometry(w, h); geo.rotateX(-Math.PI / 2);   // +Y of the plane -> -Z: v = 1 at z0
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMask: { value: tex } },
    vertexShader: `varying vec2 vUv; varying vec2 vW; void main() { vUv = uv; vW = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D uMask; varying vec2 vUv; varying vec2 vW;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y); }
      void main() {
        float m = texture2D(uMask, vUv).g;
        float n = n2(vW * 1.3) * 0.55 + n2(vW * 3.7) * 0.3 + n2(vW * 11.0) * 0.15;      // ground-scale breakup
        float wet = smoothstep(0.12, 0.55, m + (n - 0.5) * 0.45);                       // irregular, soft-edged damp areas
        float pud = smoothstep(0.6, 0.95, m + (n - 0.5) * 0.3);                          // a little darker where it pooled
        gl_FragColor = vec4(0.0, 0.0, 0.0, wet * 0.32 + pud * 0.12);                     // darkening only - no reflection
      }`,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(geo, mat); mesh.position.set((ext.x0 + ext.x1) / 2, 0, (ext.z0 + ext.z1) / 2); mesh.renderOrder = 1; mesh.receiveShadow = false;
  return { cv, ctx, tex, mesh, ext, W, H, dirty: false, lastUp: 0, lastDry: 0 };
}
function wetPaint(Wt, x, z, r, a) {
  const { ext, W, H, ctx } = Wt, px = (x - ext.x0) / (ext.x1 - ext.x0) * W, py = (z - ext.z0) / (ext.z1 - ext.z0) * H, pr = r / (ext.x1 - ext.x0) * W;
  if (px < -pr || py < -pr || px > W + pr || py > H + pr) return;
  const g = ctx.createRadialGradient(px, py, 0, px, py, pr); g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.6, `rgba(255,255,255,${a * 0.5})`); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = g; ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2); Wt.dirty = true;
}
function disLabel(text, cls) { const st = document.getElementById('drawer-stage-3d'); if (!st) return null; const el = document.createElement('div'); el.className = 'drawer__dlabel ' + (cls || ''); el.textContent = text; st.appendChild(el); return el; }
function buildDischarge(r, D) {
  const g = new THREE.Group(); g.matrixAutoUpdate = false; V.scene.add(g);
  // the cab glazing (transmissive, drawn after the opaque parts) stops writing depth, so the in-cab mist shows through the windows;
  // the walls and roof still hide it
  r.production.root.traverse(o => { if (!o.isMesh || !/_Cab_/.test(o.name)) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (/^WEB_GLASS/.test(m.name || '')) m.depthWrite = false; });
  const o = { g, cab: D.cab ? buildCabMist(D.cab) : null, route: D.escape ? buildRoute(D.escape) : null, wet: buildWet(), labels: [] };
  if (o.cab) g.add(o.cab.pts);
  if (o.route) { g.add(o.route.ribbon); g.add(o.route.inst); g.add(o.route.beacon); o.route.ribbon.layers.enable(FOCUS_LAYER); o.route.inst.layers.enable(FOCUS_LAYER); }
  g.add(o.wet.mesh);
  if (D.cab && D.cab.label) { const b = D.cab.box; o.labels.push({ el: disLabel(D.cab.label, 'is-cab'), p: new THREE.Vector3((b[0] + b[3]) / 2, b[4] + 0.75, (b[2] + b[5]) / 2), cab: true }); }
  if (D.escape && D.escape.label) { const P = D.escape.points, q = P[Math.max(0, P.length - 3)]; o.labels.push({ el: disLabel(D.escape.label, 'is-escape'), p: new THREE.Vector3(q[0], q[1] + 1.1, q[2]), route: true }); }
  return o;
}
// Shot chips (Phase 82k): while it discharges, a row of tags - Vehicle / Whole system / In-cab protection / Escape route - each
// flying the camera to its shot (manifest.discharge.shots). Activation lands on the first ("Vehicle", pulled back).
function disShot(sh, AF) {
  if (!sh || !V.pcam || !V.pcam.active) return;
  DIS.shot = sh.id; DIS.solid = !!sh.solid;
  if (DIS.chips) { let on = null; for (const b of DIS.chips.querySelectorAll('button')) { const a = b.dataset.shot === sh.id; b.setAttribute('aria-pressed', String(a)); if (a) on = b; }
    const cap = DIS.chips.querySelector('.drawer__shot-cap');
    if (cap) { cap.textContent = sh.caption || ''; cap.classList.add('is-on'); clearTimeout(DIS.capT); DIS.capT = setTimeout(() => cap.classList.remove('is-on'), 3200); }   // Phase 82s: brief
    const ind = DIS.chips.querySelector('.drawer__shot-ind'); if (ind) { ind.style.opacity = on ? 1 : 0; if (on) { ind.style.width = on.offsetWidth + 'px'; ind.style.transform = `translateX(${on.offsetLeft}px)`; ind.dataset.shot = sh.id; } } }
  const dir = V.camera.position.clone().sub(V.controls.target);
  if (sh.framing) {
    const fr = V.pcam.framing(sh.framing, { direction: dir.lengthSq() > 1e-8 ? dir : null });
    if (sh.framing === 'full') {                  // well back: the whole truck, the route and its safe point ahead in frame
      const d = Math.max(fr.distance * 1.35, 1e-3), u = dir.normalize();
      fr.distance = d; fr.position = fr.target.clone().addScaledVector(u, d); fr.limits = { ...fr.limits, maxDistance: Math.max(fr.limits.maxDistance, d * 1.05) };
    }
    V.pcam.moveTo(fr); V.controls.autoRotate = false; lastInteract = performance.now(); return;
  }
  const sc = new THREE.Vector3().setFromMatrixScale(AF).x, t = new THREE.Vector3().fromArray(sh.target).applyMatrix4(AF);
  const d = new THREE.Vector3().fromArray(sh.direction).transformDirection(AF), dist = sh.distance * sc * Math.max(1, 1.1 / Math.max(0.3, V.camera.aspect));   // tuned at a 1.1 aspect: portrait steps back
  DIS.lastT = t.toArray().map(v => +v.toFixed(3));
  focusFeatures([], { target: t.toArray(), radius: 0.5 * sc, azimuth: Math.atan2(d.z, d.x) * 180 / Math.PI, elevation: sh.elevation, distance: dist, minDistance: dist * 0.6, maxDistance: dist * 1.2 });
}
const SHOT_ICON = {                             // 18 px line icons (stroke = currentColor)
  vehicle: '<path d="M2 14h13l2-5h4l1 5v3H2z"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/><path d="M4 14V9h7v5"/>',
  system: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>',
  cab: '<path d="M4 20V6l3-3h10l3 3v14z"/><path d="M7 9h10v5H7z"/><path d="M9 3v2M12 3v2M15 3v2"/>',
  escape: '<path d="M13 4a2 2 0 1 0 0 .01"/><path d="M10 21l2-6 3 2v4M7 12l3-4 4 1 2 3 3 1M12 15l-1-5"/><path d="M3 21h4"/>' };
function buildChips(D) {
  const st = document.getElementById('drawer-stage-3d'); if (!st || !D.shots || !D.shots.length) return null;
  const el = document.createElement('div'); el.className = 'drawer__shots'; el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Discharge views');
  const ind = document.createElement('span'); ind.className = 'drawer__shot-ind'; ind.setAttribute('aria-hidden', 'true'); el.appendChild(ind);
  for (const sh of D.shots) { const b = document.createElement('button'); b.type = 'button'; b.className = 'drawer__shot'; b.dataset.shot = sh.id; b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHOT_ICON[sh.id] || SHOT_ICON.system}</svg><span>${sh.label}</span>`;
    b.addEventListener('click', (e) => { e.stopPropagation(); const r = V.models[V.url]; disShot(sh, disAssetFrame(r)); }); el.appendChild(b); }
  const cap = document.createElement('div'); cap.className = 'drawer__shot-cap'; cap.setAttribute('aria-live', 'polite'); el.appendChild(cap);
  st.appendChild(el); return el;
}
// Hidden parts (Phase 82m, manifest.hide): per LOD as it appears, triangles inside a box (asset frame) that run along x (span > minSpanX)
// and stay level (rise < maxRiseY) are dropped from the index - the stair head gate rails of the VSS. The source model is untouched.
const HIDDEN = new WeakSet();
function applyHides(r) {
  const a = r && r.production, H = a && a.manifest.hide; if (!H || !H.length) return;
  const v = new THREE.Vector3(), inv = new THREE.Matrix4(), M = new THREE.Matrix4();
  for (const L of a.lods.values()) {
    if (HIDDEN.has(L.scene)) continue; HIDDEN.add(L.scene);
    L.scene.updateMatrixWorld(true); inv.copy(L.scene.matrixWorld).invert();
    L.scene.traverse(o => {
      if (!o.isMesh || !o.geometry.index) return;
      const hs = H.filter(h => !h.meshes || o.name.includes(h.meshes)); if (!hs.length) return;
      M.multiplyMatrices(inv, o.matrixWorld); const pos = o.geometry.attributes.position, idx = o.geometry.index.array, nT = idx.length / 3;
      const P = new Float32Array(pos.count * 3); for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(M); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
      const inB = (b, i) => P[i * 3] >= b[0] && P[i * 3 + 1] >= b[1] && P[i * 3 + 2] >= b[2] && P[i * 3] <= b[3] && P[i * 3 + 1] <= b[4] && P[i * 3 + 2] <= b[5];
      const drop = new Uint8Array(nT);
      for (const h of hs) {
        const b = h.box;
        if (h.whole) {                            // connected pieces (welded by position) lying entirely inside the box
          const key = i => `${Math.round(P[i * 3] / 2e-4)},${Math.round(P[i * 3 + 1] / 2e-4)},${Math.round(P[i * 3 + 2] / 2e-4)}`;
          const par = new Map(), find = k => { while (par.get(k) !== k) { par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
          const touch = [], out = new Set();
          for (let t = 0; t < nT; t++) { const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2]; if (!(inB(b, i0) || inB(b, i1) || inB(b, i2))) continue;
            const ks = [key(i0), key(i1), key(i2)]; for (const k of ks) if (!par.has(k)) par.set(k, k);
            par.set(find(ks[1]), find(ks[0])); par.set(find(ks[2]), find(ks[0])); touch.push(t);
            if (!(inB(b, i0) && inB(b, i1) && inB(b, i2))) out.add(ks[0]); }
          const outRoots = new Set([...out].map(find));
          for (const t of touch) if (!outRoots.has(find(key(idx[t * 3])))) drop[t] = 1;
          continue;
        }
        for (let t = 0; t < nT; t++) {
          if (drop[t]) continue; const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
          if (!(inB(b, i0) && inB(b, i1) && inB(b, i2))) continue;
          const xs = [P[i0 * 3], P[i1 * 3], P[i2 * 3]], ys = [P[i0 * 3 + 1], P[i1 * 3 + 1], P[i2 * 3 + 1]];
          if (Math.max(...xs) - Math.min(...xs) > (h.minSpanX ?? 0) && Math.max(...ys) - Math.min(...ys) < (h.maxRiseY ?? 1e9)) drop[t] = 1;
        }
      }
      let cut = 0; const keep = []; for (let t = 0; t < nT; t++) { if (drop[t]) { cut++; continue; } keep.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]); }
      if (cut) o.geometry.setIndex(new THREE.BufferAttribute(new idx.constructor(keep), 1));
    });
  }
}
// Isolated close-ups (Phase 82k/o, owner: "as jy incab click moet die res van vehicle wireframe wees behalwe die incab, selfde met escape
// route"): the vehicle stays the System ghost, and only the part the shot is about is drawn solid - an overlay per vehicle mesh with
// just the selected triangles (shared vertex buffers, an opaque clone of the source material; the source is faded in System mode).
// cab = triangles inside the cab box; escape = triangles within 0.9 m of the escape route (deck, rails, stairs it passes).
const ISO = new Map(), _isoC = new THREE.Vector3();                            // `${mesh.uuid}|${kind}` -> overlay mesh (null when nothing selected)
function isoSelector(kind, D) {
  if (kind === 'cab' && D.cab) { const B = [1.38, 4.46, 2.10, 3.22, 6.16, 4.70];   // above the deck plate
    const inB = c => c.x >= B[0] && c.y >= B[1] && c.z >= B[2] && c.x <= B[3] && c.y <= B[4] && c.z <= B[5];
    return (c, a, b, d) => inB(a) && inB(b) && inB(d); }
  if (kind === 'escape' && D.escape) {                // Phase 82q (owner: "doen stairs alleen"): the two stairs only - the route from the
    // stair head landing (the first point below deck height) down to the ground, its centreline lifted 0.45 m so one radius takes the
    // treads below and the handrails above
    const P0 = D.escape.points, i0 = Math.max(0, P0.findIndex(p => p[1] < 4.3) - 1), i1 = P0.findIndex((p, i) => i > i0 && p[1] < 0.1);
    const pts = P0.slice(i0, i1 + 1).map(p => new THREE.Vector3(p[0], p[1] + 0.45, p[2])), R = 0.75, lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9);
    for (const p of pts) { lo.min(p); hi.max(p); } lo.subScalar(R); hi.addScalar(R);
    const ab = new THREE.Vector3(), ap = new THREE.Vector3();
    // per segment: the offset from the centreline split into sideways (horizontal, across the stair) and up/down - the stair is
    // narrow (stringers 0.30 m off the line) but tall (treads below, handrails above), and the radiator grille behind it is > 0.4 m aside
    const segs = []; for (let i = 0; i + 1 < pts.length; i++) { const u = new THREE.Vector3().subVectors(pts[i + 1], pts[i]), L = u.length(); if (L < 1e-6) continue; u.divideScalar(L);
      const sd = new THREE.Vector3().crossVectors(u, new THREE.Vector3(0, 1, 0)); if (sd.lengthSq() < 1e-6) sd.set(1, 0, 0); sd.normalize(); const vu = new THREE.Vector3().crossVectors(sd, u).normalize();
      segs.push({ p: pts[i], u, L, sd, vu }); }
    const dv = new THREE.Vector3();
    const near = (c, side, up) => { if (c.x < lo.x || c.y < lo.y || c.z < lo.z || c.x > hi.x || c.y > hi.y || c.z > hi.z) return false;
      for (const g of segs) { dv.subVectors(c, g.p); const t = dv.dot(g.u); if (t < -0.05 || t > g.L + 0.05) continue;
        dv.addScaledVector(g.u, -t); if (Math.abs(dv.dot(g.sd)) <= side && Math.abs(dv.dot(g.vu)) <= up) return true; }
      return false; };
    return (c, a, b, d) => near(c, 0.38, 0.75) && near(a, 0.45, 0.85) && near(b, 0.45, 0.85) && near(d, 0.45, 0.85);   // treads, stringers, handrails; no grille, no shards
  }
  return null;
}
// The outline: the System ghost's fresnel shell, brighter and tinted (cab blue, escape green) - edges glow, faces stay clear.
const ISO_MAT = {}, ISO_LINE = {};
function isoLineMaterial(kind) {
  return ISO_LINE[kind] || (ISO_LINE[kind] = new THREE.LineBasicMaterial({ color: kind === 'escape' ? 0x6dffb0 : 0x9cc8ff, transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
}
function isoMaterial(kind) {
  if (ISO_MAT[kind]) return ISO_MAT[kind];
  const col = kind === 'escape' ? [0.25, 1.0, 0.62] : [0.48, 0.72, 1.0];
  return (ISO_MAT[kind] = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(...col) }, uTime: { value: 0 } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uColor; uniform float uTime; varying vec3 vN; varying vec3 vV; void main() { float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); float rim = pow(f, 2.2); float a = 0.03 + 0.38 * rim; a *= 0.85 + 0.15 * sin(uTime * 2.4); gl_FragColor = vec4(uColor * (0.7 + 0.9 * rim), a); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
}
const ISO_EXCLUDE = { escape: /FRONT_MODULE|_CHASSIS|GLAZING|_CAB_/ };   // the radiator grille / front module behind the stair is not the stair
function featureTableOf(o) { for (let p = o; p; p = p.parent) if (p.userData && p.userData.featureTable) return p.userData.featureTable; return null; }
function buildIso(rec, kind, sel, inv, names) {
  const m = rec.mesh, g = m.geometry; if (!g.index || !m.parent) return null;
  const fa = g.attributes._feature_id_0, tbl = featureTableOf(m);
  // Phase 82q: named parts (manifest.discharge.isolate[kind]) - exact, no spatial guessing
  if (names) {
    if (!tbl || !fa) return null; const want = new Set(); tbl.forEach((f, i) => { if (names.has(f.name)) want.add(f.id ?? i); }); if (!want.size) return null;
    sel = null; var wantIds = want;
  }
  const ex = !names && ISO_EXCLUDE[kind], exIds = new Set(); if (ex && tbl && fa) tbl.forEach((f, i) => { if (ex.test(f.name || '')) exIds.add(f.id ?? i); });
  const M = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld), pos = g.attributes.position, idx = g.index.array, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(pos, idx[t]).applyMatrix4(M); b.fromBufferAttribute(pos, idx[t + 1]).applyMatrix4(M); c.fromBufferAttribute(pos, idx[t + 2]).applyMatrix4(M);
    if (wantIds) { if (wantIds.has(Math.round(fa.getX(idx[t])))) keep.push(idx[t], idx[t + 1], idx[t + 2]); continue; }
    if (exIds.size && exIds.has(Math.round(fa.getX(idx[t])))) continue;
    if (sel(_isoC.copy(a).add(b).add(c).multiplyScalar(1 / 3), a, b, c)) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  if (!keep.length) return null;
  const sg = new THREE.BufferGeometry(); for (const k in g.attributes) sg.setAttribute(k, g.attributes[k]);
  sg.setIndex(new THREE.BufferAttribute(new idx.constructor(keep), 1)); sg.computeBoundingSphere();
  // Phase 82p/q (owner: "net 'n wireframe outline" -> "gee die wireframe 'n nice outline"): crisp edge lines (feature edges > 28 deg)
  // over a dim tinted glow
  const o = new THREE.Group(), fill = new THREE.Mesh(sg, isoMaterial(kind)); fill.renderOrder = 5; fill.layers.enable(FOCUS_LAYER); o.add(fill);
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(sg, 28), isoLineMaterial(kind)); lines.renderOrder = 6; o.add(lines); o.name = 'pv_iso'; o.userData.pvOverlay = true; o.raycast = () => {};
  o.position.copy(m.position); o.quaternion.copy(m.quaternion); o.scale.copy(m.scale); o.visible = false;
  m.parent.add(o); return o;
}
function updateIso(r, D, active) {
  const sh = active && DIS.shot && D.shots && D.shots.find(x => x.id === DIS.shot), kind = sh && sh.isolate;
  for (const [k, o] of ISO) if (o) o.visible = !!kind && k.endsWith('|' + kind) && !!o.parent;
  for (const k in ISO_MAT) ISO_MAT[k].uniforms.uTime.value = DIS.t;
  if (!kind) return;
  const names = D.isolate && D.isolate[kind] ? new Set(D.isolate[kind]) : null;
  const sel = names ? (() => true) : isoSelector(kind, D), L = r.production && r.production.lods.get(r.production.activeLOD); if (!sel || !L) return;
  L.scene.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(L.scene.matrixWorld).invert();
  for (const rec of r.truckMeshes || []) { const k = rec.mesh.uuid + '|' + kind; if (ISO.has(k)) continue; const o = buildIso(rec, kind, sel, inv, names); ISO.set(k, o); if (o) o.visible = true; }
}
// Focus blur (Phase 82r, owner: "blur dalk uit die agtergrond by in-cab en stairs sodat dit meer uitstaan"): an HDR stage of the
// product post pipeline, on only in the isolated close-ups. The subject (objects on layer FOCUS_LAYER: the outlined parts, the
// route) is rendered as a white silhouette into a quarter-res mask and feathered; the frame is downsampled and gaussian-blurred
// (two separable passes); the composite keeps the subject sharp and blurs + slightly dims the rest. Cheap: quarter-res passes.
const FOCUS_LAYER = 5;
const FOCUS = { amt: 0, want: 0, built: false, scene: null, camera: null };
const FQ_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
function focusBuild() {
  const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
  FOCUS.a = rt(); FOCUS.b = rt(); FOCUS.mA = rt(); FOCUS.mB = rt();
  FOCUS.mask = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, stencilBuffer: false });
  FOCUS.out = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
  FOCUS.copy = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: { t: { value: null } }, vertexShader: FQ_VS,
    fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = texture2D(t, vUv); }', depthTest: false, depthWrite: false }));
  FOCUS.blur = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: { t: { value: null }, dir: { value: new THREE.Vector2() } }, vertexShader: FQ_VS,
    fragmentShader: `uniform sampler2D t; uniform vec2 dir; varying vec2 vUv;
      void main(){ vec4 c = texture2D(t, vUv) * 0.2270270;
        c += (texture2D(t, vUv + dir * 1.3846154) + texture2D(t, vUv - dir * 1.3846154)) * 0.3162162;
        c += (texture2D(t, vUv + dir * 3.2307692) + texture2D(t, vUv - dir * 3.2307692)) * 0.0702703; gl_FragColor = c; }`, depthTest: false, depthWrite: false }));
  FOCUS.comp = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: { tS: { value: null }, tB: { value: null }, tM: { value: null }, tR: { value: null }, amt: { value: 0 } }, vertexShader: FQ_VS,
    fragmentShader: `uniform sampler2D tS, tB, tM, tR; uniform float amt; varying vec2 vUv;
      void main(){ vec4 s = texture2D(tS, vUv), b = texture2D(tB, vUv); float m = max(smoothstep(0.05, 0.6, texture2D(tM, vUv).r), texture2D(tR, vUv).r);   // Phase 120: the subject itself always fully sharp
        float k = min(1.0, (1.0 - m) * amt * 0.5); gl_FragColor = vec4(mix(s.rgb, b.rgb * 0.9, k), mix(s.a, b.a, k)); }`, depthTest: false, depthWrite: false }));
  FOCUS.white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  FOCUS.built = true;
}
function focusPass(R, src, dst, dir) { FOCUS.blur.material.uniforms.t.value = src.texture; FOCUS.blur.material.uniforms.dir.value.copy(dir); R.setRenderTarget(dst); FOCUS.blur.render(R); }
const FOCUS_STAGE = {
  enabled: false,
  render(R, src) {
    if (!FOCUS.built) focusBuild();
    const sh = COARSE ? 2 : 1, w = Math.max(1, src.width >> sh), h = Math.max(1, src.height >> sh);   // half res (quarter on phones)
    for (const t of [FOCUS.a, FOCUS.b, FOCUS.mA, FOCUS.mB, FOCUS.mask]) if (t.width !== w || t.height !== h) t.setSize(w, h);
    if (FOCUS.out.width !== src.width || FOCUS.out.height !== src.height) FOCUS.out.setSize(src.width, src.height);
    // 1. blurred frame: downsample, 2 x (H + V) gaussian
    FOCUS.copy.material.uniforms.t.value = src.texture; R.setRenderTarget(FOCUS.a); FOCUS.copy.render(R);
    for (const t of [FOCUS.a, FOCUS.b, FOCUS.mA, FOCUS.mB]) t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
    const px = new THREE.Vector2(1 / w, 1 / h);
    const steps = COARSE ? [1] : [1, 1.6];   // Phase 82s (owner: "blur voel too much"): a gentle softening
    for (const k of steps) { focusPass(R, FOCUS.a, FOCUS.b, new THREE.Vector2(px.x * k, 0)); focusPass(R, FOCUS.b, FOCUS.a, new THREE.Vector2(0, px.y * k)); }
    // 2. subject mask: white silhouette of the layer-5 objects, feathered
    const cam = FOCUS.camera, sc = FOCUS.scene, L0 = cam.layers.mask, ov = sc.overrideMaterial, bg = sc.background, cc = R.getClearColor(new THREE.Color()), ca = R.getClearAlpha();
    cam.layers.set(FOCUS_LAYER); sc.overrideMaterial = FOCUS.white; sc.background = null; R.setClearColor(0x000000, 1);
    R.setRenderTarget(FOCUS.mask); R.clear(true, true, false); R.render(sc, cam);
    cam.layers.mask = L0; sc.overrideMaterial = ov; sc.background = bg; R.setClearColor(cc, ca);
    focusPass(R, FOCUS.mask, FOCUS.mB, new THREE.Vector2(px.x * 2.5, 0)); focusPass(R, FOCUS.mB, FOCUS.mA, new THREE.Vector2(0, px.y * 2.5));
    // 3. composite at full resolution
    const u = FOCUS.comp.material.uniforms; u.tS.value = src.texture; u.tB.value = FOCUS.a.texture; u.tM.value = FOCUS.mA.texture; u.tR.value = FOCUS.mask.texture; u.amt.value = FOCUS.amt;
    R.setRenderTarget(FOCUS.out); FOCUS.comp.render(R);
    return FOCUS.out;
  },
};
function focusUpdate(dt, want) {
  FOCUS.want = want ? 1 : 0; FOCUS.amt += (FOCUS.want - FOCUS.amt) * Math.min(1, dt * 4); if (Math.abs(FOCUS.want - FOCUS.amt) < 0.005) FOCUS.amt = FOCUS.want;
  FOCUS_STAGE.enabled = FOCUS.amt > 0.01; FOCUS.scene = V.scene; FOCUS.camera = V.camera;
  if (V.post && !V.post.stages.includes(FOCUS_STAGE)) V.post.stages.push(FOCUS_STAGE);
}

function disposeDischarge() {
  FOCUS.amt = 0; FOCUS_STAGE.enabled = false;     // Phase 82r: never carry the focus blur to another product
  if (!DIS.g) return;
  DIS.g.traverse(m => { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); });
  if (DIS.wet) DIS.wet.tex.dispose();
  V.scene.remove(DIS.g); for (const l of DIS.labels || []) if (l.el) l.el.remove(); if (DIS.chips) DIS.chips.remove();
  Object.assign(DIS, { g: null, cab: null, route: null, wet: null, labels: null, chips: null, shot: null, solid: false, on: 0, t: 0, was: false, wetUntil: 0 });
}
function updateDischarge(dt) {
  const r = V.models && V.models[V.url], D = r && r.production && r.production.manifest.discharge;
  if (DIS.key !== V.url) { disposeDischarge(); DIS.key = V.url; }
  if (!D) { if (FOCUS_STAGE.enabled) { FOCUS.amt = 0; FOCUS_STAGE.enabled = false; } return; }
  const active = systemOn && mode === 'system', now = performance.now();
  if (!DIS.g) { if (!active) return; Object.assign(DIS, buildDischarge(r, D)); DIS.chips = buildChips(D); }
  const AF = disAssetFrame(r); if (!AF) return;
  DIS.g.matrix.copy(AF); DIS.g.matrixWorldNeedsUpdate = true; DIS.inv.copy(AF).invert();
  const sc = DIS.v.setFromMatrixScale(AF).x, fy = V.stageState && Number.isFinite(V.stageState.floorY) ? V.stageState.floorY : 0;
  // camera: pull back to the whole truck when it goes off, back to the system view when it stops
  if (active !== DIS.was && V.pcam && V.pcam.active && D.view === 'full' && !keepView) {   // on: the first shot (the whole vehicle); off: the System view
    if (active) disShot((D.shots && D.shots[0]) || { id: 'vehicle', framing: 'full' }, AF);
    else { DIS.solid = false; DIS.shot = null; if (mode === 'system') disShot({ id: '', framing: 'system' }, AF); DIS.shot = null; }
  }
  if (DIS.chips) DIS.chips.classList.toggle('is-on', active);
  { const st = document.getElementById('drawer-stage-3d'); if (st) st.classList.toggle('is-discharging', active); }   // Phase 82s: quieter chrome
  updateIso(r, D, active);                        // Phase 82o: the solid part of an isolated close-up
  { const sh = active && DIS.shot && D.shots && D.shots.find(x => x.id === DIS.shot); focusUpdate(dt, !!(sh && sh.isolate)); }   // Phase 82r
  if (active && !DIS.was) DIS.t = 0;
  DIS.was = active; DIS.t += dt;
  DIS.on += ((active ? 1 : 0) - DIS.on) * Math.min(1, dt * 3);
  const h = V.renderer.domElement.height || 720, pxs = h * 0.5 / Math.tan(THREE.MathUtils.degToRad(V.camera.fov * 0.5));
  if (DIS.cab) {                                  // the glazing is transmissive (its pass never sees this mist): in the cab close-up
    const m = DIS.cab.pts.material;               // the mist draws over the cab, from other views the truck hides it
    m.uniforms.uScale.value = pxs; m.uniforms.uSize.value = 0.26 * sc; m.depthTest = DIS.shot !== 'cab';
    stepCabMist(DIS.cab, Math.min(dt, 0.05), active);
  }
  const showRoute = active ? THREE.MathUtils.smoothstep(DIS.t, 0.5, 2.2) : DIS.on * 0.999;
  if (DIS.route) stepRoute(DIS.route, Math.min(dt, 0.05), showRoute);
  // wet ground: paint where droplets struck (runoff falls straight down) / landed; dry slowly
  const Wt = DIS.wet; Wt.mesh.position.y = DIS.v.set(0, fy, 0).applyMatrix4(DIS.inv).y + 0.006;
  if (active) {
    for (let i = 0; i + 2 < MIST_SPLASH.length; i += 3) { const q = DIS.v.set(MIST_SPLASH[i], MIST_SPLASH[i + 1], MIST_SPLASH[i + 2]).applyMatrix4(DIS.inv);
      wetPaint(Wt, q.x + (Math.random() - 0.5) * 0.7, q.z + (Math.random() - 0.5) * 0.7, 0.18 + Math.random() * 0.32, 0.035); }
    if (D.cab && Math.random() < dt * 3) { const b = D.cab.box; wetPaint(Wt, b[0] - 0.2 + Math.random() * 0.4, (b[2] + b[5]) / 2 + (Math.random() - 0.5), 0.5, 0.04); }   // drain from the cab deck
    DIS.wetUntil = now + 16000;
  }
  if (now - Wt.lastDry > 250) {                   // drying: fast once it stops, a trickle while it runs
    Wt.lastDry = now; Wt.ctx.globalCompositeOperation = 'destination-out'; Wt.ctx.fillStyle = `rgba(0,0,0,${active ? 0.006 : 0.03})`; Wt.ctx.fillRect(0, 0, Wt.W, Wt.H); Wt.dirty = true;
  }
  if (Wt.dirty && now - Wt.lastUp > 120) { Wt.tex.needsUpdate = true; Wt.dirty = false; Wt.lastUp = now; }
  Wt.mesh.visible = now < DIS.wetUntil;
  // labels
  const rc = V.renderer.domElement.getBoundingClientRect(), st = document.getElementById('drawer-stage-3d'), sr = st ? st.getBoundingClientRect() : rc;
  for (const l of DIS.labels) {
    if (!l.el) continue; const vis = (l.route ? showRoute : DIS.on) > 0.3 && (!DIS.shot || DIS.shot === 'vehicle');   // Phase 82s: the bar names the close-ups
    const q = DIS.v.copy(l.p).applyMatrix4(AF).project(V.camera), behind = q.z > 1;
    l.el.classList.toggle('is-on', vis && !behind);
    if (vis && !behind) l.el.style.transform = `translate(${(rc.left - sr.left + (q.x + 1) / 2 * rc.width).toFixed(1)}px, ${(rc.top - sr.top + (1 - q.y) / 2 * rc.height).toFixed(1)}px) translate(-50%, -100%)`;
  }
}

function fadeRec(r, amt, floorOp) {
  const hiding = floorOp <= 0.001; // full-hide (truck) vs ghost (rig)
  if (amt > 0.01) {
    if (!r.on) { r.mat.transparent = true; r.mat.depthWrite = false; r.mat.needsUpdate = true; r.on = true; }
    const op = lerp(r.o0, floorOp, amt);
    r.mat.opacity = op;
    const vis = op > 0.02;
    if (r.mesh.visible !== vis) r.mesh.visible = vis;
    // Ghosted/hidden meshes stop casting shadow (no "ghost" shadow on the floor).
    const cast = (hiding ? amt < 0.5 : false) && r.c0 !== false;
    if (r.mesh.castShadow !== cast) { r.mesh.castShadow = cast; V.renderer.shadowMap.needsUpdate = true; }
  } else if (r.on) {
    r.mat.opacity = r.o0; r.mat.transparent = r.t0; r.mat.depthWrite = r.d0; r.mat.needsUpdate = true;
    r.mesh.visible = true;
    const c0 = r.c0 !== false;                  // restore the mesh's own shadow policy
    if (r.mesh.castShadow !== c0) { r.mesh.castShadow = c0; V.renderer.shadowMap.needsUpdate = true; }
    r.on = false;
  }
}
function applyFade(list, amt, floorOp) { if (!list) return; for (const r of list) fadeRec(r, amt, floorOp); }

// Runtime LOD selection (Phase 21), before the fades so a switched-in LOD is faded in the same frame.
// Shows the wanted LOD when resident, else the nearest finer resident one (never below the wanted quality);
// only while nothing finer is loaded does a coarser one stay on screen. A finer LOD is loaded as soon as the
// camera is heading for a size that needs it (damped-zoom target, or the end of a Full ⇄ System move), so it
// starts downloading when the zoom begins rather than when the camera arrives. A coarser LOD is never
// fetched: a finer one serves every size.
function updateLOD() {
  const r = V.models && V.models[V.url], a = r && r.production;
  if (!a || !LOD_CONFIG.auto || a.activeLOD == null || !a.lods.size || !V.pcam.active) return;
  const C = LOD_CONFIG, pc = V.pcam, s = r.lodPx = lodPx(r);
  if (!(s > 0)) return;                                        // canvas not laid out yet
  const want = r.lodWant = wantedLOD(s, r.lodWant);
  r.lodGpu.add(a.activeLOD);                                   // on screen = uploaded
  const ready = n => a.lods.has(n) && r.lodGpu.has(n);
  let show = want; while (show > 0 && !ready(show)) show--;
  if (!ready(show)) { show = want; while (!ready(show)) show++; }
  if (show !== a.activeLOD) { a.showLOD(show); V.refreshProductionRoles(V.url); }
  // Where the view is heading: the damped-zoom target (or the end of a Full ⇄ System move), and the visitor's zoom-in
  // rate of that target (ln distance per second, smoothed over ~0.2 s; refits, resizes and mode moves do not count).
  const dNow = V.camera.position.distanceTo(V.controls.target), dTo = pc.transition ? pc.transition.d1 : (pc.zoomDesired ?? dNow);
  const sTo = s * dNow / Math.max(dTo, 1e-6), t = performance.now(), dt = r.lodT == null ? 0 : Math.min(0.1, (t - r.lodT) / 1000);
  const zooming = !pc.transition && pc.zoomDesired != null && pc.zoomShown != null && pc.zoomDesired !== pc.zoomShown;
  // A jump of the target (slider click) counts as one wheel step per frame at most: it already names its destination.
  const zIn = zooming && r.lodZD != null ? Math.min(Math.log(r.lodZD / pc.zoomDesired), ZOOM_STEP) : 0;
  if (dt > 0) r.lodRateT += (zIn / dt - r.lodRateT) * (1 - Math.exp(-dt / 0.2));
  r.lodT = t; r.lodZD = pc.zoomDesired;
  // predicted crossing: never while zooming out or at rest, never past the closest zoom the camera allows, and not
  // when the visitor asked the browser to save data
  const saveData = typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData;
  const sMax = pc.limits ? s * dNow / pc.limits.minDistance : sTo;
  const sAhead = C.predict === 'crossing' && r.lodRateT > 0 && !saveData ? Math.max(sTo, Math.min(sTo * Math.exp(r.lodRateT * C.horizon), sMax)) : sTo;
  const need = Math.min(want, wantedLOD(sAhead, null)), finest = Math.min(...a.lods.keys());
  if (need < finest) V.requestLOD(V.url, C.progressive ? finest - 1 : need);
  // A zoom that turns back before a fetched-ahead LOD was shown abandons it: its download is aborted, or, if it has
  // arrived, it is released again (never uploaded, so this frees CPU memory only).
  if (r.lodRateT < -0.05) {
    if (r.lodLoading && r.lodLoadingN < need) r.lodAbort.abort();
    for (const n of a.lods.keys()) if (n < a.activeLOD && n < need && !r.lodGpu.has(n)) {
      if (r.lodPrep && r.lodPrep.n === n) r.lodPrep = null;
      a.unloadLOD(n); V.refreshProductionRoles(V.url); }
  }
  // a loaded LOD the view needs (or is heading for) is prepared on the GPU a chunk per frame; it is shown once ready
  for (const n of a.lods.keys()) if (n !== a.activeLOD && !r.lodGpu.has(n) && n >= need && n < a.activeLOD) { V.prepareLOD(r, n); break; }
}

function frame() {
  if (!running) return;
  requestAnimationFrame(frame);
  if (!V) return;
  updateLOD();
  // Ease the view amounts.
  cutAmt   += (cutTarget   - cutAmt)   * 0.12;
  // Production products: when returning to Full from a close System view, the truck fades back in
  // only once the camera has left its hull, so it never materialises around (or through) the lens.
  const holdTruck = mode === 'full' && V.pcam && V.pcam.active && V.pcam.transition && !V.pcam.clearOf('full');
  truckAmt += ((holdTruck ? 1 : (DIS.solid ? 0 : truckTarget)) - truckAmt) * 0.12;   // Phase 82k: close-up shots show the vehicle solid
  dimAmt   += (dimTarget   - dimAmt)   * 0.12;
  gunDimAmt += (gunDimTarget - gunDimAmt) * 0.12;

  // Cylinder slice — the plane sweeps in from just past the nose with the
  // same eased inertia as the fades, and drives the cut-edge shader band.
  cutPlane.constant = lerp(cutStart, cutConst, cutAmt);
  _cutU.c.value = cutPlane.constant;
  _cutU.on.value = cutAmt;
  if (cylGlow) cylGlow.intensity = cutAmt * 0.9;

  // Truck hides in system/gun/cutaway.
  applyFade(V.truckMeshes, truckAmt, truckFloor);
  // System-view context (Phase 66): the ghosted carrier eases in with the System fade — never while the camera is inside it.
  { const r = V.models && V.models[V.url];
    if (r && r.production) {
      const ghostMode = mode === 'system' || (mode === 'cutaway' && cutawayContextOf(V.url) === 'ghost');   // Phase 80
      const want = ghostMode && !DIS.solid && systemContextOf(V.url) === 'ghost' && (!V.pcam.active || V.pcam.clearOf('full'));
      GHOST.amt += ((want ? 1 : 0) - GHOST.amt) * 0.12;
      if (GHOST.amt > 0.004) syncGhosts(r);
      showGhosts(r, GHOST.amt > 0.004);
      if (GHOST.mat) GHOST.mat.uniforms.uAmount.value = GHOST.amt;
    } }
  // Production Cutaway (Phase 67): entering it fetches the cut geometry once; the host cylinder eases out (its own materials)
  // while the pre-cut one is shown in its place, and back on leaving. Nothing else on the product changes.
  { const r = V.models && V.models[V.url], a = r && r.production;
    if (a && r.hasCut) {
      const want = mode === 'cutaway';
      if (want && !a.cutaway) ensureCutaway(r);
      const on = want && !!a.cutaway, to = on ? 1 : 0;
      PCUT.amt += (to - PCUT.amt) * 0.12; if (Math.abs(to - PCUT.amt) < 0.002) PCUT.amt = to;
      if (a.cutaway) { const vis = PCUT.amt > 0; if (a.cutaway.scene.visible !== vis) { a.cutaway.scene.visible = vis; V.renderer.shadowMap.needsUpdate = true; } }
    } else PCUT.amt = 0; }
  // The AO ground pool follows the truck: full footprint when parked, faded
  // back when only the rig is on set.
  if (V.aoBlob) V.aoBlob.material.opacity = lerp(1, 0.3, truckAmt);
  // Rig dimming is per-mode: Cutaway ghosts everything but the sliced cylinder;
  // Gun ghosts everything but the cannon head. Full/System leave the rig lit.
  if (V.allRig) {
    for (const rec of V.allRig) {
      let t = 0;
      if (rec.isCutHost) { fadeRec(rec, PCUT.amt, 0); continue; }   // production Cutaway host (Phase 67)
      if (mode === 'cutaway') t = rec.isFocus ? 0 : dimAmt;
      else if (mode === 'gun') t = rec.isGun ? 0 : gunDimAmt;
      fadeRec(rec, t, 0.12);
    }
  }

  // Resume the gentle auto-rotate after 10s of no interaction (all orbit
  // modes — full, system, gun). The gun itself never rotates; the VIEW does.
  if (SPIN.on) { if (!userInteracting) { V.controls.autoRotate = true; V.controls.autoRotateSpeed = SPIN.speed; } }   // Phase 104
  else if ((mode === 'full' || mode === 'system' || mode === 'gun') && !userInteracting && !V.controls.autoRotate &&   // Phase 101/102: in the Blender room the idle turn is natural again
      lastInteract && (performance.now() - lastInteract > IDLE_RESUME_MS) && !(COARSE && performance.now() - lastInteract > 45000)) {
    V.controls.autoRotate = true;
  }
  if (!SPIN.on && COARSE && V.controls.autoRotate && performance.now() - lastInteract > 45000) V.controls.autoRotate = false;   // Phase 82h: phones rest

  // (Gun stays static — the model can't articulate without breaking, so the
  // cannon is shown in its correct connected position; only the spray moves.)
  const now = performance.now();
  const _dt = (now - (_prevTs.t || now)) / 1000;
  updateSpray(_dt);
  updateProdGun(_dt);                  // Phase 82: production cannon aim + foam stream
  wetUpdate(Math.min(_dt, 0.1));       // Phase 119: the sprayed floor dries
  updateMist(_dt);
  updateDischarge(_dt);                // Phase 82j: VSS in-cab mist, escape route, wet ground, camera pull-back
  { const rH = V.models && V.models[V.url]; if (rH && rH.production && rH.production.manifest.hide) applyHides(rH); }   // Phase 82m
  _prevTs.t = now;


  if (POV.save) updatePOV(Math.min(_dt, 0.1));   // Phase 119: the operator's view owns the camera
  else if (V.pcam && V.pcam.active) V.pcam.update(_dt); else V.controls.update();
  if (!POV.save) { const rB = V.models && V.models[V.url];          // Phase 82l: a panned view stays on the product (target within its central 70 %)
    if (rB && rB.bbox && !rB.bbox.isEmpty()) { const ex = rB.bbox.getSize(_panV).multiplyScalar(-0.15), t = V.controls.target, t0 = _panT.copy(t);
      t.clamp(_panA.copy(rB.bbox.min).sub(ex), _panB.copy(rB.bbox.max).add(ex));
      if (!t.equals(t0)) V.camera.position.add(_panV.subVectors(t, t0)); } }
  // Engineering callouts track their 3D anchors (cutaway only, after the cut).
  updateCallouts(mode === 'cutaway' && cutAmt > 0.6);
  // Reflect wheel/pinch zoom back onto the slider (unless it's being dragged).
  if (zoomEl && !zoomDragging) {
    const v = Math.round(getZoom() * 100);
    if (+zoomEl.value !== v) zoomEl.value = v;
  }
  if (!PWR.visible) { PWR.skips++; return; }                              // canvas scrolled out of view: draw nothing
  if (!PWR.cam) { PWR.cam = new THREE.Matrix4(); PWR.proj = new THREE.Matrix4(); }
  const near = (A, B, e) => { for (let i = 0; i < 16; i++) if (Math.abs(A.elements[i] - B.elements[i]) > e) return false; return true; };   // damping never lands exactly
  const rA = V.models && V.models[V.url], camMoved = !near(PWR.cam, V.camera.matrixWorld, 2e-5) || !near(PWR.proj, V.camera.projectionMatrix, 1e-5);
  const settling = Math.abs(cutTarget - cutAmt) > 1e-3 || Math.abs(truckTarget - truckAmt) > 1e-3 || Math.abs(dimTarget - dimAmt) > 1e-3
    || Math.abs(gunDimTarget - gunDimAmt) > 1e-3 || (GHOST.amt > 0.004 && GHOST.amt < 0.996) || (PCUT.amt > 0 && PCUT.amt < 1);
  const fx = (spray && spray.points.visible) || systemOn || WET.max > 0.002 || now < DIS.wetUntil || DIS.on > 0.01 || (mode === 'gun' && !!prodGunRig()) || PGUN.yaw !== 0 || PGUN.pitch !== 0;
  const key = `${V.url}|${mode}|${rA && rA.production ? rA.production.activeLOD : ''}|${V.loaded}`;
  const dirty = camMoved || settling || fx || key !== PWR.key || V.renderer.shadowMap.needsUpdate || now - PWR.lastInput < 1200;
  if (dirty) { PWR.tail = 12; PWR.why = [camMoved && 'cam', settling && 'settle', fx && 'fx', key !== PWR.key && 'key', V.renderer.shadowMap.needsUpdate && 'shadow', now - PWR.lastInput < 1200 && 'input'].filter(Boolean).join(','); }
  else if (PWR.tail > 0) PWR.tail--;
  if (!dirty && PWR.tail <= 0 && now - PWR.lastDraw < 500) { PWR.skips++; return; }   // unchanged: keep-alive at 2 fps
  if (COARSE && !userInteracting && now - PWR.lastDraw < 31) { PWR.skips++; return; } // phones: 30 fps unless a finger is on it
  renderFrame();
  PWR.cam.copy(V.camera.matrixWorld); PWR.proj.copy(V.camera.projectionMatrix); PWR.key = key; PWR.lastDraw = now; PWR.draws++;
}

// One frame. Production profile: HDR pipeline (ProductPost; AO applied to scene-linear radiance
// before AgX). Legacy profile: the direct path, unchanged (in-shader tone mapping on the canvas).
const TURN = { az0: null, url: null, base: [] };   // Phase 98c
let TRANSP = false;   // Phase 90: DrawerViewer.setTransparent
let FLOOR_GLOW_TEX = null;   // Phase 94: DrawerViewer.setFloorGlow
let PLINTH = null;           // Phase 95: DrawerViewer.setPlinth
const SPIN = { on: false, speed: -1.6 };   // Phase 104: DrawerViewer.setSpin (the scene turns on its own while you aim)
let ROOM = null;             // Phase 97: DrawerViewer.setRoom
const SKY = { on: false, mesh: null, scene: null, env: null, envPrev: null, key: null };   // Phase 102: DrawerViewer.setSkybox
const ROOM_U = { vp: { value: new THREE.Vector4(0, 0, 1, 1) }, on: { value: 0 } };
// Phase 117 (owner: "why is it gone — just do it right"): a true planar reflection on the showroom floor, in see-through mode only.
// Once per frame the scene is drawn from the camera mirrored in the floor plane (clipped at the floor) into a reduced-size
// target; a floor plane samples it in projection — softly blurred, faint, fading out away from the product — so the reflection
// meets every wheel exactly and turns with the product. Hidden again straight after the frame, so the full-screen viewer never has it.
const MIRROR = { on: true, strength: 0.17,   // Phase 118 (owner: "less reflection, a little blur"): was 0.3
  mesh: null, rt: null, cam: null, tm: new THREE.Matrix4(),
  clip: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), v2: new THREE.Vector2(), p: new THREE.Vector3(), d: new THREE.Vector3(),
  u: new THREE.Vector3(), q: new THREE.Quaternion(), c: new THREE.Color() };
// Phase 119 (owner: "the floor must get wet where you spray"): a wetness map on the floor around the product. Every droplet of
// the cannon that lands stamps a soft spot; the map dries out slowly. The floor-reflection plane reads it: wet floor is darker
// and a far better mirror (the product, the jet and the fires shine in it), with organic, noisy edges.
const WET = { N: 256, g: null, px: null, tex: null, key: null, cx: 0, cz: 0, E: 1, s: 1, max: 0, dirty: false };
function wetStamp(x, z, amt, s) {
  if (!WET.g) { WET.g = new Float32Array(WET.N * WET.N); WET.f = new Float32Array(WET.N * WET.N); WET.px = new Uint8Array(WET.N * WET.N * 2);   // R wet, G foam (Phase 121)
    WET.tex = new THREE.DataTexture(WET.px, WET.N, WET.N, THREE.RGFormat, THREE.UnsignedByteType);
    WET.tex.magFilter = WET.tex.minFilter = THREE.LinearFilter; WET.tex.needsUpdate = true; }
  const r = V.models && V.models[V.url];
  if (WET.key !== V.url && r && r.bbox) {                  // another product: a dry floor centred on it
    WET.key = V.url; WET.g.fill(0); WET.f.fill(0); WET.max = 0; WET.dirty = true; WET.s = s;
    WET.cx = (r.bbox.min.x + r.bbox.max.x) / 2; WET.cz = (r.bbox.min.z + r.bbox.max.z) / 2; WET.E = 30 * s;
  }
  const N = WET.N, u = ((x - WET.cx) / (2 * WET.E) + 0.5) * N, v = ((z - WET.cz) / (2 * WET.E) + 0.5) * N;
  const i0 = Math.round(u), j0 = Math.round(v);
  if (i0 < 2 || j0 < 2 || i0 >= N - 2 || j0 >= N - 2) return;
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
    const d2 = (i0 + i - u) ** 2 + (j0 + j - v) ** 2; if (d2 > 6.25) continue;
    const k = (j0 + j) * N + i0 + i, e = Math.exp(-d2 / 1.8); WET.g[k] = Math.min(1.6, WET.g[k] + amt * e);
    WET.f[k] = Math.min(1.4, WET.f[k] + amt * 1.3 * e);   // Phase 121 (owner: "white foam on the ground where I spray, fading after a few seconds")
  }
  WET.max = Math.max(WET.max, WET.g[j0 * N + i0]); WET.dirty = true;
}
function wetUpdate(dt) {                                   // spread a little (the puddle runs), dry out (~25 s), hand the map to the GPU
  if (!WET.g || WET.max <= 0.002) return;
  const N = WET.N, f = Math.exp(-dt / 25), g = WET.g, px = WET.px, a = Math.min(0.2, dt * 0.9);
  if (!WET.t) WET.t = new Float32Array(N * N);
  const t = WET.t; t.set(g);
  for (let j = 1; j < N - 1; j++) for (let i = 1, k = j * N + 1; i < N - 1; i++, k++)
    g[k] = t[k] + a * (t[k - 1] + t[k + 1] + t[k - N] + t[k + N] - 4 * t[k]);
  let mx = 0; const fo = WET.f, ff = Math.exp(-dt / 3.2);   // the foam collapses in a few seconds; the wet stays longer
  for (let k = 0; k < g.length; k++) { const w = g[k] * f, q = fo[k] * ff; g[k] = w; fo[k] = q; if (w > mx) mx = w;
    px[2 * k] = w >= 1 ? 255 : (w * 255) | 0; px[2 * k + 1] = q >= 1 ? 255 : (q * 255) | 0; }
  WET.max = mx < 0.002 ? 0 : mx; WET.tex.needsUpdate = true; WET.dirty = false;
}
// Phase 119 (owner: "a POV angle when we're in spray mode"): the operator's view — the camera stands behind the cannon at head
// height, looking where the cannon pointed when POV was switched on. A mouse aims by hovering (as in Gun view) and looks around
// by dragging; a finger aims by dragging. Entering and leaving glide (position, aim point, field of view); on leaving, the
// camera lands exactly where it was and the orbit controls take over again.
const POV = { on: false, k: 0, save: null, head: new THREE.Vector3(), yawOff: 0, eye: new THREE.Vector3(), look: new THREE.Vector3(),
  t: new THREE.Vector3(), j: new THREE.Vector3(), hp: new THREE.Vector3(), M: new THREE.Matrix4() };
function setPOV(on, opts = {}) {
  if (!V) return false;
  // Phase 121 (owner: "a button to view the system far out, the whole vehicle in frame while it sprays"): leave POV gliding
  // straight to the whole-vehicle framing (from the side the visitor was on) instead of back to the old view
  if (!on && opts.whole && POV.save && V.pcam && V.pcam.active) {
    const fr = V.pcam.framing('full', { direction: POV.save.pos.clone().sub(POV.save.tgt) });
    POV.save.pos.copy(fr.position); POV.save.tgt.copy(fr.target);
  }
  const P = prodGunRig(), S = P && prodGunFrame(P);
  if (on && (!P || !S || mode !== 'gun')) return false;
  if (on && !POV.on) {
    if (!POV.save) POV.save = { pos: V.camera.position.clone(), tgt: V.controls.target.clone(), fov: V.camera.fov, near: V.camera.near };
    POV.head.set(_pg.dir.x, 0, _pg.dir.z); if (POV.head.lengthSq() < 1e-6) POV.head.set(0, 0, -1); POV.head.normalize();
    POV.yawOff = 0; V.controls.enabled = false; V.controls.autoRotate = false;
  }
  POV.on = !!on; lastInteract = performance.now();
  return POV.on;
}
function povDrop() {   // leave POV at once, the camera staying where it is (the caller moves it on)
  if (!POV.save) return;
  V.camera.fov = POV.save.fov; V.camera.near = POV.save.near; V.camera.updateProjectionMatrix();
  POV.on = false; POV.k = 0; POV.save = null; V.controls.enabled = true;
  DOF.amt = 0; DOF_STAGE.enabled = false;
}
// Phase 121 (owner: "do the aperture and blur properly"): a real depth-of-field lens for POV. A depth pass (half resolution, opaque
// geometry only — the jet, the fires and the floor effects carry no depth, so they read as background and stay sharp) gives each
// pixel its distance; the lens is focused on the cannon head, and everything nearer goes out of focus by how much nearer it is
// (circle of confusion ~ F/z - 1). The near circle of confusion is spread outward, so the blurred cylinders melt over their own
// edges as foreground bokeh does — and nothing behind the focus plane is blurred, so the sharp cannon gets no halo.
const DOF = { amt: 0, F: 2, built: false, hide: [] };
function dofBuild() {
  const T = THREE, rt = o => new T.WebGLRenderTarget(1, 1, Object.assign({ type: T.HalfFloatType, depthBuffer: false, stencilBuffer: false, minFilter: T.LinearFilter, magFilter: T.LinearFilter }, o));
  DOF.z = rt({ depthBuffer: true });
  DOF.a = rt(); DOF.b = rt(); DOF.c = rt(); DOF.d = rt(); DOF.out = rt();
  DOF.zMat = new T.ShaderMaterial({ vertexShader: 'varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying float vZ; void main(){ gl_FragColor = vec4(1.0 / max(vZ, 1e-3), 0.0, 0.0, 1.0); }', side: T.DoubleSide });   // inverse depth: the clear (0) is infinitely far
  DOF.zMatC = DOF.zMat.clone(); DOF.zMatC.fragmentShader = 'varying float vZ; void main(){ gl_FragColor = vec4(1.0 / max(vZ, 1e-3), 1.0, 0.0, 1.0); }';   // the cannon: G = 1 where it is the visible surface
  DOF.copy = new FullScreenQuad(new T.ShaderMaterial({ uniforms: { t: { value: null } }, vertexShader: FQ_VS, fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = texture2D(t, vUv); }', depthTest: false, depthWrite: false }));
  DOF.blur = new FullScreenQuad(new T.ShaderMaterial({ uniforms: { t: { value: null }, dir: { value: new T.Vector2() } }, vertexShader: FQ_VS,
    fragmentShader: `uniform sampler2D t; uniform vec2 dir; varying vec2 vUv;
      void main(){ vec4 c = texture2D(t, vUv) * 0.2270270;
        c += (texture2D(t, vUv + dir * 1.3846154) + texture2D(t, vUv - dir * 1.3846154)) * 0.3162162;
        c += (texture2D(t, vUv + dir * 3.2307692) + texture2D(t, vUv - dir * 3.2307692)) * 0.0702703; gl_FragColor = c; }`, depthTest: false, depthWrite: false }));
  DOF.coc = new FullScreenQuad(new T.ShaderMaterial({ uniforms: { tZ: { value: null }, F: { value: 2 } }, vertexShader: FQ_VS,
    fragmentShader: `uniform sampler2D tZ; uniform float F; varying vec2 vUv;
      void main(){ vec2 z = texture2D(tZ, vUv).rg; float c = z.x > 0.0 && z.y < 0.5 ? clamp((F * z.x - 1.0) * 1.15, 0.0, 1.0) : 0.0; /* Phase 124: a natural lens - the blur grows with how far in front of the focus a surface is */ gl_FragColor = vec4(c, c, c, 1.0); }`, depthTest: false, depthWrite: false }));
  DOF.comp = new FullScreenQuad(new T.ShaderMaterial({ uniforms: { tS: { value: null }, tB: { value: null }, tC: { value: null }, tCs: { value: null }, tZ: { value: null }, amt: { value: 0 }, dbg: { value: 0 } }, vertexShader: FQ_VS,
    fragmentShader: `uniform sampler2D tS, tB, tC, tCs, tZ; uniform float amt, dbg; varying vec2 vUv;
      void main(){ vec4 s = texture2D(tS, vUv), b = texture2D(tB, vUv);
        float c = max(texture2D(tC, vUv).r, texture2D(tCs, vUv).r * 0.9);   // the near blur reaches a little past its own edge
        float k = clamp(c, 0.0, 1.0) * 0.85 * amt * (1.0 - smoothstep(0.3, 0.7, texture2D(tZ, vUv).g));   // the cannon itself stays sharp
        gl_FragColor = mix(s, b, k); if (dbg > 0.5) gl_FragColor = vec4(k, texture2D(tZ, vUv).g, texture2D(tZ, vUv).r * 0.5, 1.0); }`, depthTest: false, depthWrite: false }));
  DOF.built = true;
}
function dofPass(R, q, src, dst, dir) { q.material.uniforms.t.value = src.texture; q.material.uniforms.dir.value.copy(dir); R.setRenderTarget(dst); q.render(R); }
const DOF_STAGE = {
  enabled: false,
  render(R, src) {
    if (!DOF.built) dofBuild();
    const w = Math.max(1, src.width >> 1), h = Math.max(1, src.height >> 1);
    for (const t of [DOF.z, DOF.a, DOF.b, DOF.c, DOF.d]) if (t.width !== w || t.height !== h) t.setSize(w, h);
    if (DOF.out.width !== src.width || DOF.out.height !== src.height) DOF.out.setSize(src.width, src.height);
    const sc = V.scene, cam = V.camera, cc = R.getClearColor(new THREE.Color()), ca = R.getClearAlpha(), bg = sc.background, ov = sc.overrideMaterial, su = R.shadowMap.autoUpdate;
    // 1. depth of the opaque scene (inverse view depth; anything see-through or additive is left out)
    const hide = DOF.hide; hide.length = 0;
    sc.traverse(o => { if (!o.visible || !(o.isMesh || o.isPoints || o.isSprite || o.isLine)) return; const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (o.isPoints || o.isSprite || o.isLine || !m || m.transparent || m.blending === THREE.AdditiveBlending || m.isShadowMaterial) { o.visible = false; hide.push(o); } });
    sc.overrideMaterial = DOF.zMat; sc.background = null; R.shadowMap.autoUpdate = false; R.setClearColor(0x000000, 0);
    R.setRenderTarget(DOF.z); R.clear(true, true, false); R.render(sc, cam);
    { const ac = R.autoClear, L0 = cam.layers.mask; R.autoClear = false; cam.layers.set(FOCUS_LAYER); sc.overrideMaterial = DOF.zMatC; R.render(sc, cam); cam.layers.mask = L0; R.autoClear = ac; }
    for (const o of hide) o.visible = true;
    sc.overrideMaterial = ov; sc.background = bg; R.shadowMap.autoUpdate = su; R.setClearColor(cc, ca);
    // 2. circle of confusion, and a spread copy of it (the near field bleeds outward)
    DOF.coc.material.uniforms.tZ.value = DOF.z.texture; DOF.coc.material.uniforms.F.value = DOF.F; R.setRenderTarget(DOF.c); DOF.coc.render(R);
    const px = new THREE.Vector2(1 / w, 1 / h);
    dofPass(R, DOF.blur, DOF.c, DOF.d, new THREE.Vector2(px.x * 4, 0)); dofPass(R, DOF.blur, DOF.d, DOF.b, new THREE.Vector2(0, px.y * 4));
    dofPass(R, DOF.blur, DOF.b, DOF.d, new THREE.Vector2(px.x * 4, 0)); dofPass(R, DOF.blur, DOF.d, DOF.b, new THREE.Vector2(0, px.y * 4));
    DOF.c2 = DOF.c2 || new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    if (DOF.c2.width !== w || DOF.c2.height !== h) DOF.c2.setSize(w, h);
    DOF.copy.material.uniforms.t.value = DOF.b.texture; R.setRenderTarget(DOF.c2); DOF.copy.render(R);   // the spread CoC
    // 3. the out-of-focus image: half resolution, a wide gaussian (the aperture)
    DOF.copy.material.uniforms.t.value = src.texture; R.setRenderTarget(DOF.a); DOF.copy.render(R);
    for (const k of COARSE ? [1, 1.6] : [1, 1.7]) { dofPass(R, DOF.blur, DOF.a, DOF.b, new THREE.Vector2(px.x * k, 0)); dofPass(R, DOF.blur, DOF.b, DOF.a, new THREE.Vector2(0, px.y * k)); }   // Phase 124: a gentler aperture
    // 4. sharp where in focus, the aperture's blur where not
    const u = DOF.comp.material.uniforms; u.tS.value = src.texture; u.tB.value = DOF.a.texture; u.tC.value = DOF.c.texture; u.tCs.value = DOF.c2.texture; u.tZ.value = DOF.z.texture; u.amt.value = DOF.amt; u.dbg.value = DOF.dbg ? 1 : 0;
    R.setRenderTarget(DOF.out); DOF.comp.render(R);
    return DOF.out;
  },
};
function povFocus(dt) {
  const want = POV.on && POV.k > 0.5;
  DOF.amt += ((want ? 1 : 0) - DOF.amt) * Math.min(1, dt * 4); if (!want && DOF.amt < 0.01) DOF.amt = 0;
  DOF_STAGE.enabled = DOF.amt > 0.01;
  if (V.post && !V.post.stages.includes(DOF_STAGE)) V.post.stages.push(DOF_STAGE);
  // the cannon's own meshes are tagged (kept sharp); the lens focuses on its head, so what stands nearer — the cylinders — blurs
  const P = prodGunRig();
  if (want && P) for (const L of P.a.lods.values()) { const rest = PGUN.rest.get(L.scene); if (rest) for (const e of rest) { e.o.layers.enable(FOCUS_LAYER); if (e.head) e.head.layers.enable(FOCUS_LAYER); } }
  // the lens is focused out on the target (the fires), the cannon held sharp: everything between you and the fires — the cylinders,
  // the vehicle — falls out of focus (they stand at the cannon's own distance, so a focus on the cannon could never blur them)
  V.camera.getWorldDirection(_dofDir); DOF.F = Math.max(0.05, _dofV.copy(POV.hp).sub(V.camera.position).dot(_dofDir) * 1.45);   // Phase 124: just beyond the cannon
}

const _dofDir = new THREE.Vector3(), _dofV = new THREE.Vector3();
function updatePOV(dt) {
  const sv = POV.save; if (!sv) return false;
  const P = prodGunRig(), S = P && prodGunFrame(P);
  if (!P || !S || mode !== 'gun') POV.on = false;
  POV.k += ((POV.on ? 1 : 0) - POV.k) * (1 - Math.exp(-dt * 2.2));   // Phase 121 (owner: "rotate slower"): a calmer glide
  const e = POV.k * POV.k * (3 - 2 * POV.k), cam = V.camera;
  if (P && S) {
    const s = _pg.s.setFromMatrixScale(S).x;
    POV.j.copy(P.j).applyMatrix4(S);                                   // the cannon's turning axis on the vehicle
    POV.hp.copy(P.hp).applyMatrix4(prodGunYaw(P, PGUN.yaw, POV.M)).applyMatrix4(S);   // its head
    const c = Math.cos(POV.yawOff), sn = Math.sin(POV.yawOff), hx = POV.head.x * c - POV.head.z * sn, hz = POV.head.x * sn + POV.head.z * c;
    // Phase 120 (owner: "POV must be closer" + his reference): right behind the cannon, just above the cylinders, the head up in frame
    POV.eye.set(POV.j.x - hx * 2.1 * s, POV.hp.y - 0.05 * s, POV.j.z - hz * 2.1 * s);   // just over the cylinder tops: the head whole, the fires beyond
    POV.look.set(POV.eye.x + hx * 10 * s, POV.eye.y - 0.1 * s, POV.eye.z + hz * 10 * s);
    cam.position.lerpVectors(sv.pos, POV.eye, e); POV.t.lerpVectors(sv.tgt, POV.look, e); cam.lookAt(POV.t);
    cam.fov = sv.fov + (52 - sv.fov) * e; cam.near = Math.min(sv.near, sv.near + (0.03 * s - sv.near) * e); cam.updateProjectionMatrix();
  }
  povFocus(dt);
  if (!POV.on && POV.k < 0.003) {                                       // back where the visitor was: the controls take over
    cam.position.copy(sv.pos); V.controls.target.copy(sv.tgt); cam.fov = sv.fov; cam.near = sv.near; cam.updateProjectionMatrix(); cam.lookAt(sv.tgt);
    POV.k = 0; POV.save = null; V.controls.enabled = true; lastInteract = performance.now();
    DOF.amt = 0; DOF_STAGE.enabled = false;
  }
  return true;
}
function ensureMirror() {
  if (MIRROR.mesh) return MIRROR;
  const T = THREE;
  MIRROR.rt = new T.WebGLRenderTarget(2, 2, { type: T.HalfFloatType, samples: 4 });
  MIRROR.cam = new T.PerspectiveCamera();
  const mat = new T.ShaderMaterial({
    uniforms: { tMirror: { value: MIRROR.rt.texture }, uTM: { value: MIRROR.tm }, uTexel: { value: new T.Vector2(1, 1) },
      uK: { value: MIRROR.strength }, uC: { value: new T.Vector2() }, uR: { value: 3 },
      uWet: { value: null }, uWetC: { value: new T.Vector2() }, uWetE: { value: 1 }, uWetOn: { value: 0 }, uNs: { value: 1 } },
    vertexShader: `uniform mat4 uTM; varying vec4 vP; varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vP = uTM * w; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform sampler2D tMirror, uWet; uniform vec2 uTexel, uC, uWetC; uniform float uK, uR, uWetE, uWetOn, uNs; varying vec4 vP; varying vec3 vW;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
      void main() {
        vec2 uv = vP.xy / vP.w, o = uTexel * 2.6, q = uTexel * 1.9;   // Phase 118: a softer, satin blur (13 taps, two rings)
        vec4 c = texture2D(tMirror, uv) * 0.16
          + (texture2D(tMirror, uv + vec2(o.x, 0.0)) + texture2D(tMirror, uv - vec2(o.x, 0.0))
           + texture2D(tMirror, uv + vec2(0.0, o.y)) + texture2D(tMirror, uv - vec2(0.0, o.y))) * 0.09
          + (texture2D(tMirror, uv + q) + texture2D(tMirror, uv - q)
           + texture2D(tMirror, uv + vec2(q.x, -q.y)) + texture2D(tMirror, uv + vec2(-q.x, q.y))) * 0.075
          + (texture2D(tMirror, uv + vec2(o.x * 2.0, 0.0)) + texture2D(tMirror, uv - vec2(o.x * 2.0, 0.0))
           + texture2D(tMirror, uv + vec2(0.0, o.y * 2.0)) + texture2D(tMirror, uv - vec2(0.0, o.y * 2.0))) * 0.045;
        float k = uK * (1.0 - smoothstep(0.45, 1.0, length(vW.xz - uC) / uR));   // a polished floor, fading out across the room
        float w = 0.0, fm = 0.0;                             // Phase 119: wet floor — darker, and a much better mirror; Phase 121: foam
        if (uWetOn > 0.5) {
          vec2 wu = (vW.xz - uWetC) / (2.0 * uWetE) + 0.5;
          if (wu.x > 0.0 && wu.x < 1.0 && wu.y > 0.0 && wu.y < 1.0) { vec2 t = texture2D(uWet, wu).rg; w = t.r; fm = t.g; }
          float b = vn(vW.xz * uNs * 9.0) * 0.55 + vn(vW.xz * uNs * 23.0) * 0.45;   // clumps and bubbles
          fm = smoothstep(0.22, 0.75, fm + (b - 0.5) * 0.55) * (0.55 + 0.45 * b);
          float n = vn(vW.xz * uNs) * 0.6 + vn(vW.xz * uNs * 3.1) * 0.4;
          w = smoothstep(0.1, 0.5, w + (n - 0.5) * 0.3);
        }
        float kr = k + w * 0.42;
        // the sheen of a wet floor: brighter at a glancing view (Fresnel), streaked, in the room's cool white and red neon
        float fr = pow(1.0 - abs(normalize(cameraPosition - vW).y), 3.0);
        float st = vn(vW.xz * uNs * vec2(0.6, 4.0)) * 0.5 + 0.5;
        vec3 sheen = w * (0.012 + 0.11 * fr) * st * mix(vec3(0.62, 0.68, 0.8), vec3(1.0, 0.14, 0.12), 0.4);
        vec3 foam = vec3(0.62, 0.65, 0.7) * fm;               // white foam lying on the floor
        float a = clamp(w * 0.5 + c.a * kr + dot(sheen, vec3(0.3)) + fm * 0.9, 0.0, 1.0);
        gl_FragColor = vec4(a > 0.0 ? (c.rgb * kr * (1.0 - fm) + sheen + foam) / a : vec3(0.0), a);
      }`,
    transparent: true, depthWrite: false, opacity: 0.99 });   // opacity < 1: no part in the AO passes
  const m = new T.Mesh(new T.PlaneGeometry(1, 1), mat);
  m.rotation.x = -Math.PI / 2; m.renderOrder = -9; m.frustumCulled = false; m.visible = false; m.name = 'Phase117Mirror';   // under the shadow catcher (-8)
  V.scene.add(m); MIRROR.mesh = m;
  return MIRROR;
}
function renderMirror() {
  const M = ensureMirror(), r = V.models && V.models[V.url];
  if (!M.on || !r || !r.bbox) { M.mesh.visible = false; return; }
  const R = V.renderer, cam = V.camera, U = M.mesh.material.uniforms;
  const fy = V.stageState && Number.isFinite(V.stageState.floorY) ? V.stageState.floorY : 0;
  const box = r.hulls && r.hulls.full ? r.hulls.full.box : r.bbox;
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2, rad = 0.5 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const wetOn = !!(WET.tex && WET.max > 0.002 && WET.key === V.url), ext = wetOn ? Math.max(rad * 6, 2 * WET.E) : rad * 6;
  M.mesh.position.set(cx, fy + 0.0005, cz); M.mesh.scale.set(ext, ext, 1); M.mesh.updateMatrixWorld();
  U.uWetOn.value = wetOn ? 1 : 0;
  if (wetOn) { U.uWet.value = WET.tex; U.uWetC.value.set(WET.cx, WET.cz); U.uWetE.value = WET.E; U.uNs.value = 1 / (0.9 * WET.s); }
  U.uC.value.set(cx, cz); U.uR.value = rad * 1.6; U.uK.value = M.strength;
  R.getDrawingBufferSize(M.v2);
  const sc = M.v2.x < 1200 ? 0.4 : 0.5, w = Math.max(2, Math.round(M.v2.x * sc)), h = Math.max(2, Math.round(M.v2.y * sc));
  if (M.rt.width !== w || M.rt.height !== h) M.rt.setSize(w, h);
  U.uTexel.value.set(1 / w, 1 / h);
  // the camera mirrored in the floor: position, view direction and up reflected (a proper camera; the projection undoes the flip)
  const vc = M.cam; cam.updateMatrixWorld();
  vc.copy(cam, false);
  M.p.setFromMatrixPosition(cam.matrixWorld); cam.getWorldDirection(M.d); cam.getWorldQuaternion(M.q); M.u.set(0, 1, 0).applyQuaternion(M.q);
  M.d.add(M.p); M.p.y = 2 * fy - M.p.y; M.d.y = 2 * fy - M.d.y; M.u.y = -M.u.y;
  vc.position.copy(M.p); vc.up.copy(M.u); vc.lookAt(M.d); vc.updateMatrixWorld();
  vc.projectionMatrix.copy(cam.projectionMatrix); vc.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
  M.tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
  M.clip.constant = -(fy + 0.012);   // a hair above the floor: the flat ground pieces (contact shadow, wet ground) stay out of the reflection
  const bg = V.scene.background, prev = R.getRenderTarget(), ca = R.getClearAlpha(), su = R.shadowMap.autoUpdate;
  R.getClearColor(M.c);
  M.mesh.visible = false; V.scene.background = null; R.shadowMap.autoUpdate = false;   // the shadow maps of this frame are reused
  R.setRenderTarget(M.rt); R.setClearColor(0x000000, 0); R.clear(true, true, false);
  R.clippingPlanes = [M.clip]; R.render(V.scene, vc); R.clippingPlanes = [];
  R.setRenderTarget(prev); R.setClearColor(M.c, ca); R.shadowMap.autoUpdate = su; V.scene.background = bg;
  M.mesh.visible = true;
}

function renderFrame(withAO = true) {
  const ps = V.aoTargets && V.pr.postSettings();
  if (ps) {
    V.post.configure({ quality: ps.quality, look: ps.look });
    const aoCfg = withAO ? V.pr.aoSettings() : null;
    if (aoCfg) V.ao.configure(aoCfg.params, aoCfg.quality);
    // Phase 90: see-through mode (the showcase stage) — no room: the dome and the floors stay out of this frame, the shadow
    // catcher keeps the product's own shadow, and the output carries alpha so the page's showroom shows behind it.
    const LF = V.stage.floor;   // the legacy floor (V.floor is the stage floor for a production asset)
    const see = TRANSP, keep = see ? [V.dome.visible, LF.visible, V.stageFloor ? V.stageFloor.visible : false] : null;
    if (see && !SKY.on) {   // Phase 98c: a turntable look — the lights keep their place relative to the camera, so the shadow does not swing round with the product
      const t = V.controls.target, c = V.camera.position, az = Math.atan2(c.x - t.x, c.z - t.z);
      if (TURN.az0 == null || TURN.url !== V.url) { TURN.az0 = az; TURN.url = V.url; TURN.base = []; V.scene.traverse(o => { if (o.isDirectionalLight) TURN.base.push([o, o.position.clone()]); }); }
      const d = az - TURN.az0, cs = Math.cos(d), sn = Math.sin(d);
      for (const [L, p0] of TURN.base) { const tx = L.target ? L.target.position.x : 0, tz = L.target ? L.target.position.z : 0, x = p0.x - tx, z = p0.z - tz;
        L.position.set(tx + x * cs + z * sn, p0.y, tz - x * sn + z * cs); L.updateMatrixWorld(); if (L.target) L.target.updateMatrixWorld(); }
    }
    let fcol = null;
    if (see) {
      V.dome.visible = false; if (LF !== V.stageFloor) LF.visible = false; if (V.stageFloor) V.stageFloor.visible = false;   // (Phase 119: POV too — the dark room, the reflection, the shadow and the fires' glow carry the ground)   // Phase 99 (owner): no floor, no room — the page's own black; only the product's shadow stays
      const SF = V.stageFloor, U = SF && SF.userData.horizon;
      if (U && U.uSee) {
        const gl = V.renderer.getContext();
        U.uSee.value.set(POV.k > 0.35 ? 0 : 1, 0.42, 0.46, 0.5);                  // ellipse centre (y, share of the canvas from the bottom), radii
        U.uSeeVP.value.set(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        ROOM_U.vp.value.copy(U.uSeeVP.value); ROOM_U.on.value = 1;
        if (ROOM && ROOM.g.visible) { const p = ROOM.g.position, c = V.camera.position; ROOM.g.rotation.y = Math.atan2(p.x - c.x, p.z - c.z); }   // the arc stays behind the product
        fcol = SF.material.color.clone(); SF.material.color.multiplyScalar(0.7);    // darker, to sit in the page's own black
        fcol.r0 = SF.material.roughness; fcol.e0 = SF.material.envMapIntensity;
        SF.material.roughness = 0.3; SF.material.envMapIntensity = 1.1;           // Phase 96: a polished floor that catches the light
        fcol.ei = SF.material.emissiveIntensity;
        if (POV.k > 0.35) { SF.material.color.setRGB(0.008, 0.008, 0.01); SF.material.envMapIntensity = 0.4; SF.material.emissiveIntensity = 0; }   // Phase 119: POV — a dark, polished showroom floor
      }
    }
    V.post.transparent = see;
    V.post.overlay = see && SKY.on && !!SKY.scene;
    if (V.post.overlay) {   // Phase 102: the Blender room, ground-projected, straight onto the canvas; the product goes over it
      const R = V.renderer; R.setRenderTarget(null); R.setClearColor(0x000000, 0); R.clear(true, true, false); R.render(SKY.scene, V.camera);
    }
    if (see && !V.post.overlay) renderMirror();   // Phase 117: the floor reflection (see-through mode only)
    V.post.render(V.scene, V.camera, { ao: aoCfg ? V.ao : null, aoArgs: aoCfg ? [V.aoTargets, m => aoRole(m, aoCfg)] : null, dome: see ? null : V.dome, aoResponse: aoCfg ? aoCfg.hdrResponse : 'linear' });
    if (see) { V.dome.visible = keep[0]; LF.visible = keep[1]; if (V.stageFloor) V.stageFloor.visible = keep[2]; }
    if (MIRROR.mesh) MIRROR.mesh.visible = false;
    if (fcol) { V.stageFloor.material.color.copy(fcol); V.stageFloor.material.roughness = fcol.r0; V.stageFloor.material.envMapIntensity = fcol.e0; V.stageFloor.material.emissiveIntensity = fcol.ei; V.stageFloor.userData.horizon.uSee.value.x = 0; }
    return 'hdr';
  }
  V.renderer.render(V.scene, V.camera);
  if (withAO) renderAO();
  return 'direct';
}

// Ambient occlusion over the finished frame (direct path).
function renderAO() {
  const aoCfg = V.aoTargets && V.pr.aoSettings();
  if (!aoCfg) return false;
  V.ao.configure(aoCfg.params, aoCfg.quality);
  V.ao.render(V.scene, V.camera, V.aoTargets, m => aoRole(m, aoCfg));
  return true;
}

// AO role per mesh: product surfaces receive; glass and lamps only occlude (never darkened,
// so transmission and emission stay exactly as rendered); fading meshes (mode transitions)
// and overlays take no part. The floor occludes (tyre contact) but is never darkened.
const AO_NEVER_DARKEN = /^WEB_(LED_EMISSIVE|LENS_)/;
function aoRole(mesh, cfg) {
  if (mesh === V.floor) return cfg.floorOccludes ? 'occlude' : null;
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (!m || (m.transparent && m.opacity < 0.999)) return null;
  if (m.transmission > 0 || AO_NEVER_DARKEN.test(m.name)) return 'occlude';
  return 'receive';
}

function restoreAll() {
  if (!V) return;
  for (const list of [V.truckMeshes, V.allRig]) {
    if (!list) continue;
    for (const r of list) { r.mat.opacity = r.o0; r.mat.transparent = r.t0; r.mat.depthWrite = r.d0; r.mat.needsUpdate = true; r.mesh.visible = true; r.mesh.castShadow = r.c0 !== false; r.on = false; }
  }
  cutAmt = cutTarget = truckAmt = truckTarget = dimAmt = dimTarget = gunDimAmt = gunDimTarget = 0;
  PCUT.amt = 0;
  const pr_ = V.models && V.models[V.url] && V.models[V.url].production;
  if (pr_ && pr_.cutaway) pr_.cutaway.scene.visible = false;
  V.renderer.shadowMap.needsUpdate = true;   // re-bake the on-demand shadow for the reset state
}

// ── Mobile product-first viewer (Phase 23) ────────────────────────────────────
// Screen box (CSS px, canvas space) of the product as it is framed right now: the camera hull of the
// shown content for a production asset, the bounding box for a legacy GLB. Read-only.
const _psb = new THREE.Vector3();
function productScreenBox() {
  const r = V && V.models && V.models[V.url]; if (!r || !r.bbox) return null;
  const el = V.renderer.domElement, w = el.clientWidth, h = el.clientHeight; if (!w || !h) return null;
  let P;
  if (r.production && r.hulls) P = (mode === 'system' && r.hulls.system ? r.hulls.system : r.hulls.full).points;
  else { const b = r.bbox; P = []; for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) P.push(x, y, z); }
  V.camera.updateMatrixWorld();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    _psb.set(P[i], P[i + 1], P[i + 2]).project(V.camera);
    if (_psb.z > 1) continue;
    const x = (_psb.x * 0.5 + 0.5) * w, y = (0.5 - _psb.y * 0.5) * h;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  _psb.copy(V.controls.target).project(V.camera);
  return { x0, y0, x1, y1, width: w, height: h, pivot: { x: (_psb.x * 0.5 + 0.5) * w, y: (0.5 - _psb.y * 0.5) * h } };
}

// Reset: back to the default framing of the current mode — the same framing the product opens on
// (Phase 19 framing and limits as they are). Animated along the orbit sphere (azimuth the short way,
// polar and log-distance eased, so the path stays inside the orbit limits) and landed with the exact
// snap; a drag, a mode change or closing cancels it. Legacy detail views re-run their mode move.
let resetAnim = null;
function resetView(animate) {
  if (!V) return false;
  povDrop();     // Phase 119: Reset leaves the operator's view (the camera glides home from there)
  const r = V.models && V.models[V.url]; if (!r) return false;
  const prod = !!(r.production && r.hulls && V.pcam.active);
  if (!prod && mode !== 'full') { DrawerViewer.setMode(mode); return true; }
  if (resetAnim) { cancelAnimationFrame(resetAnim.raf); resetAnim = null; }
  ++focusWatch;
  const k = V.controls, ed = k.enableDamping;
  k.enableDamping = false; k.update(); k.enableDamping = ed;   // settle the release inertia now, not after the landing
  k.autoRotate = false;
  if (prod && mode === 'cutaway' && r.hasCut) { V.pcam.transition = null; return !!focusCutaway(animate); }   // Phase 67
  if (prod && mode === 'gun' && r.hasGun) { V.pcam.transition = null; return !!focusGun(animate); }         // Phase 80
  let end;
  if (prod) { V.pcam.transition = null; end = V.pcam.framing(mode === 'system' ? 'system' : 'full'); }
  else { const f = r.studio && r.studioFrame ? fitStudio(r.studioFrame) : fitBox(r.bbox, legacyFill()); end = { position: f.pos.clone(), target: f.tgt.clone() }; }
  const land = () => { if (prod) V.pcam.snap(end); else V.frameRecord(r); };
  return orbitTo(end, land, animate);
}
// Camera move along the orbit sphere (azimuth the short way, polar and log-distance eased, so the path stays inside the
// orbit limits), landed by `land()`. Shared by Reset (Phase 23) and component focus (Phase 25).
function orbitTo(end, land, animate) {
  const k = V.controls, r = V.models && V.models[V.url], prod = !!(r && r.production && V.pcam.active);
  const done = () => { resetAnim = null; land(); k.autoRotate = false; lastInteract = performance.now(); };
  if (!animate) { done(); return true; }
  const url = V.url, m = mode, t0 = k.target.clone(), t1 = end.target.clone();
  const s0 = new THREE.Spherical().setFromVector3(V.camera.position.clone().sub(t0));
  const s1 = new THREE.Spherical().setFromVector3(end.position.clone().sub(t1));
  const dTheta = Math.atan2(Math.sin(s1.theta - s0.theta), Math.cos(s1.theta - s0.theta));
  const s = new THREE.Spherical(), start = performance.now(), dur = 750;
  const step = () => {
    if (!visible || userInteracting || V.url !== url || mode !== m) { resetAnim = null; return; }
    const x = Math.min(1, (performance.now() - start) / dur), e = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(2 - 2 * x, 3) / 2;
    s.set(Math.exp(lerp(Math.log(s0.radius), Math.log(s1.radius), e)), lerp(s0.phi, s1.phi, e), s0.theta + dTheta * e);
    k.target.lerpVectors(t0, t1, e);
    V.camera.position.setFromSpherical(s).add(k.target);
    V.camera.lookAt(k.target);
    if (prod) V.pcam.zoomDesired = V.pcam.zoomShown = s.radius;   // a set pose, not a zoom input
    if (x < 1) resetAnim.raf = requestAnimationFrame(step); else done();
  };
  resetAnim = { raf: requestAnimationFrame(step) };
  return true;
}

// ── Product components (Phase 25): generic feature picking, highlight and focus ──────────────
// A production asset exports named features (`_FEATURE_ID_0` per vertex + a feature table per node; the NAME is stable
// across LODs). Everything here works on names and on whatever LOD is on screen; nothing product-specific.
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _fv = new THREE.Vector3();
const visibleChain = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
// meshes of the LOD on screen that carry any of the wanted feature names → cb(mesh, Set(ids))
function forFeatureMeshes(a, want, cb) {
  const rec = a.lods.get(a.activeLOD); if (!rec) return;
  for (const sc of [rec.scene, a.cutaway && a.cutaway.scene]) if (sc) sc.traverse(node => {   // + the Cutaway (Phase 67)
    const tbl = node.userData && node.userData.featureTable; if (!tbl) return;
    const ids = new Set(); for (let i = 0; i < tbl.length; i++) if (want.has(tbl[i].name)) ids.add(tbl[i].id ?? i);
    if (!ids.size) return;
    node.traverse(m => { if (m.isMesh && !m.userData.pvOverlay && m.geometry.attributes._feature_id_0) cb(m, ids); });
  });
}
// every triangle of `mesh` whose feature id is in `ids` → cb(i0, i1, i2)
function forFeatureTriangles(mesh, ids, cb) {
  const g = mesh.geometry, fa = g.attributes._feature_id_0, idx = g.index, n = idx ? idx.count / 3 : g.attributes.position.count / 3;
  for (let t = 0; t < n; t++) {
    const i0 = idx ? idx.getX(3 * t) : 3 * t;
    if (ids.has(Math.round(fa.getX(i0)))) cb(i0, idx ? idx.getX(3 * t + 1) : 3 * t + 1, idx ? idx.getX(3 * t + 2) : 3 * t + 2);
  }
}

// Pick: the first surface under a screen point that belongs to a named feature, on the LOD on screen. Faded (hidden)
// meshes and glazing are skipped, so the truck never blocks the rig in System view and glass never blocks what is behind.
function pickAt(clientX, clientY) {
  const r = V && V.models && V.models[V.url], a = r && r.production;
  if (!a || a.activeLOD == null || !a.lods.has(a.activeLOD)) return null;
  const rect = V.renderer.domElement.getBoundingClientRect();              // includes the Phase 23 CSS composition
  _ndc.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
  V.camera.updateMatrixWorld(); _ray.setFromCamera(_ndc, V.camera);
  const meshes = [];
  for (const sc of [a.lods.get(a.activeLOD).scene, a.cutaway && a.cutaway.scene]) if (sc) sc.traverse(o => {   // + the Cutaway (Phase 67)
    if (!o.isMesh || o.userData.pvOverlay || !visibleChain(o)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && ((m.transparent && m.opacity < 0.3) || m.transmission > 0.5)) return;
    meshes.push(o);
  });
  const t0 = performance.now(), hits = _ray.intersectObjects(meshes, false), ms = performance.now() - t0;
  if (!hits.length) return { name: null, ms };
  const p = a.pick(hits[0]);
  return p ? { name: p.name, featureId: p.featureId, group: p.group, system: p.system, lod: a.activeLOD, point: hits[0].point.toArray(), ms } : { name: null, ms };
}

// World bounds of named features on the LOD on screen.
function featureBounds(names) {
  const r = V && V.models && V.models[V.url], a = r && r.production; if (!a) return null;
  const box = new THREE.Box3(); let n = 0;
  forFeatureMeshes(a, new Set(names), (mesh, ids) => {
    mesh.updateWorldMatrix(true, false);
    const P = mesh.geometry.attributes.position;
    forFeatureTriangles(mesh, ids, (i0, i1, i2) => { for (const i of [i0, i1, i2]) { box.expandByPoint(_fv.fromBufferAttribute(P, i).applyMatrix4(mesh.matrixWorld)); n++; } });
  });
  if (!n) return null;
  const sp = box.getBoundingSphere(new THREE.Sphere());
  return { center: sp.center, radius: sp.radius, box };
}

// Tolerant pick (Phase 27): for coarse pointers (a finger). The exact pick wins whenever it lands on a wanted feature
// (`names`). Otherwise the features listed in `targets` (name → tolerance px; the product data opts small parts in) get
// invisible targets: their bounding spheres (world space, per level of detail, built once) are projected; those behind
// the surface under the finger are dropped (cheap depth test), and of those whose screen disc comes within their
// tolerance, the nearest by centre is accepted only if a ray at its centre really hits it — nothing hidden behind other
// geometry can be taken. Geometry is never changed.
const SPH = { asset: null, lod: null, map: new Map() };
function featureSpheres(a, want) {
  if (SPH.asset !== a || SPH.lod !== a.activeLOD) { SPH.asset = a; SPH.lod = a.activeLOD; SPH.map = new Map(); }
  const missing = new Set([...want].filter(n => !SPH.map.has(n)));   // want: any iterable of names
  if (!missing.size) return SPH.map;
  const boxes = new Map(), rec = a.lods.get(a.activeLOD);
  if (rec) rec.scene.traverse(node => {
    const tbl = node.userData && node.userData.featureTable; if (!tbl) return;
    const idName = new Map(); for (let i = 0; i < tbl.length; i++) if (missing.has(tbl[i].name)) idName.set(tbl[i].id ?? i, tbl[i].name);
    if (!idName.size) return;
    node.traverse(m => {
      if (!m.isMesh || m.userData.pvOverlay || !m.geometry.attributes._feature_id_0) return;
      m.updateWorldMatrix(true, false);
      const P = m.geometry.attributes.position, F = m.geometry.attributes._feature_id_0;
      for (let i = 0; i < P.count; i++) { const n = idName.get(Math.round(F.getX(i))); if (!n) continue; let b = boxes.get(n); if (!b) boxes.set(n, b = new THREE.Box3()); b.expandByPoint(_fv.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld)); }
    });
  });
  for (const n of missing) { const b = boxes.get(n); SPH.map.set(n, b ? b.getBoundingSphere(new THREE.Sphere()) : null); }
  return SPH.map;
}
const _sp = new THREE.Vector3();
function pickNear(clientX, clientY, { targets = null, names = null } = {}) {
  const exact = pickAt(clientX, clientY);
  if (!exact || !targets || !targets.size || (exact.name && names && names.has(exact.name))) return exact && { ...exact, tolerant: false };
  const r = V.models[V.url], a = r && r.production; if (!a) return exact;
  const t0 = performance.now(), spheres = featureSpheres(a, targets.keys()), cam = V.camera, rect = V.renderer.domElement.getBoundingClientRect();
  const tanV = Math.tan(cam.fov * Math.PI / 360), cands = [];
  cam.updateMatrixWorld();
  const surface = exact.point ? cam.position.distanceTo(_sp.fromArray(exact.point)) : Infinity;   // what the finger is on
  for (const [n, tol] of targets) {
    const s = spheres.get(n); if (!s) continue;
    const range = cam.position.distanceTo(s.center);
    if (range - s.radius > surface + Math.max(0.02 * range, 3 * s.radius)) continue;              // behind that surface
    const depth = _sp.copy(s.center).applyMatrix4(cam.matrixWorldInverse).z * -1; if (depth <= cam.near) continue;
    const rpx = s.radius / (depth * tanV) * rect.height / 2;
    _sp.copy(s.center).project(cam);
    const sx = rect.left + (_sp.x * 0.5 + 0.5) * rect.width, sy = rect.top + (0.5 - _sp.y * 0.5) * rect.height, dc = Math.hypot(sx - clientX, sy - clientY);
    if (dc - rpx <= tol) cands.push({ n, dc, rpx, sx, sy });
  }
  cands.sort((p, q) => p.dc - q.dc);
  for (const c of cands.slice(0, 4)) {
    const h = pickAt(c.sx, c.sy);
    if (h && h.name && targets.has(h.name)) return { ...h, tolerant: true, offsetPx: +Math.max(0, c.dc - c.rpx).toFixed(1), candidates: cands.length, ms: performance.now() - t0 + exact.ms };
  }
  return { ...exact, tolerant: false, candidates: cands.length, ms: performance.now() - t0 + exact.ms };
}

// System-view context (Phase 66). In System mode a production product keeps its carrier / host vehicle as a ghost — a
// light fresnel shell over the charcoal stage — so the suppression system never floats and always reads in place.
// The overlays share the source meshes' geometry (no extra memory), cast no shadow, are skipped by the shadow policy,
// picking and the product roles (pvOverlay), and stay out of AO (transparent, opacity < 1). Declared per product in
// its configuration (viewer.presentation.systemContext: 'ghost' | 'hidden'; default 'ghost').
const GHOST_STYLE = { color: [0.5, 0.54, 0.6], face: 0.008, edge: 0.22 };   // chosen by comparison (report §4): context without haze
const GHOST = { mat: null, amt: 0 };
const PRESENTATION = Object.create(null);    // url -> { modes, systemContext } from the product configuration
function ghostMaterial() {
  if (GHOST.mat) return GHOST.mat;
  GHOST.mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(...GHOST_STYLE.color) }, uFace: { value: GHOST_STYLE.face }, uEdge: { value: GHOST_STYLE.edge }, uAmount: { value: 0 } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uColor; uniform float uFace, uEdge, uAmount; varying vec3 vN; varying vec3 vV; void main() { float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(uColor, mix(uFace, uEdge, f * f * f) * uAmount); }',
    transparent: true, opacity: 0.5, depthWrite: false,
  });
  GHOST.mat.name = 'pv_system_context_ghost';
  return GHOST.mat;
}
function systemContextOf(url) { const p = PRESENTATION[url]; return (p && p.systemContext) || 'ghost'; }
// Phase 80: a production Cutaway keeps the whole product solid (Phase 67) unless the product declares cutawayContext 'ghost' - the host
// vehicle then eases to the System ghost so the section inside a bakkie's load bed is not hidden behind the bodywork.
function cutawayContextOf(url) { const p = PRESENTATION[url]; return (p && p.cutawayContext) || 'solid'; }
// One ghost per carrier mesh of every loaded level of detail; ghosts of released levels are dropped.
function syncGhosts(r) {
  const G = r.ghosts || (r.ghosts = new Map()), live = new Set();
  for (const rec of r.truckMeshes || []) {
    const m = rec.mesh; live.add(m);
    if (G.has(m) || !m.parent || !m.geometry.attributes.normal) continue;
    const g = new THREE.Mesh(m.geometry, ghostMaterial());
    g.name = 'pv_ghost'; g.userData.pvOverlay = true; g.raycast = () => {};
    g.castShadow = false; g.receiveShadow = false; g.renderOrder = 4; g.visible = !!r.ghostsOn;
    g.position.copy(m.position); g.quaternion.copy(m.quaternion); g.scale.copy(m.scale);
    m.parent.add(g); G.set(m, g);
  }
  for (const [m, g] of G) if (!live.has(m)) { if (g.parent) g.parent.remove(g); G.delete(m); }
}
function showGhosts(r, on) {
  if (!r.ghosts || r.ghostsOn === on) return;
  r.ghostsOn = on; for (const g of r.ghosts.values()) g.visible = on;
}

// Highlight: an overlay of only the selected features' triangles (own compact geometry, read through the attribute API
// so quantization is handled), a child of the source mesh — it inherits transform, visibility and the System-view fades.
// Source materials and geometry are never touched; the overlay casts no shadow, stays out of AO and is never picked.
// Scene-linear tint (the HDR pipeline tone-maps it with everything else): faint on faces, stronger at grazing angles,
// so the part's form stays readable — a restrained selection coat, no outline, no glow.
const HL = { names: [], overlays: [], mat: null, tris: 0, lod: null, fadeFrom: 0, fadeMs: 0 };
// Phase 66: a warm-white selection rim instead of the Phase 25 ice-blue coat, which read as a material change (x-ray) on the
// red cylinders. Compared (report §7): a red tint vanishes on red equipment, any face tint reads as a new material; a rim
// with faces almost untouched keeps the part's own paint. True emphasis (dimming everything else) needs feature-aware
// product materials — the parts share merged meshes — and is left to a later renderer phase.
const HL_STYLE = { tint: [1.0, 0.95, 0.9], gain: 2.2, face: 0.04, edge: 0.9 };
function highlightMaterial() {
  if (HL.mat) return HL.mat;
  HL.mat = new THREE.ShaderMaterial({
    uniforms: { uTint: { value: new THREE.Color(...HL_STYLE.tint).multiplyScalar(HL_STYLE.gain) }, uFace: { value: HL_STYLE.face }, uEdge: { value: HL_STYLE.edge }, uAmount: { value: 1 } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uTint; uniform float uFace, uEdge, uAmount; varying vec3 vN; varying vec3 vV; void main() { float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(uTint, mix(uFace, uEdge, f * f) * uAmount); }',
    transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
  HL.mat.name = 'pv_component_highlight';
  return HL.mat;
}
// Presentation fade-in (Phase 27): a new selection's overlay eases in over `fadeMs` (smoothstep); a rebuild for another
// level of detail keeps the running fade. The amount is set per frame just before the overlays draw.
function hlAmount() { if (!HL.fadeMs) return 1; const x = (performance.now() - HL.fadeFrom) / HL.fadeMs; return x >= 1 ? 1 : x <= 0 ? 0 : x * x * (3 - 2 * x); }
function hlBeforeRender() { if (HL.mat) HL.mat.uniforms.uAmount.value = hlAmount(); }
function clearOverlays() {
  for (const o of HL.overlays) { if (o.parent) o.parent.remove(o); o.geometry.dispose(); }
  HL.overlays = []; HL.tris = 0; HL.lod = null;
}
function buildHighlight() {
  clearOverlays();
  const r = V && V.models && V.models[V.url], a = r && r.production;
  if (!a || !HL.names.length || a.activeLOD == null) return;
  forFeatureMeshes(a, new Set(HL.names), (mesh, ids) => {
    const P = mesh.geometry.attributes.position, N = mesh.geometry.attributes.normal, map = new Map(), pos = [], nor = [], index = [];
    const vert = i => { let j = map.get(i); if (j === undefined) { j = map.size; map.set(i, j); pos.push(P.getX(i), P.getY(i), P.getZ(i)); if (N) nor.push(N.getX(i), N.getY(i), N.getZ(i)); else nor.push(0, 1, 0); } return j; };
    forFeatureTriangles(mesh, ids, (i0, i1, i2) => index.push(vert(i0), vert(i1), vert(i2)));
    if (!index.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(map.size > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    g.computeBoundingSphere();
    const o = new THREE.Mesh(g, highlightMaterial());
    o.name = 'pv_highlight'; o.userData.pvOverlay = true; o.raycast = () => {};
    o.castShadow = false; o.receiveShadow = false; o.renderOrder = 10; o.onBeforeRender = hlBeforeRender;
    mesh.add(o); HL.overlays.push(o); HL.tris += index.length / 3;
  });
  HL.lod = a.activeLOD;
}
function setHighlight(names, { fadeMs = 0 } = {}) {
  HL.names = names && names.length ? [...names] : [];
  HL.fadeFrom = performance.now(); HL.fadeMs = HL.names.length ? Math.max(0, fadeMs) : 0;
  buildHighlight();
  return { features: HL.names.length, overlays: HL.overlays.length, triangles: HL.tris, lod: HL.lod };
}

// Focus: move the camera to named features through the existing camera — ProductCamera.moveTo (time-based ease,
// direction kept) or, when an azimuth/elevation is given, the shared orbit tween landed with ProductCamera.snap. Limits are
// the current ones, never changed; the default framing is untouched (Reset returns to it).
// `stopBeforeLOD: n` keeps the destination coarser than LOD n: the distance is raised until the product's projected size
// stays under that LOD's threshold for any orbit about the new pivot (the Phase 24 mobile guard). LOD rules are untouched.
let focusWatch = 0;
function focusFeatures(names, o = {}) {
  const r = V && V.models && V.models[V.url], a = r && r.production, pc = V && V.pcam;
  if (!a || !pc || !pc.active || !pc.limits) return null;
  const b = o.target ? { center: new THREE.Vector3().fromArray(o.target), radius: o.radius || 0.3 } : featureBounds(names);
  if (!b) return null;
  // during a view change (Full → System) the camera carries the union of both views' limits until it lands: focus
  // with the limits of the view being entered, so the move lands on them (Phase 26: switch view, then focus, one move)
  let L = (pc.transition && pc.transition.fr && pc.transition.fr.limits) || pc.limits; const cam = V.camera, k = V.controls, D2R = Math.PI / 180;
  if (o.minDistance != null || o.maxDistance != null) L = { ...L, minDistance: Math.min(L.minDistance, o.minDistance ?? L.minDistance), maxDistance: Math.max(L.maxDistance, o.maxDistance ?? L.maxDistance) };   // Phase 82k close-ups
  let dir = cam.position.clone().sub(k.target).normalize(); const turn = o.azimuth != null || o.elevation != null;
  if (turn) {
    const cur = new THREE.Spherical().setFromVector3(dir), az = o.azimuth != null ? o.azimuth : Math.atan2(dir.z, dir.x) / D2R;
    const polar = THREE.MathUtils.clamp(o.elevation != null ? 90 - o.elevation : cur.phi / D2R, L.minPolar / D2R, L.maxPolar / D2R);
    dir = dirFromAngles(az, polar).normalize();
  }
  const tanV = Math.tan(cam.fov * D2R / 2), t = Math.min(tanV, tanV * cam.aspect);
  // a component as large as the product is framed no further out than the default view (or the visitor's, if further;
  // while the camera is still moving — into another view, or to a previous focus — the view's default alone)
  const dCap = pc.transition ? (L.dDefault || L.maxDistance) : Math.max(L.dDefault || L.maxDistance, cam.position.distanceTo(k.target));
  let d = THREE.MathUtils.clamp(o.distance != null ? o.distance : Math.min(b.radius / (t * (o.fill || 0.55)), dCap), L.minDistance, L.maxDistance), guarded = false;
  if (o.stopBeforeLOD != null && LOD_CONFIG.maxPx[o.stopBeforeLOD + 1]) {
    const limit = LOD_CONFIG.maxPx[o.stopBeforeLOD + 1] * 0.92, R = r.bbox.getSize(_fv).length() / 2, C0 = r.bbox.getCenter(new THREE.Vector3());
    const dNeed = R * V.renderer.domElement.height / (tanV * limit) + b.center.distanceTo(C0);   // true size, any orbit about the pivot
    const s = r.lodPx || 0, dPred = s * cam.position.distanceTo(k.target) / limit;               // Phase 22 prediction at the move's start
    const dMin = Math.min(L.maxDistance, Math.max(dNeed, dPred));
    if (d < dMin) { d = dMin; guarded = true; }
  }
  const fr = { mode: pc.mode, target: b.center.clone(), position: b.center.clone().addScaledVector(dir, d), distance: d, limits: L };
  if (resetAnim) { cancelAnimationFrame(resetAnim.raf); resetAnim = null; }
  k.autoRotate = false; lastInteract = performance.now();
  const keepFocus = () => { pc.pristine = false; };   // a later resize keeps the visitor's view instead of re-framing the product
  if (!turn && o.animate !== false) {
    pc.moveTo(fr);
    const id = ++focusWatch, wait = () => { if (id !== focusWatch) return; if (pc.transition) requestAnimationFrame(wait); else keepFocus(); };
    requestAnimationFrame(wait);
  } else orbitTo(fr, () => { pc.snap(fr); keepFocus(); }, o.animate !== false);
  return { target: fr.target.toArray().map(v => +v.toFixed(4)), distance: +d.toFixed(4), radius: +b.radius.toFixed(4), guarded };
}

// Production Cutaway (Phase 67). The cut geometry is fetched the first time the mode is entered (never in Full / System), set up
// like a LOD (shadow policy, anisotropy before its first upload) and shown by frame() once resident. The view looks into the
// section: the host's own features framed from the direction the section faces (manifest cutaway.view, asset frame).
function ensureCutaway(r) {
  const a = r && r.production; if (!a || a.cutaway || r.cutLoading) return;
  const url = V.url, t0 = performance.now(), el = document.getElementById('drawer-viewer-loading');
  if (el) { el.classList.remove('is-hidden'); el.textContent = 'Loading cutaway…'; }
  r.cutLoading = a.loadCutaway().then(c => {
    if (!c || V.models[url] !== r) return;
    V.pr.applyShadowPolicy(c.scene);
    for (const t of a.textures()) if (t.anisotropy !== maxAniso) { t.anisotropy = maxAniso; t.needsUpdate = true; }
    r.cutLog = { ms: Math.round(performance.now() - t0), tris: c.stats.tris };
    if (HL.names.length) buildHighlight();                 // a selection shows on the cut geometry too
  }).catch(err => { r.cutLog = { error: String(err && err.message || err) }; if (!err || err.name !== 'AbortError') console.error('[drawer-viewer] cutaway failed', err); })
    .finally(() => { r.cutLoading = null; if (el && V.url === url) { if (r.cutLog && r.cutLog.error) el.textContent = 'Cutaway unavailable'; else el.classList.add('is-hidden'); } });
}
// Production Gun (Phase 80): the cannon framed from the manifest's gun view (direction in the asset frame, elevation, fill) at a fixed
// distance, exactly like the Cutaway view; the product stays whole and solid - the cannon is shown where it is mounted.
function focusGun(animate) {
  const r = V.models && V.models[V.url], a = r && r.production, g = a && a.manifest.gun; if (!g) return null;
  const v = g.view || {}, o = { fill: v.fill ?? 0.6, animate };
  if (v.direction) { a.root.updateMatrixWorld(true); const d = new THREE.Vector3().fromArray(v.direction).transformDirection(a.root.matrixWorld); o.azimuth = Math.atan2(d.z, d.x) * 180 / Math.PI; }
  if (v.elevation != null) o.elevation = v.elevation;
  const b = featureBounds(g.focusFeatures || []), L = V.pcam.limits;
  if (b && L) { const tanV = Math.tan(V.camera.fov * Math.PI / 360), t = Math.min(tanV, tanV * V.camera.aspect); o.distance = Math.min(b.radius / (t * o.fill), L.dDefault || L.maxDistance); }
  return focusFeatures(g.focusFeatures || [], o);
}
function focusCutaway(animate) {
  const r = V.models && V.models[V.url], a = r && r.production, c = a && a.manifest.cutaway; if (!c) return null;
  const v = c.view || {}, o = { fill: v.fill ?? 0.55, animate };
  if (v.direction) { a.root.updateMatrixWorld(true); const d = new THREE.Vector3().fromArray(v.direction).transformDirection(a.root.matrixWorld); o.azimuth = Math.atan2(d.z, d.x) * 180 / Math.PI; }
  if (v.elevation != null) o.elevation = v.elevation;
  // a fixed distance (the section's fill, never beyond the default view), so Enter and Reset always land on the same view -
  // focusFeatures on its own keeps a visitor's further distance, which on a portrait screen changes the framing
  const b = featureBounds(c.focusFeatures || []), L = V.pcam.limits;
  if (b && L) { const tanV = Math.tan(V.camera.fov * Math.PI / 360), t = Math.min(tanV, tanV * V.camera.aspect); o.distance = Math.min(b.radius / (t * o.fill), L.dDefault || L.maxDistance); }
  return focusFeatures(c.focusFeatures || [], o);
}

export const DrawerViewer = {
  // Show the viewer (build on first call). Resets to the full-vehicle view.
  open(url) {
    if (!V) build();
    if (!V) return false;
    povDrop();   // Phase 119: a new product starts outside the operator's view
    // A production asset is only kept while it is on screen (it is ~150 MB of GPU
    // memory); switching to another product releases it first.
    if (url && V.releaseProduction) for (const k of Object.keys(V.models)) if (k !== url && V.models[k].production) { ++V.prodToken; V.releaseProduction(); break; }
    if (url && V.loadUrl) V.loadUrl(url);       // load on first use, otherwise just swap
    visible = true;
    mode = 'full';
    restoreAll();
    HL.names = []; clearOverlays(); ++focusWatch;
    // Reset the gun to rest + foam off, and re-enable orbit.
    foamOn = false;
    systemOn = false;
    gunYaw = gunPitch = gunYawT = gunPitchT = 0;
    PGUN.yaw = PGUN.pitch = PGUN.yawT = PGUN.pitchT = 0; PGUN.dirty = true;   // Phase 82: the production cannon back at rest
    if (aimYaw) aimYaw.rotation.y = 0;
    if (aimPitch) aimPitch.rotation.x = 0;
    V.controls.enabled = true;
    // Hold still at the reset angle; the spin resumes after 10s of no input.
    V.controls.autoRotate = false;
    lastInteract = performance.now();
    const rec = V.models && V.models[V.url];
    resize();                              // fit against the live aspect, not a stale one
    if (rec) {
      V.frameRecord(rec);                  // fit the whole product, every time
    } else {
      const p0 = dolly({ x: 3.5, y: 2.05, z: 3.9 }, { x: 0, y: 0.95, z: -0.93 });
      V.camera.position.set(p0.x, p0.y, p0.z);
      V.controls.target.set(0, 0.95, -0.93); // rig centre → system stays centred on zoom
      V.controls.update();
    }
    if (!running) { running = true; requestAnimationFrame(frame); }
    // The drawer animates open, so the canvas reaches its real size a couple of
    // frames later — re-fit once it has, or the product sits off-centre.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resize();
      const r = V.models && V.models[V.url];
      if (r && mode === 'full') V.frameRecord(r);
    }));
    return true;
  },
  close() {
    visible = false;
    running = false; // stop the render loop — no GPU cost while closed
    // Production assets release their GPU resources on close (reference-counted,
    // shared textures included); reopening reloads from the HTTP cache.
    if (V && V.releaseProduction) V.releaseProduction();
    if (V && V.ao) V.ao.dispose();              // AO render targets, materials and noise textures; rebuilt on next frame
    if (V && V.post) V.post.dispose();          // HDR target (MSAA colour + depth), output material, backdrop copy; rebuilt on next frame
    if (V && V.prepRT) { V.prepRT.dispose(); V.prepRT = null; }   // 1×1 LOD-preparation target (Phase 22)
    // Phase 34: the shadow maps (re-created and re-rendered by the first frame after reopening) and the stage floor
    // textures (GPU copy only; canvas and image stay) are rebuilt for free, 176 MB of GPU memory while closed. The render
    // lists drop the last frame's objects, so the released product can be collected (VSS: 157 -> 39 MB of JS memory).
    if (V) {
      V.pr.releaseShadowMaps();
      const fm = V.stage.floor.material; for (const k of ['map', 'normalMap', 'alphaMap']) if (fm[k]) fm[k].dispose();
      V.renderer.renderLists.dispose();
    }
    HL.names = []; clearOverlays(); ++focusWatch;                   // component highlight (Phase 25)
  },
  // Switch view mode: 'full' | 'system' | 'cutaway'.
  // opts.keepView (Phase 114, owner: "activate system must not change the view"): switch what the product does, not where the
  // camera is — no gun close-up, no re-framing, and the vehicle stays visible
  setMode(newMode, opts = {}) {
    const keep = keepView = !!opts.keepView;
    mode = newMode;
    ++focusWatch;
    if (!V) return mode;
    const rec0 = (V.models && V.models[V.url]) || null, prodCut = !!(rec0 && rec0.production && rec0.hasCut && newMode === 'cutaway');
    const prodGun = !!(rec0 && rec0.production && rec0.hasGun && newMode === 'gun');                 // Phase 80
    const cutGhost = prodCut && cutawayContextOf(V.url) === 'ghost';
    cutTarget    = newMode === 'cutaway' ? 1 : 0;
    truckTarget  = newMode === 'full' || prodGun || (prodCut && !cutGhost) || keep ? 0 : 1;  // hide the truck for system/cutaway/gun (a production Cutaway / Gun keeps the product whole)
    truckFloor   = 0;                              // fully hidden (no ghost bakkie)
    dimTarget    = newMode === 'cutaway' && !prodCut ? 1 : 0;  // legacy: ghost everything but the sliced cylinder
    gunDimTarget = newMode === 'gun' && !prodGun && !keep ? 1 : 0;  // legacy: ghost everything but the cannon head

    // Orbit stays on in every mode (gun aims by hover, drag still orbits).
    V.controls.enabled = true;
    if (newMode === 'gun') { gunYawT = 0; gunPitchT = 0; foamOn = false; }
    if (newMode !== 'system') systemOn = false;   // leaving System shuts the discharge off
    if (newMode !== 'gun') POV.on = false;        // Phase 119: POV belongs to the cannon

    const rec = (V.models && V.models[V.url]) || null;
    if (prodCut && V.pcam.active) {                // Phase 67: fetch the cut geometry (once) and look into the section
      ensureCutaway(rec);
      focusCutaway(true);
      V.controls.autoRotate = false; lastInteract = performance.now();
      return mode;
    }
    if (keep) { lastInteract = performance.now(); return mode; }
    if (prodGun && V.pcam.active) {                // Phase 80: the cannon, framed where it is mounted
      focusGun(true);
      V.controls.autoRotate = false; lastInteract = performance.now();
      return mode;
    }
    if (rec && rec.production && V.pcam.active) {
      // Switching Full/System changes the content, not the viewpoint: keep the direction the
      // visitor orbited to, re-pivot and re-fit the distance for the new content.
      const dir = V.camera.position.clone().sub(V.controls.target);
      V.pcam.moveTo(V.pcam.framing(newMode === 'system' ? 'system' : 'full', { direction: dir.lengthSq() > 1e-8 ? dir : null }));
      V.controls.autoRotate = false; lastInteract = performance.now();
      return mode;
    }
    const g = window.gsap;
    const f = V.cylFocal || new THREE.Vector3(0, 1.0, -0.9);
    const auth = !rec || rec.authored;        // the hand-tuned 4CU framings
    const fr = rec && rec.frames;
    // The SYSTEM (rig) is the product, so it's the centre of attention in
    // every mode — zoom/orbit always pivots on it and keeps it dead-centre.
    // The 4CU's framings were composed by hand; every other product derives the
    // same shot from its own bounds (all GLBs share the 3.4-unit normalisation).
    const RIG = auth || !fr ? { x: 0, y: 0.95, z: -0.93 } : { x: fr.rig.x, y: fr.rig.y, z: fr.rig.z };
    const GUN = auth || !fr || !fr.gun ? { x: 0, y: 1.28, z: -0.8 } : { x: fr.gun.x, y: fr.gun.y, z: fr.gun.z };
    let camPos, camTgt = RIG;
    if (newMode === 'cutaway') {
      // Square onto the cut face (the plane's normal is +X), lifted a touch.
      // The authored 4CU offset is ~2.0 units for a 0.95-unit vessel; other
      // products size the same shot off their own vessel.
      camTgt = { x: f.x, y: f.y, z: f.z };
      camPos = auth ? { x: f.x + 2.0, y: f.y + 0.4, z: f.z + 0.65 }
                    : cutPos(f, fr.cutRadius);
    } else if (newMode === 'system') {
      if (auth) camPos = { x: 2.5, y: 1.75, z: 1.85 };
      else { const s = fitBox(fr.sysBox, legacyFill(0.74)); camPos = s.pos; camTgt = s.tgt; }
    } else if (newMode === 'gun') {
      // Centre + zoom in on the cannon head, with everything else ghosted.
      camPos = auth ? { x: 1.7, y: 1.66, z: 1.15 } : orbitPos(GUN, fr.gunRadius, 1.6); camTgt = GUN;
    } else {
      // Full: the WHOLE product — bakkie, trailer, trolley and all — fitted to
      // the frame and centred on its own silhouette. Every product, the 4CU
      // included: the authored offsets only stay for the detail shots.
      if (!rec) camPos = { x: 3.5, y: 2.05, z: 3.9 };
      else { const b = rec.studio && rec.studioFrame ? fitStudio(rec.studioFrame) : fitBox(rec.bbox, legacyFill()); camPos = b.pos; camTgt = b.tgt; }
    }
    // Keep whatever angle the viewer is looking from. Switching Full/System is
    // a change of CONTENT, not of viewpoint: re-target and re-fit the distance,
    // but swing the camera back onto the direction it already had, so a mode
    // press never throws away the angle the user orbited to.
    {
      const keep = V.camera.position.clone().sub(V.controls.target);
      if (keep.lengthSq() > 1e-6) {
        const tgt = new THREE.Vector3(camTgt.x, camTgt.y, camTgt.z);
        const dist = new THREE.Vector3(camPos.x, camPos.y, camPos.z).distanceTo(tgt);
        const p = tgt.clone().addScaledVector(keep.normalize(), dist);
        camPos = { x: p.x, y: p.y, z: p.z };
      }
    }
    // Push the authored (35°-era) framing out along the view axis so the
    // longer 28° lens keeps the identical composition.
    if (!(newMode === 'full' && rec && rec.studio && rec.studioFrame)) camPos = dolly(camPos, camTgt);   // Phase 80: fitStudio is already at 28 deg
    // Hold the reset angle still; the render loop resumes the gentle spin
    // after 10s of no interaction (only in full/system).
    V.controls.autoRotate = false;
    const finish = () => { V.controls.autoRotate = false; lastInteract = performance.now(); };
    if (g) {
      g.to(V.camera.position, { x: camPos.x, y: camPos.y, z: camPos.z, duration: 1.15, ease: 'power3.inOut' });
      g.to(V.controls.target, { x: camTgt.x, y: camTgt.y, z: camTgt.z, duration: 1.15, ease: 'power3.inOut', onComplete: finish });
    } else {
      V.camera.position.set(camPos.x, camPos.y, camPos.z);
      V.controls.target.set(camTgt.x, camTgt.y, camTgt.z);
      finish();
    }
    return mode;
  },
  getMode() { return mode; },
  getCaps() { return V && V.caps ? V.caps() : null; },
  setFoam(on) { foamOn = !!on; return foamOn; },
  discharge() { return DIS; },             // Phase 82j (checks)
  viewAsset(t, dir, dist) {                 // Phase 82l (checks): camera at an asset-frame target / direction / distance
    const r = V.models[V.url], AF = disAssetFrame(r); if (!AF) return null; const sc = new THREE.Vector3().setFromMatrixScale(AF).x;
    const T = new THREE.Vector3().fromArray(t).applyMatrix4(AF), u = new THREE.Vector3().fromArray(dir).transformDirection(AF).normalize(), d = dist * sc;
    const L = { ...V.pcam.limits, minDistance: Math.min(V.pcam.limits.minDistance, d * 0.5), maxDistance: Math.max(V.pcam.limits.maxDistance, d * 2) };
    V.pcam.snap({ mode: V.pcam.mode, target: T, position: T.clone().addScaledVector(u, d), distance: d, limits: L }); V.controls.autoRotate = false; lastInteract = performance.now(); return true;
  },
  gunAim() {                                // Phase 82 (checks)
    const st = PGUN.stream && PGUN.stream.layers.map(L => { let n = 0, sx = 0, sy = 0, sz = 0; const v = [];
      for (let i = 0; i < L.o.n; i++) if (L.life[i] < L.max[i]) { n++; v.push([L.vel[i * 3], L.vel[i * 3 + 1], L.vel[i * 3 + 2]]); }
      return { alive: n, size: L.pts.material.size, vis: L.pts.visible, v0: v.slice(0, 3) }; });
    const rc = V.renderer.domElement.getBoundingClientRect();
    const fires = FIRE.list && FIRE.list.map(f => { const q = f.p.clone().project(V.camera);
      return { hp: +f.hp.toFixed(2), out: f.out, vis: f.grp.visible, screen: [Math.round(rc.left + (q.x + 1) / 2 * rc.width), Math.round(rc.top + (1 - q.y) / 2 * rc.height)] }; });
    return { camDist: V.camera.position.distanceTo(V.controls.target), tgt: V.controls.target.toArray().map(v => +v.toFixed(3)), shotT: DIS.lastT, power: { draws: PWR.draws, skips: PWR.skips, visible: PWR.visible, coarse: COARSE, why: PWR.why,
      d: { cut: cutTarget - cutAmt, truck: truckTarget - truckAmt, dim: dimTarget - dimAmt, gd: gunDimTarget - gunDimAmt, ghost: GHOST.amt, pcut: PCUT.amt } }, fires, speed: PGUN.speed, yaw: PGUN.yaw, pitch: PGUN.pitch, yawT: PGUN.yawT, pitchT: PGUN.pitchT, rig: !!prodGunRig(), muzzle: _pg.mz.toArray(), dir: _pg.dir.toArray(), stream: st };
  },
  getFoam() { return foamOn; },
  setSpin(on, speed) { SPIN.on = !!on; if (speed) SPIN.speed = speed; if (V && !SPIN.on) { V.controls.autoRotate = false; V.controls.autoRotateSpeed = -0.9; lastInteract = performance.now(); } return SPIN.on; },   // Phase 104
  // Phase 104: frame the whole product (keeping the current direction), whatever the mode — e.g. the cannon while it sprays
  frameWhole() { if (!V || !V.pcam || !V.pcam.active) return false; const dir = V.camera.position.clone().sub(V.controls.target);
    V.pcam.moveTo(V.pcam.framing('full', { direction: dir.lengthSq() > 1e-8 ? dir : null })); return true; },
  setPolarLock(rad) { if (V && V.pcam) V.pcam.polarLock = rad == null ? null : rad; return true; },   // Phase 103: lock the tilt (showcase turntable)
  setTransparent(on) { TRANSP = !!on; TURN.az0 = null; if (!TRANSP) this.setSkybox(null); if (!TRANSP) { for (const [L, p0] of TURN.base) { L.position.copy(p0); L.updateMatrixWorld(); } TURN.base = []; this.setFloorGlow(null); this.setPlinth(null); this.setRoom(null); } return TRANSP; },
  // Phase 102: the showroom built in Blender — a 360° equirectangular panorama, ground-projected so the product stands on its
  // floor with true perspective at any orbit angle, plus the same room as the product's environment light (reflections).
  //   opts: { url, envUrl, heightM (panorama centre above the floor), radiusM (room radius), productHeightM, angle (radians) }
  async setSkybox(opts) {
    if (!V) return false;
    if (!opts) { SKY.on = false; if (SKY.envPrev !== null) { V.scene.environment = SKY.envPrev; SKY.envPrev = null; } return true; }
    const r = V.models && V.models[V.url]; if (!r) return false;
    const box = r.hulls && r.hulls.full ? r.hulls.full.box : r.bbox;
    const u = opts.productHeightM ? (box.max.y - box.min.y) / opts.productHeightM : 1;   // viewer units per metre
    const fy = V.stageFloor ? V.stageFloor.position.y : 0;
    if (SKY.key !== opts.url) {
      const tex = await new THREE.TextureLoader().loadAsync(opts.url);
      tex.colorSpace = THREE.SRGBColorSpace; tex.mapping = THREE.EquirectangularReflectionMapping; tex.anisotropy = 8;
      if (SKY.mesh) { SKY.mesh.material.uniforms.map.value.dispose(); SKY.mesh.geometry.dispose(); SKY.mesh.material.dispose(); }
      SKY.mesh = new GroundProjectedSkybox(tex); SKY.mesh.material.toneMapped = false; SKY.mesh.material.depthWrite = false;
      SKY.scene = new THREE.Scene(); SKY.scene.add(SKY.mesh); SKY.key = opts.url;
      if (opts.envUrl) {
        try {
          const hdr = await new RGBELoader().loadAsync(opts.envUrl); hdr.mapping = THREE.EquirectangularReflectionMapping;
          const pm = new THREE.PMREMGenerator(V.renderer); SKY.env = pm.fromEquirectangular(hdr).texture; pm.dispose(); hdr.dispose();
        } catch (e) { SKY.env = null; }
      }
    }
    // the shader projects around the world origin with the floor at y = 0: centre the room under the product, on its floor
    SKY.mesh.position.set((box.min.x + box.max.x) / 2, fy, (box.min.z + box.max.z) / 2);
    SKY.mesh.scale.setScalar(Math.max(4, 22 * u));
    SKY.mesh.height = (opts.heightM || 1.5) * u; SKY.mesh.radius = (opts.radiusM || 8) * u;
    SKY.mesh.rotation.y = opts.angle || 0;
    if (SKY.env) { if (SKY.envPrev === null) SKY.envPrev = V.scene.environment; V.scene.environment = SKY.env; }
    SKY.on = true;
    return { u };
  },
  // Phase 97: an architectural showroom around the product (owner: "that shape feels cheap — make it feel like an expensive
  // room"). A round room in 3D, so it turns with the camera: walls of dark fluted panels (instanced half-round slats) on a black
  // backing, a recessed LED cove at the foot of the wall and a fine line at its top, and accent slots of the product's colour
  // between panel bays. Every surface fades out at the canvas edges in see-through mode, so the room melts into the page.
  setRoom(color, opts = {}) {
    if (!V) return false;
    const r = V.models && V.models[V.url], SF = V.stageFloor;
    if (!ROOM) {
      // Phase 97b (owner: "seamless, elegant, expensive"): ONE continuous surface — the floor sweeps up into the wall through a
      // soft cove (an infinity cove), so there is no join anywhere. The fluting lives in the material: it rises out of the dark
      // at wall height and dissolves toward the top and the ends of the arc. A soft halo of the product's colour sits on the
      // wall right behind it. Every edge fades (floor edge, top, arc ends, canvas edges).
      const T = THREE, g = new T.Group(); g.name = 'Phase97Room';
      const R = 4.6, Hh = 6.5, ARC = Math.PI * 1.3, CR = 1.1, RIN = R - CR - 1.4;
      const prof = [new T.Vector2(RIN, 0.003)];
      for (let k = 0; k <= 4; k++) prof.push(new T.Vector2(RIN + (R - CR - RIN) * k / 4, 0.003));
      for (let k = 1; k <= 18; k++) { const t = (k / 18) * Math.PI / 2; prof.push(new T.Vector2(R - CR + Math.sin(t) * CR, 0.003 + CR - Math.cos(t) * CR)); }
      for (let k = 1; k <= 10; k++) prof.push(new T.Vector2(R, 0.003 + CR + (Hh - CR) * k / 10));
      const geo = new T.LatheGeometry(prof, 160, -ARC / 2, ARC);
      // Phase 98b (owner's reference: sweeping dark slabs with thin red neon edges): large overlapping curved plates, drawn once.
      // The lathe's v runs floor -> cove -> wall; it is remapped so the wall alone spans the texture (v 0..1, top = ceiling).
      { const uv = geo.attributes.uv, n = prof.length; for (let i = 0; i < uv.count; i++) { const j = uv.getY(i) * (n - 1); uv.setY(i, Math.min(1, Math.max(0, (j - 23) / (n - 1 - 23)))); } }
      const faceted = (() => {
        const W = 2048, H = 768, TAU = Math.PI * 2;
        const cc = document.createElement('canvas'), nc = document.createElement('canvas'); cc.width = nc.width = W; cc.height = nc.height = H;
        const cx = cc.getContext('2d'), nx = nc.getContext('2d');
        cx.fillStyle = '#060709'; cx.fillRect(0, 0, W, H); nx.fillStyle = '#000'; nx.fillRect(0, 0, W, H);
        const curve = (x, o) => H * 0.5 + o.off + o.A * Math.sin(TAU * o.k * x / W + o.ph) + o.B * Math.sin(TAU * (o.k + 1) * x / W + o.ph * 1.7);
        const rb = [
          { off: -300, th: 330, A: 120, B: 40, k: 2, ph: 0.4, a: '#3a3c44', b: '#16171c' }, { off: -150, th: 300, A: 150, B: 50, k: 3, ph: 2.1, a: '#30323a', b: '#121317' },
          { off: -10, th: 340, A: 130, B: 60, k: 2, ph: 3.6, a: '#40424b', b: '#191a1f' }, { off: 120, th: 300, A: 160, B: 40, k: 3, ph: 5.2, a: '#2d2f36', b: '#101115' },
          { off: 250, th: 360, A: 110, B: 55, k: 2, ph: 1.3, a: '#363840', b: '#14151a' }];
        const neon = [[1, 0.5, 0.26], [2, 0.38, 0.2], [3, 0.52, 0.24], [4, 0.63, 0.22]];   // [ribbon, centre across the width, half-length share]
        rb.forEach((o, ri) => {
          cx.save(); cx.shadowColor = 'rgba(0,0,0,0.95)'; cx.shadowBlur = 70; cx.shadowOffsetY = 26;
          cx.beginPath(); for (let x = 0; x <= W; x += 8) { const y = curve(x, o); x ? cx.lineTo(x, y) : cx.moveTo(x, y); }
          for (let x = W; x >= 0; x -= 8) cx.lineTo(x, curve(x, o) + o.th); cx.closePath();
          const g = cx.createLinearGradient(0, H * 0.2, 0, H * 0.95); g.addColorStop(0, o.a); g.addColorStop(1, o.b); cx.fillStyle = g; cx.fill(); cx.restore();
          // the plate's top edge: a thin lit rim in every plate
          cx.save(); cx.beginPath(); for (let x = 0; x <= W; x += 8) { const y = curve(x, o); x ? cx.lineTo(x, y) : cx.moveTo(x, y); }
          cx.strokeStyle = 'rgba(190,196,210,0.10)'; cx.lineWidth = 1.5; cx.stroke(); cx.restore();
          neon.filter(n => n[0] === ri).forEach(([, c, hl]) => {
            const x0 = (c - hl) * W, x1 = (c + hl) * W, mk = (g2, col) => { g2.addColorStop(0, col + '0)'); g2.addColorStop(0.5, col + '1)'); g2.addColorStop(1, col + '0)'); return g2; };
            const edge = (ctx, wd, col, blur) => { ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = wd; ctx.shadowColor = col + '0.9)'; ctx.shadowBlur = blur;
              ctx.strokeStyle = mk(ctx.createLinearGradient(x0, 0, x1, 0), col); ctx.beginPath();
              for (let x = x0; x <= x1; x += 6) { const y = curve(x, o); x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); ctx.restore(); };
            edge(nx, 9, 'rgba(255,255,255,', 40); edge(nx, 3.2, 'rgba(255,255,255,', 14);       // the neon (white; the material tints it)
            edge(cx, 46, 'rgba(120,12,20,', 70);                                                  // and its faint glow on the plate beside it
          });
        });
        const cm = new T.CanvasTexture(cc), nm = new T.CanvasTexture(nc);
        cm.colorSpace = T.SRGBColorSpace; nm.colorSpace = T.SRGBColorSpace;
        for (const t of [cm, nm]) { t.wrapS = T.RepeatWrapping; t.wrapT = T.ClampToEdgeWrapping; t.anisotropy = 4; }
        return { cm, nm };
      })();
      const U = { uGlow: { value: new T.Color(0xff2030) }, uR: { value: R }, uH: { value: Hh }, uRin: { value: RIN }, uHalfArc: { value: ARC / 2 } };
      const mat = new T.MeshStandardMaterial({ color: 0xffffff, map: faceted.cm, emissive: new T.Color(0xff2030), emissiveMap: faceted.nm, emissiveIntensity: 2.6, roughness: 0.4, metalness: 0.15, envMapIntensity: 0.5, side: T.BackSide, transparent: true, depthWrite: false });
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, U); sh.uniforms.uSeeVP = ROOM_U.vp; sh.uniforms.uSeeOn = ROOM_U.on;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRoomP;')
          .replace('#include <project_vertex>', '#include <project_vertex>\n  vRoomP = position;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vRoomP; uniform vec3 uGlow; uniform float uR, uH, uRin, uHalfArc; uniform vec4 uSeeVP; uniform float uSeeOn;`)
          .replace('#include <map_fragment>', `#include <map_fragment>
  float rr = length(vRoomP.xz), yy = vRoomP.y, ang = atan(vRoomP.x, vRoomP.z);
  float wallK = smoothstep(1.0, 2.0, yy) * (1.0 - smoothstep(uH * 0.5, uH * 0.92, yy));       // flutes only on the open wall
  float fl = 0.5 + 0.5 * cos(ang * 150.0);                                                     // ~150 flutes over the circle
  diffuseColor.rgb *= mix(1.0, 0.0, 0.0) * mix(0.18, 1.0, smoothstep(0.6, 2.6, yy));`)   // the floor part stays dark; the wall carries the relief
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  { float behind = exp(-ang * ang / 0.16);                                                      // straight behind the product
    float halo = behind * exp(-pow((yy - 1.6) / 1.5, 2.0));
    float wash = exp(-pow((yy - 3.4) / 1.8, 2.0)) * (0.5 + 0.5 * wallK);                 // a soft wash from above
    totalEmissiveRadiance += uGlow * 0.06 * halo + vec3(0.62, 0.64, 0.7) * 0.014 * wash * behind; }`)
          .replace('#include <dithering_fragment>', `#include <dithering_fragment>
  float k = smoothstep(0.45, 1.9, yy)                                                           // Phase 99b: rises out of the black floor (the floor part stays invisible)
          * (1.0 - smoothstep(uH * 0.55, uH * 0.98, yy))                                        // dissolves toward the top
          * smoothstep(0.0, 0.5, uHalfArc - abs(ang));                                           // and toward the ends of the arc
  if (uSeeOn > 0.5) { vec2 e = (gl_FragCoord.xy - uSeeVP.xy) / uSeeVP.zw;
    k *= smoothstep(0.0, 0.22, 1.0 - e.y) * smoothstep(0.0, 0.04, e.x) * smoothstep(0.0, 0.04, 1.0 - e.x); }   // Phase 99c: the canvas spans the whole section — only a soft fade at the top, no vignette
  gl_FragColor *= k;`);
      };
      mat.customProgramCacheKey = () => 'phase97cove';
      const cove = new T.Mesh(geo, mat); cove.renderOrder = -9;
      g.add(cove);
      ROOM = { g, U, R, mat };
      V.scene.add(g);
    }
    if (!color || !r || !SF) { ROOM.g.visible = false; ROOM_U.on.value = 0; return false; }
    const box = r.hulls && r.hulls.full ? r.hulls.full.box : r.bbox;
    ROOM.g.position.set((box.min.x + box.max.x) / 2, SF.position.y, (box.min.z + box.max.z) / 2);
    const size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    ROOM.g.scale.setScalar(Math.max(0.85, size / 3.4));
    ROOM.U.uGlow.value.set(color); ROOM.mat.emissive.set(color);
    ROOM.g.visible = true;
    return true;
  },
  // Phase 95: "The Bay" — a display turntable inlaid in the stage floor: a dark, glossy disc under the product, a thin glowing
  // ring at its rim (the Ritestand circle, in the product's colour) and a soft halo just outside it. See-through stage only.
  setPlinth(color) {
    if (!V) return false;
    const r = V.models && V.models[V.url], SF = V.stageFloor;
    if (!PLINTH) {
      const T = THREE, g = new T.Group(); g.name = 'Phase95Plinth';
      const disc = new T.Mesh(new T.CircleGeometry(1, 96), new T.MeshStandardMaterial({ color: 0x050608, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.18, transparent: true, opacity: 0.85, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2; disc.renderOrder = -9;
      const ring = new T.Mesh(new T.RingGeometry(0.991, 1.0, 160), new T.MeshBasicMaterial({ color: 0xff2030, transparent: true, opacity: 0.5, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false, side: T.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.renderOrder = -7;
      const hc = document.createElement('canvas'); hc.width = 512; hc.height = 8; const hx = hc.getContext('2d');
      const hg = hx.createLinearGradient(0, 0, 512, 0); hg.addColorStop(0, 'rgba(255,255,255,0)'); hg.addColorStop(0.42, 'rgba(255,255,255,0.55)'); hg.addColorStop(0.5, 'rgba(255,255,255,1)'); hg.addColorStop(0.58, 'rgba(255,255,255,0.4)'); hg.addColorStop(1, 'rgba(255,255,255,0)');
      hx.fillStyle = hg; hx.fillRect(0, 0, 512, 8);
      const htex = new T.CanvasTexture(hc);
      const haloGeo = new T.RingGeometry(0.86, 1.16, 160, 1);
      { const uv = haloGeo.attributes.uv, pos = haloGeo.attributes.position; for (let i = 0; i < uv.count; i++) { const d = Math.hypot(pos.getX(i), pos.getY(i)); uv.setXY(i, (d - 0.86) / 0.30, 0.5); } }
      const halo = new T.Mesh(haloGeo, new T.MeshBasicMaterial({ color: 0xff2030, map: htex, transparent: true, opacity: 0.22, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
      halo.rotation.x = -Math.PI / 2; halo.renderOrder = -7;
      g.add(disc, ring, halo); PLINTH = { g, disc, ring, halo };
      V.scene.add(g);
    }
    if (!color || !r || !SF) { PLINTH.g.visible = false; return false; }
    const box = r.hulls && r.hulls.full ? r.hulls.full.box : r.bbox;
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    const rad = 0.5 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.98;   // the footprint's long side: the wheels sit on the disc, the corners may overhang (as on any turntable)
    PLINTH.g.position.set(cx, SF.position.y + 0.0004, cz); PLINTH.g.scale.setScalar(rad);
    PLINTH.ring.position.y = PLINTH.halo.position.y = 0.0015 / rad;
    PLINTH.ring.material.color.set(color); PLINTH.halo.material.color.set(color);
    PLINTH.g.visible = true;
    return { cx, cz, rad };
  },
  // Phase 94: a pool of the product's colour on the stage floor itself (emissive, in perspective, under the product)
  setFloorGlow(color, intensity = 1) {
    const f = V && V.stageFloor; if (!f) return false;
    const m = f.material;
    if (!color) { m.emissiveIntensity = 0; return true; }
    if (!FLOOR_GLOW_TEX) {
      const c = document.createElement('canvas'); c.width = c.height = 512; const x = c.getContext('2d');
      const g = x.createRadialGradient(256, 256, 0, 256, 256, 256);
      // the floor is a disc of radius 16; the pool reaches ~4.5 units, hot in the middle, long soft falloff
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.03, '#d2d2d2'); g.addColorStop(0.07, '#7a7a7a'); g.addColorStop(0.11, '#2e2e2e');
      g.addColorStop(0.16, '#0c0c0c'); g.addColorStop(0.22, '#000000'); g.addColorStop(1, '#000000');
      x.fillStyle = g; x.fillRect(0, 0, 512, 512);
      // Phase 98: the light of a ring-shaped ceiling fixture overhead, falling on the floor as fine concentric rings
      x.globalCompositeOperation = 'lighter'; x.lineCap = 'round';
      [[0.115, 2.2, 0.55], [0.17, 1.4, 0.4], [0.235, 1.0, 0.28], [0.31, 0.8, 0.18]].forEach(([r, w, a]) => {
        x.strokeStyle = `rgba(255,255,255,${a})`; x.lineWidth = w; x.beginPath(); x.arc(256, 256, r * 512, 0, Math.PI * 2); x.stroke(); });
      x.globalCompositeOperation = 'source-over';
      FLOOR_GLOW_TEX = new THREE.CanvasTexture(c); FLOOR_GLOW_TEX.colorSpace = THREE.SRGBColorSpace;
    }
    if (m.emissiveMap !== FLOOR_GLOW_TEX) { m.emissiveMap = FLOOR_GLOW_TEX; m.needsUpdate = true; }
    m.emissive.set(color); m.emissiveIntensity = intensity;
    return true;
  },   // Phase 90: see-through canvas for the showcase stage (no dome / floor, shadow kept)
  getTransparent() { return TRANSP; },
  // Phase 117: the floor reflection in see-through mode — on/off and its strength (0..1)
  // Phase 119: the operator's POV behind the cannon (Gun view / spraying only)
  setPOV(on, opts) { return setPOV(on, opts); },
  getPOV() { return POV.on; },
  dofDebug(on) { DOF.dbg = !!on; return DOF.dbg; },
  dofRead(fx, fy) { const R = V.renderer, out = {}; for (const k of ['z', 'c', 'c2', 'a']) { const t = DOF[k]; if (!t) continue; const b = new Uint16Array(4);
      R.readRenderTargetPixels(t, Math.floor(fx * t.width), Math.floor(fy * t.height), 1, 1, b); out[k] = [...b].map(v => THREE.DataUtils.fromHalfFloat(v).toFixed(3)).join(','); } return out; },
  jetInfo() { const T = PGUN.tube; return { vh: !!VH.h, vhKey: VH.key, end: T ? +T.m.uniforms.uEnd.value.toFixed(3) : null, path: PGUN.path ? PGUN.path.length : 0, last: PGUN.path && PGUN.path.length ? PGUN.path[PGUN.path.length - 1].toArray().map(v => +v.toFixed(2)) : null }; },
  dofInfo() { const P = prodGunRig(); let tagged = 0; if (P) for (const L of P.a.lods.values()) { const r = PGUN.rest.get(L.scene); if (r) for (const e of r) { tagged++; } } return { amt: DOF.amt, F: DOF.F, enabled: DOF_STAGE.enabled, inStages: !!(V.post && V.post.stages.includes(DOF_STAGE)), stages: V.post ? V.post.stages.length : -1, tagged, nodes: P ? [...P.nodes] : null }; },
  wetLevel() { return { max: WET.max, key: WET.key, E: WET.E, cx: WET.cx, cz: WET.cz }; },
  setMirror(on, strength) { MIRROR.on = !!on; if (Number.isFinite(strength)) MIRROR.strength = strength; return MIRROR.on; },
  // Vehicle-system discharge — every nozzle sprays at once (system mode only).
  setSystem(on) { systemOn = !!on; return systemOn; },
  getSystem() { return systemOn; },
  setZoom(t) { setZoom(t); return getZoom(); },
  getZoom() { return getZoom(); },
  // ── Production asset (Phase 13) ─────────────────────────────────────────
  // The current product's ProductionAsset (null for legacy GLB products).
  production() { const r = V && V.models && V.models[V.url]; return r && r.production ? r.production : null; },
  // Lamps: 'off' | 'low' | 'on' (Phase 6/9 EMISSION_LEVEL presets). Default off.
  setLamps(level) { const a = this.production(); return a ? a.setLamps(level) : null; },
  // Independently loadable / disposable LODs (the runtime selector, LOD_CONFIG.auto, drives them automatically).
  async loadLOD(n) { const a = this.production(); if (!a) return null; const r = await a.loadLOD(n);
    V.pr.applyShadowPolicy(a.root);
    for (const t of a.textures()) if (t.anisotropy !== maxAniso) { t.anisotropy = maxAniso; t.needsUpdate = true; }
    a.showLOD(a.activeLOD ?? n); V.refreshProductionRoles(V.url); return r; },
  showLOD(n) { const a = this.production(); if (!a || !a.lods.has(n)) return false; a.showLOD(n); V.refreshProductionRoles(V.url); return true; },
  unloadLOD(n) { const a = this.production(); if (!a || a.activeLOD === n) return false; a.unloadLOD(n); V.refreshProductionRoles(V.url); return true; },
  // ── Product renderer (Phase 14) ─────────────────────────────────────────
  // Swap the IBL environment of the active profile ('neutral-studio' | 'industrial-neutral' | 'bright-studio').
  async setEnvironment(id) { if (!V) return null; await V.pr.configure({ environment: id }); return V.pr.state(); },
  // Patch the active profile, e.g. { key: { ratio: 1.5 } } or { shadow: { quality: 'high' } }.
  async configureRenderer(patch) { if (!V) return null; await V.pr.configure(patch); return V.pr.state(); },
  getRendererState() { return V ? { ...V.pr.state(), aoMemory: V.ao.memory(), postMemory: V.post.memory(), stage: V.stageState, camera: V.pcam.active ? V.pcam.state() : null, lod: this.getLODState() } : null; },
  // Runtime LOD (Phase 21): automatic selection on/off (manual showLOD is overridden while it is on) and its state.
  setAutoLOD(on) { LOD_CONFIG.auto = !!on; return LOD_CONFIG.auto; },
  getCutawayState() { const r = V && V.models && V.models[V.url], a = r && r.production; if (!a || !r.hasCut) return null;
    return { loaded: !!a.cutaway, loading: !!r.cutLoading, amount: +PCUT.amt.toFixed(3), shown: !!(a.cutaway && a.cutaway.scene.visible), log: r.cutLog || null }; },
  getLODState() { const r = V && V.models && V.models[V.url], a = r && r.production; if (!a) return null;
    return { auto: LOD_CONFIG.auto, active: a.activeLOD, wanted: r.lodWant, px: r.lodPx == null ? null : Math.round(r.lodPx), resident: [...a.lods.keys()].sort(), loading: !!r.lodLoading, log: r.lodLog }; },
  // ── Mobile product-first viewer (Phase 23) ──────────────────────────────────
  getProductScreenBox() { return productScreenBox(); },
  resetView({ animate = true } = {}) { return resetView(animate); },
  isResetting() { return !!resetAnim; },
  // Re-measure the canvas after a page-layout change that fired no window resize.
  refreshSize() { resize(); },
  // ── Product components (Phase 25) ───────────────────────────────────────────
  featureCatalog() { const a = this.production(); return a ? [...a.components.values()].map(c => ({ name: c.name, system: c.system, group: c.group, anchor: c.anchor, lods: Object.keys(c.lods).map(Number) })) : []; },
  pickAt(clientX, clientY) { return pickAt(clientX, clientY); },
  setHighlight(names, opts) { return setHighlight(names, opts); },
  getHighlight() { return { names: [...HL.names], overlays: HL.overlays.length, triangles: HL.tris, lod: HL.lod }; },
  setHighlightStyle(st = {}) { Object.assign(HL_STYLE, st); if (HL.mat) { HL.mat.uniforms.uTint.value.setRGB(...HL_STYLE.tint).multiplyScalar(HL_STYLE.gain); HL.mat.uniforms.uFace.value = HL_STYLE.face; HL.mat.uniforms.uEdge.value = HL_STYLE.edge; } return { ...HL_STYLE }; },
  featureBounds(names) { const b = featureBounds(names); return b && { center: b.center.toArray(), radius: b.radius, min: b.box.min.toArray(), max: b.box.max.toArray() }; },
  focusFeatures(names, opts) { return focusFeatures(names, opts); },
  // ── Per-product legacy framing (Phase 29) ───────────────────────────────────
  // { fill, fillPortrait } for a legacy GLB url (from its product configuration); re-frames it at once if it is on
  // screen and the visitor has not moved the camera since it was framed. Production assets ignore it (ProductCamera).
  // Phase 66: the product configuration's presentation declaration (viewer.presentation): { modes, systemContext }.
  // Re-announces the capabilities only when they change for the product on screen.
  setPresentation(url, p) {
    if (p && typeof p === 'object') PRESENTATION[url] = { modes: p.modes && typeof p.modes === 'object' ? { ...p.modes } : null, systemContext: p.systemContext || null, cutawayContext: p.cutawayContext || null };
    else delete PRESENTATION[url];
    if (V && V.url === url && V.loaded && V.caps) {
      const c = V.caps(), key = JSON.stringify(c);
      if (V.capsKey !== key) { V.capsKey = key; const st = document.getElementById('drawer-stage-3d'); if (st) st.dispatchEvent(new CustomEvent('dv:ready', { bubbles: true, detail: c })); }
    }
    return PRESENTATION[url] || null;
  },
  getPresentation(url) { const p = PRESENTATION[url || (V && V.url)]; return p ? { modes: p.modes ? { ...p.modes } : null, systemContext: p.systemContext, cutawayContext: p.cutawayContext || null } : null; },
  setFraming(url, cam) {
    if (!V) return null;
    V.framing = V.framing || Object.create(null);
    if (cam && (cam.fill != null || cam.fillPortrait != null)) V.framing[url] = { fill: cam.fill ?? null, fillPortrait: cam.fillPortrait ?? null };
    else delete V.framing[url];
    const r = V.models && V.models[url];
    if (V.url === url && r && !r.production && r.bbox && V.loaded && !movedSinceFrame && !userInteracting) V.frameRecord(r);
    return V.framing[url] || null;
  },
  // ── Product feature presentation (Phase 27) ─────────────────────────────────
  pickNear(clientX, clientY, opts) { return pickNear(clientX, clientY, opts); },
  isCameraMoving() { return !!(V && ((V.pcam && V.pcam.transition) || resetAnim)); },
};

window.DrawerViewer = DrawerViewer;
