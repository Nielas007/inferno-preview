// Product camera + presentation (Phase 19) — production assets only.
//
// Everything is derived from the product's own geometry, in world units, never from a
// hard-coded distance: the approved asset scale is never touched, and any production asset
// frames, orbits and zooms the same way.
//
//   buildHull()      convex hull of the product's vertices. The silhouette of a set of points
//                    under a perspective camera is the silhouette of its convex hull, so the
//                    hull gives the EXACT framing extents (not a bounding box) at any angle, and
//                    a watertight "outside" for collision.
//   frameProduct()   closed-form distance that makes the silhouette fill a given share of the
//                    frame from any direction / FOV / aspect, plus near / far.
//   ProductCamera    owns OrbitControls for production products: limits, orbit pivot, ground
//                    and hull clearance, frame-rate-independent damping, damped zoom and
//                    mode transitions.
import * as THREE from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

const D2R = Math.PI / 180;

// All distances are relative to the product (R = hull bounding-sphere radius, Hh = product height),
// so a different production asset gets the same presentation. Values: Phase 19 report §3–§8.
export const CAMERA_CONFIG = {
  fov: 28,                               // vertical FOV, degrees (§4: kept — 24° is only 3–4 % flatter, 32°/36° measurably worse)
  view: { azimuthDeg: 37, polarDeg: 70 },     // default 3/4 front on the key-lit side (§3); azimuth from +X toward the vehicle front (+Z)
  fill: 0.80,                            // silhouette extent (from the pivot) on the limiting frame axis, exact
  spinSafeFill: 0.98,                    // the default distance also keeps the product inside the frame through a full idle spin (§6)
  // Narrow canvases (§14): the view turns toward the front (narrower silhouette) and the product fills more,
  // blended by aspect from `fromAspect` (landscape look) to `toAspect` (full portrait look).
  portrait: { fromAspect: 0.85, toAspect: 0.5, view: { azimuthDeg: 60, polarDeg: 66 }, fill: 0.86, spinSafeFill: 1.05 },
  orbit: { minPolarDeg: 44, maxPolarDeg: 100 },  // §6: above 46° elevation the dump body is > 2/3 of the silhouette
  minEyeHeight: 0.035,                   // × product height: the eye never goes under ≈ 0.28 m real (§6, §9)
  clearanceR: 0.52,                      // × hull radius beyond the farthest hull exit: near-field depth ratio ≤ 3 at min zoom (§7)
  maxFillFactor: 1.6,                    // max distance = default distance × this: silhouette still ≥ 0.5 of the frame (§7)
  pivotSamples: 36,                      // azimuth samples for the orbit-balanced pivot (§8)
  damping: 0.08,                         // OrbitControls damping per 60 Hz frame, applied frame-rate independently (§13)
  zoomTau: 0.11,                         // s — time constant of the damped zoom (wheel / pinch / slider), no overshoot
  transitionS: 1.15,                     // s — mode change (the Phase 18 GSAP duration and power3.inOut curve)
  envRadius: 26,                         // backdrop dome radius: the far plane must contain it
};

// ── geometry ────────────────────────────────────────────────────────────────────────────
const visible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };

/**
 * Convex hull of every visible mesh under `root` (or of `meshes`), in world space.
 * `stride` samples every n-th vertex: stride 8 is ≤ 0.006 units (≤ 26 mm real) from the exact hull for the VSS —
 * 0.06 % of the default framing, 0.5 % of the camera clearance — at a quarter of the stride-1 cost (§15).
 */
export function buildHull({ root = null, meshes = null, stride = 8 } = {}) {
  const list = meshes || [];
  if (root) root.traverse(o => { if (o.isMesh && visible(o)) list.push(o); });
  const pts = [], v = new THREE.Vector3();
  for (const o of list) {
    o.updateMatrixWorld(true);
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i += stride) pts.push(v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).clone());
  }
  if (pts.length < 4) return null;
  const ch = new ConvexHull().setFromPoints(pts);
  const set = new Set(), planes = [];
  for (const f of ch.faces) {
    planes.push(f.normal.x, f.normal.y, f.normal.z, -f.constant);  // three's Face: n·x = constant, outward n; stored so n·x + w ≤ 0 is inside
    let e = f.edge; do { set.add(e.head().point); e = e.next; } while (e !== f.edge);
  }
  const verts = [...set], points = new Float32Array(verts.length * 3);
  verts.forEach((p, i) => { points[i * 3] = p.x; points[i * 3 + 1] = p.y; points[i * 3 + 2] = p.z; });
  const box = new THREE.Box3().setFromArray(points);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return { points, planes: new Float32Array(planes), box, center: sphere.center, radius: sphere.radius, height: box.max.y - box.min.y, count: verts.length };
}

/** Distance from `o` (inside or outside the hull) along unit `u` to where the ray leaves the hull; 0 if it misses. */
export function exitDistance(hull, o, u) {
  let tIn = -Infinity, tOut = Infinity; const P = hull.planes;
  for (let i = 0; i < P.length; i += 4) {
    const nd = P[i] * u.x + P[i + 1] * u.y + P[i + 2] * u.z;
    const s = P[i] * o.x + P[i + 1] * o.y + P[i + 2] * o.z + P[i + 3];
    if (Math.abs(nd) < 1e-9) { if (s > 0) return 0; continue; }
    const t = -s / nd;
    if (nd > 0) tOut = Math.min(tOut, t); else tIn = Math.max(tIn, t);
  }
  return tOut >= Math.max(tIn, 0) ? tOut : 0;
}

/** Signed distance-ish test: is `p` outside the hull by at least `margin`? (max plane distance) */
export function hullSeparation(hull, p) {
  let m = -Infinity; const P = hull.planes;
  for (let i = 0; i < P.length; i += 4) m = Math.max(m, P[i] * p.x + P[i + 1] * p.y + P[i + 2] * p.z + P[i + 3]);
  return m;   // > 0 outside (≤ true Euclidean distance to the hull), < 0 inside
}

export const dirFromAngles = (azimuthDeg, polarDeg) => {
  const a = azimuthDeg * D2R, p = polarDeg * D2R;
  return new THREE.Vector3(Math.sin(p) * Math.cos(a), Math.cos(p), Math.sin(p) * Math.sin(a));
};

// camera basis for a view direction u (pivot → camera), world up
function basis(u) {
  const w = u.clone().normalize();
  let r = new THREE.Vector3(0, 1, 0).cross(w); if (r.lengthSq() < 1e-8) r.set(1, 0, 0); r.normalize();
  const v = w.clone().cross(r).normalize();
  return { r, v, w };
}

/**
 * Closed-form framing distance: the camera looks at `pivot` from direction `u`; every hull point must
 * satisfy |x_ndc| ≤ fill and |y_ndc| ≤ fill. For a point at camera-space (x, y) and depth (d − s):
 *   d ≥ s + |x| / (fill · tan(fov/2) · aspect)   and   d ≥ s + |y| / (fill · tan(fov/2)).
 */
export function fitDistance(hull, pivot, u, { fov, aspect, fill }) {
  const { r, v, w } = basis(u), t = Math.tan(fov * D2R / 2), P = hull.points;
  const kx = 1 / (fill * t * aspect), ky = 1 / (fill * t);
  let d = 0;
  for (let i = 0; i < P.length; i += 3) {
    const px = P[i] - pivot.x, py = P[i + 1] - pivot.y, pz = P[i + 2] - pivot.z;
    const x = px * r.x + py * r.y + pz * r.z, y = px * v.x + py * v.y + pz * v.z, s = px * w.x + py * w.y + pz * w.z;
    d = Math.max(d, s + Math.abs(x) * kx, s + Math.abs(y) * ky);
  }
  return d;
}

/** NDC silhouette box of the hull for a camera at `pivot + u·d` looking at the pivot. */
export function silhouette(hull, pivot, u, d, { fov, aspect }) {
  const { r, v, w } = basis(u), t = Math.tan(fov * D2R / 2), P = hull.points;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const px = P[i] - pivot.x, py = P[i + 1] - pivot.y, pz = P[i + 2] - pivot.z;
    const z = d - (px * w.x + py * w.y + pz * w.z);
    const x = (px * r.x + py * r.y + pz * r.z) / (z * t * aspect), y = (px * v.x + py * v.y + pz * v.z) / (z * t);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, fillW: (x1 - x0) / 2, fillH: (y1 - y0) / 2 };
}

/**
 * Orbit-balanced pivot (§8): the point about which the silhouette stays centred through a full turn.
 * Start from the hull box centre and move the pivot by the mean screen-space offset of the silhouette
 * centre (mapped back to world units) over `n` azimuths at `polarDeg`, until it stops moving.
 */
export function balancedPivot(hull, { fov, aspect, polarDeg, fill, n = 36, iters = 8 }) {
  const p = hull.box.getCenter(new THREE.Vector3()), t = Math.tan(fov * D2R / 2);
  for (let it = 0; it < iters; it++) {
    const acc = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      const u = dirFromAngles(k * 360 / n, polarDeg), d = fitDistance(hull, p, u, { fov, aspect, fill });
      const s = silhouette(hull, p, u, d, { fov, aspect }), { r, v } = basis(u);
      acc.addScaledVector(r, s.cx * d * t * aspect).addScaledVector(v, s.cy * d * t);
    }
    acc.multiplyScalar(1 / n); p.add(acc);
    if (acc.length() < 1e-4) break;
  }
  return p;
}

/**
 * frameProduct: framing + clip planes from the product bounds.
 * Returns the camera position / target for `direction`, the distance, and near / far.
 */
export function frameProduct(hull, { pivot, direction, fov, aspect, fill, clearance, maxDistance, envRadius, minEyeY = null, groundY = null }) {
  const u = direction.clone().normalize();
  const distance = fitDistance(hull, pivot, u, { fov, aspect, fill });
  const position = pivot.clone().addScaledVector(u, distance);
  // near: no product point can be nearer than the clearance, and the floor seen along the lowest
  // frustum ray from the lowest eye position (at the farthest zoom) must stay beyond it too
  let near = 0.5 * clearance;
  if (minEyeY != null) {
    const eye = Math.max(1e-4, minEyeY - (groundY ?? hull.box.min.y)), dMax = Math.max(maxDistance || distance, distance);
    const down = fov * D2R / 2 - Math.atan2(pivot.y - minEyeY, dMax);          // bottom ray below the horizon
    if (down > 0) near = Math.min(near, 0.8 * eye * Math.cos(fov * D2R / 2) / Math.sin(down));
  }
  near = Math.max(0.005 * hull.radius, near);
  const far = (pivot.length() + Math.max(maxDistance || distance, distance) + (envRadius || 0) + hull.radius) * 1.02;
  return { target: pivot.clone(), position, distance, fov, near, far };
}

// ── camera controller ───────────────────────────────────────────────────────────────────
const easeInOutCubic = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);   // = GSAP power3.inOut

export class ProductCamera {
  constructor(camera, controls, config = CAMERA_CONFIG) {
    this.camera = camera; this.controls = controls; this.cfg = config;
    this.active = false; this.hulls = null; this.pivots = {}; this.mode = 'full'; this.limits = null;
    this.zoomDesired = null; this.zoomShown = null; this.transition = null;
    this.pristine = false;               // still on the framing we set (no orbit / zoom by the visitor since)
    this._aspect = null;                 // aspect the current pose was composed for
    this._o = new THREE.Vector3(); this._u = new THREE.Vector3();
    // The visitor takes over the viewing direction; a running mode transition still completes (pivot, distance and
    // the new mode's limits), so a drag during Full ⇄ System can never leave one mode with the other's limits (Phase 20 §11).
    controls.addEventListener('start', () => { this.pristine = false; });
  }

  // Per product: `full` hull (every mesh) and `system` hull (fire-suppression rig only).
  setProduct({ full, system }) {
    this.hulls = { full, system: system || full }; this.pivots = {}; this.active = true;
    this.transition = null; this.zoomDesired = this.zoomShown = null;
  }
  clear() { this.active = false; this.hulls = null; this.pivots = {}; this.transition = null; this.zoomDesired = this.zoomShown = null; }

  aspect() { return this.camera.aspect || 1; }
  // 0 = landscape presentation, 1 = full portrait presentation
  portraitT() { const p = this.cfg.portrait; return p ? THREE.MathUtils.clamp((p.fromAspect - this.aspect()) / (p.fromAspect - p.toAspect), 0, 1) : 0; }
  viewAngles() { const t = this.portraitT(), a = this.cfg.view, b = this.cfg.portrait ? this.cfg.portrait.view : a;
    return { azimuthDeg: THREE.MathUtils.lerp(a.azimuthDeg, b.azimuthDeg, t), polarDeg: THREE.MathUtils.lerp(a.polarDeg, b.polarDeg, t) }; }
  fill() { const t = this.portraitT(); return THREE.MathUtils.lerp(this.cfg.fill, this.cfg.portrait ? this.cfg.portrait.fill : this.cfg.fill, t); }
  spinSafeFill() { const t = this.portraitT(); return THREE.MathUtils.lerp(this.cfg.spinSafeFill, this.cfg.portrait ? this.cfg.portrait.spinSafeFill : this.cfg.spinSafeFill, t); }
  cacheKey(mode) { return mode + ':' + this.aspect().toFixed(2); }
  hull(mode) { return (this.hulls && (this.hulls[mode] || this.hulls.full)) || null; }

  pivot(mode) {
    const key = this.cacheKey(mode);
    if (!this.pivots[key]) {
      const h = this.hull(mode), a = this.viewAngles();
      this.pivots[key] = balancedPivot(h, { fov: this.cfg.fov, aspect: this.aspect(), polarDeg: a.polarDeg, fill: this.fill(), n: this.cfg.pivotSamples });
    }
    return this.pivots[key];
  }

  /** Framing + limits for a mode at the live aspect. `direction` defaults to the configured 3/4 view. */
  framing(mode = 'full', { direction = null } = {}) {
    const h = this.hull(mode), c = this.cfg, a = this.viewAngles();
    const u = (direction ? direction.clone() : dirFromAngles(a.azimuthDeg, a.polarDeg)).normalize();
    const pivot = this.pivot(mode);
    const fit = frameProduct(h, { pivot, direction: u, fov: c.fov, aspect: this.aspect(), fill: this.fill(), clearance: c.clearanceR * h.radius });
    // default distance: the configured view at `fill`, but never so close that orbiting from it crops the product
    // (measured from the configured view, so the zoom limits do not depend on the current angle)
    const dView = direction ? fitDistance(h, pivot, dirFromAngles(a.azimuthDeg, a.polarDeg), { fov: c.fov, aspect: this.aspect(), fill: this.fill() }) : fit.distance;
    const dDefault = Math.max(dView, this.spinSafeDistance(mode, pivot));
    const lim = this.computeLimits(mode, pivot, dDefault);
    const distance = Math.min(lim.maxDistance, Math.max(lim.minDistance, direction ? fit.distance : dDefault));
    return { mode, target: pivot.clone(), position: pivot.clone().addScaledVector(u, distance), distance, limits: lim };
  }

  /** Smallest pivot distance from which a full turn at the default elevation (the idle spin) keeps the product in frame. */
  spinSafeDistance(mode, pivot) {
    const key = 'spin:' + this.cacheKey(mode);
    if (this.pivots[key] != null) return this.pivots[key];
    const h = this.hull(mode), c = this.cfg, pol = this.viewAngles().polarDeg, f = this.spinSafeFill(); let d = 0;
    for (let az = 0; az < 360; az += 5) d = Math.max(d, fitDistance(h, pivot, dirFromAngles(az, pol), { fov: c.fov, aspect: this.aspect(), fill: f }));
    return (this.pivots[key] = d);
  }

  /** Zoom / orbit / clip limits for a mode (§6, §7). */
  computeLimits(mode, pivot, dDefault) {
    const h = this.hull(mode), c = this.cfg, clearance = c.clearanceR * h.radius;
    const minPolar = c.orbit.minPolarDeg * D2R, maxPolar = c.orbit.maxPolarDeg * D2R;
    // smallest pivot distance that clears the hull by `clearance` in every reachable direction
    let need = 0; const u = this._u;
    for (let az = 0; az < 360; az += 5) for (let pd = c.orbit.minPolarDeg; pd <= c.orbit.maxPolarDeg + 1e-6; pd += 2) {
      u.copy(dirFromAngles(az, pd)); need = Math.max(need, exitDistance(h, pivot, u) + clearance);
    }
    const g = this.hulls.full, minEyeY = g.box.min.y + c.minEyeHeight * g.height;   // ground = the product's contact plane, in every mode
    const minDistance = need, maxDistance = Math.max(dDefault * c.maxFillFactor, minDistance * 1.2);
    const f = frameProduct(h, { pivot, direction: new THREE.Vector3(0, 0, 1), fov: c.fov, aspect: this.aspect(), fill: this.fill(), clearance, maxDistance, envRadius: c.envRadius, minEyeY, groundY: g.box.min.y });
    return { minDistance, maxDistance, minPolar, maxPolar, minEyeY, clearance, near: f.near, far: f.far, dDefault };
  }

  /** Apply limits + clip planes (no camera move). */
  applyLimits(lim) {
    const k = this.controls, cam = this.camera;
    this.limits = lim;
    k.minDistance = lim.minDistance; k.maxDistance = lim.maxDistance;
    k.minPolarAngle = lim.minPolar; k.maxPolarAngle = lim.maxPolar;
    k.enableDamping = true; k.enablePan = false;
    if (cam.near !== lim.near || cam.far !== lim.far) { cam.near = lim.near; cam.far = lim.far; cam.updateProjectionMatrix(); }
  }

  /** Jump to a framing (open / product swap). */
  snap(fr) {
    this.transition = null; this.mode = fr.mode; this.applyLimits(fr.limits); this.pristine = true; this._aspect = this.aspect();
    this.controls.target.copy(fr.target); this.camera.position.copy(fr.position); this.camera.lookAt(fr.target);
    this.zoomDesired = this.zoomShown = fr.distance;
    this.controls.update();
  }

  /** Animated move to a framing (mode change): target and distance ease, the viewing direction is kept. */
  moveTo(fr, durationS = this.cfg.transitionS) {
    const t0 = this.controls.target.clone(), off = this.camera.position.clone().sub(t0);
    this.mode = fr.mode;
    // limits: the union during the move, the new mode's limits once it lands
    const L = this.limits || fr.limits;
    this.applyLimits({ ...fr.limits, minDistance: Math.min(L.minDistance, fr.limits.minDistance), maxDistance: Math.max(L.maxDistance, fr.limits.maxDistance) });
    this.transition = { t: 0, dur: Math.max(0.001, durationS), t0, t1: fr.target.clone(), d0: off.length(), d1: fr.distance, u: off.normalize(), fr };
  }

  /** Per-frame update. Call instead of controls.update() while a production product is shown. */
  update(dt) {
    const k = this.controls, cam = this.camera, c = this.cfg, L = this.limits;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    if (!this.active || !L) { k.update(); return; }

    // mode transition: pivot and distance ease to the new framing; the direction stays the visitor's (orbit input still rotates)
    if (this.transition) {
      const T = this.transition; T.t += dt;
      const x = easeInOutCubic(Math.min(1, T.t / T.dur));
      const u = this._u.copy(cam.position).sub(k.target); if (u.lengthSq() < 1e-12) u.copy(T.u); u.normalize();
      k.target.lerpVectors(T.t0, T.t1, x);
      const d = Math.exp(THREE.MathUtils.lerp(Math.log(T.d0), Math.log(T.d1), x));
      cam.position.copy(k.target).addScaledVector(u, d);
      k.dampingFactor = 1 - Math.pow(1 - c.damping, dt * 60);
      k.update(dt);                                   // visitor rotation (no-op without input); distance re-imposed below
      u.copy(cam.position).sub(k.target).normalize();
      cam.position.copy(k.target).addScaledVector(u, d);
      this.clampPose(true);   // ground only: the hull of the mode being entered may still be fading in
      cam.lookAt(k.target);
      this.zoomDesired = this.zoomShown = cam.position.distanceTo(k.target);
      if (T.t >= T.dur) { this.transition = null; this.applyLimits(T.fr.limits); this.pristine = true; this._aspect = this.aspect(); }
      return;
    }

    // damped zoom: OrbitControls applies wheel / pinch / slider changes to the camera at once;
    // take that as the DESIRED distance, put the camera back where it was, and ease towards it.
    const off = this._o.copy(cam.position).sub(k.target), rNow = off.length();
    if (this.zoomShown == null) this.zoomShown = this.zoomDesired = rNow;
    if (Math.abs(rNow - this.zoomShown) > 1e-6) { this.zoomDesired = rNow; this.pristine = false; cam.position.copy(k.target).addScaledVector(off.normalize(), this.zoomShown); }

    // frame-rate-independent damping and auto-rotate (both are per-call in OrbitControls r160)
    k.dampingFactor = 1 - Math.pow(1 - c.damping, dt * 60);
    // ground: the polar limit that keeps the eye above minEyeY at the current distance
    const r = Math.max(1e-6, this.zoomShown), ground = Math.acos(THREE.MathUtils.clamp((L.minEyeY - k.target.y) / r, -1, 1));
    k.maxPolarAngle = Math.min(L.maxPolar, ground);
    k.update(dt);

    // ease the shown distance towards the desired one (critically damped first order: no overshoot)
    const a = 1 - Math.exp(-dt / c.zoomTau);
    this.zoomDesired = THREE.MathUtils.clamp(this.zoomDesired, L.minDistance, L.maxDistance);
    this.zoomShown += (this.zoomDesired - this.zoomShown) * a;
    if (Math.abs(this.zoomDesired - this.zoomShown) < 1e-5) this.zoomShown = this.zoomDesired;
    off.copy(cam.position).sub(k.target).normalize();
    cam.position.copy(k.target).addScaledVector(off, this.zoomShown);
    this.clampPose(false);
    cam.lookAt(k.target);
  }

  // keep the eye above the ground plane and outside the hull (+ clearance)
  clampPose(inTransition) {
    const cam = this.camera, k = this.controls, L = this.limits, h = this.hull(this.mode);
    const off = this._o.copy(cam.position).sub(k.target); let r = off.length(); if (r < 1e-6) return;
    const u = off.multiplyScalar(1 / r);
    if (h && !inTransition) { const need = exitDistance(h, k.target, u) + L.clearance; if (r < need) { r = need; this.zoomShown = Math.max(this.zoomShown, r); } }
    cam.position.copy(k.target).addScaledVector(u, r);
    if (cam.position.y < L.minEyeY) {           // slide up along the sphere
      const y = L.minEyeY - k.target.y, hz = Math.sqrt(Math.max(0, r * r - y * y)), hl = Math.hypot(u.x, u.z) || 1;
      cam.position.set(k.target.x + u.x / hl * hz, L.minEyeY, k.target.z + u.z / hl * hz);
    }
  }

  /**
   * Canvas aspect changed. Untouched framing → re-frame for the new aspect (the view itself adapts, §14).
   * After the visitor has orbited / zoomed → keep their direction and the product's apparent size.
   */
  refit() {
    if (!this.active || !this.limits) return;
    const a1 = this.aspect(), a0 = this._aspect || a1;
    if (this.transition) { const fr = this.framing(this.mode, { direction: this.transition.u }); const L = fr.limits; this.transition.fr = fr; this.transition.t1.copy(fr.target); this.transition.d1 = fr.distance; this.applyLimits({ ...L, minDistance: Math.min(L.minDistance, this.limits.minDistance), maxDistance: Math.max(L.maxDistance, this.limits.maxDistance) }); return; }
    if (this.pristine) { this.snap(this.framing(this.mode)); return; }
    const dir = this.camera.position.clone().sub(this.controls.target), d0 = dir.length(); dir.normalize();
    const fr = this.framing(this.mode, { direction: dir }), L = fr.limits, h = this.hull(this.mode), c = this.cfg;
    const f0 = fitDistance(h, this.controls.target, dir, { fov: c.fov, aspect: a0, fill: 1 }), f1 = fitDistance(h, fr.target, dir, { fov: c.fov, aspect: a1, fill: 1 });
    const d = THREE.MathUtils.clamp(d0 * f1 / Math.max(1e-6, f0), L.minDistance, L.maxDistance);
    this.applyLimits(L);
    this.controls.target.copy(fr.target);
    this.camera.position.copy(fr.target).addScaledVector(dir, d); this.camera.lookAt(fr.target);
    this.zoomDesired = this.zoomShown = d; this._aspect = a1;
  }

  /** Camera outside `mode`'s hull by at least `margin` (default: 1.2 × the near plane). */
  clearOf(mode = 'full', margin = 1.2 * this.camera.near) { const h = this.hull(mode); return !h || hullSeparation(h, this.camera.position) >= margin; }

  /** Snapshot for reports / tests. */
  state() {
    const L = this.limits, p = this.controls.target, o = this.camera.position.clone().sub(p), d = o.length();
    return { active: this.active, mode: this.mode, pivot: p.toArray(), distance: d, polarDeg: Math.acos(o.y / d) / D2R, azimuthDeg: ((Math.atan2(o.z, o.x) / D2R) + 360) % 360, fov: this.camera.fov, near: this.camera.near, far: this.camera.far,
      limits: L && { minDistance: L.minDistance, maxDistance: L.maxDistance, minPolarDeg: L.minPolar / D2R, maxPolarDeg: L.maxPolar / D2R, minEyeY: L.minEyeY, clearance: L.clearance, dDefault: L.dDefault },
      hulls: this.hulls && Object.fromEntries(Object.entries(this.hulls).map(([k, h]) => [k, { vertices: h.count, faces: h.planes.length / 4, radius: h.radius }])) };
  }

  // slider / buttons: 0 = farthest, 1 = closest (same mapping as the Phase 18 viewer)
  setZoom(t) { const L = this.limits; if (!L) return; t = THREE.MathUtils.clamp(t, 0, 1); this.zoomDesired = THREE.MathUtils.lerp(L.maxDistance, L.minDistance, t); this.pristine = false; }
  getZoom() { const L = this.limits; if (!L) return 0.5; const d = this.zoomDesired ?? this.camera.position.distanceTo(this.controls.target); return THREE.MathUtils.clamp((L.maxDistance - d) / (L.maxDistance - L.minDistance), 0, 1); }
}
