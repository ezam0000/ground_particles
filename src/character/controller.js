/**
 * Character locomotion.
 *
 * This owns motion only — the visual rig, cloth and footprints read the state
 * this produces. One mode, plus air:
 *
 *  - WALK: camera-relative desired velocity, eased facing, distance-driven gait
 *    phase so footfalls land where the feet actually are (no sliding).
 *  - AIR: a Space impulse, gravity, and a landing that the contact system can
 *    hear about. While airborne the ground snap is skipped — the terrain keeps
 *    being sampled so the landing point is known the whole way down.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { input } from "../core/input.js";
import { expDamp } from "../core/camera.js";

const _wish = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();

const WALK_SPEED = 2.5;
const RUN_SPEED = 5.4;
const WALK_ACCEL = 26;
const WALK_DECEL = 30;

/** Space impulse, metres/second. With GRAVITY this apexes around 0.75 m. */
const JUMP_SPEED = 4.6;
const GRAVITY = 14;

/** Gait: metres of travel per full stride cycle, scaled by speed. */
const STRIDE_BASE = 1.55;

export class CharacterController {
    /**
     * @param {{ heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:Vector3):Vector3 }} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        this.position = new Vector3(0, 0, 0);
        this.velocity = new Vector3(0, 0, 0);
        this.prevVelocity = new Vector3(0, 0, 0);
        this.acceleration = new Vector3(0, 0, 0);

        this.facing = 0; // yaw, radians
        this.speed = 0;
        this.speed01 = 0; // normalised against RUN_SPEED, for FOV

        /** Signed lean, -1..1 (right positive), from lateral acceleration. */
        this.lean = 0;

        // -------------------------------------------------------------- air
        /** Vertical velocity while airborne. Zero on the ground. */
        this.vy = 0;
        this.airborne = false;
        /** Set for exactly one frame on touchdown, with the impact speed. */
        this.landed = false;
        this.fallSpeed = 0;

        // ------------------------------------------------------------- gait
        this.gaitPhase = 0;
        /**
         * True when the legs should be running a gait at all.
         *
         * One flag, read by the figure and by the contact system, because three
         * copies of "is this character walking" is three chances for the feet to
         * disagree with the footprints.
         */
        this.stepping = true;
        /** Set true for exactly one frame when a foot plants. */
        this.footfall = false;
        /** 0 = left foot, 1 = right foot — which foot just planted. */
        this.footIndex = 0;
        /** World position of the foot that just planted. */
        this.footPos = new Vector3();
        /** Impact strength 0..1, scales spray and deformation depth. */
        this.footImpact = 0;

        this.groundY = 0;
        this.groundNormal = new Vector3(0, 1, 0);
    }

    /**
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    update(dt, rig) {
        const h = Math.min(dt, 1 / 30);

        this.prevVelocity.copyFrom(this.velocity);

        rig.getFlatForward(_fwd);
        rig.getFlatRight(_right);
        this._walkStep(h);

        // ---------------------------------------------------- integrate + snap
        this.position.x += this.velocity.x * h;
        this.position.z += this.velocity.z * h;

        this.groundY = this.terrain.heightAt(this.position.x, this.position.z);
        this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);

        this.landed = false;
        if (this.airborne) {
            this.vy -= GRAVITY * h;
            this.position.y += this.vy * h;
            if (this.position.y <= this.groundY) {
                this.fallSpeed = -this.vy;
                this.position.y = this.groundY;
                this.vy = 0;
                this.airborne = false;
                this.landed = true;
                // A fraction of the impact as camera trauma — a landing thump.
                rig.addTrauma(Math.min(0.3, this.fallSpeed * 0.045));
            }
        } else {
            // Snap with a little softness so micro-ripples don't jitter the rig.
            this.position.y = expDamp(this.position.y, this.groundY, 26, h);
            if (input.jumpPressed && !input.inspecting) {
                this.airborne = true;
                this.vy = JUMP_SPEED;
                this.position.y += this.vy * h;
            }
        }

        // --------------------------------------------------------- bookkeeping
        this.speed = Math.hypot(this.velocity.x, this.velocity.z);
        this.speed01 = Scalar.Clamp(this.speed / RUN_SPEED, 0, 1);

        this.acceleration.x = (this.velocity.x - this.prevVelocity.x) / h;
        this.acceleration.z = (this.velocity.z - this.prevVelocity.z) / h;

        // Lateral acceleration → lean. Project accel onto the character's right.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const latAcc = this.acceleration.x * rx + this.acceleration.z * rz;
        const leanWant = Scalar.Clamp(latAcc / 26, -1, 1) * 0.35;
        this.lean = expDamp(this.lean, leanWant, 6.5, h);

        this._gait(h);
    }

    _walkStep(h) {
        if (input.inspecting) {
            // Freeze in place while appreciating a pillar.
            this.velocity.x = 0;
            this.velocity.z = 0;
            return;
        }

        const maxSpeed = input.sprint ? RUN_SPEED : WALK_SPEED;

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );

        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen > 0.001) {
            _wish.x = (_wish.x / wishLen) * maxSpeed;
            _wish.z = (_wish.z / wishLen) * maxSpeed;

            const a = WALK_ACCEL * h;
            this.velocity.x += Scalar.Clamp(_wish.x - this.velocity.x, -a, a);
            this.velocity.z += Scalar.Clamp(_wish.z - this.velocity.z, -a, a);

            // Face the direction of travel, eased.
            const want = Math.atan2(_wish.x, _wish.z);
            this.facing = angleDamp(this.facing, want, 11, h);
        } else {
            const d = WALK_DECEL * h;
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            if (s > 0.0001) {
                const k = Math.max(0, s - d) / s;
                this.velocity.x *= k;
                this.velocity.z *= k;
            }
        }
    }

    /**
     * Distance-driven gait. Phase advances with ground travelled, not with time,
     * which is what keeps feet planted instead of sliding.
     */
    _gait(h) {
        this.footfall = false;

        // Airborne legs dangle; they do not run a gait and they do not plant.
        this.stepping = !this.airborne && this.speed <= RUN_SPEED * 1.2;
        if (!this.stepping) {
            this.gaitPhase = 0;
            return;
        }

        const dist = this.speed * h;
        const stride = STRIDE_BASE * (0.72 + 0.28 * Math.min(1, this.speed / RUN_SPEED));
        const prev = this.gaitPhase;
        this.gaitPhase = (this.gaitPhase + dist / stride) % 1;

        if (this.speed < 0.15) return;

        // Two plants per cycle, at phase 0.0 and 0.5.
        const crossed =
            (prev < 0.5 && this.gaitPhase >= 0.5) || this.gaitPhase < prev;
        if (!crossed) return;

        this.footfall = true;
        this.footIndex = this.gaitPhase < 0.5 ? 0 : 1;
        this.footImpact = Scalar.Clamp(0.35 + this.speed / RUN_SPEED, 0, 1.3);

        // Offset the plant to the correct side of the body.
        const side = this.footIndex === 0 ? -0.17 : 0.17;
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        this.footPos.set(
            this.position.x + rx * side,
            this.position.y,
            this.position.z + rz * side
        );
    }
}

// ------------------------------------------------------------------ helpers

/** Shortest signed delta from a to b, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/** Framerate-independent easing across the shortest arc. */
export function angleDamp(cur, target, rate, dt) {
    return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}
