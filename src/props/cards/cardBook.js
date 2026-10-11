/**
 * Card book inventory — browse collected Odyssey cards, flip for lore.
 * Open/close with B; Left/Right browse; F flip.
 */

import { list as listOwned } from "./collection.js";
import { CARDS, getCard } from "./catalog.js";
import { trapDialogFocus } from "../../ui/dialog.js";
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
        this.el.setAttribute("role", "dialog");
        this.el.setAttribute("aria-modal", "true");
        this.el.setAttribute("aria-label", "Card book");
        this.el.setAttribute("aria-hidden", "true");
        this.el.innerHTML =
            '<div class="ob-dim" aria-hidden="true"></div>' +
            '<div class="ob-title">Card book</div>' +
            '<div class="ob-progress"></div>' +
            '<div class="ob-empty">Your discoveries belong here. Speak with characters, inspect the world, and face its challengers to collect cards.</div>' +
            '<div class="ob-stage" hidden>' +
            '  <div class="ob-card">' +
            '    <div class="ob-face ob-front"><div class="ob-face-inner"><img alt="" decoding="async" /></div></div>' +
            '    <div class="ob-face ob-back"><div class="ob-face-inner"><div class="odyssey-lore"></div></div></div>' +
            "  </div>" +
            "</div>" +
            '<div class="ob-strip" hidden></div>' +
            '<details class="ob-discovery"><summary>Discovery hints</summary><p></p></details>' +
            '<div class="ob-hint"><button data-book="previous">Previous</button><button data-book="next">Next</button><button data-book="flip">Flip <kbd>F</kbd></button><button data-book="close">Close <kbd>B / Esc</kbd></button></div>';
        document.body.appendChild(this.el);
        trapDialogFocus(this.el);

        this._empty = /** @type {HTMLElement} */ (this.el.querySelector(".ob-empty"));
        this._stage = /** @type {HTMLElement} */ (this.el.querySelector(".ob-stage"));
        this._strip = /** @type {HTMLElement} */ (this.el.querySelector(".ob-strip"));
        this._img = /** @type {HTMLImageElement} */ (this.el.querySelector(".ob-front img"));
        this._loreRoot = /** @type {HTMLElement} */ (this.el.querySelector(".odyssey-lore"));
        this._progress = this.el.querySelector(".ob-progress");
        this._discovery = this.el.querySelector(".ob-discovery p");
        this.getDiscoveryHint = () => "Explore the dunes. Speak to characters and inspect nearby landmarks.";
        this.onClose = null;
        this.el.addEventListener("click", (event) => {
            const button = event.target.closest("button");
            if (!button) return;
            const action = button.dataset.book;
            if (action === "close") this.onClose?.();
            if (action === "flip") this.toggleFlip();
            if (action === "previous") this.browse(-1);
            if (action === "next") this.browse(1);
            if (button.dataset.card) {
                const index = this._cards.findIndex((c) => c.id === button.dataset.card);
                if (index >= 0) {
                    this._index = index;
                    this.flipped = false; this.el.classList.remove("flipped");
                    this._renderFocus(); this._renderStrip();
                    this._strip.querySelector(`[data-card="${button.dataset.card}"]`)?.focus();
                } else {
                    this._discovery.textContent = this.getDiscoveryHint(button.dataset.card);
                    this.el.querySelector("details").open = true;
                }
            }
        });

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
        this.el.setAttribute("aria-hidden", "false");
        this.el.querySelector('[data-book="close"]').focus();
    }

    close() {
        if (!this.visible) return;
        this.visible = false;
        this.flipped = false;
        this.el.classList.remove("show", "flipped");
        this.el.setAttribute("aria-hidden", "true");
    }

    toggle() {
        if (this.visible) this.close();
        else this.open();
    }

    _refresh() {
        this._cards = listOwned();
        this._progress.textContent = `Collected ${this._cards.length} of ${CARDS.length}`;
        const missing = CARDS.find((c) => !this._cards.includes(c));
        this._discovery.textContent = missing ? this.getDiscoveryHint(missing.id) : "All six cards are collected. Their stories stay saved for your next visit.";
        this.el.querySelector('[data-book="flip"]').disabled = !this._cards.length;
        this.el.querySelector('[data-book="previous"]').disabled = this._cards.length < 2;
        this.el.querySelector('[data-book="next"]').disabled = this._cards.length < 2;
        if (!this._cards.length) {
            this._empty.hidden = false;
            this._stage.hidden = true;
            this._strip.hidden = false;
            this._renderStrip();
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
        for (let slot = 0; slot < CARDS.length; slot++) {
            const entry = CARDS[slot];
            const owned = this._cards.includes(entry);
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.card = entry.id;
            button.className = "ob-slot" + (owned ? "" : " locked") + (this._cards[this._index] === entry ? " active" : "");
            button.setAttribute("aria-label", owned ? entry.title : `Undiscovered card ${slot + 1}; show discovery hint`);
            if (owned) {
                const img = document.createElement("img");
                img.src = getCard(entry.id).front; img.alt = ""; img.decoding = "async";
                button.appendChild(img);
            } else button.textContent = "?";
            this._strip.appendChild(button);
        }
    }

    /** @param {number} delta */
    browse(delta) {
        if (!this.visible || this._cards.length < 2) return;
        const focused = document.activeElement?.closest(".ob-slot")?.dataset.card;
        this._index = (this._index + delta + this._cards.length) % this._cards.length;
        this.flipped = false;
        this.el.classList.remove("flipped");
        this._renderFocus();
        this._renderStrip();
        if (focused) this._strip.querySelector(`[data-card="${focused}"]`)?.focus();
    }

    toggleFlip() {
        if (!this.visible || !this._cards.length) return;
        this.flipped = !this.flipped;
        this.el.classList.toggle("flipped", this.flipped);
    }
}
