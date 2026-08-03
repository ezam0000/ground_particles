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
