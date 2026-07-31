// -----------------------------------------------------------------------------
// Portfolio pedestal material (authored GLB albedo + dedicated key lights).
//
// Spell-pool lights alone are too soft for near-black baked GLB albedos.
// Props carry their own 6-slot key lights with soft falloff, plus albedo
// exposure so the texture stays readable from every camera angle.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowShadowLookup>
#include<snowAtmosphere>
#include<snowSpellLights>

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vViewDist: f32;

var albedoTex: texture_2d<f32>;
var albedoTexSampler: sampler;
var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;
var cascade0: texture_2d<f32>;
var cascade0Sampler: sampler;
var cascade1: texture_2d<f32>;
var cascade1Sampler: sampler;
var cascade2: texture_2d<f32>;
var cascade2Sampler: sampler;

uniform cameraPos: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;

uniform cascadeMatrices: array<mat4x4f, 3>;
uniform cascadeSplits: vec4f;
uniform cascadeParams: array<vec4f, 3>;
uniform shadowTexel: f32;
uniform shadowSoftness: f32;
uniform shadowBias: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;
uniform ambientIntensity: f32;

uniform albedoColor: vec3f;
uniform useTex: f32;
/// Soft albedo lift — keeps authored texture readable in full shadow.
uniform panelGlow: f32;
/// Camera-key fill radiance (rgb). Lights the face toward the viewer.
uniform fillRadiance: vec3f;
/// Multiplies sampled / fallback albedo before lighting (dark GLBs need this).
uniform albedoGain: f32;

/// Prop-only spots (xyz, w = radius). Soft falloff — not spell attenuation.
uniform keyLightPos: array<vec4f, 6>;
uniform keyLightCol: array<vec4f, 6>;
uniform keyLightCount: f32;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

fn softKeyAtt(dist2: f32, radius: f32) -> f32 {
    let r = max(radius, 0.5);
    let t = sqrt(dist2) / r;
    if (t >= 1.0) { return 0.0; }
    let w = 1.0 - t;
    // Strong core, gentle rim — readable on dark albedo.
    return w * w * (1.0 + 1.5 * w);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorld;
    let N = normalize(input.vNormal);
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;
    const INV_PI: f32 = 0.31830988618;

    let tex = textureSample(albedoTex, albedoTexSampler, input.vUV).rgb;
    var albedo = mix(uniforms.albedoColor, tex, uniforms.useTex);
    // Lift crushed blacks before any lighting (baked GLBs are often near-zero).
    albedo = albedo * uniforms.albedoGain + vec3f(0.035);
    albedo = min(albedo, vec3f(1.4));

    let NdotL = dot(N, L);
    let noiseRot = ign(input.position.xy) * 6.28318530718;
    var shadow = 1.0;
    if (NdotL > -0.35) {
        shadow = sunShadow(world, N, input.vViewDist, noiseRot);
    }
    // Soft floor — cascade shadow must not silhouette a pillar.
    shadow = mix(0.88, 1.0, shadow);

    let roughness = 0.62;
    let sun = uniforms.sunRadiance * 1.55;

    var direct = albedo * INV_PI * sun * wrapDiffuse(NdotL, 0.48) * shadow;
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), roughness);
        let Vis = visSmithGGXCorrelated(clamp(dot(N, V), 1e-4, 1.0), NdotL, roughness);
        let F = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3f(0.04));
        direct += sun * D * Vis * F * NdotL * shadow * 0.28;
    }

    // Bounce from the opposite side of the sun — fills the backlit face.
    let Lb = -L;
    direct += albedo * INV_PI * sun * 0.55 * wrapDiffuse(dot(N, Lb), 0.6);

    // Camera key — always lights whatever face you are looking at.
    direct += albedo * INV_PI * uniforms.fillRadiance
            * wrapDiffuse(dot(N, V), 0.7);

    // Hemisphere ambient — stronger than scene default for props.
    var irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
    irradiance += shIrradiance(vec3f(0.0, 1.0, 0.0), uniforms.shR)
                * uniforms.ambientIntensity * 0.65
                * clamp(-N.y * 0.5 + 0.5, 0.0, 1.0)
                * vec3f(0.85, 0.68, 0.45);

    var color = direct + albedo * INV_PI * irradiance;

    // Dedicated pillar spots (soft, bright).
    let nk = i32(uniforms.keyLightCount);
    for (var i = 0; i < 6; i++) {
        if (i >= nk) { break; }
        let p = uniforms.keyLightPos[i];
        let d = p.xyz - world;
        let dist2 = dot(d, d);
        let att = softKeyAtt(dist2, p.w);
        if (att <= 0.0) { continue; }
        let Lk = d * inverseSqrt(max(dist2, 1e-8));
        let rad = uniforms.keyLightCol[i].rgb * uniforms.keyLightCol[i].w * att;
        color += albedo * INV_PI * wrapDiffuse(dot(N, Lk), 0.72) * rad;
    }

    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, albedo, vec3f(0.04), roughness, 0.55,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    // Guaranteed texture visibility.
    color += albedo * uniforms.panelGlow;

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, uniforms.sunRadiance,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, 1.0);
}
