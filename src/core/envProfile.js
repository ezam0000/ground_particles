/**
 * Environment profiles and the snow↔sand blend controller.
 *
 * `S.environment` is the *target*. `envBlend` is the continuous factor
 * (0 = full snow, 1 = full sand) eased every frame. Systems sample
 * `getLerped()` — nothing hard-swaps mid-frame, and the deform buffer is
 * never cleared on a switch.
 *
 * Sand physics is not "snow × refillMul". Dry sand cannot hold a steep wall:
 * berms avalanche back into the trench (slump), print rims cave in to the
 * angle of repose (diffusion), and wind saltation fills from upwind — a
 * desert-dry footprint caves in within seconds rather than lingering like
 * packed snow. Those rates are separate multipliers (snow = 1).
 */

import { S } from "./settings.js";

/** Seconds to cross from one extreme to the other. */
const BLEND_DURATION = 3.2;

/**
 * @typedef {{
 *   albedo: [number, number, number],
 *   sprayAlbedo: [number, number, number],
 *   sssStrength: number,
 *   sssRadius: number,
 *   glintIntensity: number,
 *   glintGrazing: number,
 *   refillMul: number,
 *   contactScale: number,
 *   bermScale: number,
 *   compressionScale: number,
 *   rimRoughness: number,
 *   slumpMul: number,
 *   bermDiffMul: number,
 *   depDiffMul: number,
 *   depDecayMul: number,
 *   bermDecayMul: number,
 *   windInfillMul: number,
 *   sprayKickScale: number,
 *   iceScale: number,
 *   exposure: number,
 *   fogDensity: number,
 *   aerialStrength: number,
 *   detailUrl: string|null,
 * }} EnvProfile
 */

/** @type {EnvProfile} */
const SNOW = {
    albedo: [0.855, 0.885, 0.945],
    sprayAlbedo: [0.92, 0.94, 0.98],
    sssStrength: 1.0,
    sssRadius: 1.0,
    glintIntensity: 0.55,
    glintGrazing: 0.72,
    refillMul: 1.0,
    contactScale: 1.0,
    bermScale: 1.0,
    compressionScale: 1.0,
    rimRoughness: 1.0,
    slumpMul: 1.0,
    bermDiffMul: 1.0,
    depDiffMul: 1.0,
    depDecayMul: 1.0,
    bermDecayMul: 1.0,
    windInfillMul: 1.0,
    sprayKickScale: 1.0,
    iceScale: 1.0,
    exposure: 0.105,
    fogDensity: 0.0072,
    aerialStrength: 1.0,
    detailUrl: "/assets/environments/snow/detail.png",
};

/** @type {EnvProfile} */
const SAND = {
    albedo: [0.78, 0.62, 0.42],
    sprayAlbedo: [0.82, 0.68, 0.48],
    sssStrength: 0.08,
    sssRadius: 0.45,
    glintIntensity: 0.04,
    glintGrazing: 0.35,
    // Keep master refill near 1 — sand uses the per-term muls below instead.
    refillMul: 1.0,
    contactScale: 0.55,
    bermScale: 1.4,
    compressionScale: 1.15,
    rimRoughness: 0.5,
    // Collapse rates at refillRate = 1. Desert-dry: prints cave in fast.
    //   slump      berm avalanches into the hole (half-life ~1 s).
    //   depDecay   floor τ ≈ 1.2 s — a print is gone in a few seconds.
    //   bermDecay  berm τ ≈ 1.4 s.
    //   windInfill saltation fill from upwind.
    slumpMul: 420.0,
    bermDiffMul: 55.0,
    depDiffMul: 50.0,
    depDecayMul: 340.0,
    bermDecayMul: 280.0,
    windInfillMul: 14.0,
    sprayKickScale: 0.55,
    iceScale: 0.0,
    exposure: 0.14,
    fogDensity: 0.0045,
    aerialStrength: 0.7,
    detailUrl: "/assets/environments/sand/detail.png",
};

/** @type {Record<"snow"|"sand", EnvProfile>} */
export const PROFILES = { snow: SNOW, sand: SAND };

/** 0 = snow, 1 = sand. */
let envBlend = S.environment === "sand" ? 1 : 0;
/** Peak mid-transition fog cue. */
let transitionPulse = 0;

/** Scratch for getLerped — no per-frame allocation. */
const _out = {
    albedo: [0, 0, 0],
    sprayAlbedo: [0, 0, 0],
    sssStrength: 0,
    sssRadius: 0,
    glintIntensity: 0,
    glintGrazing: 0,
    refillMul: 0,
    contactScale: 0,
    bermScale: 0,
    compressionScale: 0,
    rimRoughness: 0,
    slumpMul: 0,
    bermDiffMul: 0,
    depDiffMul: 0,
    depDecayMul: 0,
    bermDecayMul: 0,
    windInfillMul: 0,
    sprayKickScale: 0,
    iceScale: 0,
    exposure: 0,
    fogDensity: 0,
    aerialStrength: 0,
    envBlend: 0,
    transitionPulse: 0,
};

function targetBlend() {
    return S.environment === "sand" ? 1 : 0;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * Smoothstep ease toward the target. Call once per frame from main.
 * @param {number} dt
 */
export function updateEnv(dt) {
    const step = dt > 0 ? dt : 1 / 60;
    const target = targetBlend();
    const rate = 1 / BLEND_DURATION;
    if (envBlend < target) envBlend = Math.min(target, envBlend + rate * step);
    else if (envBlend > target) envBlend = Math.max(target, envBlend - rate * step);

    const mid = 1 - Math.abs(envBlend - 0.5) * 2;
    transitionPulse = mid * mid;
}

/** Current blend factor in [0, 1]. */
export function getEnvBlend() {
    return envBlend;
}

/**
 * Lerped profile bag for this frame. Reuses one object.
 */
export function getLerped() {
    const a = PROFILES.snow;
    const b = PROFILES.sand;
    const t = envBlend;

    _out.albedo[0] = lerp(a.albedo[0], b.albedo[0], t);
    _out.albedo[1] = lerp(a.albedo[1], b.albedo[1], t);
    _out.albedo[2] = lerp(a.albedo[2], b.albedo[2], t);
    _out.sprayAlbedo[0] = lerp(a.sprayAlbedo[0], b.sprayAlbedo[0], t);
    _out.sprayAlbedo[1] = lerp(a.sprayAlbedo[1], b.sprayAlbedo[1], t);
    _out.sprayAlbedo[2] = lerp(a.sprayAlbedo[2], b.sprayAlbedo[2], t);
    _out.sssStrength = lerp(a.sssStrength, b.sssStrength, t);
    _out.sssRadius = lerp(a.sssRadius, b.sssRadius, t);
    _out.glintIntensity = lerp(a.glintIntensity, b.glintIntensity, t);
    _out.glintGrazing = lerp(a.glintGrazing, b.glintGrazing, t);
    _out.refillMul = lerp(a.refillMul, b.refillMul, t);
    _out.contactScale = lerp(a.contactScale, b.contactScale, t);
    _out.bermScale = lerp(a.bermScale, b.bermScale, t);
    _out.compressionScale = lerp(a.compressionScale, b.compressionScale, t);
    _out.rimRoughness = lerp(a.rimRoughness, b.rimRoughness, t);
    _out.slumpMul = lerp(a.slumpMul, b.slumpMul, t);
    _out.bermDiffMul = lerp(a.bermDiffMul, b.bermDiffMul, t);
    _out.depDiffMul = lerp(a.depDiffMul, b.depDiffMul, t);
    _out.depDecayMul = lerp(a.depDecayMul, b.depDecayMul, t);
    _out.bermDecayMul = lerp(a.bermDecayMul, b.bermDecayMul, t);
    _out.windInfillMul = lerp(a.windInfillMul, b.windInfillMul, t);
    _out.sprayKickScale = lerp(a.sprayKickScale, b.sprayKickScale, t);
    _out.iceScale = lerp(a.iceScale, b.iceScale, t);
    _out.exposure = lerp(a.exposure, b.exposure, t);
    _out.fogDensity = lerp(a.fogDensity, b.fogDensity, t) + transitionPulse * 0.004;
    _out.aerialStrength = lerp(a.aerialStrength, b.aerialStrength, t);
    _out.envBlend = t;
    _out.transitionPulse = transitionPulse;
    return _out;
}
