/**
 * Zeus death screen — fullscreen art + SFX when the player shoots a sacred NPC.
 * Soft continue with E; caller handles respawn / bow loss.
 */

import { preloadSfx, playSfx, unlockAudio } from "../combat/sfx.js";

const ART = "/assets/odyssey/zeus_death.png";
const SFX = "/assets/sfx/zeus_death.mp3";
const SFX_VOL = 0.85;

const CSS = `
#zeus-death {
    position: fixed;
    inset: 0;
    z-index: 95;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 280ms ease;
    background: #000;
}
#zeus-death.show { opacity: 1; }
#zeus-death img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}
#zeus-death .zd-hint {
    position: absolute;
    bottom: 7vh;
    left: 50%;
    transform: translateX(-50%);
    font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    font-size: 11px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(230, 220, 200, 0.82);
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.9);
}
#zeus-death .zd-hint b {
    font-weight: 700;
    border: 1px solid rgba(255, 220, 160, 0.45);
    border-radius: 4px;
    padding: 1px 6px 2px;
    margin-right: 4px;
    color: #ffe7b0;
}
`;

export class ZeusDeath {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.el = document.createElement("div");
        this.el.id = "zeus-death";
        this.el.innerHTML =
            '<img alt="Zeus is upset" decoding="async" />' +
            '<div class="zd-hint"><b>E</b> continue</div>';
        document.body.appendChild(this.el);
        /** @type {HTMLImageElement} */
        this._img = this.el.querySelector("img");
        this._img.src = ART;

        this.visible = false;
        void preloadSfx(SFX);
    }

    show() {
        if (this.visible) return;
        this.visible = true;
        unlockAudio();
        playSfx(SFX, SFX_VOL);
        this.el.classList.add("show");
    }

    hide() {
        if (!this.visible) return;
        this.visible = false;
        this.el.classList.remove("show");
    }

    async warmUp() {
        await preloadSfx(SFX);
    }
}
