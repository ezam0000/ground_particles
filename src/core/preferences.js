/** Personal settings are independent of collectible progress. */
const KEY = "dunes.preferences.v1";
export const preferences = { volume: 1, sensitivity: 1, reducedMotion: false };
const listeners = new Set();

try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object") {
        for (const key of ["volume", "sensitivity", "reducedMotion"]) {
            const value = normalize(key, saved[key]);
            if (value !== undefined) preferences[key] = value;
        }
    }
} catch { /* Storage is optional; play remains available. */ }

function normalize(key, value) {
    if (key === "reducedMotion") return typeof value === "boolean" ? value : undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (key === "volume") return Math.min(1, Math.max(0, value));
    if (key === "sensitivity") return Math.min(2, Math.max(0.25, value));
    return undefined;
}

export function setPreference(key, value) {
    const next = normalize(key, value);
    if (next === undefined || preferences[key] === next) return;
    preferences[key] = next;
    try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* optional */ }
    for (const fn of listeners) fn(key, next);
}

export function onPreferenceChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function applyMotionPreference() {
    document.documentElement.classList.toggle("reduced-motion", preferences.reducedMotion);
}
