// Screen-space ambient occlusion for the product viewer (Phase 15). Never imported by the hero.
//
//   1. G-buffer   the product only, re-rendered with a geometric-normal material into
//                 RGBA8 (packed view normal + receiver mask in alpha) + a 32-bit depth texture
//   2. GTAO       three r160's GTAOShader (horizon-based, world-space radius)  → R8
//   3. denoise    three r160's PoissonDenoiseShader (depth/normal-aware)        → R8
//   4. composite  direct path: full-screen multiply onto the already tone-mapped canvas.
//                 HDR path (Phase 18): compute() returns the buffer and ProductPost applies the same
//                 mask / intensity / bias to scene-linear radiance before tone mapping.
//
// Occlusion is multiplied into the frame the Phase 14 pipeline has already produced (AgX,
// in-shader), so with AO off nothing about that pipeline changes. The attenuation is applied
// in display-linear light (the canvas holds sRGB-encoded values).
//
// Who takes part is decided per mesh by the caller's classify(mesh):
//   'receive'  → occludes and is darkened         (product surfaces)
//   'occlude'  → occludes, never darkened         (floor, glass, lamps)
//   null       → absent from the AO pass entirely (dome, fading meshes, overlays)
// The viewer's own materials are never modified: meshes point at the AO materials only for
// the duration of the G-buffer draw and are restored before anything else renders.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOShader, generateMagicSquareNoise } from 'three/addons/shaders/GTAOShader.js';
import { PoissonDenoiseShader, generatePdSamplePointInitializer } from 'three/addons/shaders/PoissonDenoiseShader.js';

// Resolution / sample budgets. Strength (intensity, radius…) is set separately by the profile.
export const AO_QUALITY = {
  high: { scale: 1.0, samples: 16, denoiseSamples: 16, denoiseRings: 2, denoiseRadius: 8 },
  low:  { scale: 0.5, samples: 8,  denoiseSamples: 8,  denoiseRings: 2, denoiseRadius: 5 },
};

const COMPOSITE = {
  uniforms: { tAO: { value: null }, tMask: { value: null }, intensity: { value: 1 }, bias: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tAO; uniform highp sampler2D tMask; uniform float intensity; uniform float bias;
    varying vec2 vUv;
    // bilinear receiver mask from the nearest-filtered G-buffer (soft, alias-free silhouette)
    float mask(vec2 uv) {
      vec2 s = vec2(textureSize(tMask, 0)); vec2 p = uv * s - 0.5; ivec2 i = ivec2(floor(p)); vec2 f = fract(p);
      ivec2 m = ivec2(s) - 1;
      float a = texelFetch(tMask, clamp(i, ivec2(0), m), 0).a, b = texelFetch(tMask, clamp(i + ivec2(1, 0), ivec2(0), m), 0).a;
      float c = texelFetch(tMask, clamp(i + ivec2(0, 1), ivec2(0), m), 0).a, d = texelFetch(tMask, clamp(i + ivec2(1, 1), ivec2(0), m), 0).a;
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    void main() {
      float occ = 1.0 - texture2D(tAO, vUv).r;
      occ = max(0.0, occ - bias) / max(1e-3, 1.0 - bias);   // bias: ignore faint occlusion (facet noise)
      float a = 1.0 - intensity * occ * mask(vUv);           // display-linear attenuation
      gl_FragColor = vec4(vec3(pow(max(a, 0.0), 1.0 / 2.2)), 1.0);   // → sRGB-encoded multiplier
    }`,
};

function poissonNoise(size = 64) {
  const d = new Uint8Array(size * size * 4);
  let s = 0x9e3779b9;                                      // deterministic hash noise (stable frames)
  for (let i = 0; i < d.length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d[i] = (s >>> 0) & 255; }
  const t = new THREE.DataTexture(d, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
  return t;
}

export class ProductAO {
  constructor(renderer) {
    this.renderer = renderer;
    this.params = { intensity: 1, radius: 0.1, thickness: 0.05, distanceExponent: 2, distanceFallOff: 1, power: 1, bias: 0 };
    this.quality = 'high';
    this.size = new THREE.Vector2(0, 0);
    this.box = null;
    this._built = false;
    this._saved = [];
    this.lastStats = null;
  }

  _build() {
    const R = this.renderer;
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.gbuffer = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture });
    const r8 = { type: THREE.UnsignedByteType, format: THREE.RedFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, r8);
    this.denoiseTarget = new THREE.WebGLRenderTarget(1, 1, r8);

    // geometric view-space normals, receiver mask in alpha (opacity), no textures ever bound
    const nm = (side, mask) => { const m = new THREE.MeshNormalMaterial({ side, opacity: mask, blending: THREE.NoBlending }); m.transparent = false; return m; };
    this.gMat = { receive: [nm(THREE.FrontSide, 1), nm(THREE.DoubleSide, 1), nm(THREE.BackSide, 1)],
                  occlude: [nm(THREE.FrontSide, 0), nm(THREE.DoubleSide, 0), nm(THREE.BackSide, 0)] };

    this.gtaoNoise = generateMagicSquareNoise();
    this.gtao = new THREE.ShaderMaterial({
      defines: { ...GTAOShader.defines, NORMAL_VECTOR_TYPE: 1, DEPTH_SWIZZLING: 'x', SCENE_CLIP_BOX: 1 },
      uniforms: THREE.UniformsUtils.clone(GTAOShader.uniforms),
      vertexShader: GTAOShader.vertexShader, fragmentShader: GTAOShader.fragmentShader,
      blending: THREE.NoBlending, depthTest: false, depthWrite: false,
    });
    this.gtao.uniforms.tNormal.value = this.gbuffer.texture;
    this.gtao.uniforms.tDepth.value = depthTexture;
    this.gtao.uniforms.tNoise.value = this.gtaoNoise;

    this.pdNoise = poissonNoise();
    this.denoise = new THREE.ShaderMaterial({
      defines: { ...PoissonDenoiseShader.defines, NORMAL_VECTOR_TYPE: 1, DEPTH_VALUE_SOURCE: 0, SAMPLE_LUMINANCE: 'a.x', FRAGMENT_OUTPUT: 'vec4(denoised, 1.)' },
      uniforms: THREE.UniformsUtils.clone(PoissonDenoiseShader.uniforms),
      vertexShader: PoissonDenoiseShader.vertexShader, fragmentShader: PoissonDenoiseShader.fragmentShader,
      blending: THREE.NoBlending, depthTest: false, depthWrite: false,
    });
    Object.assign(this.denoise.uniforms, { tDiffuse: { value: this.aoTarget.texture }, tNormal: { value: this.gbuffer.texture }, tDepth: { value: depthTexture }, tNoise: { value: this.pdNoise } });
    this.denoise.uniforms.lumaPhi.value = 10; this.denoise.uniforms.depthPhi.value = 2; this.denoise.uniforms.normalPhi.value = 3;

    this.composite = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(COMPOSITE.uniforms), vertexShader: COMPOSITE.vertexShader, fragmentShader: COMPOSITE.fragmentShader,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.composite.uniforms.tAO.value = this.denoiseTarget.texture;
    this.composite.uniforms.tMask.value = this.gbuffer.texture;
    this.quad = new FullScreenQuad(null);
    this._built = true;
    this._appliedQuality = null;
  }

  configure(params = {}, quality) {
    Object.assign(this.params, params);
    if (quality) this.quality = quality;
  }
  setBox(box) { this.box = box ? box.clone() : null; }

  _applyQuality() {
    const q = AO_QUALITY[this.quality] || AO_QUALITY.high;
    if (this._appliedQuality === this.quality) return q;
    this.gtao.defines.SAMPLES = q.samples; this.gtao.needsUpdate = true;
    this.denoise.defines.SAMPLES = q.denoiseSamples;
    this.denoise.defines.SAMPLE_VECTORS = generatePdSamplePointInitializer(q.denoiseSamples, q.denoiseRings, 2);
    this.denoise.uniforms.radius.value = q.denoiseRadius; this.denoise.needsUpdate = true;
    this.size.set(0, 0);                                   // force a resize to the new scale
    this._appliedQuality = this.quality;
    return q;
  }
  _resize(q) {
    const R = this.renderer, gl = R.getContext();
    const w = Math.max(1, Math.round(gl.drawingBufferWidth * q.scale)), h = Math.max(1, Math.round(gl.drawingBufferHeight * q.scale));
    if (w === this.size.x && h === this.size.y) return;
    this.size.set(w, h);
    this.gbuffer.setSize(w, h); this.aoTarget.setSize(w, h); this.denoiseTarget.setSize(w, h);
    this.gtao.uniforms.resolution.value.set(w, h); this.denoise.uniforms.resolution.value.set(w, h);
  }

  // Swap every participating mesh onto the AO materials and hide everything else; restored in _restore().
  _isolate(scene, targets, classify) {
    const saved = this._saved; saved.length = 0;
    const chain = new Set();
    for (const t of targets) for (let p = t; p; p = p.parent) chain.add(p);
    const inTarget = new Set(targets);
    const visit = (o, inside) => {
      const here = inside || inTarget.has(o);
      if (!here && !chain.has(o)) { if (o.visible) { saved.push([o, true, null]); o.visible = false; } return; }
      if (here && o.isMesh && o.visible) {
        const c = classify(o);
        if (!c) { saved.push([o, true, null]); o.visible = false; return; }
        const src = Array.isArray(o.material) ? o.material[0] : o.material;
        const side = src.side === THREE.DoubleSide ? 1 : src.side === THREE.BackSide ? 2 : 0;
        saved.push([o, true, o.material]); o.material = this.gMat[c][side];
      }
      for (const ch of o.children) visit(ch, here);
    };
    visit(scene, false);
  }
  _restore() {
    for (const [o, vis, mat] of this._saved) { o.visible = vis; if (mat) o.material = mat; }
    this._saved.length = 0;
  }

  /** Direct path: call right after the frame has been rendered to the canvas (display-space composite). */
  render(scene, camera, targets, classify) {
    this.compute(scene, camera, targets, classify);
    const R = this.renderer, p = this.params, ac = R.autoClear;
    // 4. composite onto the canvas (no clear: it multiplies the frame already there)
    this.composite.uniforms.intensity.value = p.intensity; this.composite.uniforms.bias.value = p.bias;
    R.setRenderTarget(null); R.autoClear = false;
    this.quad.material = this.composite; this.quad.render(R);
    R.autoClear = ac;
  }

  /** Steps 1–3 only: returns the denoised AO buffer + receiver mask for a caller that composites
   *  in scene-linear light (ProductPost, Phase 18). */
  compute(scene, camera, targets, classify) {
    if (!this._built) this._build();
    const R = this.renderer, q = this._applyQuality();
    this._resize(q);
    const p = this.params;
    const cc = R.getClearColor(new THREE.Color()), ca = R.getClearAlpha(), ac = R.autoClear, bg = scene.background, env = scene.environment;
    // 1. G-buffer
    this._isolate(scene, targets, classify);
    scene.background = null;
    R.setRenderTarget(this.gbuffer); R.setClearColor(0x7f7fff, 0); R.autoClear = false; R.clear(true, true, false);
    R.render(scene, camera);
    this._restore();
    scene.background = bg; scene.environment = env;
    // 2. GTAO
    const u = this.gtao.uniforms;
    u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
    u.cameraProjectionMatrix.value.copy(camera.projectionMatrix); u.cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
    u.cameraWorldMatrix.value.copy(camera.matrixWorld);
    u.radius.value = p.radius; u.thickness.value = p.thickness; u.distanceExponent.value = p.distanceExponent;
    u.distanceFallOff.value = p.distanceFallOff; u.scale.value = p.power;
    if (this.box) { u.sceneBoxMin.value.copy(this.box.min); u.sceneBoxMax.value.copy(this.box.max); }
    R.setRenderTarget(this.aoTarget); R.setClearColor(0xffffff, 1); R.clear(true, false, false);
    this.quad.material = this.gtao; this.quad.render(R);
    // 3. denoise
    this.denoise.uniforms.cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
    R.setRenderTarget(this.denoiseTarget); R.clear(true, false, false);
    this.quad.material = this.denoise; this.quad.render(R);
    R.setClearColor(cc, ca); R.autoClear = ac;
    return { ao: this.denoiseTarget.texture, mask: this.gbuffer.texture, params: this.params };
  }

  memory() {
    if (!this._built) return { bytes: 0 };
    const px = this.size.x * this.size.y;
    return { width: this.size.x, height: this.size.y, gbufferRGBA8: px * 4, depth32: px * 4, ao8: px, denoise8: px, bytes: px * 10 };
  }

  dispose() {
    if (!this._built) return;
    this._restore();
    this.gbuffer.depthTexture.dispose(); this.gbuffer.dispose(); this.aoTarget.dispose(); this.denoiseTarget.dispose();
    for (const k of ['receive', 'occlude']) for (const m of this.gMat[k]) m.dispose();
    this.gtao.dispose(); this.denoise.dispose(); this.composite.dispose();
    this.gtaoNoise.dispose(); this.pdNoise.dispose(); this.quad.dispose();
    this.size.set(0, 0); this._built = false;
  }
}
