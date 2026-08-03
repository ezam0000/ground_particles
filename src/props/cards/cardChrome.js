/**
 * Shared collectible-card chrome — parchment lore back styling.
 */

export const LORE_CSS = `
.odyssey-lore {
    box-sizing: border-box;
    position: relative;
    width: 100%;
    height: 100%;
    padding: 28px 24px 24px;
    overflow: auto;
    color: #2a1c12;
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    background:
        radial-gradient(120% 90% at 50% 8%, rgba(255, 250, 235, 0.55), transparent 55%),
        radial-gradient(80% 60% at 100% 100%, rgba(120, 70, 30, 0.14), transparent 50%),
        radial-gradient(70% 50% at 0% 90%, rgba(90, 50, 20, 0.12), transparent 45%),
        linear-gradient(165deg, #f3e6c8 0%, #e8d4a8 42%, #dcc49a 100%);
    box-shadow: inset 0 0 0 1px rgba(90, 55, 25, 0.28);
}
.odyssey-lore::before {
    content: "";
    position: absolute;
    inset: 10px;
    border: 1px solid rgba(90, 55, 25, 0.22);
    border-radius: 2px;
    pointer-events: none;
    box-shadow: inset 0 0 40px rgba(80, 45, 15, 0.08);
}
.odyssey-lore::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0.35;
    background:
        repeating-linear-gradient(
            0deg,
            transparent,
            transparent 2px,
            rgba(90, 55, 25, 0.03) 2px,
            rgba(90, 55, 25, 0.03) 3px
        );
    mix-blend-mode: multiply;
}
.odyssey-lore > * {
    position: relative;
    z-index: 1;
}
.odyssey-lore .ol-eyebrow {
    margin: 0 0 12px;
    font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.28em;
    text-transform: uppercase;
    color: rgba(110, 70, 30, 0.7);
}
.odyssey-lore h2 {
    margin: 0;
    max-width: 100%;
    font-size: clamp(22px, 4.4vw, 32px);
    font-weight: 700;
    letter-spacing: 0.035em;
    text-transform: uppercase;
    line-height: 1.12;
    color: #1a1008;
    text-shadow: 0 1px 0 rgba(255, 248, 230, 0.55);
    overflow-wrap: anywhere;
}
.odyssey-lore h2.ol-long {
    font-size: clamp(18px, 3.6vw, 26px);
    letter-spacing: 0.02em;
}
.odyssey-lore .ol-rule {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 16px 0 18px;
}
.odyssey-lore .ol-rule::before,
.odyssey-lore .ol-rule::after {
    content: "";
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(90, 55, 25, 0.45), transparent);
}
.odyssey-lore .ol-rule span {
    font-size: 13px;
    color: rgba(110, 70, 30, 0.75);
    letter-spacing: 0.12em;
}
.odyssey-lore .ol-lead {
    margin: 0 0 16px;
    font-size: 17px;
    line-height: 1.5;
    font-style: italic;
    color: #3a2414;
}
.odyssey-lore .ol-body {
    margin: 0;
    font-size: 15.5px;
    line-height: 1.65;
    color: rgba(42, 28, 18, 0.9);
}
`;

/**
 * Build lore inner HTML for a card.
 * @param {{ title: string, lore: string }} card
 */
export function loreHtml(card) {
    const parts = String(card.lore || "").split(/\n\n+/);
    const body = parts.slice(1).join("\n\n");
    return (
        '<div class="ol-eyebrow">The Odyssey · Collectible</div>' +
        "<h2></h2>" +
        '<div class="ol-rule" aria-hidden="true"><span>✦</span></div>' +
        '<p class="ol-lead"></p>' +
        (body ? '<p class="ol-body"></p>' : "")
    );
}

/**
 * Fill a lore root that already has loreHtml structure.
 * @param {HTMLElement} root
 * @param {{ title: string, lore: string }} card
 */
export function fillLore(root, card) {
    const parts = String(card.lore || "").split(/\n\n+/);
    const h2 = root.querySelector("h2");
    const lead = root.querySelector(".ol-lead");
    const body = root.querySelector(".ol-body");
    if (h2) {
        h2.textContent = card.title;
        // Long all-caps titles (e.g. Laestrygonians) need a tighter face.
        h2.classList.toggle("ol-long", String(card.title || "").length > 11);
    }
    if (lead) lead.textContent = parts[0] || "";
    if (body) body.textContent = parts.slice(1).join("\n\n");
}
