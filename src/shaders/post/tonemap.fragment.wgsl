// -----------------------------------------------------------------------------
// The composite: shafts, bloom, exposure, the display transform, grain.
//
// Everything that has to happen in one place happens here, because each of these
// is defined relative to the one before it. Shafts are radiance and go in before
// exposure; bloom is thresholded in *exposed* units so its knee means something
// fixed; contrast is applied in linear so it pushes into the tone curve's
// shoulder rather than clipping after it; grain goes on after the encode so it
// reads evenly across the range instead of vanishing in the shadows.
//
// Bright, low-contrast fields die at the tonemapper. The scene is a huge, sunlit
// surface, so any curve that saturates early turns the whole field into a flat
// sheet with no form — the single most common failure in terrain rendering.
//
// AgX is the default here rather than ACES for exactly that reason: it desaturates
// toward white as it approaches the shoulder instead of hue-shifting, and its
// shoulder is long enough that a sunlit drift at 6x middle grey still has legible
// gradation instead of clipping to 1.0. ACES is offered for comparison and does
// visibly worse on this content — it pushes bright snow toward a warm cast and
// crushes the last stop.
// -----------------------------------------------------------------------------

varying vUV: vec2f;

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;
/// Quarter-resolution bright pass — the tight glow around a glint or the sun.
var bloomNear: texture_2d<f32>;
var bloomNearSampler: sampler;
/// Sixteenth-resolution, blurred — the broad halo that reads as atmosphere.
var bloomFar: texture_2d<f32>;
var bloomFarSampler: sampler;
var shaftsTex: texture_2d<f32>;
var shaftsTexSampler: sampler;

uniform exposure: f32;
uniform contrast: f32;
uniform mode: f32;       // 0 = AgX, 1 = ACES, 2 = none
uniform grainAmount: f32;
uniform time: f32;
uniform vignette: f32;
uniform bloomAmount: f32;
uniform shaftAmount: f32;

// ------------------------------------------------------------------ AgX

const AGX_IN = mat3x3f(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
);

const AGX_OUT = mat3x3f(
     1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116
);

/// Sixth-order fit of the AgX contrast curve.
fn agxContrast(x: vec3f) -> vec3f {
    let x2 = x * x;
    let x4 = x2 * x2;
    return 15.5 * x4 * x2
         - 40.14 * x4 * x
         + 31.96 * x4
         - 6.868 * x2 * x
         + 0.4298 * x2
         + 0.1191 * x
         - 0.00232;
}

fn agx(color: vec3f) -> vec3f {
    const MIN_EV: f32 = -12.47393;
    const MAX_EV: f32 = 4.026069;

    var v = AGX_IN * max(color, vec3f(0.0));
    v = clamp(log2(max(v, vec3f(1e-10))), vec3f(MIN_EV), vec3f(MAX_EV));
    v = (v - MIN_EV) / (MAX_EV - MIN_EV);
    return agxContrast(v);
}

/// Gentle saturation recovery. AgX deliberately desaturates highlights; without
/// a little of it back, the cool shadow / warm light split the whole look rests
/// on gets flattened out along with the clipping it was there to prevent.
fn agxLook(color: vec3f, sat: f32) -> vec3f {
    let lw = vec3f(0.2126, 0.7152, 0.0722);
    let l = dot(color, lw);
    return max(vec3f(0.0), l + (color - l) * sat);
}

// ------------------------------------------------------------------ ACES

fn acesFitted(x: vec3f) -> vec3f {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

// -----------------------------------------------------------------------------

fn linearToSrgb(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
}

// -----------------------------------------------------------------------------

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    var c = textureSample(textureSampler, textureSamplerSampler, input.vUV).rgb;

    // Light shafts, in scene radiance so the tone curve rolls them off with
    // everything else. Added rather than blended: a shaft is light arriving at
    // the lens along a path, not a surface that replaces what is behind it.
    if (uniforms.shaftAmount > 0.0001) {
        c += textureSampleLevel(shaftsTex, shaftsTexSampler, input.vUV, 0.0).rgb
           * uniforms.shaftAmount;
    }

    c *= uniforms.exposure;

    // Bloom. Both levels are already in exposed units — the prefilter applied the
    // same exposure before thresholding, which is what lets the knee sit at a
    // fixed 1.0 instead of chasing the exposure slider.
    if (uniforms.bloomAmount > 0.0001) {
        let near = textureSampleLevel(bloomNear, bloomNearSampler, input.vUV, 0.0).rgb;
        let far = textureSampleLevel(bloomFar, bloomFarSampler, input.vUV, 0.0).rgb;
        // Weighted toward the wide level: a tight halo on a sand field reads as a
        // rendering artefact, a broad one reads as glare in the air.
        c += (near * 0.35 + far * 0.65) * uniforms.bloomAmount;
    }

    // Contrast about middle grey, applied in linear before the curve so it
    // pushes into the tonemapper's shoulder rather than clipping after it.
    if (abs(uniforms.contrast - 1.0) > 0.001) {
        c = 0.18 * pow(max(c / 0.18, vec3f(1e-5)), vec3f(uniforms.contrast));
    }

    // Every branch below returns *display-linear*, ready for one sRGB encode.
    var mapped: vec3f;
    if (uniforms.mode < 0.5) {
        // AgX's contrast polynomial already emits display-encoded values, so it
        // needs its EOTF (the 2.2 power) applied before the shared sRGB encode
        // at the bottom. Skipping that double-encodes the image: everything
        // lifts toward mid grey and the whole frame goes flat and milky —
        // which on a bright dune field is indistinguishable from "the shader is
        // wrong".
        var v = agx(c);
        v = agxLook(v, 1.14);
        mapped = pow(max(AGX_OUT * v, vec3f(0.0)), vec3f(2.2));
    } else if (uniforms.mode < 1.5) {
        // The Narkowicz fit is already display-linear.
        mapped = acesFitted(c);
    } else {
        mapped = clamp(c, vec3f(0.0), vec3f(1.0));
    }

    // Vignette, very slight — enough to keep the eye centred on a scene with no
    // UI to anchor it.
    if (uniforms.vignette > 0.001) {
        let d = length(input.vUV - vec2f(0.5)) * 1.414;
        mapped *= mix(1.0, smoothstep(1.05, 0.35, d), uniforms.vignette);
    }

    var outCol = linearToSrgb(mapped);

    // Grain, added after the encode so it reads evenly across the range instead
    // of vanishing in the shadows.
    if (uniforms.grainAmount > 0.0001) {
        let n = fract(sin(dot(input.vUV * vec2f(1920.0, 1080.0)
                + vec2f(uniforms.time * 91.7, uniforms.time * 43.3),
                vec2f(12.9898, 78.233))) * 43758.5453);
        outCol += (n - 0.5) * uniforms.grainAmount;
    }

    fragmentOutputs.color = vec4f(outCol, 1.0);
}
