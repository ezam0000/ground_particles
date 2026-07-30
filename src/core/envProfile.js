/**
 * Environment profiles and the snow↔sand blend controller.
 *
 * `S.environment` is the *target*. `envBlend` is the continuous factor
 * (0 = full snow, 1 = full sand) eased every frame. Systems sample
 * `getLerped()` — nothing hard-swaps mid-frame, and the deform buffer is
 * never cleared on a switch.
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
 *   iceScale: number,
 *   exposure: number,
 *   fogDensity: number,
 *   aerialStrength: number,
 *   detailUrl: string|null,
 * }} EnvProfile
 */

/** @type {Record<"snow"|"sand", EnvProfile>} */
export const PROFILES = {
    snow: {
        // Matches the hard-coded snow.fragment albedo / settings defaults.
        albedo: [0.855, 0.885, 0.945],
        sprayAlbedo: [0.92, 0.94, 0.98],
        sssStrength: 1.0,
        sssRadius: 1.0,
        glintIntensity: 0.55,
        glintGrazing: 0.72,
        refillMul: 1.0,
        contactScale: 1.0,
        iceScale: 1.0,
        exposure: 0.105,
        fogDensity: 0.0072,
        aerialStrength: 1.0,
        detailUrl: "/assets/environments/snow/detail.png",
    },
    sand: {
        albedo: [0.78, 0.62, 0.42],
        sprayAlbedo: [0.82, 0.68, 0.48],
        sssStrength: 0.08,
        sssRadius: 0.45,
        glintIntensity: 0.04,
        glintGrazing: 0.35,
        refillMul: 2.4,
        contactScale: 0.55,
        iceScale: 0.0,
        exposure: 0.14,
        fogDensity: 0.0045,
        aerialStrength: 0.7,
        detailUrl: "/assets/environments/sand/detail.png",
    },
};

/** 0 = snow, 1 = sand. */
let envBlend = S.environment === "sand" ? 1 : 0;
/** Peak mid-transition fog cue, decays after. */
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

/**
 * Smoothstep ease toward the target. Call once per frame from main.
 * @param {number} dt
 */
export function updateEnv(dt) {
    if (S.freezeTime && dt === 0) {
        // Still allow blend while time is frozen so the toggle is usable.
    }
    const step = dt > 0 ? dt : 1 / 60;
    const target = targetBlend();
    const rate = 1 / BLEND_DURATION;
    if (envBlend < target) envBlend = Math.min(target, envBlend + rate * step);
    else if (envBlend > target) envBlend = Math.max(target, envBlend - rate * step);

    // Bell curve peaking at mid-blend — brief aerial haze while the ground changes.
    const mid = 1 - Math.abs(envBlend - 0.5) * 2;
    transitionPulse = mid * mid;
}

/** Current blend factor in [0, 1]. */
export function getEnvBlend() {
    return envBlend;
}

/**
 * Lerped profile bag for this frame. Reuses one object — copy fields if you
 * need to keep them across a frame boundary.
 */
export function getLerped() {
    const a = PROFILES.snow;
    const b = PROFILES.sand;
    const t = envBlend;
    const u = 1 - t;

    _out.albedo[0] = a.albedo[0] * u + b.albedo[0] * t;
    _out.albedo[1] = a.albedo[1] * u + b.albedo[1] * t;
    _out.albedo[2] = a.albedo[2] * u + b.albedo[2] * t;
    _out.sprayAlbedo[0] = a.sprayAlbedo[0] * u + b.sprayAlbedo[0] * t;
    _out.sprayAlbedo[1] = a.sprayAlbedo[1] * u + b.sprayAlbedo[1] * t;
    _out.sprayAlbedo[2] = a.sprayAlbedo[2] * u + b.sprayAlbedo[2] * t;
    _out.sssStrength = a.sssStrength * u + b.sssStrength * t;
    _out.sssRadius = a.sssRadius * u + b.sssRadius * t;
    _out.glintIntensity = a.glintIntensity * u + b.glintIntensity * t;
    _out.glintGrazing = a.glintGrazing * u + b.glintGrazing * t;
    _out.refillMul = a.refillMul * u + b.refillMul * t;
    _out.contactScale = a.contactScale * u + b.contactScale * t;
    _out.iceScale = a.iceScale * u + b.iceScale * t;
    _out.exposure = a.exposure * u + b.exposure * t;
    _out.fogDensity = a.fogDensity * u + b.fogDensity * t;
    _out.aerialStrength = a.aerialStrength * u + b.aerialStrength * t;
    // Mid-transition fog bump on top of the lerped density.
    _out.fogDensity += transitionPulse * 0.004;
    _out.envBlend = t;
    _out.transitionPulse = transitionPulse;
    return _out;
}
