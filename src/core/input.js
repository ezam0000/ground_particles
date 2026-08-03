/**
 * Raw input state. Everything lands in one mutable struct that systems poll —
 * no events fired into game code, no per-frame allocation.
 *
 * Mouse look uses pointer lock, so there is no cursor: portfolio cards open on
 * approach and their links fire on a keypress, never on a click.
 */

export const input = {
    // Movement axes, camera-relative, already normalised to a unit disc.
    moveX: 0,
    moveZ: 0,
    moving: false,

    // Accumulated mouse delta since last `endFrame()`, in radians.
    lookX: 0,
    lookY: 0,

    // Zoom, consumed by the camera rig.
    zoomDelta: 0,

    sprint: false, // shift
    /** Set for one frame on Space keydown; cleared by `endFrame()`. */
    jumpPressed: false,
    /** Set for one frame on E keydown — opens the active portfolio card. */
    openPressed: false,
    /** Set for one frame on I keydown — toggle pillar inspect. */
    inspectPressed: false,
    /** Sticky: character frozen, camera orbits the inspected pillar. */
    inspecting: false,
    /** Set for one frame on C — cycle player emote. */
    emotePressed: false,
    /** Set for one frame on R — draw / shoot bow. */
    drawPressed: false,
    /** Set for one frame on B — toggle Odyssey card book. */
    bookPressed: false,
    /** Set for one frame on F — flip active collectible card. */
    flipPressed: false,
    /** Set for one frame on ArrowLeft — card book browse. */
    navLeftPressed: false,
    /** Set for one frame on ArrowRight — card book browse. */
    navRightPressed: false,

    locked: false,
};

const keys = Object.create(null);

const LOOK_SCALE = 0.0022;

/** @param {HTMLCanvasElement} canvas */
export function initInput(canvas) {
    canvas.addEventListener("click", () => {
        if (!input.locked) canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
        input.locked = document.pointerLockElement === canvas;
        if (!input.locked) {
            // Drop held state so the character doesn't run off while unfocused.
            for (const k in keys) keys[k] = false;
        }
    });

    document.addEventListener("mousemove", (e) => {
        if (!input.locked) return;
        input.lookX += e.movementX * LOOK_SCALE;
        input.lookY += e.movementY * LOOK_SCALE;
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener(
        "wheel",
        (e) => {
            if (!input.locked) return;
            e.preventDefault();
            input.zoomDelta += e.deltaY * 0.0016;
        },
        { passive: false }
    );

    window.addEventListener("keydown", (e) => {
        if (e.code === "Space") {
            // Space scrolls the page by default; never let it.
            e.preventDefault();
            if (!e.repeat) input.jumpPressed = true;
        }
        if (e.code === "KeyE" && !e.repeat) input.openPressed = true;
        if (e.code === "KeyI" && !e.repeat) input.inspectPressed = true;
        if (e.code === "KeyC" && !e.repeat) input.emotePressed = true;
        if (e.code === "KeyR" && !e.repeat) input.drawPressed = true;
        if (e.code === "KeyB" && !e.repeat) input.bookPressed = true;
        if (e.code === "KeyF" && !e.repeat) input.flipPressed = true;
        if (e.code === "ArrowLeft" && !e.repeat) input.navLeftPressed = true;
        if (e.code === "ArrowRight" && !e.repeat) input.navRightPressed = true;
        if (e.code === "Escape" && !e.repeat && input.inspecting) {
            input.inspectPressed = true; // same toggle path exits inspect
        }
        if (e.repeat) return;
        keys[e.code] = true;
    });

    window.addEventListener("keyup", (e) => {
        keys[e.code] = false;
    });

    window.addEventListener("blur", () => {
        for (const k in keys) keys[k] = false;
    });
}

/** Resolve held keys into movement axes. Called once per frame before update. */
export function pollInput() {
    let x = 0;
    let z = 0;
    if (keys.KeyW || keys.ArrowUp) z += 1;
    if (keys.KeyS || keys.ArrowDown) z -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;

    // Clamp to a unit disc so diagonals aren't faster.
    const len = Math.sqrt(x * x + z * z);
    if (len > 1) {
        x /= len;
        z /= len;
    }
    input.moveX = x;
    input.moveZ = z;
    input.moving = len > 0.001;
    input.sprint = !!(keys.ShiftLeft || keys.ShiftRight);
}

/** Clear per-frame accumulators. Called at the very end of the frame. */
export function endFrame() {
    input.lookX = 0;
    input.lookY = 0;
    input.zoomDelta = 0;
    input.jumpPressed = false;
    input.openPressed = false;
    input.inspectPressed = false;
    input.emotePressed = false;
    input.drawPressed = false;
    input.bookPressed = false;
    input.flipPressed = false;
    input.navLeftPressed = false;
    input.navRightPressed = false;
}
