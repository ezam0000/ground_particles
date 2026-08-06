/**
 * Timed VO captions — large cinematic lines with speaker portraits.
 * Antinous’s “beggar” line uses a featured terracotta frame.
 */

const CSS = `
#subs {
    position: fixed;
    left: 50%;
    bottom: 18vh;
    z-index: 52;
    transform: translateX(-50%) translateY(12px);
    max-width: min(960px, 94vw);
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition:
        opacity 280ms ease,
        visibility 280ms ease,
        transform 340ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
#subs.show {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0);
}
#subs .subs-frame {
    display: flex;
    align-items: center;
    gap: clamp(12px, 1.8vw, 22px);
    padding: 10px 18px 10px 10px;
    border-radius: 6px;
    background: linear-gradient(
        90deg,
        rgba(8, 6, 4, 0.55) 0%,
        rgba(8, 6, 4, 0.28) 55%,
        rgba(8, 6, 4, 0.08) 100%
    );
    border: 1px solid rgba(255, 236, 210, 0.14);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
#subs .subs-face {
    flex: 0 0 auto;
    width: clamp(56px, 7.5vw, 80px);
    height: clamp(56px, 7.5vw, 80px);
    border-radius: 50%;
    overflow: hidden;
    object-fit: cover;
    object-position: center;
    border: none;
    box-shadow: none;
    background: transparent;
}
#subs .subs-text {
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
    font: 600 clamp(22px, 3.2vw, 40px)/1.35 "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    letter-spacing: 0.03em;
    color: rgba(255, 246, 230, 0.96);
    text-shadow:
        0 0 2px rgba(0, 0, 0, 0.95),
        0 2px 4px rgba(0, 0, 0, 0.9),
        0 4px 18px rgba(0, 0, 0, 0.75),
        0 0 40px rgba(0, 0, 0, 0.45);
}
#subs .subs-text .accent {
    color: inherit;
    font-style: italic;
}

/* Star line — Antinous “beggar” */
#subs.featured .subs-frame {
    padding: 14px 22px 14px 12px;
    border-radius: 8px;
    background: linear-gradient(
        105deg,
        rgba(48, 18, 12, 0.78) 0%,
        rgba(28, 12, 8, 0.55) 40%,
        rgba(12, 8, 6, 0.22) 100%
    );
    border: 1.5px solid rgba(196, 92, 54, 0.72);
    box-shadow:
        0 0 0 1px rgba(255, 196, 140, 0.12),
        0 10px 36px rgba(80, 20, 8, 0.45),
        inset 0 1px 0 rgba(255, 210, 170, 0.12);
}
#subs.featured .subs-face {
    width: clamp(72px, 9.5vw, 100px);
    height: clamp(72px, 9.5vw, 100px);
    border: none;
    box-shadow: none;
}
#subs.featured .subs-text {
    font-size: clamp(24px, 3.6vw, 44px);
    color: rgba(255, 228, 200, 0.98);
    letter-spacing: 0.04em;
}
#subs.featured .subs-text .accent {
    color: #e87848;
    font-style: italic;
    font-weight: 700;
    text-shadow:
        0 0 2px rgba(0, 0, 0, 0.95),
        0 0 18px rgba(200, 70, 30, 0.45),
        0 2px 6px rgba(0, 0, 0, 0.85);
}
`;

/**
 * @typedef {{ portrait?: string, featured?: boolean, accentWord?: string }} SubtitleOpts
 */

export class Subtitles {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.el = document.createElement("div");
        this.el.id = "subs";
        this.el.setAttribute("aria-live", "polite");

        this._frame = document.createElement("div");
        this._frame.className = "subs-frame";

        this._face = document.createElement("img");
        this._face.className = "subs-face";
        this._face.alt = "";
        this._face.decoding = "async";

        this._text = document.createElement("div");
        this._text.className = "subs-text";

        this._frame.appendChild(this._face);
        this._frame.appendChild(this._text);
        this.el.appendChild(this._frame);
        document.body.appendChild(this.el);

        this._hideAt = 0;
        this._token = 0;
    }

    /**
     * @param {string} text
     * @param {number} durationSec
     * @param {SubtitleOpts} [opts]
     */
    show(text, durationSec, opts = {}) {
        if (!text) return;
        const token = ++this._token;
        const portrait = opts.portrait || "";
        const featured = !!opts.featured;

        this.el.classList.toggle("featured", featured);
        if (portrait) {
            this._face.hidden = false;
            if (this._face.getAttribute("src") !== portrait) this._face.src = portrait;
        } else {
            this._face.hidden = true;
            this._face.removeAttribute("src");
        }

        this._text.textContent = "";
        const accent = opts.accentWord;
        if (accent && text.includes(accent)) {
            const i = text.indexOf(accent);
            this._text.appendChild(document.createTextNode(text.slice(0, i)));
            const em = document.createElement("span");
            em.className = "accent";
            em.textContent = accent;
            this._text.appendChild(em);
            this._text.appendChild(document.createTextNode(text.slice(i + accent.length)));
        } else {
            this._text.textContent = text;
        }

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
        this.el.classList.remove("featured");
    }
}
