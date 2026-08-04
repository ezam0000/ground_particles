/**
 * Polyphemus — spawns after the sheep flock is wiped.
 *
 * Calm patrol by default. First headshot permanently enrages (chase + slash
 * until death). Dies from 5 headshots inside a rolling 15s window.
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
import { getLerped } from "../core/envProfile.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { angleDamp } from "../character/controller.js";
import { preloadSfx, playSfx, playVo, unlockAudio } from "../combat/sfx.js";

const MODEL = "/assets/odyssey/models/cyclops.glb";
const PAIN_SFX = "/assets/sfx/cyclops_pain.mp3";
const DEATH_SFX = "/assets/sfx/cyclops_at_dead.mp3";
const DEATH_LINE =
    "Πάτερ Ποσειδώνα, με τύφλωσαν. Εκδίκηση, πατέρα! Εκδίκηση για μένα. Ποσειδώνα! Εκδίκηση για μένα!";
const HEADSHOT_SFX = "/assets/sfx/headshot.mp3";
const PAIN_VOL = 0.72;
const DEATH_VOL = 0.8;
const HEADSHOT_VOL = 0.7;

const TARGET_HEIGHT = 3.2;
const COLLIDE_RADIUS = 0.85;
const CHAR_RADIUS = 0.45;
const BODY_R = 0.48;
const CHEST_Y = 1.85;
const FACE_Y = 2.55;

const WALK_SPEED = 1.25;
const RUN_SPEED = 3.4;
const WALK_ANIM_SPEED = 1.0;
const RUN_ANIM_SPEED = 1.05;

/** Start slash only when already near the player (not from 4 m out). */
const ATTACK_RANGE = 2.15;
/** Chase plant distance — just outside collision shell. */
const CHASE_STOP = 1.2;
/** Windup close-in so the swinging hand reaches the avatar. */
const LUNGE_SPEED = 2.2;
const HIT_DELAY = 0.48;
const HIT_WINDOW = 0.4;
const HIT_CONTACT = COLLIDE_RADIUS + CHAR_RADIUS + 0.65;
const HAND_HIT_R = 1.55;
const BODY_PRESS = COLLIDE_RADIUS + CHAR_RADIUS + 0.35;

const HEADS_TO_KILL = 5;
const HEAD_WINDOW_MS = 15000;
const HP_FLASH_DECAY = 6;
const HP_SHOW_RANGE = 12;

const FOOT_WIDTH = 0.18;
const FOOT_ELONG = 1.6;
const STRIDE = 0.72;
const STANCE = 0.24;

const HAND_BONES = ["LeftHand", "RightHand", "LeftForeArm", "RightForeArm"];

const _splits = new Vector4();
const _fill = new Color3(0.5, 0.4, 0.32);
const _min = new Vector3();
const _max = new Vector3();
const _normal = new Vector3();
const _yawQ = new Quaternion();
const _tiltQ = new Quaternion();
const _orient = new Quaternion();
const _hand = new Vector3();
const _keyPos = new Float32Array(24);
const _keyCol = new Float32Array(24);

export class Cyclops {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../render/depthPass.js").DepthPass} depthPass
     * @param {import("../spells/spellLights.js").SpellLights} lights
     */
    constructor(scene, terrain, sky, shadows, depthPass, lights) {
        this.scene = scene;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;
        this.depthPass = depthPass;
        this.lights = lights;

        this._mats = [];
        this._mesh = null;
        this._root = null;
        this.x = 0;
        this.z = 0;
        this.yaw = 0;
        this.radius = COLLIDE_RADIUS;
        this.bodyRadius = BODY_R;
        this.chestY = CHEST_Y;
        this.headY = FACE_Y;

        /** @type {{ x:number, z:number }[]} */
        this._patrol = [];
        this._patrolI = 1;

        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._walk = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._run = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._attack = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._spawnClip = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._hitBack = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._hitWaist = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._hitChest = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._dieClip = null;

        this._spawned = false;
        this._alive = false;
        this._dying = false;
        this._corpse = false;
        this._reacting = false;
        this._attacking = false;
        /** Permanent chase after first headshot until death. */
        this._enraged = false;
        this._hitT = 0;
        this._hitLanded = false;
        this.didHit = false;

        /** @type {number[]} headshot timestamps (ms) */
        this._headTimes = [];
        /** 0..1 impact flash for health bar. */
        this._hpFlash = 0;

        /** @type {(() => void)|null} */
        this.onDeath = null;

        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._anim = null;
        this._sinceSplat = 0;
        this._foot = 0;
        this._stride = STRIDE;
        this._prevX = 0;
        this._prevZ = 0;
        this._tiltN = new Vector3(0, 1, 0);
        /** @type {import("@babylonjs/core/Bones/bone").Bone[]} */
        this._strikeBones = [];

        this._depthMats = [0, 1].map((c) => this._makeDepthMaterial(c));
        this._prepassMat = this._makePrepassMaterial();

        this._ready = this._load();
        void preloadSfx(PAIN_SFX);
        void preloadSfx(DEATH_SFX);
        void preloadSfx(HEADSHOT_SFX);
    }

    get alive() {
        return this._alive && !this._dying && !this._corpse;
    }

    async _load() {
        const result = await SceneLoader.ImportMeshAsync("", "", MODEL, this.scene);
        const root = result.meshes[0];
        root.name = "cyclopsRoot";

        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh|null} */
        let body = null;
        for (const m of result.meshes) {
            if (m === root) continue;
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
                body = /** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (m);
                break;
            }
        }
        if (!body) throw new Error("cyclops.glb: no skinned mesh");

        body.computeBonesUsingShaders = false;
        if (body.skeleton) body.skeleton.returnToRest();

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
        this._setEnabled(false);

        this._strikeBones = [];
        if (body.skeleton) {
            for (const name of HAND_BONES) {
                const b = body.skeleton.bones.find((bone) => bone.name === name);
                if (b) this._strikeBones.push(b);
            }
        }

        const groups = result.animationGroups || [];
        for (const g of groups) g.stop();

        this._walk = groups.find((g) => /^walking$/i.test(g.name))
            || groups.find((g) => /monster_walk/i.test(g.name))
            || groups.find((g) => /walking/i.test(g.name) && !/injur|back/i.test(g.name))
            || null;
        this._run = groups.find((g) => /^running$/i.test(g.name)) || null;
        this._attack = groups.find((g) => /charged_upward_slash|slash/i.test(g.name)) || null;
        this._spawnClip = groups.find((g) => /dive_down_and_land/i.test(g.name)) || null;
        this._hitBack = groups.find((g) => /hit_in_back|hit in back/i.test(g.name)) || null;
        this._hitWaist = groups.find((g) => /hit_reaction_to_waist/i.test(g.name)) || null;
        this._hitChest = groups.find((g) => /hit_reaction_1/i.test(g.name))
            || groups.find((g) => /^hit_reaction$/i.test(g.name))
            || null;
        this._dieClip = groups.find((g) => /^dead$/i.test(g.name))
            || groups.find((g) => /dying_backwards/i.test(g.name))
            || groups.find((g) => /fall_dead|abdominal/i.test(g.name))
            || null;

        for (const g of [this._spawnClip, this._hitBack, this._dieClip, this._attack]) {
            if (g) this._pinHipsXZ(g);
        }

        if (this._walk) {
            const span = Math.max(0.01, this._walk.to - this._walk.from);
            const fps = this._walk.targetedAnimations[0]?.animation?.framePerSecond || 30;
            const cycleSec = span / fps / WALK_ANIM_SPEED;
            this._stride = Math.max(0.4, WALK_SPEED * cycleSec * 0.5);
        }

        return root;
    }

    _setEnabled(on) {
        if (this._root) this._root.setEnabled(on);
        if (this._mesh) this._mesh.isVisible = on;
    }

    /**
     * @param {{ x:number, z:number }} near
     */
    spawn(near) {
        if (this._spawned || !this._root || !this._mesh) return;
        this._spawned = true;
        this._alive = true;
        this._dying = false;
        this._corpse = false;
        this._headTimes.length = 0;
        this._hpFlash = 0;
        this._enraged = false;

        const ang = Math.random() * Math.PI * 2;
        const dist = 6 + Math.random() * 3;
        this.x = near.x + Math.sin(ang) * dist;
        this.z = near.z + Math.cos(ang) * dist;
        this.yaw = Math.atan2(near.x - this.x, near.z - this.z);
        this._buildPatrol();
        this._prevX = this.x;
        this._prevZ = this.z;
        this._placeRoot(this._root, 1);
        this._setEnabled(true);

        unlockAudio();
        playSfx(PAIN_SFX, PAIN_VOL * 0.85);

        const intro = this._spawnClip;
        if (intro) {
            if (this._anim) this._anim.stop();
            this._reacting = true;
            intro.onAnimationGroupEndObservable.clear();
            intro.onAnimationGroupEndObservable.addOnce(() => {
                this._playCalm();
            });
            intro.start(false, 1.0);
            this._anim = intro;
        } else {
            this._playCalm();
        }
    }

    _buildPatrol() {
        const cx = this.x;
        const cz = this.z;
        const r = 7;
        this._patrol = [
            { x: cx + r, z: cz },
            { x: cx, z: cz + r },
            { x: cx - r, z: cz },
            { x: cx, z: cz - r },
        ];
        this._patrolI = 0;
    }

    _playCalm() {
        if (this._dying || this._corpse) return;
        if (this._anim && this._anim !== this._walk) this._anim.stop();
        if (this._walk) {
            this._walk.start(true, WALK_ANIM_SPEED);
            this._anim = this._walk;
        }
        this._reacting = false;
        this._attacking = false;
    }

    _playRun() {
        if (this._dying || this._corpse) return;
        const clip = this._run || this._walk;
        if (!clip) return;
        if (this._anim === clip && clip.isPlaying) return;
        if (this._anim && this._anim !== clip) this._anim.stop();
        clip.start(true, this._run ? RUN_ANIM_SPEED : WALK_ANIM_SPEED);
        this._anim = clip;
        this._reacting = false;
        this._attacking = false;
    }

    /**
     * @param {"back"|"waist"|"chest"|"head"} zone
     */
    playHit(zone) {
        if (!this.alive) return;

        this._hpFlash = 1;
        unlockAudio();
        if (zone === "head") {
            playSfx(HEADSHOT_SFX, HEADSHOT_VOL);
            playSfx(PAIN_SFX, PAIN_VOL);
            const now = performance.now();
            this._headTimes.push(now);
            this._pruneHeadTimes(now);
            if (this._headTimes.length >= HEADS_TO_KILL) {
                this._die();
                return;
            }
            this._enraged = true;
        } else {
            playSfx(PAIN_SFX, PAIN_VOL);
        }

        if (this._reacting || this._dying) return;

        let clip = this._hitWaist;
        if (zone === "back") clip = this._hitBack || clip;
        else if (zone === "chest" || zone === "head") clip = this._hitChest || clip;
        else clip = this._hitWaist || this._hitChest || this._hitBack;
        if (!clip) {
            if (this._enraged) this._playRun();
            return;
        }

        if (this._anim) this._anim.stop();
        this._attacking = false;
        this._reacting = true;
        this._hitLanded = true;
        clip.onAnimationGroupEndObservable.clear();
        clip.onAnimationGroupEndObservable.addOnce(() => {
            if (!this.alive) return;
            if (this._enraged) this._playRun();
            else this._playCalm();
        });
        clip.start(false, 1.0);
        this._anim = clip;
    }

    /** @param {number} now */
    _pruneHeadTimes(now) {
        const cutoff = now - HEAD_WINDOW_MS;
        while (this._headTimes.length && this._headTimes[0] < cutoff) {
            this._headTimes.shift();
        }
    }

    /**
     * @param {Vector3} playerPos
     */
    getHealthView(playerPos) {
        if (!this.alive || !this._spawned || !this._root?.isEnabled()) return null;
        const dx = playerPos.x - this.x;
        const dz = playerPos.z - this.z;
        if (dx * dx + dz * dz > HP_SHOW_RANGE * HP_SHOW_RANGE) return null;
        this._pruneHeadTimes(performance.now());
        const ground = this.terrain.heightAt(this.x, this.z);
        return {
            id: "cyclops",
            name: "Polyphemus",
            x: this.x,
            y: ground + TARGET_HEIGHT * 0.95,
            z: this.z,
            kind: /** @type {"pips"} */ ("pips"),
            pips: Math.max(0, HEADS_TO_KILL - this._headTimes.length),
            maxPips: HEADS_TO_KILL,
            flash: this._hpFlash,
        };
    }

    _die() {
        if (this._dying || this._corpse) return;
        this._dying = true;
        this._alive = false;
        this._enraged = false;
        this._attacking = false;
        unlockAudio();
        playVo(DEATH_SFX, DEATH_VOL, DEATH_LINE);

        const clip = this._dieClip;
        if (this._anim) this._anim.stop();
        if (clip) {
            this._reacting = true;
            clip.onAnimationGroupEndObservable.clear();
            clip.onAnimationGroupEndObservable.addOnce(() => {
                this._corpse = true;
                this._dying = false;
                this._reacting = false;
                if (this.onDeath) this.onDeath();
            });
            clip.start(false, 1.0);
            this._anim = clip;
        } else {
            this._corpse = true;
            this._dying = false;
            if (this.onDeath) this.onDeath();
        }
    }

    _pinHipsXZ(group) {
        let restX = 0;
        let restZ = 0;
        let found = false;
        for (const ta of group.targetedAnimations) {
            if (!/hips/i.test(ta.target?.name || "")) continue;
            if (ta.animation.targetProperty !== "position") continue;
            const keys = ta.animation.getKeys();
            if (!keys.length) continue;
            restX = keys[0].value.x;
            restZ = keys[0].value.z;
            found = true;
            break;
        }
        if (!found) return;
        for (const ta of group.targetedAnimations) {
            if (!/hips/i.test(ta.target?.name || "")) continue;
            if (ta.animation.targetProperty !== "position") continue;
            const keys = ta.animation.getKeys();
            for (let i = 0; i < keys.length; i++) {
                keys[i].value.x = restX;
                keys[i].value.z = restZ;
            }
        }
    }

    /**
     * @param {number} pdx
     * @param {number} pdz
     * @param {number} pDist
     */
    _facingPlayer(pdx, pdz, pDist) {
        if (pDist < 1e-4) return true;
        const fx = Math.sin(this.yaw);
        const fz = Math.cos(this.yaw);
        return (pdx / pDist) * fx + (pdz / pDist) * fz > 0.12;
    }

    /**
     * @param {Vector3} playerPos
     * @param {number} pDist
     */
    _inMeleeContact(playerPos, pDist) {
        if (pDist <= BODY_PRESS) return true;
        if (pDist > HIT_CONTACT) return false;
        const mesh = this._mesh;
        const sk = mesh?.skeleton;
        if (!sk || !this._strikeBones.length) return pDist <= HIT_CONTACT * 0.85;
        sk.computeAbsoluteTransforms();
        const py = playerPos.y + 1.05;
        for (let i = 0; i < this._strikeBones.length; i++) {
            this._strikeBones[i].getAbsolutePositionToRef(mesh, _hand);
            const d = Math.hypot(_hand.x - playerPos.x, _hand.y - py, _hand.z - playerPos.z);
            if (d <= HAND_HIT_R) return true;
        }
        return false;
    }

    /**
     * @param {number} playerX
     * @param {number} playerZ
     */
    _startAttack(playerX, playerZ) {
        if (!this._attack || this._attacking || this._reacting || this._dying) return;
        if (this._anim) this._anim.stop();
        this._attacking = true;
        this._hitT = 0;
        this._hitLanded = false;
        this.yaw = Math.atan2(playerX - this.x, playerZ - this.z);
        if (this._root) this._placeRoot(this._root);

        this._attack.onAnimationGroupEndObservable.clear();
        this._attack.onAnimationGroupEndObservable.addOnce(() => {
            if (!this.alive) return;
            if (this._enraged) this._playRun();
            else this._playCalm();
        });
        this._attack.start(false, 1.0);
        this._anim = this._attack;
    }

    _placeRoot(root, dt = 1 / 60) {
        const groundY = this.terrain.heightAt(this.x, this.z);
        this.terrain.normalAt(this.x, this.z, _normal);
        const k = 1 - Math.exp(-6 * Math.max(dt, 1 / 120));
        this._tiltN.x += (_normal.x * 0.5 - this._tiltN.x) * k;
        this._tiltN.y += (_normal.y - this._tiltN.y) * k;
        this._tiltN.z += (_normal.z * 0.5 - this._tiltN.z) * k;
        const nLen = Math.hypot(this._tiltN.x, this._tiltN.y, this._tiltN.z) || 1;
        _normal.set(this._tiltN.x / nLen, this._tiltN.y / nLen, this._tiltN.z / nLen);

        Quaternion.RotationAxisToRef(Vector3.UpReadOnly, this.yaw, _yawQ);
        Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, _normal, _tiltQ);
        _tiltQ.multiplyToRef(_yawQ, _orient);
        if (!root.rotationQuaternion) root.rotationQuaternion = _orient.clone();
        else {
            const sk = 1 - Math.exp(-10 * Math.max(dt, 1 / 120));
            Quaternion.SlerpToRef(root.rotationQuaternion, _orient, sk, root.rotationQuaternion);
        }
        root.position.set(this.x, groundY, this.z);
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
        const mat = this._makePropMaterial("cyclops:body", Color3.White(), albedoTex, mesh);
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
        mat.setFloat("panelGlow", 0.1);
        mat.setFloat("albedoGain", 1.12);
        mat.setColor3("fillRadiance", _fill.clone());
        mat.setFloat("keyLightCount", 0);
        mat.setArray4("keyLightPos", _keyPos);
        mat.setArray4("keyLightCol", _keyCol);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < 3; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        if (!Cyclops._white) {
            Cyclops._white = RawTexture.CreateRGBATexture(
                new Uint8Array([170, 150, 130, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        mat.setTexture("albedoTex", textureOrNull || Cyclops._white);
        if (textureOrNull) {
            textureOrNull.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
            textureOrNull.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        }
        this._mats.push({ mat, mesh });
        return mat;
    }

    _makeDepthMaterial(cascade) {
        return new ShaderMaterial(
            "cyclopsDepth" + cascade, this.scene,
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
            "cyclopsPrepass", this.scene,
            { vertex: "staticPrepass", fragment: "prepass" },
            {
                attributes: ["position"],
                uniforms: ["world", "viewProjection"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
    }

    async warmUp() {
        await this._ready;
        await preloadSfx(PAIN_SFX);
        await preloadSfx(DEATH_SFX);
        await preloadSfx(HEADSHOT_SFX);
        for (const { mat, mesh } of this._mats) {
            await whenReady(mat, mat.name, [mesh, false]);
        }
        if (this._mesh) {
            await whenReady(this._prepassMat, "cyclops prepass", [this._mesh, false]);
            for (let i = 0; i < this._depthMats.length; i++) {
                await whenReady(this._depthMats[i], "cyclops depth " + i, [this._mesh, false]);
            }
        }
    }

    /** @param {Vector3} pos */
    resolveCollision(pos) {
        if (!this._spawned || (!this.alive && !this._corpse && !this._dying)) return;
        if (!this._root?.isEnabled()) return;
        const dx = pos.x - this.x;
        const dz = pos.z - this.z;
        const min = this.radius + CHAR_RADIUS;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-8) return;
        const d = Math.sqrt(d2);
        const k = min / d;
        pos.x = this.x + dx * k;
        pos.z = this.z + dz * k;
    }

    /**
     * @param {number} dt
     * @param {Vector3} playerPos
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     */
    update(dt, playerPos, cameraPos, env) {
        if (!this._mesh || !this._root || !this._spawned) return;
        if (!this._root.isEnabled()) return;

        this.didHit = false;
        const h = Math.max(dt, 0);
        if (this._hpFlash > 0) this._hpFlash = Math.max(0, this._hpFlash - HP_FLASH_DECAY * h);

        const pdx = playerPos.x - this.x;
        const pdz = playerPos.z - this.z;
        const pDist = Math.hypot(pdx, pdz);
        const enraged = this._enraged && this.alive;

        if (
            enraged &&
            !this._attacking &&
            !this._reacting &&
            !this._dying &&
            pDist < ATTACK_RANGE &&
            this._attack
        ) {
            this._startAttack(playerPos.x, playerPos.z);
        }

        if (this._attacking && !this._reacting) {
            this._hitT += h;
            // Windup lunge — close the last gap so the slash hand meets the player.
            if (!this._hitLanded && this._hitT < HIT_DELAY + HIT_WINDOW && pDist > CHASE_STOP) {
                const step = Math.min(pDist - CHASE_STOP, LUNGE_SPEED * h);
                const inv = 1 / (pDist || 1);
                this.x += pdx * inv * step;
                this.z += pdz * inv * step;
            }
            const cdx = playerPos.x - this.x;
            const cdz = playerPos.z - this.z;
            const cDist = Math.hypot(cdx, cdz);
            if (
                !this._hitLanded &&
                this._hitT >= HIT_DELAY &&
                this._hitT <= HIT_DELAY + HIT_WINDOW &&
                this._facingPlayer(cdx, cdz, cDist) &&
                this._inMeleeContact(playerPos, cDist)
            ) {
                this._hitLanded = true;
                this.didHit = true;
            }
        }

        const busy = this._attacking || this._reacting || this._dying || this._corpse;
        if (!busy && h > 0 && this.alive) {
            if (enraged) {
                if (pDist > CHASE_STOP) {
                    const step = Math.min(pDist - CHASE_STOP, RUN_SPEED * h);
                    const inv = 1 / (pDist || 1);
                    this.x += pdx * inv * step;
                    this.z += pdz * inv * step;
                    this.yaw = angleDamp(this.yaw, Math.atan2(pdx, pdz), 10, h);
                }
                this._placeRoot(this._root, h);
                this._stampFeet();
            } else if (this._patrol.length > 1) {
                const target = this._patrol[this._patrolI];
                let dx = target.x - this.x;
                let dz = target.z - this.z;
                const dist = Math.hypot(dx, dz);
                if (dist < 0.4) {
                    this._patrolI = (this._patrolI + 1) % this._patrol.length;
                } else {
                    const step = Math.min(dist, WALK_SPEED * h);
                    dx /= dist;
                    dz /= dist;
                    this.x += dx * step;
                    this.z += dz * step;
                    this.yaw = angleDamp(this.yaw, Math.atan2(dx, dz), 8, h);
                }
                this._placeRoot(this._root, h);
                this._stampFeet();
            }
        } else {
            if (this._attacking) {
                this.yaw = angleDamp(this.yaw, Math.atan2(pdx, pdz), 6, h);
            }
            this._placeRoot(this._root, h);
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
            m.setFloat("ambientIntensity", S.ambientIntensity * 1.2);
            m.setColor3("fillRadiance", _fill);
            m.setFloat("albedoGain", 1.12);
            m.setFloat("panelGlow", 0.1);
            m.setFloat("keyLightCount", 0);
            this.lights.apply(m);
        }
    }

    _stampFeet() {
        const field = this.terrain.deform;
        const dx = this.x - this._prevX;
        const dz = this.z - this._prevZ;
        const moved = Math.hypot(dx, dz);
        this._prevX = this.x;
        this._prevZ = this.z;
        if (moved < 1e-4) return;

        const env = getLerped();
        const cs = env.contactScale;
        const bs = env.bermScale;
        const fx = Math.sin(this.yaw);
        const fz = Math.cos(this.yaw);
        const rx = -fz;
        const rz = fx;

        const stride = this._stride || STRIDE;
        this._sinceSplat += moved;
        if (this._sinceSplat < stride) return;
        this._sinceSplat -= stride;

        const side = this._foot ? 1 : -1;
        this._foot ^= 1;
        const px = this.x + rx * STANCE * side - fx * 0.1;
        const pz = this.z + rz * STANCE * side - fz * 0.1;
        field.brush(
            px, pz,
            FOOT_WIDTH,
            0.28 * cs,
            0.18 * cs * bs,
            Math.min(1, 0.95 * env.compressionScale),
            0,
            this.yaw,
            FOOT_ELONG,
            env.rimRoughness
        );
    }
}
