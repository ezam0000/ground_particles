/**
 * Boot loading soundtrack — one random looping track for the load screen.
 * HTMLAudio (not the combat one-shot pool). Gesture fallback for autoplay.
 */

const TRACKS = [
    "/assets/boot/loading_1.mp3",
    "/assets/boot/loading_2.mp3",
];

const VOL = 0.35;
const FADE_MS = 700;

/** @type {HTMLAudioElement|null} */
let _audio = null;
let _started = false;
let _stopping = false;
/** @type {(() => void)|null} */
let _gestureOff = null;

function pick() {
    return TRACKS[(Math.random() * TRACKS.length) | 0];
}

function tryPlay() {
    if (!_audio || _stopping) return;
    const p = _audio.play();
    if (p && typeof p.catch === "function") {
        p.catch(() => {
            // Autoplay blocked — wait for a gesture on the boot overlay.
            armGesture();
        });
    }
}

function armGesture() {
    if (_gestureOff || _stopping) return;
    const boot = document.getElementById("boot") || document;
    const onGesture = () => {
        disarmGesture();
        if (!_audio || _stopping) return;
        void _audio.play().catch(() => {});
    };
    boot.addEventListener("pointerdown", onGesture, { once: true });
    boot.addEventListener("keydown", onGesture, { once: true });
    _gestureOff = () => {
        boot.removeEventListener("pointerdown", onGesture);
        boot.removeEventListener("keydown", onGesture);
        _gestureOff = null;
    };
}

function disarmGesture() {
    if (_gestureOff) _gestureOff();
}

/** Pick a random track and start (or arm gesture if autoplay is blocked). */
export function start() {
    if (_started) return;
    _started = true;
    _stopping = false;

    const a = new Audio(pick());
    a.loop = true;
    a.preload = "auto";
    a.volume = VOL;
    _audio = a;
    tryPlay();
}

/**
 * Fade out and release the player.
 * @param {{ fadeMs?: number }} [opts]
 */
export function stop(opts = {}) {
    const fadeMs = opts.fadeMs ?? FADE_MS;
    disarmGesture();
    const a = _audio;
    if (!a) {
        _stopping = true;
        return Promise.resolve();
    }
    _stopping = true;

    return new Promise((resolve) => {
        const from = a.volume;
        if (fadeMs <= 0 || from <= 0.001) {
            a.pause();
            a.removeAttribute("src");
            a.load();
            _audio = null;
            resolve();
            return;
        }
        const t0 = performance.now();
        const tick = (now) => {
            const t = Math.min(1, (now - t0) / fadeMs);
            a.volume = from * (1 - t);
            if (t < 1 && _audio === a) {
                requestAnimationFrame(tick);
                return;
            }
            a.pause();
            a.removeAttribute("src");
            a.load();
            if (_audio === a) _audio = null;
            resolve();
        };
        requestAnimationFrame(tick);
    });
}
