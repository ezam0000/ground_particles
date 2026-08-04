/**
 * Loading-screen driver.
 *
 * A phase-weighted progress model: each phase declares how much of the bar it
 * owns, and the bar only ever moves forward. `phase()` also yields to the
 * browser so the DOM actually repaints between heavy synchronous steps.
 */

import { start as startBootMusic, stop as stopBootMusic } from "./bootMusic.js";

const bar = /** @type {HTMLElement} */ (document.getElementById("boot-bar"));
const label = /** @type {HTMLElement} */ (document.getElementById("boot-phase"));
const root = /** @type {HTMLElement} */ (document.getElementById("boot"));
const hint = /** @type {HTMLElement} */ (document.getElementById("hint"));
const crosshair = /** @type {HTMLElement} */ (document.getElementById("crosshair"));

let progress = 0;

// Kick music as soon as the loading module is imported (races GPU warm-up).
startBootMusic();

/** Yield to the compositor so the loading screen repaints. */
export function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/**
 * @param {string} text shown under the bar
 * @param {number} to target progress, 0..1
 */
export async function phase(text, to) {
    if (label) label.textContent = text;
    progress = Math.max(progress, to);
    if (bar) bar.style.width = (progress * 100).toFixed(1) + "%";
    await nextFrame();
}

export async function done() {
    await phase("enter", 1);
    // Let the bar visibly land before the fade starts.
    await new Promise((r) => setTimeout(r, 360));
    const vid = /** @type {HTMLVideoElement|null} */ (document.getElementById("boot-video"));
    if (vid) vid.pause();
    void stopBootMusic({ fadeMs: 700 });
    root?.classList.add("gone");
    hint?.classList.add("show");
    // Crosshair waits until Eumaeus gifts the bow (main.js toggles .show).
    setTimeout(() => {
        root?.remove();
        hint?.classList.remove("show");
    }, 6000);
}

/** Show or hide the centre aim reticle. */
export function setCrosshair(on) {
    crosshair?.classList.toggle("show", !!on);
    if (!on) {
        crosshair?.classList.remove("warn");
        crosshair?.classList.remove("teach");
    }
}

/** Amber sacred-NPC aim cue. */
export function setCrosshairWarn(on) {
    crosshair?.classList.toggle("warn", !!on);
}

/** Under-crosshair “R draw & shoot” coach mark. */
export function setCrosshairTeach(on) {
    crosshair?.classList.toggle("teach", !!on);
}

export function fail(message) {
    void stopBootMusic({ fadeMs: 200 });
    root?.remove();
    const el = document.getElementById("nogpu");
    if (el) {
        el.classList.add("show");
        const b = el.querySelector("b");
        if (b && message) b.textContent = message;
    }
}
