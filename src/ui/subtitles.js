/**
 * Timed VO captions — centered above the footer HUD.
 */

const CSS = `
#subs {
    position: fixed;
    left: 50%;
    bottom: 17vh;
    z-index: 52;
    transform: translateX(-50%);
    max-width: min(720px, 88vw);
    pointer-events: none;
    text-align: center;
    font: 400 13px/1.45 ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.02em;
    color: rgba(245, 232, 210, 0.92);
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.9), 0 0 24px rgba(0, 0, 0, 0.55);
    opacity: 0;
    visibility: hidden;
    transition: opacity 220ms ease, visibility 220ms ease;
}
#subs.show {
    opacity: 1;
    visibility: visible;
}
`;

export class Subtitles {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.el = document.createElement("div");
        this.el.id = "subs";
        this.el.setAttribute("aria-live", "polite");
        document.body.appendChild(this.el);

        this._hideAt = 0;
        this._token = 0;
    }

    /**
     * @param {string} text
     * @param {number} durationSec
     */
    show(text, durationSec) {
        if (!text) return;
        const token = ++this._token;
        this.el.textContent = text;
        this.el.classList.add("show");
        const dur = Math.max(1.2, durationSec || 3.5);
        this._hideAt = performance.now() + dur * 1000;
        window.setTimeout(() => {
            if (token !== this._token) return;
            if (performance.now() >= this._hideAt - 16) this.hide();
        }, dur * 1000 + 40);
    }

    hide() {
        this.el.classList.remove("show");
    }
}
