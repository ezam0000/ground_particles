/**
 * Character locomotion.
 *
 * This owns motion only — the visual rig, cloth and footprints read the state
 * this produces. One mode, plus air:
 *
 *  - WALK: camera-relative wish on the ground plane, asymmetric accel/decel,
 *    slope traction, eased facing, distance-driven gait phase.
 *  - AIR: Space impulse (coyote + buffer), gravity, light air control, soft land.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { input } from "../core/input.js";
import { expDamp } from "../core/camera.js";

const _wish = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _tangent = new Vector3();

const WALK_SPEED = 2.5;
const RUN_SPEED = 5.4;

/** Ground accel toward wish (m/s²). Walk starts heavier than it stops. */
const WALK_ACCEL = 14;
const RUN_ACCEL = 11;
/** Decel when releasing input — snappier than start. */
const GROUND_DECEL = 22;
/** Air wish influence as a fraction of ground accel. */
const AIR_CONTROL = 0.28;

/** Space impulse, metres/second. With GRAVITY this apexes around 0.75 m. */
const JUMP_SPEED = 4.6;
const GRAVITY = 14;
/** Jump still allowed this long after leaving ground. */
const COYOTE_TIME = 0.1;
/** Jump press remembered this long before landing. */
const JUMP_BUFFER = 0.1;

/** Along-slope gravity when grounded (m/s²), scaled by slope steepness. */
const SLOPE_PULL = 6.5;
/** Uphill speed factor at a 30° slope (1 = flat). */
const UPHILL_DRAG = 0.55;

/** Visual sink into recent foot trenches (metres), no GPU readback. */
const SINK_MAX = 0.045;
const SINK_PER_STEP = 0.018;
const SINK_DECAY = 4.5;

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
        /** Seconds since last grounded; coyote while < COYOTE_TIME. */
        this._coyote = 0;
        /** Seconds remaining on a buffered jump press. */
        this._jumpBuf = 0;

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
        /** Soft visual offset into foot trenches (subtracted from snap Y). */
        this.sink = 0;
        /** Temporary ground-snap rate after landing; 0 = default. */
        this._landSnapRate = 0;
        /**
         * Hit / emote lock — no wish, jump, or gait. Knockback velocity still
         * integrates until it decays.
         */
        this.locked = false;
        /** Horizontal knockback decay rate (1/s) while locked from a hit. */
        this._hitDecay = 0;
    }

    /**
     * Giant (or other) impact: lock locomotion and shove away from (ax, az).
     * @param {number} ax
     * @param {number} az
     * @param {number} [impulse=4.8]
     */
    applyHit(ax, az, impulse = 4.8) {
        this.locked = true;
        this.airborne = false;
        this.vy = 0;
        this._jumpBuf = 0;
        this._coyote = 0;
        this.sink = 0;
        this.stepping = false;
        this.footfall = false;
        let dx = this.position.x - ax;
        let dz = this.position.z - az;
        const d = Math.hypot(dx, dz);
        if (d < 1e-4) {
            dx = Math.sin(this.facing);
            dz = Math.cos(this.facing);
        } else {
            dx /= d;
            dz /= d;
        }
        this.velocity.x = dx * impulse;
        this.velocity.z = dz * impulse;
        this._hitDecay = 3.2;
        // Keep current facing — snapping toward the attacker fought the fall
        // clip's authored orientation and made get-up look like an angle shift.
    }

    /**
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    update(dt, rig) {
        const h = Math.min(dt, 1 / 30);

        this.prevVelocity.copyFrom(this.velocity);

        if (input.jumpPressed && !input.inspecting && !this.locked) {
            this._jumpBuf = JUMP_BUFFER;
        } else if (this._jumpBuf > 0) {
            this._jumpBuf = Math.max(0, this._jumpBuf - h);
        }

        rig.getFlatForward(_fwd);
        rig.getFlatRight(_right);

        this.groundY = this.terrain.heightAt(this.position.x, this.position.z);
        this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);

        this._walkStep(h);

        // ---------------------------------------------------- integrate + snap
        this.position.x += this.velocity.x * h;
        this.position.z += this.velocity.z * h;

        this.groundY = this.terrain.heightAt(this.position.x, this.position.z);
        this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);

        this.landed = false;
        if (this.airborne) {
            this._coyote = Math.max(0, this._coyote - h);
            this.vy -= GRAVITY * h;
            this.position.y += this.vy * h;
            if (this.position.y <= this.groundY - this.sink) {
                this.fallSpeed = -this.vy;
                this.position.y = this.groundY - this.sink;
                this.vy = 0;
                this.airborne = false;
                this.landed = true;
                this._coyote = COYOTE_TIME;
                // Soft land snap rate scales with impact — light hops settle gently.
                const landRate = 18 + Math.min(14, this.fallSpeed * 2.5);
                this._landSnapRate = landRate;
                rig.addTrauma(Math.min(0.3, this.fallSpeed * 0.045));
                this._tryJump(h);
            }
        } else {
            this._coyote = COYOTE_TIME;
            this.sink = Math.max(0, this.sink - SINK_DECAY * h * this.sink);
            const snapY = this.groundY - this.sink;
            const snapRate = this._landSnapRate || 22;
            this.position.y = expDamp(this.position.y, snapY, snapRate, h);
            if (Math.abs(this.position.y - snapY) < 0.002) this._landSnapRate = 0;
            this._tryJump(h);
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
        const leanWant = Scalar.Clamp(latAcc / 18, -1, 1) * 0.38;
        this.lean = expDamp(this.lean, leanWant, 5.5, h);

        this._gait(h);
    }

    /** Consume buffered jump if coyote / grounded allows. */
    _tryJump(h) {
        if (this._jumpBuf <= 0 || input.inspecting || this.locked) return;
        if (this.airborne && this._coyote <= 0) return;
        this._jumpBuf = 0;
        this._coyote = 0;
        this.airborne = true;
        this.vy = JUMP_SPEED;
        this.sink = 0;
        this.position.y += this.vy * h;
    }

    _walkStep(h) {
        if (input.inspecting || this.locked) {
            // Ease to a stop (inspect) or decay knockback (hit lock).
            const rate = this.locked && this._hitDecay > 0
                ? this._hitDecay
                : GROUND_DECEL * 1.4;
            if (this.locked && this._hitDecay > 0) {
                const k = Math.exp(-rate * h);
                this.velocity.x *= k;
                this.velocity.z *= k;
                if (Math.hypot(this.velocity.x, this.velocity.z) < 0.05) {
                    this.velocity.x = 0;
                    this.velocity.z = 0;
                    this._hitDecay = 0;
                }
            } else {
                const d = rate * h;
                const s = Math.hypot(this.velocity.x, this.velocity.z);
                if (s > 0.0001) {
                    const k = Math.max(0, s - d) / s;
                    this.velocity.x *= k;
                    this.velocity.z *= k;
                } else {
                    this.velocity.x = 0;
                    this.velocity.z = 0;
                }
            }
            return;
        }

        const sprint = input.sprint;
        const maxSpeed = sprint ? RUN_SPEED : WALK_SPEED;
        const accel = (sprint ? RUN_ACCEL : WALK_ACCEL) * (this.airborne ? AIR_CONTROL : 1);

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );

        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen > 0.001) {
            // Project wish onto the ground plane so slopes aren't flat-XZ slides.
            const nx = this.groundNormal.x;
            const ny = this.groundNormal.y;
            const nz = this.groundNormal.z;
            const wdx = _wish.x / wishLen;
            const wdz = _wish.z / wishLen;
            // Remove normal component of (wdx, 0, wdz).
            const ndot = wdx * nx + wdz * nz;
            _tangent.set(wdx - nx * ndot, -ny * ndot, wdz - nz * ndot);
            const tLen = Math.hypot(_tangent.x, _tangent.z);
            if (tLen > 1e-5) {
                _wish.x = (_tangent.x / tLen) * maxSpeed;
                _wish.z = (_tangent.z / tLen) * maxSpeed;
            } else {
                _wish.x = wdx * maxSpeed;
                _wish.z = wdz * maxSpeed;
            }

            // Uphill drag: moving against the slope normal's horizontal.
            if (!this.airborne) {
                const uphill = -(_wish.x * nx + _wish.z * nz);
                if (uphill > 0.05) {
                    const steep = Scalar.Clamp(1 - ny, 0, 0.5) * 2;
                    const drag = 1 - steep * (1 - UPHILL_DRAG);
                    _wish.x *= drag;
                    _wish.z *= drag;
                }
            }

            const a = accel * h;
            this.velocity.x += Scalar.Clamp(_wish.x - this.velocity.x, -a, a);
            this.velocity.z += Scalar.Clamp(_wish.z - this.velocity.z, -a, a);

            const want = Math.atan2(_wish.x, _wish.z);
            this.facing = angleDamp(this.facing, want, 10, h);
        } else if (!this.airborne) {
            const d = GROUND_DECEL * h;
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            if (s > 0.0001) {
                const k = Math.max(0, s - d) / s;
                this.velocity.x *= k;
                this.velocity.z *= k;
            } else {
                this.velocity.x = 0;
                this.velocity.z = 0;
            }
        }

        // Downhill pull along the slope when grounded.
        if (!this.airborne) {
            const ny = this.groundNormal.y;
            if (ny < 0.995) {
                const pull = SLOPE_PULL * (1 - ny) * h;
                this.velocity.x += this.groundNormal.x * pull;
                this.velocity.z += this.groundNormal.z * pull;
                // Cap after pull so we don't runaway on steep faces.
                const s = Math.hypot(this.velocity.x, this.velocity.z);
                const cap = RUN_SPEED * 1.15;
                if (s > cap) {
                    this.velocity.x *= cap / s;
                    this.velocity.z *= cap / s;
                }
            }
        }
    }

    /**
     * Distance-driven gait. Phase advances with ground travelled, not with time,
     * which is what keeps feet planted instead of sliding.
     */
    _gait(h) {
        this.footfall = false;

        // Airborne / locked legs do not run a gait and they do not plant.
        this.stepping = !this.locked && !this.airborne && this.speed <= RUN_SPEED * 1.2;
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
        this.sink = Math.min(SINK_MAX, this.sink + SINK_PER_STEP * this.footImpact);

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
