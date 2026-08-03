/**
 * Death-drop collectible card — framed front art, flippable lore back.
 * Pointer lock owns the mouse; E dismisses, F flips.
 */

import { getCard } from "./catalog.js";
import { add as collectAdd } from "./collection.js";
import { LORE_CSS, loreHtml, fillLore } from "./cardChrome.js";

const CSS = `
#odyssey-drop {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 320ms ease;
}
#odyssey-drop.show { opacity: 1; }
#odyssey-drop .od-dim {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.62);
}
#odyssey-drop .od-scene {
    position: relative;
    z-index: 1;
    width: min(86vw, 420px);
    max-height: min(78vh, 720px);
    perspective: 1400px;
    transform: translateY(12px) scale(0.96);
    transition: transform 360ms cubic-bezier(0.22, 1, 0.36, 1);
}
#odyssey-drop.show .od-scene {
    transform: translateY(0) scale(1);
}
#odyssey-drop .od-card {
    position: relative;
    width: 100%;
    aspect-ratio: 3 / 4.2;
    max-height: min(78vh, 720px);
    transform-style: preserve-3d;
    transition: transform 520ms cubic-bezier(0.22, 1, 0.36, 1);
}
#odyssey-drop.flipped .od-card {
    transform: rotateY(180deg);
}
#odyssey-drop .od-face {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    border-radius: 14px;
    padding: 7px;
    background: linear-gradient(135deg, #5eead4 0%, #e879f9 45%, #facc15 100%);
    box-shadow:
        0 0 0 3px #0a0a0a,
        0 24px 80px rgba(0, 0, 0, 0.65),
        0 0 60px rgba(232, 121, 249, 0.18);
}
#odyssey-drop .od-face-inner {
    width: 100%;
    height: 100%;
    border-radius: 8px;
    border: 5px solid #0a0a0a;
    overflow: hidden;
    background: #0a0a0a;
}
#odyssey-drop .od-face-inner img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}
#odyssey-drop .od-back {
    transform: rotateY(180deg);
}
#odyssey-drop .od-hint {
    position: absolute;
    bottom: 7vh;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2;
    font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(255, 245, 230, 0.78);
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.8);
    white-space: nowrap;
}
#odyssey-drop .od-hint b {
    font-weight: 700;
    border: 1px solid rgba(255, 220, 160, 0.45);
    border-radius: 4px;
    padding: 1px 6px 2px;
    margin: 0 2px 0 8px;
    color: #ffe7b0;
}
#odyssey-drop .od-hint b:first-child { margin-left: 0; }
` + LORE_CSS;

export class DropCard {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.el = document.createElement("div");
        this.el.id = "odyssey-drop";
        this.el.innerHTML =
            '<div class="od-dim" aria-hidden="true"></div>' +
            '<div class="od-scene">' +
            '  <div class="od-card">' +
            '    <div class="od-face od-front"><div class="od-face-inner"><img alt="" decoding="async" /></div></div>' +
            '    <div class="od-face od-back"><div class="od-face-inner"><div class="odyssey-lore"></div></div></div>' +
            "  </div>" +
            "</div>" +
            '<div class="od-hint"><b>F</b> flip <b>E</b> continue</div>';
        document.body.appendChild(this.el);

        this._img = /** @type {HTMLImageElement} */ (this.el.querySelector(".od-front img"));
        this._loreRoot = /** @type {HTMLElement} */ (this.el.querySelector(".odyssey-lore"));

        this.visible = false;
        this.flipped = false;
        /** @type {string|null} */
        this.activeId = null;
    }

    /**
     * @param {string} cardId
     */
    show(cardId) {
        const card = getCard(cardId);
        if (!card) return;
        collectAdd(cardId);
        this.activeId = cardId;
        this._img.src = card.front;
        this._img.alt = card.title;
        this._loreRoot.innerHTML = loreHtml(card);
        fillLore(this._loreRoot, card);
        this.flipped = false;
        this.el.classList.remove("flipped");
        this.visible = true;
        this.el.classList.add("show");
    }

    hide() {
        if (!this.visible) return;
        this.visible = false;
        this.flipped = false;
        this.activeId = null;
        this.el.classList.remove("show", "flipped");
    }

    toggleFlip() {
        if (!this.visible) return;
        this.flipped = !this.flipped;
        this.el.classList.toggle("flipped", this.flipped);
    }
}
