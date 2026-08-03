/**
 * Framed Polyphemus collectible card — shown when the cyclops dies.
 * Pointer lock owns the mouse; dismiss with E.
 */

const CSS = `
#pcard-poly {
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
#pcard-poly.show { opacity: 1; }
#pcard-poly .poly-dim {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.62);
}
#pcard-poly .poly-frame {
    position: relative;
    z-index: 1;
    padding: 7px;
    border-radius: 14px;
    background: linear-gradient(135deg, #5eead4 0%, #e879f9 45%, #facc15 100%);
    box-shadow:
        0 0 0 3px #0a0a0a,
        0 24px 80px rgba(0, 0, 0, 0.65),
        0 0 60px rgba(232, 121, 249, 0.18);
    transform: translateY(12px) scale(0.96);
    transition: transform 360ms cubic-bezier(0.22, 1, 0.36, 1);
}
#pcard-poly.show .poly-frame {
    transform: translateY(0) scale(1);
}
#pcard-poly .poly-inner {
    display: block;
    border-radius: 8px;
    border: 5px solid #0a0a0a;
    background: #0a0a0a;
    max-height: min(78vh, 720px);
    max-width: min(86vw, 420px);
    width: auto;
    height: auto;
}
#pcard-poly .poly-hint {
    position: absolute;
    bottom: 7vh;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2;
    font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    font-size: 11px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(255, 245, 230, 0.78);
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.8);
}
#pcard-poly .poly-hint b {
    font-weight: 700;
    border: 1px solid rgba(255, 220, 160, 0.45);
    border-radius: 4px;
    padding: 1px 6px 2px;
    margin-right: 4px;
    color: #ffe7b0;
}
`;

export class PolyphemusCard {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.el = document.createElement("div");
        this.el.id = "pcard-poly";
        this.el.innerHTML =
            '<div class="poly-dim" aria-hidden="true"></div>' +
            '<div class="poly-frame">' +
            '<img class="poly-inner" src="/assets/odyssey/polyphemus_card.png" alt="Polyphemus" decoding="async" />' +
            "</div>" +
            '<div class="poly-hint"><b>E</b> continue</div>';
        document.body.appendChild(this.el);

        this.visible = false;
    }

    show() {
        if (this.visible) return;
        this.visible = true;
        this.el.classList.add("show");
    }

    hide() {
        if (!this.visible) return;
        this.visible = false;
        this.el.classList.remove("show");
    }
}
