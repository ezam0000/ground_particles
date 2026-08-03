/**
 * Card book inventory — browse collected Odyssey cards, flip for lore.
 * Open/close with B; Left/Right browse; F flip.
 */

import { list as listOwned } from "./collection.js";
import { LORE_CSS, loreHtml, fillLore } from "./cardChrome.js";

const CSS = `
#odyssey-book {
    position: fixed;
    inset: 0;
    z-index: 85;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 280ms ease;
}
#odyssey-book.show { opacity: 1; }
#odyssey-book .ob-dim {
    position: absolute;
    inset: 0;
    background: rgba(6, 4, 2, 0.78);
}
#odyssey-book .ob-title {
    position: relative;
    z-index: 1;
    font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    font-size: 11px;
    letter-spacing: 0.28em;
    text-transform: uppercase;
    color: rgba(240, 200, 120, 0.75);
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.7);
}
#odyssey-book .ob-empty {
    position: relative;
    z-index: 1;
    max-width: min(420px, 86vw);
    text-align: center;
    font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.55;
    color: rgba(240, 226, 200, 0.72);
}
#odyssey-book .ob-stage {
    position: relative;
    z-index: 1;
    width: min(86vw, 400px);
    perspective: 1400px;
}
#odyssey-book .ob-card {
    position: relative;
    width: 100%;
    aspect-ratio: 3 / 4.2;
    transform-style: preserve-3d;
    transition: transform 520ms cubic-bezier(0.22, 1, 0.36, 1);
}
#odyssey-book.flipped .ob-card {
    transform: rotateY(180deg);
}
#odyssey-book .ob-face {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    border-radius: 14px;
    padding: 7px;
    background: linear-gradient(135deg, #5eead4 0%, #e879f9 45%, #facc15 100%);
    box-shadow:
        0 0 0 3px #0a0a0a,
        0 20px 60px rgba(0, 0, 0, 0.55);
}
#odyssey-book .ob-face-inner {
    width: 100%;
    height: 100%;
    border-radius: 8px;
    border: 5px solid #0a0a0a;
    overflow: hidden;
    background: #0a0a0a;
}
#odyssey-book .ob-face-inner img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}
#odyssey-book .ob-back { transform: rotateY(180deg); }
#odyssey-book .ob-strip {
    position: relative;
    z-index: 1;
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
    max-width: min(92vw, 640px);
}
#odyssey-book .ob-thumb {
    width: 52px;
    height: 72px;
    border-radius: 6px;
    border: 2px solid rgba(255, 220, 160, 0.25);
    object-fit: cover;
    opacity: 0.55;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
}
#odyssey-book .ob-thumb.active {
    opacity: 1;
    border-color: #f0c878;
    box-shadow: 0 0 0 1px #f0c878, 0 6px 18px rgba(0, 0, 0, 0.5);
}
#odyssey-book .ob-hint {
    position: relative;
    z-index: 1;
    font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgba(255, 245, 230, 0.7);
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.8);
}
#odyssey-book .ob-hint b {
    font-weight: 700;
    border: 1px solid rgba(255, 220, 160, 0.4);
    border-radius: 4px;
    padding: 1px 6px 2px;
    margin: 0 2px 0 8px;
    color: #ffe7b0;
}
#odyssey-book .ob-hint b:first-child { margin-left: 0; }
#odyssey-book .ob-stage[hidden],
#odyssey-book .ob-strip[hidden],
#odyssey-book .ob-empty[hidden] { display: none !important; }
` + LORE_CSS;

export class CardBook {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.el = document.createElement("div");
        this.el.id = "odyssey-book";
        this.el.innerHTML =
            '<div class="ob-dim" aria-hidden="true"></div>' +
            '<div class="ob-title">Card book</div>' +
            '<div class="ob-empty">No cards yet — defeat the island’s foes.</div>' +
            '<div class="ob-stage" hidden>' +
            '  <div class="ob-card">' +
            '    <div class="ob-face ob-front"><div class="ob-face-inner"><img alt="" decoding="async" /></div></div>' +
            '    <div class="ob-face ob-back"><div class="ob-face-inner"><div class="odyssey-lore"></div></div></div>' +
            "  </div>" +
            "</div>" +
            '<div class="ob-strip" hidden></div>' +
            '<div class="ob-hint"><b>←→</b> browse <b>F</b> flip <b>B</b> close</div>';
        document.body.appendChild(this.el);

        this._empty = /** @type {HTMLElement} */ (this.el.querySelector(".ob-empty"));
        this._stage = /** @type {HTMLElement} */ (this.el.querySelector(".ob-stage"));
        this._strip = /** @type {HTMLElement} */ (this.el.querySelector(".ob-strip"));
        this._img = /** @type {HTMLImageElement} */ (this.el.querySelector(".ob-front img"));
        this._loreRoot = /** @type {HTMLElement} */ (this.el.querySelector(".odyssey-lore"));

        this.visible = false;
        this.flipped = false;
        this._index = 0;
        /** @type {import("./catalog.js").CardDef[]} */
        this._cards = [];
    }

    open() {
        this._refresh();
        this.visible = true;
        this.flipped = false;
        this.el.classList.add("show");
        this.el.classList.remove("flipped");
    }

    close() {
        if (!this.visible) return;
        this.visible = false;
        this.flipped = false;
        this.el.classList.remove("show", "flipped");
    }

    toggle() {
        if (this.visible) this.close();
        else this.open();
    }

    _refresh() {
        this._cards = listOwned();
        if (!this._cards.length) {
            this._empty.hidden = false;
            this._stage.hidden = true;
            this._strip.hidden = true;
            this._strip.innerHTML = "";
            return;
        }
        this._empty.hidden = true;
        this._stage.hidden = false;
        this._strip.hidden = false;
        if (this._index >= this._cards.length) this._index = this._cards.length - 1;
        if (this._index < 0) this._index = 0;
        this._renderFocus();
        this._renderStrip();
    }

    _renderFocus() {
        const c = this._cards[this._index];
        if (!c) return;
        this._img.src = c.front;
        this._img.alt = c.title;
        this._loreRoot.innerHTML = loreHtml(c);
        fillLore(this._loreRoot, c);
    }

    _renderStrip() {
        this._strip.innerHTML = "";
        for (let i = 0; i < this._cards.length; i++) {
            const img = document.createElement("img");
            img.className = "ob-thumb" + (i === this._index ? " active" : "");
            img.src = this._cards[i].front;
            img.alt = this._cards[i].title;
            img.decoding = "async";
            this._strip.appendChild(img);
        }
    }

    /** @param {number} delta */
    browse(delta) {
        if (!this.visible || this._cards.length < 2) return;
        this._index = (this._index + delta + this._cards.length) % this._cards.length;
        this.flipped = false;
        this.el.classList.remove("flipped");
        this._renderFocus();
        this._renderStrip();
    }

    toggleFlip() {
        if (!this.visible || !this._cards.length) return;
        this.flipped = !this.flipped;
        this.el.classList.toggle("flipped", this.flipped);
    }
}
