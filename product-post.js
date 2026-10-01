// Product-viewer HDR output pipeline (Phase 18). Never imported by the hero (showroom.js).
//
//   1. scene      lights, PMREM environment, shadows, transmission → HDR target
//                 (RGBA16F, MSAA, scene-linear radiance; three disables tone mapping for render targets)
//   2. stages     optional HDR passes (none registered by default; bloom etc. plug in here)
//   3. output     one full-screen pass on the canvas:
//                   radiance × AO (ProductAO's buffer, scene-linear; strength matched to the approved
//                   Phase 15 display response — see AO_P15_RESPONSE)  →  [look]  →  AgX (calibrated
//                   exposure)  →  sRGB (renderer.outputColorSpace)
//
// AO is applied here, not as a second draw into the HDR target: three r160 invalidates the MSAA
// colour attachment right after resolving it, so the target cannot be drawn into again.
//
// The backdrop dome is a display-referred painting (authored sRGB values, toneMapped:false in the
// direct path). In the HDR target it is drawn with radiance pre-inverted through the same AgX
// transform, so the output pass reproduces its authored values. Everything else is scene-referred.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// MSAA sample budgets. Colour is RGBA16F in both (see PHASE_18_HDR_POST_REPORT §4).
export const POST_QUALITY = {
  high: { samples: 4 },
  low:  { samples: 2 },
};

// ── AgX, exactly as three r160 tonemapping_pars_fragment, plus an optional look saturation ──
// (applied after the sigmoid, before the outset matrix — the "look" slot of the reference AgX;
//  saturation 1.0 is the identity, i.e. bit-for-bit three's AgXToneMapping)
const AGX_GLSL = /* glsl */`
  const mat3 P18_LINEAR_REC2020_TO_LINEAR_SRGB = mat3( vec3( 1.6605, - 0.1246, - 0.0182 ), vec3( - 0.5876, 1.1329, - 0.1006 ), vec3( - 0.0728, - 0.0083, 1.1187 ) );
  const mat3 P18_LINEAR_SRGB_TO_LINEAR_REC2020 = mat3( vec3( 0.6274, 0.0691, 0.0164 ), vec3( 0.3293, 0.9195, 0.0880 ), vec3( 0.0433, 0.0113, 0.8956 ) );
  vec3 p18AgxContrast( vec3 x ) { vec3 x2 = x * x; vec3 x4 = x2 * x2;
    return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
  vec3 p18AgX( vec3 color, float exposure, float saturation ) {
    const mat3 AgXInsetMatrix = mat3( vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ), vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ), vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
    const mat3 AgXOutsetMatrix = mat3( vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ), vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ), vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ) );
    const float AgxMinEv = - 12.47393; const float AgxMaxEv = 4.026069;
    color = P18_LINEAR_SRGB_TO_LINEAR_REC2020 * color;
    color *= exposure;
    color = AgXInsetMatrix * color;
    color = max( color, 1e-10 ); color = log2( color ); color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
    color = clamp( color, 0.0, 1.0 );
    color = p18AgxContrast( color );
    #ifdef LOOK
      float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
      color = luma + saturation * ( color - luma );
    #endif
    color = AgXOutsetMatrix * color;
    color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
    color = P18_LINEAR_REC2020_TO_LINEAR_SRGB * color;
    return color;
  }`;

const OUTPUT_FRAG = /* glsl */`
  uniform sampler2D tHDR;
  uniform sampler2D tAO; uniform highp sampler2D tMask; uniform float aoIntensity; uniform float aoBias;
  uniform float exposure; uniform float saturation;
  varying vec2 vUv;
  ${AGX_GLSL}
  #ifdef USE_AO
  // bilinear receiver mask from the nearest-filtered AO G-buffer (as the Phase 15 composite)
  float aoMask( vec2 uv ) {
    vec2 s = vec2( textureSize( tMask, 0 ) ); vec2 p = uv * s - 0.5; ivec2 i = ivec2( floor( p ) ); vec2 f = fract( p );
    ivec2 m = ivec2( s ) - 1;
    float a = texelFetch( tMask, clamp( i, ivec2( 0 ), m ), 0 ).a, b = texelFetch( tMask, clamp( i + ivec2( 1, 0 ), ivec2( 0 ), m ), 0 ).a;
    float c = texelFetch( tMask, clamp( i + ivec2( 0, 1 ), ivec2( 0 ), m ), 0 ).a, d = texelFetch( tMask, clamp( i + ivec2( 1, 1 ), ivec2( 0 ), m ), 0 ).a;
    return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
  }
  #endif
  #ifdef AO_P15_RESPONSE
  vec3 p18sRGBOETF( vec3 c ) { c = max( c, vec3( 0.0 ) ); return mix( pow( c, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), c * 12.92, vec3( lessThanEqual( c, vec3( 0.0031308 ) ) ) ); }
  vec3 p18sRGBEOTF( vec3 c ) { c = max( c, vec3( 0.0 ) ); return mix( pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), c / 12.92, vec3( lessThanEqual( c, vec3( 0.04045 ) ) ) ); }
  #endif
  void main() {
    vec3 radiance = texture2D( tHDR, vUv ).rgb;
    #ifdef USE_AO
      float occ = 1.0 - texture2D( tAO, vUv ).r;
      occ = max( 0.0, occ - aoBias ) / max( 1e-3, 1.0 - aoBias );
      float a = max( 0.0, 1.0 - aoIntensity * occ * aoMask( vUv ) );
      #ifdef AO_P15_RESPONSE
        // Scene-linear AO whose DISPLAYED strength equals the approved Phase 15 MEDIUM response
        // (that composite multiplied the sRGB-encoded frame by a^(1/2.2)). AgX has a local slope of
        // 1.2–1.7 in the toe/mid-tones, so the same linear factor reads stronger after tone mapping:
        // solve for the scene-linear factor m with AgX(L·m) = the Phase 15 display result, using the
        // local log-slope of AgX at this pixel (a secant over the actual attenuation, so it is exact
        // to second order for the ≤ 35 % attenuations AO produces). Still applied before tone mapping.
        if ( a < 0.9999 ) {
          const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
          vec3 d0 = p18AgX( radiance, exposure, saturation );
          float y0 = dot( d0, LUMA );
          if ( y0 > 1e-6 ) {
            float yT = dot( p18sRGBEOTF( p18sRGBOETF( d0 ) * pow( a, 1.0 / 2.2 ) ), LUMA );
            float r = clamp( yT / y0, 1e-3, 1.0 );
            float y1 = dot( p18AgX( radiance * r, exposure, saturation ), LUMA );
            float g = ( r < 0.9999 && y1 > 0.0 && y1 < y0 ) ? clamp( log( y1 / y0 ) / log( r ), 0.5, 4.0 ) : 1.0;
            radiance *= pow( r, 1.0 / g );
          } else radiance *= a;
        }
      #else
        radiance *= a;                                           // plain scene-linear attenuation
      #endif
    #endif
    gl_FragColor = linearToOutputTexel( vec4( p18AgX( radiance, exposure, saturation ), 1.0 ) );
  }`;

// ── the same AgX on the CPU (to pre-invert display-referred backdrop values) ──
const mul = (m, v) => [m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2], m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2], m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]];
const S2R = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
const R2S = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const INSET = [[0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]];
const OUTSET = [[1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]];
const contrast = x => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; };
export function agxCPU(rgb, exposure, saturation = 1) {
  let c = mul(S2R, rgb).map(x => x * exposure); c = mul(INSET, c);
  c = c.map(x => contrast(Math.min(1, Math.max(0, (Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393)))));
  if (saturation !== 1) { const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; c = c.map(x => l + saturation * (x - l)); }
  c = mul(OUTSET, c).map(x => Math.pow(Math.max(0, x), 2.2));
  return mul(R2S, c);
}
const srgbToLinear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
// radiance L with agx(L) ≈ display-linear D (per-channel multiplicative fixed point; AgX is monotone and near-diagonal)
function agxInverse(D, exposure, saturation) {
  if (D[0] <= 0 && D[1] <= 0 && D[2] <= 0) return [0, 0, 0];
  let L = D.map(d => Math.max(d, 1e-6) * 12);
  for (let k = 0; k < 80; k++) {
    const A = agxCPU(L, exposure, saturation);
    L = L.map((l, i) => D[i] <= 0 ? l * 0.5 : l * Math.min(2, Math.max(0.5, D[i] / Math.max(A[i], 1e-9))));
  }
  return L;
}

const DOME_PIXELS = new WeakMap();

export class ProductPost {
  constructor(renderer) {
    this.renderer = renderer;
    this.quality = 'high';
    this.look = { saturation: 1 };
    this.stages = [];                 // optional HDR passes: { enabled, render(renderer, srcTarget) → target }
    this.size = new THREE.Vector2(0, 0);
    this._built = false;
    this._dome = { key: null, texture: null, material: null };
    this.lastStats = null;
  }

  _build() {
    this.hdr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: POST_QUALITY[this.quality].samples, depthBuffer: true, stencilBuffer: false });
    this.output = new THREE.ShaderMaterial({
      uniforms: { tHDR: { value: null }, tAO: { value: null }, tMask: { value: null }, aoIntensity: { value: 0 }, aoBias: { value: 0 }, exposure: { value: 1 }, saturation: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: OUTPUT_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.output);
    this._appliedSamples = POST_QUALITY[this.quality].samples;
    this._built = true;
  }
  configure({ quality, look } = {}) {
    if (quality && POST_QUALITY[quality]) this.quality = quality;
    if (look) Object.assign(this.look, look);
  }
  _resize() {
    const R = this.renderer, gl = R.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, s = POST_QUALITY[this.quality].samples;
    if (this._appliedSamples !== s) { this.hdr.dispose(); this.hdr.samples = s; this._appliedSamples = s; this.size.set(0, 0); }
    if (w === this.size.x && h === this.size.y) return;
    this.size.set(w, h); this.hdr.setSize(w, h);
  }
  // Pre-inverted HDR copy of the display-referred backdrop texture (rebuilt when exposure or look change).
  _domeMaterial(dome) {
    const src = dome.material, R = this.renderer, key = `${src.map && src.map.uuid}|${R.toneMappingExposure}|${this.look.saturation}`;
    if (this._dome.key === key) return this._dome.material;
    const img = src.map.image, w = img.width, h = img.height;
    let px = DOME_PIXELS.get(img);                          // the painted canvas never changes: read it once
    if (!px) { px = img.getContext('2d').getImageData(0, 0, w, h).data; DOME_PIXELS.set(img, px); }
    const data = new Uint16Array(w * h * 4), cache = new Map(), one = THREE.DataUtils.toHalfFloat(1);
    for (let i = 0; i < w * h; i++) {
      const k = (px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2];
      let L = cache.get(k); if (!L) { L = agxInverse([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]].map(srgbToLinear), R.toneMappingExposure, this.look.saturation).map(x => THREE.DataUtils.toHalfFloat(x)); cache.set(k, L); }
      data[i * 4] = L[0]; data[i * 4 + 1] = L[1]; data[i * 4 + 2] = L[2]; data[i * 4 + 3] = one;
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.flipY = src.map.flipY; tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    if (this._dome.texture) this._dome.texture.dispose();
    if (!this._dome.material) this._dome.material = new THREE.MeshBasicMaterial({ side: src.side, depthWrite: src.depthWrite });
    this._dome.material.map = tex; this._dome.material.needsUpdate = true;
    this._dome.texture = tex; this._dome.key = key;
    return this._dome.material;
  }

  /**
   * Render one frame through the HDR pipeline.
   * @param ao      ProductAO instance (or null)   @param aoArgs [targets, classify, params] for ProductAO.compute()
   * @param dome    the display-referred backdrop mesh (drawn pre-inverted into the HDR target)
   */
  render(scene, camera, { ao = null, aoArgs = null, dome = null, aoResponse = 'phase15' } = {}) {
    if (!this._built) this._build();
    this._resize();
    const R = this.renderer;
    // 1. scene → HDR (scene-linear; three turns tone mapping off for render targets)
    let domeMat = null; if (dome) { domeMat = dome.material; dome.material = this._domeMaterial(dome); }
    R.setRenderTarget(this.hdr); R.clear(true, true, false);
    R.render(scene, camera);
    if (dome) dome.material = domeMat;
    // 2. optional HDR stages
    let src = this.hdr;
    for (const st of this.stages) if (st.enabled) src = st.render(R, src) || src;
    // 3. AO buffer (scene-linear attenuation is applied in the output pass)
    let a = null; if (ao && aoArgs) a = ao.compute(scene, camera, ...aoArgs);
    // 4. output: × AO → [look] → AgX → sRGB, onto the canvas
    const u = this.output.uniforms, useAO = !!a, useLook = this.look.saturation !== 1, p15 = useAO && aoResponse === 'phase15';
    const d = this.output.defines;
    if (('USE_AO' in d) !== useAO || ('LOOK' in d) !== useLook || ('AO_P15_RESPONSE' in d) !== p15) {
      if (useAO) d.USE_AO = ''; else delete d.USE_AO;
      if (useLook) d.LOOK = ''; else delete d.LOOK;
      if (p15) d.AO_P15_RESPONSE = ''; else delete d.AO_P15_RESPONSE;
      this.output.needsUpdate = true;
    }
    u.tHDR.value = src.texture; u.exposure.value = R.toneMappingExposure; u.saturation.value = this.look.saturation;
    if (a) { u.tAO.value = a.ao; u.tMask.value = a.mask; u.aoIntensity.value = a.params.intensity; u.aoBias.value = a.params.bias; }
    R.setRenderTarget(null);
    this.quad.render(R);
  }

  memory() {
    if (!this._built) return { bytes: 0 };
    const px = this.size.x * this.size.y, s = this._appliedSamples;
    const m = { width: this.size.x, height: this.size.y, samples: s,
      msaaColorRGBA16F: s ? px * 8 * s : 0, msaaDepth24: s ? px * 4 * s : 0, resolvedRGBA16F: px * 8, depthNoMSAA: s ? 0 : px * 4,
      dome: this._dome.texture ? this._dome.texture.image.width * this._dome.texture.image.height * 8 : 0 };
    m.bytes = m.msaaColorRGBA16F + m.msaaDepth24 + m.resolvedRGBA16F + m.depthNoMSAA + m.dome;
    return m;
  }

  dispose() {
    if (!this._built) return;
    this.hdr.dispose(); this.output.dispose(); this.quad.dispose();
    if (this._dome.texture) this._dome.texture.dispose();
    if (this._dome.material) this._dome.material.dispose();
    this._dome = { key: null, texture: null, material: null };
    for (const st of this.stages) if (st.dispose) st.dispose();
    this.size.set(0, 0); this._built = false;
  }
}
