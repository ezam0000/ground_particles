/**
 * Where the character meets the ground.
 *
 * Translates locomotion state into brushes on the terrain state buffer. This is
 * the only thing standing between the physics in `controller.js` and the marks
 * left on the field, and it is deliberately separate from both: the controller
 * should not know a deformation buffer exists, and the buffer should not know
 * what a foot is.
 *
 * Depth / berm / compression / rim / kick scale come from `getLerped()` so sand
 * reads as shallower sharper prints with grit kicks, not sped-up powder snow.
 *
 * Zero allocation: brushes are pushed straight into the field's staging array.
 */

import { getLerped } from "../core/envProfile.js";

/**
 * Boot geometry, metres. `WIDTH` is the short-axis radius, so the print is
 * 20 cm across and 34 cm long — a boot plus the collapse of the sand around it.
 * Narrower than this and the print is only six texels wide and the rim detail
 * has nowhere to live.
 */
const BOOT_WIDTH = 0.10;
const BOOT_ELONG = 1.7;

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
    }

    /** @param {number} _dt seconds */
    update(_dt) {
        const ch = this.character;
        const f = this.field;
        const env = getLerped();
        this._env = env;

        // Nothing touches the ground while the character is above it.
        // Foot-only stamps (no continuous pelvis drag — that read as skating).
        if (ch.airborne) return;

        // Touchdowns — the figure fires one for each foot as it plants, and the
        // first plant after a jump is a landing by construction (see
        // `Figure._updateFeet`), so the fall speed folds in here.
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
                1.6,
                0.4 + ch.speed / 5.4 + (ch.landed ? ch.fallSpeed * 0.18 : 0)
            );
            const cs = env.contactScale;
            const bs = env.bermScale;
            f.brush(
                px, pz,
                BOOT_WIDTH,
                (0.20 + 0.16 * impact) * cs,
                (0.12 + 0.09 * impact) * cs * bs,
                Math.min(1, 0.95 * env.compressionScale),
                0,
                ch.facing,
                BOOT_ELONG,
                env.rimRoughness
            );

            const py = fig ? fig.plant[i * 3 + 1] : ch.position.y;
            this._kick(px, py, pz, impact);
        }
    }

    /**
     * Grains thrown by a boot landing. Sand scales count and loft down so kicks
     * read as grit, not powder puffs.
     */
    _kick(x, y, z, impact) {
        const sp = this.spray;
        if (!sp) return;
        const ch = this.character;
        // A landing throws grit even from a standing jump (no horizontal speed).
        if (ch.speed < 0.4 && !ch.landed) return;

        const kick = this._env ? this._env.sprayKickScale : 1;
        if (kick < 0.05) return;

        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        const n = Math.max(1, ((6 + impact * 14) * kick) | 0);

        for (let k = 0; k < n; k++) {
            const spread = 0.9;
            const rx = (Math.random() - 0.5) * spread;
            const rz = (Math.random() - 0.5) * spread;
            // Sand loft is lower; snow keeps the full scoop.
            const up = (0.9 + Math.random() * 1.9) * (0.45 + 0.55 * kick);
            const back = 0.5 + Math.random() * 1.6 * impact;
            const clod = Math.random() < 0.22 ? 1 : 0;

            sp.emit(
                x + rx * 0.09, y + 0.03 + Math.random() * 0.05, z + rz * 0.09,
                -fx * back + rx * 1.3 + ch.velocity.x * 0.25,
                up * (clod ? 1.25 : 1.0),
                -fz * back + rz * 1.3 + ch.velocity.z * 0.25,
                clod ? 0.014 + Math.random() * 0.012 : 0.020 + Math.random() * 0.030,
                clod ? 0.55 + Math.random() * 0.35 : 0.55 + Math.random() * 0.60,
                clod
            );
        }
    }
}
