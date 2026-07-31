/**
 * The project / résumé card — one DOM overlay when the character walks up to a
 * pedestal. Pointer lock owns the mouse; links fire on E via Pedestals.
 */

const CSS = `
#pcard {
    position: fixed;
    left: 50%;
    bottom: 12vh;
    z-index: 60;
    transform: translate(-50%, 10px);
    width: min(400px, 82vw);
    padding: 16px 18px 14px;
    border-radius: 10px;
    background: rgba(10, 12, 16, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(10px);
    color: #e8e4da;
    font-family: ui-sans-serif, "Inter", "Segoe UI", system-ui, sans-serif;
    text-align: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 220ms ease, transform 220ms ease;
}
#pcard.show { opacity: 1; transform: translate(-50%, 0); }
#pcard .p-kind {
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(240, 200, 120, 0.7);
    margin-bottom: 4px;
}
#pcard .p-title {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.02em;
}
#pcard .p-new {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 7px;
    border-radius: 999px;
    background: rgba(240, 200, 120, 0.16);
    color: #f0c878;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    vertical-align: 2px;
}
#pcard .p-period {
    margin-top: 4px;
    font-size: 11px;
    letter-spacing: 0.06em;
    color: rgba(232, 228, 218, 0.55);
}
#pcard .p-desc {
    margin-top: 6px;
    font-size: 12.5px;
    line-height: 1.55;
    color: rgba(232, 228, 218, 0.72);
}
#pcard .p-link {
    margin-top: 10px;
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #f0c878;
}
#pcard .p-link b {
    font-weight: 700;
    border: 1px solid rgba(240, 200, 120, 0.45);
    border-radius: 4px;
    padding: 0 5px 1px;
    margin-right: 2px;
}
#pcard .p-inspect {
    margin-top: 8px;
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(232, 228, 218, 0.55);
}
#pcard .p-inspect b {
    font-weight: 700;
    border: 1px solid rgba(232, 228, 218, 0.28);
    border-radius: 4px;
    padding: 0 5px 1px;
    margin-right: 2px;
    color: rgba(232, 228, 218, 0.85);
}
`;

const KIND_LABEL = {
    project: "project",
    job: "experience",
    school: "education",
};

export class ProjectCard {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.el = document.createElement("div");
        this.el.id = "pcard";
        this.el.innerHTML =
            '<div class="p-kind"></div>' +
            '<div class="p-title"><span class="t"></span><span class="p-new">new</span></div>' +
            '<div class="p-period"></div>' +
            '<div class="p-desc"></div>' +
            '<div class="p-link"><b>E</b> open site</div>' +
            '<div class="p-inspect"><b>I</b> inspect</div>';
        document.body.appendChild(this.el);

        this._kind = this.el.querySelector(".p-kind");
        this._title = this.el.querySelector(".t");
        this._badge = this.el.querySelector(".p-new");
        this._period = this.el.querySelector(".p-period");
        this._desc = this.el.querySelector(".p-desc");
        this._link = this.el.querySelector(".p-link");
        this._inspect = this.el.querySelector(".p-inspect");

        /** @type {object|null} */
        this.active = null;
        this._inspecting = false;
    }

    /**
     * @param {{
     *   title: string,
     *   description: string,
     *   link?: string|null,
     *   isNew?: boolean,
     *   period?: string|null,
     *   kind?: string,
     * }} p
     */
    show(p) {
        if (this.active === p) return;
        this.active = p;
        this._kind.textContent = KIND_LABEL[p.kind] || p.kind || "";
        this._title.textContent = p.title;
        this._desc.textContent = p.description;
        this._badge.style.display = p.isNew ? "" : "none";
        if (p.period) {
            this._period.textContent = p.period;
            this._period.style.display = "";
        } else {
            this._period.style.display = "none";
        }
        this._link.style.display = p.link ? "" : "none";
        this.el.classList.add("show");
        this.setInspecting(this._inspecting);
    }

    /** @param {boolean} on */
    setInspecting(on) {
        this._inspecting = !!on;
        if (!this._inspect) return;
        this._inspect.innerHTML = on
            ? "<b>I</b> exit · mouse orbit · scroll zoom"
            : "<b>I</b> inspect";
    }

    hide() {
        if (!this.active) return;
        this.active = null;
        this._inspecting = false;
        this.el.classList.remove("show");
    }
}
