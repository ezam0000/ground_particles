/**
 * Bow-acquired toast — tells the player they have the bow and how to fire.
 */

const CSS = `
#bow-toast {
    position: fixed;
    left: 50%;
    bottom: 22vh;
    z-index: 70;
    transform: translateX(-50%) translateY(10px);
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: opacity 320ms ease, transform 320ms ease, visibility 0s linear 320ms;
    text-align: center;
    max-width: min(92vw, 420px);
}
#bow-toast.show {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0);
    transition: opacity 320ms ease, transform 320ms ease, visibility 0s;
}
#bow-toast .bt-title {
    margin: 0 0 8px;
    font: 600 13px/1.3 ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: rgba(255, 236, 200, 0.95);
    text-shadow: 0 1px 14px rgba(0, 0, 0, 0.85);
}
#bow-toast .bt-body {
    margin: 0;
    font: 400 12px/1.55 ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.06em;
    color: rgba(230, 220, 205, 0.82);
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.8);
}
#bow-toast b {
    font-weight: 700;
    color: #ffe7b0;
    border: 1px solid rgba(255, 220, 160, 0.45);
    border-radius: 4px;
    padding: 1px 6px 2px;
    margin: 0 2px;
}
`;

export class BowToast {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.el = document.createElement("div");
        this.el.id = "bow-toast";
        this.el.setAttribute("aria-live", "polite");
        document.body.appendChild(this.el);

        this._hideTimer = 0;
        this.visible = false;
    }

    /**
     * @param {{ restored?: boolean }} [opts]
     */
    show(opts = {}) {
        const restored = !!opts.restored;
        this.el.innerHTML =
            `<p class="bt-title">${restored ? "Bow restored" : "Bow received"}</p>` +
            `<p class="bt-body">` +
            (restored
                ? `Press <b>R</b> to draw &amp; shoot · aim with the mouse`
                : `Eumaeus armed you. Press <b>R</b> to draw &amp; shoot · look to aim`) +
            `</p>`;

        this.visible = true;
        this.el.classList.add("show");
        window.clearTimeout(this._hideTimer);
        this._hideTimer = window.setTimeout(() => this.hide(), 7000);
    }

    hide() {
        this.visible = false;
        this.el.classList.remove("show");
        window.clearTimeout(this._hideTimer);
        this._hideTimer = 0;
    }
}
