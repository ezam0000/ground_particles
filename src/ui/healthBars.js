/**
 * Proximity enemy health bars — world-projected DOM overlays.
 * Kinds: metal (unkillable full fill + flash), hp (draining fill), pips (cyclops).
 */

import { Vector3, Matrix, Viewport } from "@babylonjs/core/Maths/math";

const CSS = `
#hp-bars {
    position: fixed;
    inset: 0;
    z-index: 45;
    pointer-events: none;
    overflow: hidden;
}
#hp-bars .hp-item {
    position: absolute;
    left: 0;
    top: 0;
    transform: translate(-50%, -100%);
    width: 118px;
    opacity: 0;
    transition: opacity 180ms ease;
    will-change: transform, opacity;
}
#hp-bars .hp-item.show { opacity: 1; }
#hp-bars .hp-item.flash .hp-fill,
#hp-bars .hp-item.flash .hp-pip.on {
    filter: brightness(1.55) saturate(0.7);
}
#hp-bars .hp-name {
    margin: 0 0 4px;
    text-align: center;
    font: 600 9px/1.2 ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(240, 230, 210, 0.78);
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.85);
    white-space: nowrap;
}
#hp-bars .hp-track {
    position: relative;
    height: 7px;
    border-radius: 2px;
    background: rgba(12, 10, 8, 0.72);
    box-shadow:
        inset 0 0 0 1px rgba(255, 240, 210, 0.12),
        0 1px 6px rgba(0, 0, 0, 0.45);
    overflow: hidden;
}
#hp-bars .hp-fill {
    height: 100%;
    width: 100%;
    transform-origin: left center;
    transform: scaleX(1);
    border-radius: 2px;
    transition: transform 90ms linear, filter 80ms ease;
}
#hp-bars .hp-fill.mortal {
    background: linear-gradient(90deg, #8a3a22 0%, #c4783a 55%, #e8b06a 100%);
}
#hp-bars .hp-fill.metal {
    background: linear-gradient(90deg, #4a5058 0%, #9aa3ad 42%, #d5dbe2 58%, #6a727c 100%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
}
#hp-bars .hp-pips {
    display: flex;
    gap: 3px;
    justify-content: center;
}
#hp-bars .hp-pip {
    width: 16px;
    height: 7px;
    border-radius: 2px;
    background: rgba(20, 16, 12, 0.75);
    box-shadow: inset 0 0 0 1px rgba(255, 230, 180, 0.18);
    transition: background 100ms ease, filter 80ms ease, box-shadow 100ms ease;
}
#hp-bars .hp-pip.on {
    background: linear-gradient(180deg, #e8c878 0%, #a87830 100%);
    box-shadow:
        inset 0 1px 0 rgba(255, 245, 210, 0.45),
        0 0 6px rgba(200, 140, 50, 0.25);
}
`;

const POOL = 4;
const _world = new Vector3();
const _screen = new Vector3();
const _ident = Matrix.Identity();
const _viewport = new Viewport(0, 0, 1, 1);

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   x: number, y: number, z: number,
 *   kind: "metal"|"hp"|"pips",
 *   ratio?: number,
 *   pips?: number,
 *   maxPips?: number,
 *   flash?: number,
 * }} HpTrack
 */

export class HealthBars {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     */
    constructor(scene) {
        this.scene = scene;
        this.engine = scene.getEngine();

        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.root = document.createElement("div");
        this.root.id = "hp-bars";
        document.body.appendChild(this.root);

        /** @type {{ el: HTMLElement, name: HTMLElement, track: HTMLElement, fill: HTMLElement|null, pips: HTMLElement|null, pipEls: HTMLElement[], used: boolean }[]} */
        this._pool = [];
        for (let i = 0; i < POOL; i++) {
            const el = document.createElement("div");
            el.className = "hp-item";
            el.innerHTML =
                '<div class="hp-name"></div>' +
                '<div class="hp-track"><div class="hp-fill mortal"></div></div>' +
                '<div class="hp-pips" hidden></div>';
            this.root.appendChild(el);
            const pips = /** @type {HTMLElement} */ (el.querySelector(".hp-pips"));
            /** @type {HTMLElement[]} */
            const pipEls = [];
            for (let p = 0; p < 5; p++) {
                const pip = document.createElement("div");
                pip.className = "hp-pip";
                pips.appendChild(pip);
                pipEls.push(pip);
            }
            this._pool.push({
                el,
                name: /** @type {HTMLElement} */ (el.querySelector(".hp-name")),
                track: /** @type {HTMLElement} */ (el.querySelector(".hp-track")),
                fill: /** @type {HTMLElement} */ (el.querySelector(".hp-fill")),
                pips,
                pipEls,
                used: false,
            });
        }

        this._slot = 0;
    }

    beginFrame() {
        this._slot = 0;
        for (let i = 0; i < POOL; i++) this._pool[i].used = false;
    }

    /**
     * @param {HpTrack} t
     */
    track(t) {
        if (this._slot >= POOL) return;
        const engine = this.engine;
        const w = engine.getRenderWidth();
        const h = engine.getRenderHeight();
        if (w < 2 || h < 2) return;

        _world.set(t.x, t.y, t.z);
        _viewport.width = w;
        _viewport.height = h;
        Vector3.ProjectToRef(_world, _ident, this.scene.getTransformMatrix(), _viewport, _screen);

        // Behind camera / far clip discard.
        if (_screen.z < 0 || _screen.z > 1) return;
        if (_screen.x < -40 || _screen.x > w + 40 || _screen.y < -40 || _screen.y > h + 40) return;

        const slot = this._pool[this._slot++];
        slot.used = true;
        slot.name.textContent = t.name;

        const flashOn = (t.flash || 0) > 0.12;
        slot.el.classList.toggle("flash", flashOn);

        if (t.kind === "pips") {
            slot.track.hidden = true;
            slot.pips.hidden = false;
            const max = t.maxPips || 5;
            const on = t.pips || 0;
            for (let i = 0; i < slot.pipEls.length; i++) {
                const pip = slot.pipEls[i];
                pip.hidden = i >= max;
                pip.classList.toggle("on", i < on);
            }
        } else {
            slot.track.hidden = false;
            slot.pips.hidden = true;
            const fill = slot.fill;
            if (fill) {
                fill.classList.toggle("metal", t.kind === "metal");
                fill.classList.toggle("mortal", t.kind === "hp");
                const r = t.kind === "metal" ? 1 : Math.max(0, Math.min(1, t.ratio ?? 1));
                fill.style.transform = "scaleX(" + r.toFixed(3) + ")";
            }
        }

        slot.el.style.transform =
            "translate(" + _screen.x.toFixed(1) + "px, " + _screen.y.toFixed(1) + "px) translate(-50%, -100%)";
        slot.el.classList.add("show");
    }

    endFrame() {
        for (let i = 0; i < POOL; i++) {
            const slot = this._pool[i];
            if (!slot.used) slot.el.classList.remove("show", "flash");
        }
    }
}
