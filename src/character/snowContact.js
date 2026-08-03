/**
 * Where the character meets the ground.
 *
 * Boots stay visually above the sand mesh (avatar clearance). This module only
 * sells contact: elongated sole brushes + surface grit that moves with each step.
 */

import { getLerped } from "../core/envProfile.js";

/** Short-axis radius (m). Elongation stretches along facing → sole scrape. */
const BOOT_WIDTH = 0.085;
const BOOT_ELONG = 2.45;
/** Light continuous scrape under the stance while moving (m of travel). */
const SCRAPE_EVERY = 0.11;

export class SnowContact {
    /**
     * @param {import("./controller.js").CharacterController} character
     * @param {import("../terrain/deformation.js").DeformationField} field
     * @param {import("./figure.js").Figure} [figure] posed skeleton, if built
     * @param {import("../vfx/particles.js").SprayField} [spray]
     */
    constructor(character, field, figure, spray) {
        this.character = character;
        this.field = field;
        this.spray = spray || null;
        this.figure = figure || null;

        /** @type {ReturnType<typeof getLerped>|null} */
        this._env = null;
        this._scrape = 0;
        this._prevX = character.position.x;
        this._prevZ = character.position.z;
    }

    /** @param {number} _dt seconds */
    update(_dt) {
        const ch = this.character;
        const f = this.field;
        const env = getLerped();
        this._env = env;

        if (ch.airborne || ch.locked) {
            this._prevX = ch.position.x;
            this._prevZ = ch.position.z;
            return;
        }

        const dx = ch.position.x - this._prevX;
        const dz = ch.position.z - this._prevZ;
        const moved = Math.hypot(dx, dz);
        this._prevX = ch.position.x;
        this._prevZ = ch.position.z;

        // Discrete sole plant — deeper scrape + grit burst.
        const fig = this.figure;
        for (let i = 0; i < 2; i++) {
            let px, pz;
            if (fig) {
                if (!fig.touchdown[i] || !ch.stepping) continue;
                px = fig.plant[i * 3];
                pz = fig.plant[i * 3 + 2];
            } else {
                if (!ch.footfall || i !== ch.footIndex) continue;
                px = ch.footPos.x;
                pz = ch.footPos.z;
            }

            const impact = Math.min(
                1.2,
                0.3 + ch.speed / 6 + (ch.landed ? ch.fallSpeed * 0.14 : 0)
            );
            const cs = env.contactScale;
            const bs = env.bermScale;
            f.brush(
                px, pz,
                BOOT_WIDTH,
                (0.10 + 0.08 * impact) * cs,
                (0.07 + 0.05 * impact) * cs * bs,
                Math.min(1, 0.6 * env.compressionScale),
                0,
                ch.facing,
                BOOT_ELONG,
                env.rimRoughness
            );
            this._stepGrit(px, ch.position.y, pz, impact);
        }

        // Soft trail between plants — sand shifting under the stance.
        if (ch.speed > 0.35 && moved > 1e-4) {
            this._scrape += moved;
            if (this._scrape >= SCRAPE_EVERY) {
                this._scrape = 0;
                const k = Math.min(moved, 0.2);
                const cs = env.contactScale;
                const bs = env.bermScale;
                f.brush(
                    ch.position.x, ch.position.z,
                    BOOT_WIDTH * 0.85,
                    0.045 * k * cs,
                    0.055 * k * cs * bs,
                    Math.min(1, 0.4 * k * env.compressionScale),
                    0,
                    ch.facing,
                    BOOT_ELONG * 1.15,
                    0.9 * env.rimRoughness
                );
            }
        }
    }

    /**
     * Surface grit that kicks sideways/back with the step — sells sand moving,
     * not a foot buried in the mesh.
     */
    _stepGrit(x, y, z, impact) {
        const sp = this.spray;
        if (!sp) return;
        const ch = this.character;
        const kick = this._env ? this._env.sprayKickScale : 1;
        if (kick < 0.05) return;

        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        const n = Math.max(5, ((12 + impact * 16) * kick) | 0);

        for (let k = 0; k < n; k++) {
            const side = (Math.random() - 0.5) * 1.2;
            const rx = -fz * side + (Math.random() - 0.5) * 0.35;
            const rz = fx * side + (Math.random() - 0.5) * 0.35;
            // Spawn on the surface, push mostly horizontal with a little loft.
            const up = (0.2 + Math.random() * 0.7) * (0.6 + 0.4 * kick);
            const push = 0.6 + Math.random() * 1.4 * impact;
            sp.emit(
                x + rx * 0.06, y + 0.02 + Math.random() * 0.03, z + rz * 0.06,
                -fx * push * 0.35 + rx * push + ch.velocity.x * 0.3,
                up,
                -fz * push * 0.35 + rz * push + ch.velocity.z * 0.3,
                0.014 + Math.random() * 0.02,
                0.35 + Math.random() * 0.5,
                Math.random() < 0.15 ? 1 : 0
            );
        }
    }
}
