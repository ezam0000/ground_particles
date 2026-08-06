/**
 * Tiny pooled Web Audio player — low-latency one-shots, no per-frame alloc.
 */

/** @type {AudioContext|null} */
let _ctx = null;
/** @type {Map<string, AudioBuffer>} */
const _buffers = new Map();
/** @type {Map<string, Promise<AudioBuffer|null>>} */
const _loading = new Map();

function ctx() {
    if (_ctx) return _ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _ctx = new AC();
    return _ctx;
}

/** Resume after a user gesture (pointer lock / key). */
export function unlockAudio() {
    const c = ctx();
    if (c && c.state === "suspended") void c.resume();
}

/**
 * Prefetch and decode a clip.
 * @param {string} url
 */
export function preloadSfx(url) {
    if (_buffers.has(url) || _loading.has(url)) return _loading.get(url) || Promise.resolve(_buffers.get(url));
    const p = (async () => {
        const c = ctx();
        if (!c) return null;
        try {
            const res = await fetch(url);
            const raw = await res.arrayBuffer();
            const buf = await c.decodeAudioData(raw.slice(0));
            _buffers.set(url, buf);
            return buf;
        } catch {
            return null;
        } finally {
            _loading.delete(url);
        }
    })();
    _loading.set(url, p);
    return p;
}

/**
 * Play a decoded clip immediately (falls back to HTMLAudio if needed).
 * @param {string} url
 * @param {number} [volume]
 */
export function playSfx(url, volume = 0.5) {
    unlockAudio();
    const c = ctx();
    const buf = _buffers.get(url);
    if (c && buf) {
        const src = c.createBufferSource();
        const gain = c.createGain();
        gain.gain.value = volume;
        src.buffer = buf;
        src.connect(gain);
        gain.connect(c.destination);
        src.start(0);
        return;
    }
    // Decode in flight or WebAudio missing — HTMLAudio fallback.
    const a = new Audio(url);
    a.volume = volume;
    void a.play().catch(() => {});
    if (!_buffers.has(url)) void preloadSfx(url);
}

/**
 * Duration of a preloaded clip in seconds (0 if unknown).
 * @param {string} url
 */
export function sfxDuration(url) {
    const buf = _buffers.get(url);
    return buf ? buf.duration : 0;
}

/** @type {((text: string, durationSec: number, opts?: { portrait?: string, featured?: boolean, accentWord?: string }) => void)|null} */
let _onVoSubtitle = null;

/**
 * Hook VO captions (set once from main / Subtitles).
 * @param {((text: string, durationSec: number, opts?: { portrait?: string, featured?: boolean, accentWord?: string }) => void)|null} fn
 */
export function setVoSubtitleHandler(fn) {
    _onVoSubtitle = fn;
}

/**
 * Spoken line: play clip and show subtitle for its duration.
 * @param {string} url
 * @param {number} volume
 * @param {string} text
 * @param {{ portrait?: string, featured?: boolean, accentWord?: string }} [opts]
 */
export function playVo(url, volume, text, opts = {}) {
    playSfx(url, volume);
    if (!text || !_onVoSubtitle) return;
    const dur = sfxDuration(url);
    const fallback = Math.min(14, Math.max(2.5, text.length * 0.055));
    _onVoSubtitle(text, dur > 0.2 ? dur : fallback, opts);
}
