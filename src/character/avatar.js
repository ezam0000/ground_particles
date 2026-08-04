/**
 * Player avatar — crushed skinned `main_man.glb`.
 *
 * Same render path as the giant: Babylon CPU-skins the mesh so prop beauty /
 * static depth / prepass stay rigid. The controller owns locomotion; this
 * module poses the root and swaps Alert / Walking / Running clips.
 */

import "@babylonjs/loaders/glTF";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4, Color3, Quaternion } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { bindMatrixArray, whenReady } from "../core/gpuUtil.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { input } from "../core/input.js";

const MODEL = "/assets/character/main_man.glb";
/** Match authored mesh (~1.82 m). */
const TARGET_HEIGHT = 1.82;
/** Sprint / high-speed threshold for the Running clip. */
const RUN_CLIP_SPEED = 3.6;
/** Below this ground speed we treat the avatar as idle (Alert). */
const IDLE_SPEED = 0.28;
/** Wait this long after stopping before playing Alert. */
const IDLE_DELAY = 0.25;
/** Crossfade duration when swapping locomotion clips. */
const BLEND_DUR = 0.16;
/**
 * Lift the skinned root so animated soles stay above the sand mesh.
 * Walk/run clips plant a few cm below the root origin otherwise.
 */
const FOOT_CLEARANCE = 0.07;
/** Arrow release into Archery_Shot (seconds). */
const RELEASE_T = 0.28;

const _aimDir = new Vector3();

const _splits = new Vector4();
const _fill = new Color3(0.55, 0.48, 0.38);
const _min = new Vector3();
const _max = new Vector3();
const _normal = new Vector3();
const _yawQ = new Quaternion();
const _tiltQ = new Quaternion();
const _orient = new Quaternion();
const _hipsA = new Quaternion();
const _hipsB = new Quaternion();
const _keyPos = new Float32Array(24);
const _keyCol = new Float32Array(24);

export class PlayerAvatar {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../render/depthPass.js").DepthPass} depthPass
     * @param {import("../spells/spellLights.js").SpellLights} lights
     * @param {import("./controller.js").CharacterController} controller
     */
    constructor(scene, terrain, sky, shadows, depthPass, lights, controller) {
        this.scene = scene;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;
        this.depthPass = depthPass;
        this.lights = lights;
        this.controller = controller;

        this._mats = [];
        this._mesh = null;
        this._root = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._walk = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._run = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._idle = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._fall = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._getUp = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup[]} */
        this._emotes = [];
        this._emoteI = 0;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._draw = null;
        this._drawT = 0;
        this._shotFired = false;
        /** @type {import("../combat/bow.js").Bow|null} */
        this.bow = null;
        /** False until Eumaeus gifts the bow (lost again on Zeus soft death). */
        this.hasBow = false;
        /** @type {(() => Vector3)|null} look-dir provider from camera (crosshair) */
        this.getAimDir = null;
        /** @type {(() => Vector3)|null} camera world position for muzzle→ray aim */
        this.getCameraPos = null;
        /** @type {((aimDir: Vector3) => void)|null} fired after each released shot */
        this.onShot = null;
        this._active = null;
        /** Clip fading out during a crossfade (null when idle). */
        this._fadeOut = null;
        this._blendT = 1;
        /**
         * 'hit' | 'emote' | 'draw' | null — locomotion sync is suspended while set.
         * Hit cannot be cancelled; emote cancels on move/jump.
         */
        this._busy = null;
        this._visible = true;
        /** Seconds spent below IDLE_SPEED on the ground. */
        this._stillT = 0;
        /** Last gait phase written into a locomotion clip (for sync). */
        this._syncedPhase = -1;

        this._depthMats = [0, 1].map((c) => this._makeDepthMaterial(c));
        this._prepassMat = this._makePrepassMaterial();

        this._ready = this._load();
    }

    async _load() {
        const result = await SceneLoader.ImportMeshAsync("", "", MODEL, this.scene);
        const root = result.meshes[0];
        root.name = "avatarRoot";

        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh|null} */
        let body = null;
        for (const m of result.meshes) {
            if (m === root) continue;
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
                body = /** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (m);
                break;
            }
        }
        if (!body) throw new Error("main_man.glb: no skinned mesh");

        body.computeBonesUsingShaders = false;

        this._bindPropMaterial(body);
        body.renderingGroupId = 1;
        body.isPickable = false;
        body.receiveShadows = true;
        this.shadows.registerCaster(body, (c) => this._depthMats[c], 2);
        this.depthPass.registerCaster(body, this._prepassMat);

        root.computeWorldMatrix(true);
        body.computeWorldMatrix(true);
        const bi = body.getBoundingInfo();
        _min.copyFrom(bi.boundingBox.minimumWorld);
        _max.copyFrom(bi.boundingBox.maximumWorld);
        const h = Math.max(0.01, _max.y - _min.y);
        root.scaling.setAll(TARGET_HEIGHT / h);

        this._root = root;
        this._mesh = body;
        this._placeRoot();

        const groups = result.animationGroups || [];
        for (const g of groups) g.stop();
        this._walk = groups.find((g) => /walk/i.test(g.name)) || null;
        this._run = groups.find((g) => /run/i.test(g.name)) || null;
        this._idle =
            groups.find((g) => /alert|idle|rest/i.test(g.name)) || null;
        this._fall =
            groups.find((g) => /falling_down/i.test(g.name)) ||
            groups.find((g) => /fall/i.test(g.name) && !/standup|stand_up|get.?up/i.test(g.name)) ||
            null;
        this._getUp =
            groups.find((g) => /stand_up|standup|get.?up/i.test(g.name)) || null;
        this._emotes = groups.filter((g) =>
            /gangnam|emote|groove/i.test(g.name)
        );
        this._draw =
            groups.find((g) => /archery_shot|archery shot/i.test(g.name)) ||
            groups.find((g) => /archery/i.test(g.name)) ||
            null;
        if (!this._walk && groups[0]) this._walk = groups[0];

        // Fall/get-up clips ship with Hips XZ root motion; pin to idle rest so
        // the mesh doesn't teleport when chaining fall → stand-up.
        // Archery_Shot has a small XZ drift — pin the same way.
        const rest = this._hipsRestXZ(this._idle || this._walk);
        if (rest) {
            if (this._fall) this._pinHipsXZ(this._fall, rest.x, rest.z);
            if (this._getUp) this._pinHipsXZ(this._getUp, rest.x, rest.z);
            if (this._draw) this._pinHipsXZ(this._draw, rest.x, rest.z);
        }

        // Initial state: alert at rest (basic game design).
        const start = this._idle || this._walk;
        if (start) {
            start.start(true, 1);
            start.setWeightForAllAnimatables(1);
            this._active = start;
        }

        return root;
    }

    /** Rest Hips XZ from an idle/walk clip (first translation key). */
    _hipsRestXZ(group) {
        if (!group) return null;
        for (const ta of group.targetedAnimations) {
            const target = ta.target;
            const anim = ta.animation;
            if (!target || !anim) continue;
            if (!/hips/i.test(target.name || "")) continue;
            if (anim.targetProperty !== "position") continue;
            const keys = anim.getKeys();
            if (!keys.length) continue;
            const v = keys[0].value;
            return { x: v.x, z: v.z };
        }
        return null;
    }

    /**
     * Zero Hips XZ root motion in a clip (keep Y). Prevents fall→get-up teleports.
     * @param {import("@babylonjs/core/Animations/animationGroup").AnimationGroup} group
     * @param {number} x
     * @param {number} z
     */
    _pinHipsXZ(group, x, z) {
        for (const ta of group.targetedAnimations) {
            const target = ta.target;
            const anim = ta.animation;
            if (!target || !anim) continue;
            if (!/hips/i.test(target.name || "")) continue;
            if (anim.targetProperty !== "position") continue;
            const keys = anim.getKeys();
            for (let i = 0; i < keys.length; i++) {
                keys[i].value.x = x;
                keys[i].value.z = z;
            }
        }
    }

    _placeRoot(dt = 1 / 60) {
        const root = this._root;
        if (!root) return;
        const ch = this.controller;
        const x = ch.position.x;
        const z = ch.position.z;
        Quaternion.RotationAxisToRef(Vector3.UpReadOnly, ch.facing, _yawQ);

        // While knocked down, skip terrain tilt — dune normals twist a prone
        // body and read as the character "shifting angle" mid get-up.
        if (this._busy === "hit") {
            if (!root.rotationQuaternion) root.rotationQuaternion = _yawQ.clone();
            else root.rotationQuaternion.copyFrom(_yawQ);
        } else {
            this.terrain.normalAt(x, z, _normal);
            _normal.x *= 0.55;
            _normal.z *= 0.55;
            const nLen = Math.hypot(_normal.x, _normal.y, _normal.z) || 1;
            _normal.x /= nLen;
            _normal.y /= nLen;
            _normal.z /= nLen;
            Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, _normal, _tiltQ);
            _tiltQ.multiplyToRef(_yawQ, _orient);
            if (!root.rotationQuaternion) root.rotationQuaternion = _orient.clone();
            else {
                const k = 1 - Math.exp(-10 * Math.max(dt, 1 / 120));
                Quaternion.SlerpToRef(root.rotationQuaternion, _orient, k, root.rotationQuaternion);
            }
        }
        // Hit reactions need the body on the sand; locomotion keeps soles clear.
        const yOff = this._busy === "hit" ? 0 : FOOT_CLEARANCE;
        root.position.set(x, ch.position.y + yOff, z);
    }

    _bindPropMaterial(mesh) {
        const old = mesh.material;
        let albedoTex = null;
        if (old) {
            albedoTex =
                old.albedoTexture ||
                old.baseTexture ||
                old.diffuseTexture ||
                old.emissiveTexture ||
                null;
        }
        const mat = this._makePropMaterial("avatar:body", Color3.White(), albedoTex, mesh);
        mesh.material = mat;
    }

    _makePropMaterial(name, albedo, textureOrNull, mesh) {
        const mat = new ShaderMaterial(
            name, this.scene,
            { vertex: "prop", fragment: "prop" },
            {
                attributes: ["position", "normal", "uv"],
                uniforms: [
                    "world", "viewProjection",
                    "cameraPos", "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity", "albedoColor", "useTex", "panelGlow",
                    "fillRadiance", "albedoGain",
                    "keyLightPos", "keyLightCol", "keyLightCount",
                    ...SPELL_LIGHT_UNIFORMS,
                ],
                samplers: ["albedoTex", "skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = true;
        mat.setColor3("albedoColor", albedo);
        mat.setFloat("useTex", textureOrNull ? 1 : 0);
        mat.setFloat("panelGlow", 0.12);
        mat.setFloat("albedoGain", 1.15);
        mat.setColor3("fillRadiance", _fill.clone());
        mat.setFloat("keyLightCount", 0);
        mat.setArray4("keyLightPos", _keyPos);
        mat.setArray4("keyLightCol", _keyCol);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < 3; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        if (!PlayerAvatar._white) {
            PlayerAvatar._white = RawTexture.CreateRGBATexture(
                new Uint8Array([180, 170, 155, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        mat.setTexture("albedoTex", textureOrNull || PlayerAvatar._white);
        if (textureOrNull) {
            textureOrNull.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
            textureOrNull.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        }
        this._mats.push({ mat, mesh });
        return mat;
    }

    _makeDepthMaterial(cascade) {
        return new ShaderMaterial(
            "avatarDepth" + cascade, this.scene,
            { vertex: "staticDepth", fragment: "terrainDepth" },
            {
                attributes: ["position"],
                uniforms: ["world", "lightViewProjection"],
                shaderLanguage: ShaderLanguage.WGSL,
                defines: ["SNOW_CASCADE " + cascade],
            }
        );
    }

    _makePrepassMaterial() {
        return new ShaderMaterial(
            "avatarPrepass", this.scene,
            { vertex: "staticPrepass", fragment: "prepass" },
            {
                attributes: ["position"],
                uniforms: ["world", "viewProjection"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
    }

    /** @param {boolean} v */
    setVisible(v) {
        this._visible = !!v;
        if (this._root) this._root.setEnabled(this._visible);
        if (this._mesh) this._mesh.isVisible = this._visible;
    }

    async warmUp() {
        await this._ready;
        for (const { mat, mesh } of this._mats) {
            await whenReady(mat, mat.name, [mesh, false]);
        }
        if (this._mesh) {
            await whenReady(this._prepassMat, "avatar prepass", [this._mesh, false]);
            for (let i = 0; i < this._depthMats.length; i++) {
                await whenReady(this._depthMats[i], "avatar depth " + i, [this._mesh, false]);
            }
        }
    }

    /** Alert at rest when still; Walking / Running when moving. */
    _syncAnim(dt) {
        if (this._busy) {
            // Advance any leftover crossfade into the busy clip.
            if (this._fadeOut && this._blendT < 1) {
                this._blendT = Math.min(1, this._blendT + dt / BLEND_DUR);
                const t = this._blendT;
                if (this._active) this._active.setWeightForAllAnimatables(t);
                this._fadeOut.setWeightForAllAnimatables(1 - t);
                if (t >= 1) {
                    this._fadeOut.stop();
                    this._fadeOut = null;
                }
            }
            return;
        }

        const ch = this.controller;
        const moving = !ch.airborne && ch.speed > IDLE_SPEED;
        let want = null;
        let speed = 1;

        if (ch.airborne) {
            // Hold the last locomotion pose in the air (brief freeze).
            if (this._active) this._active.speedRatio = 0;
            if (this._fadeOut) {
                this._fadeOut.stop();
                this._fadeOut = null;
                this._blendT = 1;
            }
            this._stillT = 0;
            return;
        }

        if (moving) {
            this._stillT = 0;
            if (ch.speed >= RUN_CLIP_SPEED && this._run) {
                want = this._run;
                // Cadence tracks travel so plants stay under the mesh.
                speed = Math.min(1.4, 0.75 + ch.speed01 * 0.65);
            } else if (this._walk) {
                want = this._walk;
                speed = Math.min(1.3, 0.65 + ch.speed01 * 0.7);
            }
        } else {
            this._stillT += Math.max(dt, 0);
            if (this._stillT >= IDLE_DELAY && this._idle) {
                want = this._idle;
                speed = 1;
            } else if (this._active && this._active !== this._idle) {
                want = this._active;
                speed = 0;
            } else if (this._idle) {
                want = this._idle;
                speed = 1;
            }
        }

        if (want && want !== this._active) {
            this._crossfade(want, speed, ch);
        } else if (want) {
            want.speedRatio = speed;
            // Keep full weight after any prior blend; never goToFrame mid-stride
            // (that snapped every gait wrap and made walk/run look choppy).
            if (this._blendT >= 1) want.setWeightForAllAnimatables(1);
        }

        // Advance crossfade weights.
        if (this._fadeOut && this._blendT < 1) {
            this._blendT = Math.min(1, this._blendT + dt / BLEND_DUR);
            const t = this._blendT;
            if (this._active) this._active.setWeightForAllAnimatables(t);
            this._fadeOut.setWeightForAllAnimatables(1 - t);
            if (t >= 1) {
                this._fadeOut.stop();
                this._fadeOut = null;
            }
        }
    }

    /**
     * Hand bone for parenting props (CPU-skinned skeleton).
     * @param {string} name
     * @returns {import("@babylonjs/core/Bones/bone").Bone|null}
     */
    getHandBone(name) {
        const sk = this._mesh?.skeleton;
        if (!sk) return null;
        return sk.bones.find((b) => b.name === name) || null;
    }

    /** Refresh bone absolute matrices after animation (required for hand sockets). */
    prepareSkeleton() {
        const sk = this._mesh?.skeleton;
        if (sk) sk.computeAbsoluteTransforms();
    }

    /**
     * @param {string} name
     * @param {Vector3} out
     */
    getHandWorldPos(name, out) {
        const bone = this.getHandBone(name);
        if (!bone || !this._mesh) return false;
        bone.getAbsolutePositionToRef(this._mesh, out);
        return true;
    }

    /** Fire bow: fast Archery_Shot, infinite ammo, aim = crosshair look dir. */
    playDraw() {
        if (!this.hasBow) return;
        if (this._busy === "hit" || this._busy === "draw") return;
        if (this.controller.airborne || input.inspecting) return;
        const clip = this._draw;
        if (!clip) return;

        if (this._busy === "emote") this._clearBusyObservers(this._active);
        this._busy = "draw";
        this.controller.locked = true;
        this.controller.velocity.x = 0;
        this.controller.velocity.z = 0;
        this._drawT = 0;
        this._shotFired = false;
        this._faceAim();
        this._clearBusyObservers(clip);
        clip.onAnimationGroupEndObservable.addOnce(() => {
            if (this._busy !== "draw") return;
            if (this.bow) this.bow.equip();
            this._endBusy();
        });
        this._hardCut(clip, 1);
        if (this.bow) {
            this.bow.equip();
            this.bow.setVisible(true);
        }
    }

    /** Face the crosshair so the archery clip aims forward (not back / sideways). */
    _faceAim() {
        if (this.getAimDir) _aimDir.copyFrom(this.getAimDir());
        else {
            const f = this.controller.facing;
            _aimDir.set(Math.sin(f), 0, Math.cos(f));
        }
        this.controller.facing = Math.atan2(_aimDir.x, _aimDir.z);
    }

    _tickDraw(dt) {
        if (this._busy !== "draw") return;
        this._faceAim();
        this._drawT += Math.max(dt, 0);
        if (!this._shotFired && this._drawT >= RELEASE_T) {
            this._shotFired = true;
            if (this.getAimDir) _aimDir.copyFrom(this.getAimDir());
            else {
                const f = this.controller.facing;
                _aimDir.set(Math.sin(f), 0.08, Math.cos(f));
            }
            if (_aimDir.lengthSquared() < 1e-6) _aimDir.set(0, 0.08, 1);
            _aimDir.normalize();
            const cam = this.getCameraPos ? this.getCameraPos() : this.controller.position;
            this.bow?.releaseShot(_aimDir, cam);
            if (this.onShot) this.onShot(_aimDir);
        }
    }

    /** Stop fade-out leftovers and clear end observers on a group. */
    _clearBusyObservers(group) {
        if (group) group.onAnimationGroupEndObservable.clear();
    }

    _endBusy() {
        this._busy = null;
        this.controller.locked = false;
        this.controller._hitDecay = 0;
        const idle = this._idle || this._walk;
        if (idle) {
            this._crossfade(idle, 1, this.controller);
        }
    }

    /**
     * Giant hit: play fall, then get-up, then unlock.
     * Ignored if already in a hit sequence.
     */
    playHit() {
        if (this._busy === "hit") return;
        if (!this._fall) {
            this.controller.locked = false;
            return;
        }
        if (this._busy === "emote" || this._busy === "draw") {
            this._clearBusyObservers(this._active);
            this._shotFired = true;
        }
        this.bow?.setVisible(false);
        this._busy = "hit";
        this.controller.locked = true;
        this._clearBusyObservers(this._fall);
        this._clearBusyObservers(this._getUp);
        this._fall.onAnimationGroupEndObservable.addOnce(() => {
            if (this._busy !== "hit") return;
            // Kill leftover knockback so get-up doesn't slide/teleport.
            this.controller.velocity.x = 0;
            this.controller.velocity.z = 0;
            this.controller._hitDecay = 0;
            if (this._getUp) {
                this._clearBusyObservers(this._getUp);
                this._getUp.onAnimationGroupEndObservable.addOnce(() => {
                    if (this._busy === "hit") this._endBusy();
                });
                // Align root yaw so get-up's first hips facing matches fall's last
                // (clips are authored in different local orientations).
                this._alignFacingToHips(this._fall, this._getUp);
                // Hard cut — crossfading two different prone poses twists the body.
                this._hardCut(this._getUp, 1);
            } else {
                this._endBusy();
            }
        });
        this._crossfade(this._fall, 1, this.controller);
    }

    /**
     * Read Hips rotation key from a group.
     * @param {import("@babylonjs/core/Animations/animationGroup").AnimationGroup} group
     * @param {"first"|"last"} which
     * @param {Quaternion} out
     */
    _hipsQuat(group, which, out) {
        out.copyFromFloats(0, 0, 0, 1);
        if (!group) return false;
        for (const ta of group.targetedAnimations) {
            const target = ta.target;
            const anim = ta.animation;
            if (!target || !anim) continue;
            if (!/hips/i.test(target.name || "")) continue;
            if (anim.targetProperty !== "rotationQuaternion" && anim.targetProperty !== "rotation") {
                continue;
            }
            const keys = anim.getKeys();
            if (!keys.length) continue;
            const v = keys[which === "last" ? keys.length - 1 : 0].value;
            if (v.w != null) out.copyFrom(v);
            else Quaternion.FromEulerVectorToRef(v, out);
            return true;
        }
        return false;
    }

    /** Yaw (radians) around +Y from a quaternion. */
    _quatYaw(q) {
        // glTF/Babylon: yaw from quaternion
        const siny = 2 * (q.w * q.y + q.x * q.z);
        const cosy = 1 - 2 * (q.y * q.y + q.z * q.z);
        return Math.atan2(siny, cosy);
    }

    /**
     * Shift controller facing so `to` clip's first hips yaw matches `from`'s last.
     * @param {import("@babylonjs/core/Animations/animationGroup").AnimationGroup} from
     * @param {import("@babylonjs/core/Animations/animationGroup").AnimationGroup} to
     */
    _alignFacingToHips(from, to) {
        if (!this._hipsQuat(from, "last", _hipsA)) return;
        if (!this._hipsQuat(to, "first", _hipsB)) return;
        const delta = this._quatYaw(_hipsA) - this._quatYaw(_hipsB);
        this.controller.facing += delta;
        if (this._root?.rotationQuaternion) {
            Quaternion.RotationAxisToRef(Vector3.UpReadOnly, this.controller.facing, this._root.rotationQuaternion);
        }
    }

    /**
     * Instant clip swap (no blend) — used for fall→get-up.
     * @param {import("@babylonjs/core/Animations/animationGroup").AnimationGroup} next
     * @param {number} speed
     */
    _hardCut(next, speed) {
        if (this._fadeOut) {
            this._fadeOut.stop();
            this._fadeOut = null;
        }
        if (this._active && this._active !== next) this._active.stop();
        this._blendT = 1;
        if (!next.isPlaying) next.start(false, speed);
        else {
            next.speedRatio = speed;
            next.goToFrame(next.from);
        }
        next.setWeightForAllAnimatables(1);
        this._active = next;
    }

    /** Cycle to the next emote and play it (locked until end or cancelled). */
    playEmote() {
        if (!this._emotes.length || this._busy === "hit") return;
        if (this._busy === "emote") {
            this._clearBusyObservers(this._active);
        }
        const clip = this._emotes[this._emoteI % this._emotes.length];
        this._emoteI = (this._emoteI + 1) % this._emotes.length;
        this._busy = "emote";
        this.controller.locked = true;
        this.controller.velocity.x = 0;
        this.controller.velocity.z = 0;
        this._clearBusyObservers(clip);
        clip.onAnimationGroupEndObservable.addOnce(() => {
            if (this._busy === "emote" && this._active === clip) this._endBusy();
        });
        this._crossfade(clip, 1, this.controller);
    }

    /** Cancel an emote early (move / jump). Hit sequences are not cancellable. */
    _tryCancelEmote() {
        if (this._busy !== "emote") return;
        this._clearBusyObservers(this._active);
        this._endBusy();
    }

    /**
     * Soft clip swap — both groups play briefly with complementary weights.
     * @param {import("@babylonjs/core/Animations/animationGroup").AnimationGroup} next
     * @param {number} speed
     * @param {import("./controller.js").CharacterController} ch
     */
    _crossfade(next, speed, ch) {
        if (this._fadeOut) {
            this._fadeOut.stop();
            this._fadeOut = null;
        }
        const prev = this._active;
        if (prev && prev !== next && prev.isPlaying) {
            this._fadeOut = prev;
            this._blendT = 0;
            prev.setWeightForAllAnimatables(1);
        } else {
            if (prev && prev !== next) prev.stop();
            this._blendT = 1;
        }

        const loop =
            next === this._idle ||
            next === this._walk ||
            next === this._run;
        if (!next.isPlaying) next.start(loop, speed);
        else next.speedRatio = speed;
        next.setWeightForAllAnimatables(this._blendT >= 1 ? 1 : 0);
        this._active = next;

        if (!loop) {
            next.speedRatio = speed;
        } else if (
            (next === this._walk || next === this._run) &&
            prev &&
            (prev === this._walk || prev === this._run)
        ) {
            // Align only on walk↔run swaps — never every stride.
            this._syncGaitPhase(next, ch.gaitPhase);
        }
    }

    /**
     * One-shot align of clip frame to controller gait (walk↔run only).
     * @param {import("@babylonjs/core/Animations/animationGroup").AnimationGroup} group
     * @param {number} phase 0..1
     */
    _syncGaitPhase(group, phase) {
        const from = group.from;
        const to = group.to;
        const span = to - from;
        if (span <= 0) return;
        const p = ((phase % 1) + 1) % 1;
        group.goToFrame(from + p * span);
        this._syncedPhase = phase;
    }

    /**
     * @param {number} dt
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     */
    update(dt, cameraPos, env) {
        if (!this._mesh || !this._root) return;

        // Emote cancel on locomotion intent (hit is uninterruptible).
        if (
            this._busy === "emote" &&
            (input.moving || input.jumpPressed)
        ) {
            this._tryCancelEmote();
        }
        if (input.emotePressed && !this._busy && !this.controller.airborne && !input.inspecting) {
            this.playEmote();
        }
        if (input.drawPressed && !this._busy && !this.controller.airborne && !input.inspecting) {
            this.playDraw();
        }
        this._tickDraw(dt);

        this._syncAnim(dt);
        this._placeRoot(dt);
        if (this.bow) {
            // Only while drawing — idle bone sockets aren't reliable, so we hide
            // the grip-cheat bow between shots instead of leaving it floating.
            this.bow.setVisible(this.hasBow && this._busy === "draw");
        }

        const sky = this.sky;
        _splits.set(
            this.shadows.splits[0], this.shadows.splits[1],
            this.shadows.splits[2], this.shadows.splits[3]
        );

        for (const { mat: m } of this._mats) {
            m.setVector3("cameraPos", cameraPos);
            m.setVector3("sunDir", sky.sunDir);
            m.setColor3("sunRadiance", sky.sunRadiance);
            m.setArray4("shR", sky.sh);
            bindMatrixArray(m, "cascadeMatrices", this.shadows.matrixData);
            m.setVector4("cascadeSplits", _splits);
            m.setArray4("cascadeParams", this.shadows.paramData);
            m.setFloat("shadowTexel", this.shadows.texelSize);
            m.setFloat("shadowSoftness", 1.8);
            m.setFloat("shadowBias", 0.022);
            m.setFloat("fogDensity", env.fogDensity);
            m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
            m.setFloat("fogStart", S.fogStart);
            m.setFloat("aerialStrength", env.aerialStrength);
            m.setFloat("ambientIntensity", S.ambientIntensity * 1.25);
            m.setColor3("fillRadiance", _fill);
            m.setFloat("albedoGain", 1.15);
            m.setFloat("panelGlow", 0.12);
            m.setFloat("keyLightCount", 0);
            this.lights.apply(m);
        }
    }
}
