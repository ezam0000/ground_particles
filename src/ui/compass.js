/** A bearing ring with a circular target marker and readable destination/distance. */
const CSS = `
#compass { position: fixed; top: 18px; right: 20px; z-index: 48; display: flex; align-items: center; gap: 12px; pointer-events: none; color: var(--ui-text); }
#compass .c-disc { position: relative; width: 58px; height: 58px; border-radius: 50%; background: rgba(21,17,13,.85); border: 1px solid var(--ui-border); }
#compass .c-rose { position: absolute; inset: 6px; border: 1px solid rgba(223,186,120,.2); border-radius: 50%; }
#compass .c-north { position: absolute; left: 50%; top: -6px; transform: translateX(-50%); color: var(--ui-muted); background: #211b14; padding: 0 2px; font: 500 10px/1.2 ui-sans-serif,system-ui,sans-serif; }
#compass .c-marker { position: absolute; left: 24px; top: 24px; width: 8px; height: 8px; border-radius: 50%; background: var(--ui-gold); box-shadow: 0 0 8px #e8bc6655; }
#compass .c-label { font: 600 14px/1.4 ui-sans-serif,system-ui,sans-serif; text-shadow: 0 1px 6px #000; }
#compass .c-distance { font: 400 13px/1.5 ui-sans-serif,system-ui,sans-serif; color: var(--ui-muted); text-shadow: 0 1px 6px #000; }
@media(max-width:700px) { #compass { right:12px; top:65px; } }
`;
const RAD2DEG = 180 / Math.PI;
export class Compass {
    constructor() {
        const style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
        this.root = document.createElement("div"); this.root.id = "compass";
        this.root.innerHTML = '<div><div class="c-label"></div><div class="c-distance"></div></div><div class="c-disc" aria-hidden="true"><div class="c-rose"><span class="c-north">N</span></div><span class="c-marker" hidden></span></div>';
        document.body.appendChild(this.root);
        this._rose = this.root.querySelector(".c-rose");
        this._north = this.root.querySelector(".c-north");
        this._marker = this.root.querySelector(".c-marker");
        this._label = this.root.querySelector(".c-label");
        this._distance = this.root.querySelector(".c-distance");
        this._lastLabel = ""; this._lastDistance = ""; this._lastYaw = NaN; this._lastBearing = NaN;
    }
    update(yaw, target, px, pz) {
        const yawDegrees = Math.round(yaw * RAD2DEG * 10) / 10;
        if (yawDegrees !== this._lastYaw) {
            this._lastYaw = yawDegrees;
            this._rose.style.transform = `rotate(${-yawDegrees}deg)`;
            this._north.style.transform = `translateX(-50%) rotate(${yawDegrees}deg)`;
        }
        const available = !!target?.available;
        if (this._marker.hidden === available) this._marker.hidden = !available;
        const label = target?.label || "Explore";
        const distance = available ? Math.round(Math.hypot(target.x - px, target.z - pz)) + " m away" : "Discover at your own pace";
        if (label !== this._lastLabel) { this._label.textContent = label; this._lastLabel = label; }
        if (distance !== this._lastDistance) { this._distance.textContent = distance; this._lastDistance = distance; }
        if (!available) return;
        const bearing = Math.round((Math.atan2(target.x - px, target.z - pz) - yaw) * RAD2DEG * 10) / 10;
        if (bearing !== this._lastBearing) {
            this._lastBearing = bearing;
            this._marker.style.transform = `rotate(${bearing}deg) translateY(-20px)`;
        }
    }
}
