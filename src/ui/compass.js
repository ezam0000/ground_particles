/**
 * Subtle top-right compass — MDI compass SVG (Iconify) + objective needle.
 * North = world +Z (matches CameraRig yaw = 0 facing +Z).
 */

const CSS = `
#compass {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 48;
    width: 64px;
    height: 64px;
    pointer-events: none;
    opacity: 0.78;
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.55));
}
#compass .c-disc {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: rgba(12, 10, 8, 0.42);
    box-shadow: inset 0 0 0 1px rgba(232, 220, 200, 0.18);
}
#compass .c-rose {
    position: absolute;
    inset: 8px;
    background: url("/assets/ui/compass.svg") center / contain no-repeat;
    transform-origin: 50% 50%;
    will-change: transform;
}
#compass .c-needle {
    position: absolute;
    left: 50%;
    top: 6px;
    width: 0;
    height: 0;
    margin-left: -5px;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-bottom: 12px solid rgba(232, 180, 90, 0.95);
    transform-origin: 50% 26px;
    will-change: transform;
    opacity: 0;
    transition: opacity 180ms ease;
}
#compass .c-needle.show { opacity: 1; }
#compass .c-label {
    position: absolute;
    left: 50%;
    top: 100%;
    margin-top: 4px;
    transform: translateX(-50%);
    white-space: nowrap;
    font: 500 8px/1.2 ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgba(232, 220, 200, 0.55);
    text-shadow: 0 1px 6px rgba(0, 0, 0, 0.75);
    opacity: 0;
    transition: opacity 180ms ease;
}
#compass .c-label.show { opacity: 1; }
`;

const RAD2DEG = 180 / Math.PI;

export class Compass {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.root = document.createElement("div");
        this.root.id = "compass";
        this.root.innerHTML =
            '<div class="c-disc"></div>' +
            '<div class="c-rose" aria-hidden="true"></div>' +
            '<div class="c-needle" aria-hidden="true"></div>' +
            '<div class="c-label"></div>';
        document.body.appendChild(this.root);

        this._rose = /** @type {HTMLElement} */ (this.root.querySelector(".c-rose"));
        this._needle = /** @type {HTMLElement} */ (this.root.querySelector(".c-needle"));
        this._label = /** @type {HTMLElement} */ (this.root.querySelector(".c-label"));
    }

    /**
     * @param {number} yaw camera flat yaw (0 = +Z)
     * @param {{ x:number, z:number, label?:string }|null} target world XZ objective
     * @param {number} px player x
     * @param {number} pz player z
     */
    update(yaw, target, px, pz) {
        // Dial: N (+Z) stays world-north while the player turns.
        this._rose.style.transform = "rotate(" + (-yaw * RAD2DEG).toFixed(2) + "deg)";

        if (!target) {
            this._needle.classList.remove("show");
            this._label.classList.remove("show");
            this._label.textContent = "";
            return;
        }

        const bearing = Math.atan2(target.x - px, target.z - pz);
        let rel = bearing - yaw;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        this._needle.style.transform = "rotate(" + (rel * RAD2DEG).toFixed(2) + "deg)";
        this._needle.classList.add("show");

        if (target.label) {
            this._label.textContent = target.label;
            this._label.classList.add("show");
        } else {
            this._label.classList.remove("show");
            this._label.textContent = "";
        }
    }
}
