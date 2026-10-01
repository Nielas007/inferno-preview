// SHOWROOM HERO — the live three.js scene behind the home hero (loaded by showroom.js once WebGL is known to work).
// Phase 70: the hero shares the production viewer's visual language — charcoal studio, dark matte floor with a
// light pool, warm key / warm-white rim, no mirror floor, no bloom, no forced clear-coat — and frames the hero
// product per layout band (phone / tablet / standard / wide) so it is whole on every screen. Each band's static
// poster (images/hero/…) is rendered from exactly the same camera, so the live scene takes over without a jump.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const canvas = document.getElementById('scene');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const lerp = THREE.MathUtils.lerp;
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const qs = new URLSearchParams(location.search);
const NO_CYCLE = qs.has('nocycle');
// Niel's call: hold the hero on one low cinematic angle instead of cycling
// through seven shots. Every bit of camera motion here — the 8 s shot cycle, the
// idle orbit/breathe drift and the mouse parallax — kept the whole 2.9 M
// triangle scene re-rendering forever, and each shot change hitched. Parked, the
// frame never changes, so the render loop can stand still too. `?cycle=1`
// restores the old moving hero.
const HERO_HOLD = qs.get('cycle') !== '1';
const HERO_DRIFT = { amp: 0.55, secs: 64 };    // metres of travel, seconds per round trip
const USE_REFLECTOR = qs.get('refl') === '1';      // Phase 70: matte studio floor by default
const V = (x, y, z) => new THREE.Vector3(x, y, z);
// Blender metres (Z-up) → three (Y-up): (x, y, z) → (x, z, -y)
const B = (x, y, z) => new THREE.Vector3(x, z, -y);

// ── Shots — from the Blender cameras ────────────────────────────
const SHOTS = [
  // Shot 0 IS the Cycles poster's camera (Blender CAM_Hall). Matching it exactly means the
  // poster→live crossfade has nothing to jump between: the same frame, one rendered, one live.
  { name: 'Hero',    pos: V( 4.60, 0.65,  -6.00), look: V( 0.00, 1.20, -0.40), fov: 28.4 },
  { name: 'HallLow', pos: V(-3.50, 0.55, -12.50), look: V(-4.50, 1.10, -1.00), fov: 32.3 },
  { name: 'Grille',  pos: V( 2.60, 0.70,  -5.64), look: V( 0.00, 0.80, -2.24), fov: 22.9 },
  { name: 'TRotor',  pos: V( 2.90, 3.42,   3.53), look: V( 0.00, 2.22,  0.93), fov: 19.2 },
  { name: 'Trailer', pos: V(-4.83, 1.20,  -7.06), look: V(-0.63, 1.18, -6.46), fov: 22.9 },
  { name: 'Skiddy',  pos: V( 3.44, 0.65, -10.99), look: V( 1.54, 0.76, -8.39), fov: 20.9 },
  { name: 'Bakkie2', pos: V(-2.20, 0.60,  -0.60), look: V(-4.39, 0.95, -3.10), fov: 28.4 },
];
const MODEL_SCALE = 0.1;                 // Showroom.blend: 10 units = 1 m
const ROW_MID = -6;                      // build_showroom.py hall centre (Blender x)

// ── Hero product + framing per layout band (Phase 70) ─────────────
// The hero product is declared on <section class="hero" data-hero-model=…> in index.html; swapping it needs only that
// attribute and the band posters, not this file. The four bands are the same breakpoints (viewport aspect) as the hero
// CSS and the <picture> posters. In a band the camera keeps the hero azimuth and a FIXED vertical fov, and the product
// sits at a fixed offset from the frame centre measured in frame heights (ox right, oy up) at a fixed width (wH, frame
// heights), seen from el degrees above its centre — eye height, so the matte floor reads as a surface with the light pool
// on it (a camera near the floor squeezes the lit floor into a bright line at the horizon). A viewport of the same band
// that is wider or narrower only reveals more or less at both sides — exactly what object-fit: cover does to that band's
// poster, which is rendered at the band's widest aspect. Poster = live first frame.
const HERO_MODEL = document.querySelector('.hero')?.dataset.heroModel || 'models/hero.glb?v=1';
const HERO_BANDS = [
  { name: 'phone',    upTo: 0.62,     vfov: 36,   el: 2.5, wH: 0.40, ox: 0.00, oy: 0.10 },
  { name: 'tablet',   upTo: 1.15,     vfov: 32,   el: 2.5, wH: 0.52, ox: 0.00, oy: 0.06 },
  { name: 'standard', upTo: 1.45,     vfov: 28.4, el: 2.5, wH: 0.60, ox: 0.26, oy: -0.03 },
  { name: 'wide',     upTo: Infinity, vfov: 28.4, el: 2.5, wH: 0.74, ox: 0.31, oy: -0.04 },
];
const bandFor = (aspect) => HERO_BANDS.find(b => aspect <= b.upTo);
// the hero azimuth: the original three-quarter front view (Blender CAM_Hall), horizontal part only
const HERO_AZ = (() => { const d = new THREE.Vector3(4.60, 0.65, -6.00).sub(new THREE.Vector3(0.00, 1.20, -0.40)); d.y = 0; return d.normalize(); })();
function frameFor(band, box) {
  const C = box.getCenter(new THREE.Vector3()), el = band.el * Math.PI / 180;
  const dir = new THREE.Vector3(HERO_AZ.x * Math.cos(el), Math.sin(el), HERO_AZ.z * Math.cos(el));
  const cam = new THREE.PerspectiveCamera(band.vfov, 1, 0.1, 1000), corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
  const widthH = (d) => { cam.position.copy(C).addScaledVector(dir, d); cam.lookAt(C); cam.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity; for (const p of corners) { const v = p.clone().project(cam); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); } return (x1 - x0) / 2; };  // aspect 1: NDC width / 2 = frame heights
  let lo = 0.5, hi = 500; for (let i = 0; i < 48; i++) { const d = (lo + hi) / 2; if (widthH(d) > band.wH) lo = d; else hi = d; }
  const d = (lo + hi) / 2, pos = C.clone().addScaledVector(dir, d);
  const fwd = C.clone().sub(pos).normalize(), right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(), up = new THREE.Vector3().crossVectors(right, fwd);
  const H = 2 * d * Math.tan(band.vfov * Math.PI / 360);          // frame height in metres at the product
  const look = C.clone().addScaledVector(right, -band.ox * H).addScaledVector(up, -band.oy * H);
  return { pos, look, fov: band.vfov, d, H };
}

// ── Renderer ─────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
// Cap the pixel ratio. The scene itself draws in ~6 ms, but bokeh + bloom on a
// full 3456x1702 retina buffer is 5.9 M pixels of blur every frame and that is
// where the hero's headroom goes. At 1.5 it is 2592x1276 — on a soft, depth-of-
// field render you cannot see the difference, and there is 2.6x the room to
// spare. `?dpr=2` puts it back.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, parseFloat(qs.get('dpr') || '1.5')));
renderer.setSize(window.innerWidth, window.innerHeight, false);
// Blender grades this scene through AgX, so the live view has to as well — ACES was the single
// biggest reason the WebGL pass and the Cycles stills did not look like the same room.
renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.52;     // Phase 70: lower (was 0.72) — saturated reds stay red through AgX instead of blowing to salmon
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Nothing in this hall ever moves — only the camera does — so the 4096² shadow
// map is identical every frame. Left on auto it re-rendered all 687 casters
// (6.4 M triangles) per frame before the beauty pass even started. Bake it once
// when the model lands instead; set needsUpdate again if anything is moved.
renderer.shadowMap.autoUpdate = false;
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
// Charcoal studio (Phase 70): a vertical gradient — darkest at the top, rising to the horizon tone exactly at the row where
// the current band's camera puts the horizon (repainted per band, see frameHero) — and a fog of that same horizon tone that
// only the floor receives (the product has fog off), so the floor melts into the backdrop instead of meeting it in a line.
const STUDIO = { horizon: 0.085, top: 0.010, warm: [1.0, 0.95, 0.88] };
const studioCanvas = document.createElement('canvas'); studioCanvas.width = 4; studioCanvas.height = 512;
const studioTex = new THREE.CanvasTexture(studioCanvas); studioTex.colorSpace = THREE.SRGBColorSpace;
function paintStudio(row) {   // row = the horizon's height in the frame, 0 = top … 1 = bottom
  const ctx = studioCanvas.getContext('2d'), g = ctx.createLinearGradient(0, 0, 0, 512);
  const s = (k) => { const y = STUDIO.top + (STUDIO.horizon - STUDIO.top) * k, w = STUDIO.warm, e = (v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); return `rgb(${e(y * w[0])},${e(y * w[1])},${e(y * w[2])})`; };
  const r = Math.min(0.97, Math.max(0.2, row));
  g.addColorStop(0, s(0)); g.addColorStop(r * 0.45, s(0.12)); g.addColorStop(r * 0.8, s(0.5)); g.addColorStop(r, s(1)); g.addColorStop(1, s(1));
  ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 512); studioTex.needsUpdate = true;
}
paintStudio(0.6);
scene.background = studioTex;
scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(STUDIO.horizon * STUDIO.warm[0], STUDIO.horizon * STUDIO.warm[1], STUDIO.horizon * STUDIO.warm[2]), 0.022);
const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 400);

// ── Lights — Blender's showroom rig, same places, same colours ──
// build_showroom.py: Key 16×5 m warm, Fill 18×10 cool, Rim 24×4 cool, all aimed at (ROW_MID, -1, 1).
const AIM = B(ROW_MID, -1.0, 1.0);
function area(color, intensity, w, h, bpos) {
  const l = new THREE.RectAreaLight(color, intensity, w, h);
  l.position.copy(bpos); l.lookAt(AIM); scene.add(l); return l;
}
// The old hall rig, dimmed to the same 30–45 % it runs at in Blender. It sets the room;
// the three shaping panels below do the actual work on the hero.
// Phase 70: warm key, neutral fill, warm-white rim (the production viewer's lighting language; no cold blue).
area(0xfff1e4, 2.1, 16, 5,  B(ROW_MID - 9.0, 13.0, 14.0));   // key
area(0xf3efe9, 0.4, 18, 10, B(ROW_MID + 13.0, 14.0, 7.0));   // fill
area(0xfff0e0, 1.4, 24, 4,  B(ROW_MID + 3.0, -12.0, 11.0));  // rim

// ── Shaping rig — the same three panels as the Cycles hero, in metres ──
// A matte wrap reads through gradient and edge, not highlight: one long strip overhead, one
// narrow cold rim grazing the far side from behind, one weak bounce on the camera side.
function panel(color, intensity, w, h, pos, aim) {
  const l = new THREE.RectAreaLight(color, intensity, w, h);
  l.position.copy(pos); l.lookAt(aim); scene.add(l); return l;
}
panel(0xfff5ea,  4.5, 4.0, 12.0, B( 1.2,  0.8, 5.2), B( 0.0,  0.6, 1.4));  // Sweep_Key  — top strip (was 9.0)
panel(0xfff0e0, 16.0, 0.7,  8.0, B(-5.8, -5.8, 2.4), B(-0.4, -0.8, 1.5));  // Sweep_Rim  — warm-white edge (was 45, cold: the bonnet glare)
panel(0xf5efe6,  0.5, 4.6, 12.0, B( 9.2,  3.4, 2.2), B( 0.6,  1.0, 1.2));  // Sweep_Flag — near-side bounce

scene.add(new THREE.AmbientLight(0x141216, 0.04));
// RectAreaLights cast no shadows → one soft shadow-only sun from the key direction.
const shadowSun = new THREE.DirectionalLight(0xfff4e6, 0.55);
shadowSun.position.copy(B(ROW_MID - 9.0, 13.0, 14.0)); shadowSun.target.position.copy(AIM);
shadowSun.castShadow = true; shadowSun.shadow.mapSize.set(4096, 4096);
Object.assign(shadowSun.shadow.camera, { near: 1, far: 80, left: -18, right: 18, top: 18, bottom: -18 });
shadowSun.shadow.bias = -0.00025; shadowSun.shadow.normalBias = 0.02; shadowSun.shadow.radius = 10;
scene.add(shadowSun); scene.add(shadowSun.target);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
new RGBELoader().load('textures/studio_small_09_1k.hdr', (hdr) => { scene.environment = pmrem.fromEquirectangular(hdr).texture; hdr.dispose(); }, undefined, () => {});

// ── Post: light DOF + restrained bloom ──────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// No BokehPass. Measured on this scene: the beauty pass draws in ~6.4 ms, but
// bokeh re-renders the whole scene into a depth target and then blurs 5.9 M
// pixels, and that is where every frame of headroom went. The hero reads as a
// product shot without it; the drawer viewer keeps its own DOF.
const bokeh = { enabled: false, uniforms: {} };
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.11, 0.6, 1.25);
bloom.enabled = false;                    // Phase 70: no bloom — the production viewer has none, and it haloed the red
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ── Hall cyc — the same profile as build_showroom.py, in metres ──
{
  const W = 80, BACK = -26, FRONT = 48, H = 26, R = 9, segs = 14;
  // No flat floor section: that grey slab in front of the curve was the "room is not black".
  // The reflector plane IS the floor; the cyc is only the curve and the back wall.
  const prof = [[BACK + R, 0]];
  for (let i = 1; i <= segs; i++) { const a = Math.PI / 2 * i / segs; prof.push([BACK + R - R * Math.sin(a), R - R * Math.cos(a)]); }
  prof.push([BACK, H]);
  const pos = [], idx = [];
  prof.forEach(([by, bz]) => { pos.push(ROW_MID - W / 2, bz, -by, ROW_MID + W / 2, bz, -by); });
  for (let i = 0; i < prof.length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const cyc = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x020408, roughness: 0.55, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.10 }));
  cyc.receiveShadow = true;
  // Layer 1 is the backdrop and NO light is enabled on it. The panels light the products only,
  // so the room stays black instead of smearing grey across the frame.
  cyc.layers.set(1); camera.layers.enable(1);
  cyc.visible = false;                    // Phase 70: the studio gradient + fog replace the black cyc (its edge showed at the right)
  scene.add(cyc);
}

// ── Floor: concrete grain + light pool (unlit) → base of the reflector ──
const floorTexSize = 2048;
const floorCanvas = document.createElement('canvas'); floorCanvas.width = floorCanvas.height = floorTexSize;
const floorTex = new THREE.CanvasTexture(floorCanvas); floorTex.colorSpace = THREE.SRGBColorSpace; floorTex.anisotropy = 16;
{
  const ctx = floorCanvas.getContext('2d'); ctx.fillStyle = '#0a0b0d'; ctx.fillRect(0, 0, floorTexSize, floorTexSize);
  const img = new Image();
  img.onload = () => {
    ctx.filter = 'saturate(0.12) brightness(0.7) contrast(1.05)';
    const TILES = 36, tile = floorTexSize / TILES;
    const sx = img.width * 0.1, sy = img.height * 0.1, sw = img.width * 0.8, sh = img.height * 0.8;
    for (let y = 0; y < TILES; y++) for (let x = 0; x < TILES; x++) {
      const fx = x % 2 ? -1 : 1, fy = y % 2 ? -1 : 1;
      ctx.save(); ctx.translate(x * tile + (fx < 0 ? tile : 0), y * tile + (fy < 0 ? tile : 0)); ctx.scale(fx, fy);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, tile, tile); ctx.restore();
    }
    ctx.filter = 'none';
    // No painted light pool. A floor lights up because something shines on it, not because a
    // white blob is baked into its texture.
    const g = ctx.createRadialGradient(floorTexSize / 2, floorTexSize / 2, 0, floorTexSize / 2, floorTexSize / 2, floorTexSize * 0.5);
    g.addColorStop(0.0, 'rgba(46,46,47,1)'); g.addColorStop(0.45, 'rgba(22,22,23,1)');
    g.addColorStop(0.78, 'rgba(8,8,9,1)');   g.addColorStop(1.0, 'rgba(3,3,4,1)');
    ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = g; ctx.fillRect(0, 0, floorTexSize, floorTexSize);
    ctx.globalCompositeOperation = 'source-over'; floorTex.needsUpdate = true;
  };
  img.src = 'textures/concrete_floor_worn_001_diff_1k.jpg';
}
const FLOOR_W = 80, FLOOR_D = 74, FLOOR_Z = -11;    // hall footprint in three coords
const floorGeo = new THREE.PlaneGeometry(FLOOR_W, FLOOR_D);
let floorMesh;
if (USE_REFLECTOR) {
  // Blurred planar reflection: 9-tap projected blur, fresnel-weighted, over the concrete base, fogged.
  const shader = {
    uniforms: {
      color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
      tFloor: { value: floorTex }, uCamPos: { value: new THREE.Vector3() }, uCenter: { value: new THREE.Vector2() },
      uFogDensity: { value: scene.fog.density }, uFogColor: { value: scene.fog.color },
    },
    vertexShader: `
      uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vWorld; varying vec2 vUv2;
      void main() { vUv2 = uv; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vUv = textureMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform sampler2D tFloor; uniform vec3 uCamPos; uniform vec2 uCenter; uniform float uFogDensity; uniform vec3 uFogColor;
      varying vec4 vUv; varying vec3 vWorld; varying vec2 vUv2;
      void main() {
        float r = 0.0022 * vUv.w;
        vec3 refl = vec3(0.0);
        refl += texture2DProj(tDiffuse, vUv).rgb * 0.28;
        refl += texture2DProj(tDiffuse, vUv + vec4( r, 0.0, 0.0, 0.0)).rgb * 0.09;
        refl += texture2DProj(tDiffuse, vUv + vec4(-r, 0.0, 0.0, 0.0)).rgb * 0.09;
        refl += texture2DProj(tDiffuse, vUv + vec4(0.0,  r, 0.0, 0.0)).rgb * 0.09;
        refl += texture2DProj(tDiffuse, vUv + vec4(0.0, -r, 0.0, 0.0)).rgb * 0.09;
        refl += texture2DProj(tDiffuse, vUv + vec4( r,  r, 0.0, 0.0)).rgb * 0.09;
        refl += texture2DProj(tDiffuse, vUv + vec4(-r,  r, 0.0, 0.0)).rgb * 0.09;
        refl += texture2DProj(tDiffuse, vUv + vec4( r, -r, 0.0, 0.0)).rgb * 0.09;
        refl += texture2DProj(tDiffuse, vUv + vec4(-r, -r, 0.0, 0.0)).rgb * 0.09;
        vec3 base = texture2D(tFloor, vUv2).rgb * 0.20;
        vec3 vdir = normalize(uCamPos - vWorld);
        float fres = pow(1.0 - max(vdir.y, 0.0), 2.2);
        float k = 0.22 + 0.55 * fres;
        vec3 col = base + refl * k;
        float d = length(uCamPos - vWorld);
        float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
        col = mix(col, uFogColor, f);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  };
  floorMesh = new Reflector(floorGeo, { clipBias: 0.004, textureWidth: 1600, textureHeight: 900, color: 0xffffff, shader });
  floorMesh.material.uniforms.tFloor.value = floorTex;
} else {
  // Phase 70: the production 'inferno' floor — a plain dark matte albedo, no painted texture; the light pool comes from the
  // pool light below. It is 600 m wide so its far edge dissolves in the studio fog (the 80 m hall floor ended in a line).
  floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x302e2b, roughness: 0.95, metalness: 0, envMapIntensity: 0.1 }));
}
floorMesh.rotation.x = -Math.PI / 2; floorMesh.position.set(ROW_MID, -0.006, FLOOR_Z); scene.add(floorMesh);
const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_W, FLOOR_D), new THREE.ShadowMaterial({ opacity: 0.45 }));
shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.set(ROW_MID, 0.003, FLOOR_Z); shadowCatcher.receiveShadow = true; scene.add(shadowCatcher);

// ── Model ────────────────────────────────────────────────────────
const root = new THREE.Group(); scene.add(root);
const draco = new DRACOLoader(); draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
const gltfLoader = new GLTFLoader(); gltfLoader.setDRACOLoader(draco);
let modelReady = false;
gltfLoader.load(HERO_MODEL, (gltf) => {
  const model = gltf.scene;
  model.scale.setScalar(MODEL_SCALE);
  model.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(model);
  console.log('[showroom] bbox m', bb.min.toArray().map(v => +v.toFixed(2)), bb.max.toArray().map(v => +v.toFixed(2)));
  const c = bb.getCenter(new THREE.Vector3());
  if (floorMesh.material.uniforms) floorMesh.material.uniforms.uCenter.value.set(c.x, c.z);
  model.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    node.castShadow = true; node.receiveShadow = true;
    let m = node.material;
    m.fog = false;                         // Phase 70: the fog is the floor's fade into the studio, not haze on the product
    if (m.isMeshStandardMaterial) {
      m.envMapIntensity = 0.9;
      if (m.map) m.map.anisotropy = 16;
      // emissives (headlight bulbs, lenses) — keep them lit, stop them blowing out the bloom
      if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.05) m.emissiveIntensity = Math.min(m.emissiveIntensity ?? 1, 0.55);
      if ((m.metalness ?? 0) > 0.5) m.roughness = Math.max(0.22, m.roughness * 0.95);
      const isBodyPaint = /carpaint|body_|hood|fender|cabin|door(?!_handle)|baked|ford/i.test(node.name || '');
      const col = m.color;
      const isRedCoat = col && col.r > 0.25 && col.g < col.r * 0.45 && col.b < col.r * 0.45;
      if (isBodyPaint || isRedCoat) {
        const phys = new THREE.MeshPhysicalMaterial();
        THREE.MeshStandardMaterial.prototype.copy.call(phys, m);
        // Phase 70: satin wrap and matte painted-steel red (was clear-coat 1.0 / 0.75: the panels mirrored in it and the
        // broad white sheen turned the red salmon through AgX)
        phys.clearcoat = isBodyPaint ? 0.3 : 0; phys.clearcoatRoughness = isBodyPaint ? 0.35 : 0;
        phys.roughness = isBodyPaint ? Math.min(0.62, (m.roughness ?? 0.5) + 0.12) : Math.max(0.6, m.roughness ?? 0.6);
        phys.envMapIntensity = isBodyPaint ? 0.8 : 0.35; if (!isBodyPaint) phys.specularIntensity = 0.55;
        phys.fog = false;
        node.material = phys;
      }
    }
  });
  root.add(model);
  heroBox = new THREE.Box3().setFromObject(model);
  // Phase 70: the studio light pool under the product — a soft warm spot, so the floor is lit by something, not painted
  const C = heroBox.getCenter(new THREE.Vector3());
  const pool = new THREE.SpotLight(0xfff1e2, 30, 0, 0.85, 1.0, 2);
  pool.position.set(C.x, C.y + 8.5, C.z); pool.target.position.set(C.x, 0, C.z); scene.add(pool); scene.add(pool.target);
  frameHero(true);
  modelReady = true;
  renderer.shadowMap.needsUpdate = true;   // the one shadow bake for the session
  warmUp();                                // goes live when the programs are compiled (see warmUp)
}, (ev) => { if (ev.total) document.body.style.setProperty('--glb-progress', (ev.loaded / ev.total).toFixed(3)); },
   (err) => console.error('[showroom] glb failed', err));

// ── Video → live handoff ─────────────────────────────────────────
let live = false, liveT0 = 0, shown = false, holdPose = false;
// Phase 70: live only once the model is in AND its programs are compiled (warmUp), so the first live frame is cheap; the
// canvas is revealed (body.is-3d) one frame after that first frame has been drawn — over a poster of the same frame.
function goLiveIfArmed() {
  if (live || !modelReady || !warmed) return;
  live = true; liveT0 = performance.now();
  const b = SHOTS[0];
  from.pos.copy(b.pos); from.look.copy(b.look); from.fov = b.fov;
  at.pos.copy(b.pos);   at.look.copy(b.look);   at.fov = b.fov;
  cur.pos.copy(b.pos);  cur.look.copy(b.look);  cur.fov = b.fov;   // no glide: start there
  tStart = -1;
  _redraw = true;
}
let heroBox = null, heroBand = null, driftAmp = HERO_DRIFT.amp;
function frameHero(force) {
  if (!heroBox) return;
  const band = bandFor(window.innerWidth / window.innerHeight);
  if (!force && band === heroBand) return;
  heroBand = band; document.body.dataset.heroBand = band.name;
  const f = frameFor(band, heroBox);
  SHOTS[0].pos.copy(f.pos); SHOTS[0].look.copy(f.look); SHOTS[0].fov = f.fov;
  // the drift and the fog scale with the framing, so every band reads the same (the product never hazes on a phone)
  driftAmp = 0.035 * f.H; scene.fog.density = 0.8 / f.d;
  // the horizon row of this framing (no roll; the drift is horizontal): the backdrop reaches the fog's tone exactly there
  const pitch = Math.atan2(f.look.y - f.pos.y, Math.hypot(f.look.x - f.pos.x, f.look.z - f.pos.z));
  paintStudio(0.5 + 0.5 * Math.tan(pitch) / Math.tan(THREE.MathUtils.degToRad(f.fov) / 2));
  if (floorMesh.material.uniforms) floorMesh.material.uniforms.uFogDensity.value = scene.fog.density;
  if (shot === 0) { for (const o of [from, at, cur]) { o.pos.copy(f.pos); o.look.copy(f.look); o.fov = f.fov; } tStart = -1; }
  _redraw = true;
}

// ── Pointer → drift + shot selection ─────────────────────────────
let nx = 0, ny = 0, lastPointer = 0;
const SWITCH_MS = 2600, DWELL_MS = 900, IDLE_CYCLE_MS = 8000;
let shot = 0, tStart = -1;
// A transition always departs from the pose we are actually at → interrupting never snaps.
const from = { pos: SHOTS[0].pos.clone(), look: SHOTS[0].look.clone(), fov: SHOTS[0].fov };
const at   = { pos: SHOTS[0].pos.clone(), look: SHOTS[0].look.clone(), fov: SHOTS[0].fov };
function goTo(i) { if (i === shot) return; from.pos.copy(at.pos); from.look.copy(at.look); from.fov = at.fov; shot = i; tStart = performance.now(); }
let zoneCandidate = 0, zoneSince = 0;
window.addEventListener('pointermove', (e) => {
  if (!Number.isFinite(e.clientX)) return;          // a synthetic event without coordinates would NaN the camera
  nx = (e.clientX / window.innerWidth) * 2 - 1;
  ny = (e.clientY / window.innerHeight) * 2 - 1;
  lastPointer = performance.now();
  if (HERO_HOLD) return;                            // held: the pointer moves nothing
  const z = Math.min(SHOTS.length - 1, Math.floor(((nx + 1) / 2) * SHOTS.length));
  if (z !== zoneCandidate) { zoneCandidate = z; zoneSince = lastPointer; }
  else if (z !== shot && lastPointer - zoneSince > DWELL_MS) goTo(z);
}, { passive: true });
window.addEventListener('pointerleave', () => { nx = 0; ny = 0; });

// ── Camera drive ─────────────────────────────────────────────────
const _pos = new THREE.Vector3(), _look = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _fwd = new THREE.Vector3();
const cur = { pos: SHOTS[0].pos.clone(), look: SHOTS[0].look.clone(), fov: SHOTS[0].fov };
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // cubic in-out: film dolly, not a slide
let sx = 0, sy = 0;                                                             // smoothed pointer
function sampleShot(now) {
  const b = SHOTS[shot];
  const k = tStart < 0 ? 1 : ease(Math.max(0, Math.min(1, (now - tStart) / SWITCH_MS)));
  at.pos.lerpVectors(from.pos, b.pos, k); at.look.lerpVectors(from.look, b.look, k); at.fov = lerp(from.fov, b.fov, k);
  _pos.copy(at.pos); _look.copy(at.look);
  if (!reducedMotion && HERO_HOLD) {
    // A very slow truck left↔right about the hero pose. One round trip a minute,
    // ±0.55 m of travel: you never catch the camera moving, the shot just never
    // sits still. The target follows at a fraction of the amount, so the frame
    // parallaxes like a hand-held hold instead of sliding like a dolly.
    _fwd.subVectors(_look, _pos).normalize(); _right.crossVectors(_fwd, _up).normalize();
    // Phase 70: the drift starts at zero when the scene goes live (= the poster's pose) and scales with the band framing
    const d = holdPose ? 0 : Math.sin(((now - liveT0) * 0.001 / HERO_DRIFT.secs) * Math.PI * 2);
    _pos.addScaledVector(_right, d * driftAmp);
    _look.addScaledVector(_right, d * driftAmp * 0.18);
  } else if (!reducedMotion && !HERO_HOLD) {
    sx += (nx - sx) * 0.03; sy += (ny - sy) * 0.03;
    _fwd.subVectors(_look, _pos).normalize(); _right.crossVectors(_fwd, _up).normalize();
    const dist = _pos.distanceTo(_look);
    const ax = 0.06 * dist, ay = 0.03 * dist;
    const t = now * 0.001;
    const orbit = Math.sin(t * 0.11) * 0.035 * dist, breathe = Math.sin(t * 0.37) * 0.015;   // slow idle orbit + breath
    _pos.addScaledVector(_right, sx * ax + orbit).addScaledVector(_up, -sy * ay + breathe);
    _look.addScaledVector(_right, sx * ax * 0.3 + orbit * 0.15).addScaledVector(_up, -sy * ay * 0.3);
  }
  return at.fov;
}

// products cover gate (Phase 70: the boot is an async module right after the hero, so this can run before #products is
// parsed — look it up when needed, and once more when the document is complete)
let productsEl = null;
let sceneVisible = true;
function updateVisibility() {
  productsEl = productsEl || document.getElementById('products');
  if (!productsEl) return;
  const top = productsEl.getBoundingClientRect().top;
  sceneVisible = top > 1;
  document.body.classList.toggle('covered', top <= 1);
}
window.addEventListener('scroll', updateVisibility, { passive: true }); updateVisibility();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateVisibility, { once: true });

// The stutter at the video→live handoff was every one of the scene's 41 shader
// programs compiling inside the first ten frames: 78–99 ms each, ~0.9 s of
// hitching right at the moment the visitor first touches the page. Compile them
// while the video is still playing and there is time to spare, and push the
// textures to the GPU too so the first live frame has nothing left to upload.
let warmed = false;
const _lastDrawn = { pos: new THREE.Vector3(NaN, NaN, NaN), look: new THREE.Vector3(), fov: -1 };
let _redraw = true;                      // force one draw after a resize or handoff
function warmUp() {
  const done = () => {
    const seen = new Set();
    scene.traverse(n => {
      const mats = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
      for (const m of mats) for (const k in m) {
        const t = m[k];
        if (t && t.isTexture && !seen.has(t.uuid)) { seen.add(t.uuid); try { renderer.initTexture(t); } catch (e) {} }
      }
    });
    // compileAsync only knows about the scene; bokeh, bloom and the output pass
    // have shaders of their own, so put one whole frame through the composer.
    try { composer.render(); } catch (e) {}
    warmed = true;
    goLiveIfArmed();
  };
  try {
    if (renderer.compileAsync) renderer.compileAsync(scene, camera).then(done).catch(done);
    else { renderer.compile(scene, camera); done(); }
  } catch (e) { done(); }
}
function tick() {
  requestAnimationFrame(tick);
  if (!sceneVisible) return;
  // Until the live view takes over, this canvas sits behind the hero video and
  // not one pixel of it is on screen — but it was still running the full
  // post-processed render every frame, which cost the video its playback
  // (measured 12 fps with 11% of video frames dropped). Draw a single warm-up
  // frame so the shaders are compiled for a clean handoff, then idle.
  if (!live) return;                      // Phase 70: warmUp compiles off the critical path; the poster covers the wait
  const now = performance.now();
  if (!reducedMotion && !NO_CYCLE && !HERO_HOLD && now - lastPointer > IDLE_CYCLE_MS && (tStart < 0 || now - tStart > IDLE_CYCLE_MS)) {
    goTo((shot + 1) % SHOTS.length); lastPointer = now - IDLE_CYCLE_MS + 1;
  }
  const fov = sampleShot(now);
  const K = 0.06;
  cur.pos.lerp(_pos, K); cur.look.lerp(_look, K); cur.fov += (fov - cur.fov) * K;
  camera.position.copy(cur.pos); camera.lookAt(cur.look);
  if (Math.abs(camera.fov - cur.fov) > 0.005) { camera.fov = cur.fov; camera.updateProjectionMatrix(); }
  const focus = cur.pos.distanceTo(cur.look);
  if (bokeh.uniforms?.focus) { bokeh.uniforms.focus.value = focus; bokeh.uniforms.aperture.value = lerp(0.00016, 0.00006, smoothstep(3.0, 14.0, focus)); }
  if (floorMesh.material.uniforms) floorMesh.material.uniforms.uCamPos.value.copy(camera.position);
  // Nothing in this hall animates — the picture is a pure function of the camera
  // pose. Once the pose settles (which, with the hero held, is a second after the
  // handoff and then forever) the next frame would be identical to the last, so
  // don't draw it. That is what turns a parked hero from a continuous 2.9 M
  // triangle render into no work at all.
  if (!modelReady) return;
  const moved = cur.pos.distanceToSquared(_lastDrawn.pos) > 1e-9
             || cur.look.distanceToSquared(_lastDrawn.look) > 1e-9
             || Math.abs(cur.fov - _lastDrawn.fov) > 1e-4;
  if (!moved && !_redraw) return;
  composer.render();
  _lastDrawn.pos.copy(cur.pos); _lastDrawn.look.copy(cur.look); _lastDrawn.fov = cur.fov;
  _redraw = false;
  if (!shown) { shown = true; requestAnimationFrame(() => document.body.classList.add('is-3d')); }
}
requestAnimationFrame(tick);

function resize() {
  _redraw = true;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w / 2, h / 2);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  frameHero(false);
}
window.addEventListener('resize', resize);
window.__showroom = { SHOTS, goTo, camera, scene, renderer, composer, bokeh, bloom, get shot() { return shot; }, get pose() { return { from, at, tStart }; },
  get band() { return heroBand && heroBand.name; }, get live() { return live; },
  hold(on = true) { holdPose = !!on; _redraw = true; } };   // hold(): no drift — used to render the band posters from the live scene
