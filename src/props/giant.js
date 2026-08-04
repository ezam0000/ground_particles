/**
 * Giant enemy statue — skinned landmark on the dunes.
 *
 * Uses the crushed `giant.glb` (Walking / Running). Babylon CPU-skins the
 * mesh so the shared prop beauty / depth / prepass shaders stay rigid.
 */

import "@babylonjs/loaders/glTF";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4, Color3, Quaternion } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { input } from "../core/input.js";
import { bindMatrixArray, whenReady } from "../core/gpuUtil.js";
import { getLerped } from "../core/envProfile.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { angleDamp } from "../character/controller.js";
import { preloadSfx, playSfx, unlockAudio } from "../combat/sfx.js";

const MODEL = "/assets/odyssey/models/giant.glb";
const HIT_SFX = "/assets/sfx/giant_hit.mp3";
const HIT_SFX_VOL = 0.65;
const ROAR_SFX = "/assets/sfx/giant_roar.mp3";
const ROAR_SFX_VOL = 0.72;
/** Play a pain roar every N arrow hits. */
const ROAR_EVERY = 5;
const HP_FLASH_DECAY = 6;
const HP_SHOW_RANGE = 14;

/** World height of the giant, metres. Source mesh is ~3m tall. */
const TARGET_HEIGHT = 3;
/** Feet collision radius. */
const COLLIDE_RADIUS = 0.75;
const CHAR_RADIUS = 0.45;
/** Player must be this close (XZ) to award the Laestrygonians card via I. */
const CARD_INSPECT_RANGE = 7.5;

/** Walk speed (m/s) — clip is in-place, so we drive the root ourselves. */
const WALK_SPEED = 1.35;
/** Animation playback rate matched to WALK_SPEED stride feel. */
const WALK_ANIM_SPEED = 1.0;

/** Player within this range can trigger an attack. */
const ATTACK_RANGE = 11;
/** Minimum seconds between attacks. */
const ATTACK_COOLDOWN = 3.2;
/** Seconds after attack start before the hit box arms. */
const HIT_DELAY = 0.55;
/** Seconds the hit box stays live after HIT_DELAY. */
const HIT_WINDOW = 0.28;
/**
 * Max player–giant distance for a connecting swing (body radii + short reach).
 * Was ~3.2 — felt like remote hits; now requires near contact.
 */
const HIT_CONTACT = COLLIDE_RADIUS + CHAR_RADIUS + 0.55;
/** Hand/forearm must be this close to the player torso to count as contact. */
const HAND_HIT_R = 1.35;
/** Body-press fallback when hands aren't near but you're in the giant's space. */
const BODY_PRESS = COLLIDE_RADIUS + CHAR_RADIUS + 0.2;

/** Foot print — larger than a human boot. */
const FOOT_WIDTH = 0.16;
const FOOT_ELONG = 1.55;
/** Metres between plants; tuned so 2 plants ≈ one walk-clip cycle at WALK_SPEED. */
const STRIDE = 0.68;
const STANCE = 0.22;

/** Patrol loop south of spawn (xz waypoints). */
const PATROL = [
    { x: 6, z: -28 },
    { x: 18, z: -28 },
    { x: 18, z: -40 },
    { x: 6, z: -40 },
];

const _splits = new Vector4();
const _fill = new Color3(0.55, 0.48, 0.38);
const _min = new Vector3();
const _max = new Vector3();
const _normal = new Vector3();
const _yawQ = new Quaternion();
const _tiltQ = new Quaternion();
const _orient = new Quaternion();
const _hand = new Vector3();
const _keyPos = new Float32Array(24);
const _keyCol = new Float32Array(24);

const HAND_BONES = ["LeftHand", "RightHand", "LeftForeArm", "RightForeArm"];

export class Giant {
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
        this.x = PATROL[0].x;
        this.z = PATROL[0].z;
        this.yaw = 0;
        this.radius = COLLIDE_RADIUS;
        this._patrolI = 1;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._walk = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup[]} */
        this._attacks = [];
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._hitBack = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._hitWaist = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._hitChest = null;
        this._reacting = false;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._anim = null;
        this._attacking = false;
        this._attackCd = 1.5;
        this._hitT = 0;
        this._hitLanded = false;
        /** One-frame pulse when a swing connects with the player. */
        this.didHit = false;
        this._sinceSplat = 0;
        this._foot = 0;
        this._stride = STRIDE;
        this._prevX = PATROL[0].x;
        this._prevZ = PATROL[0].z;
        /** Softened ground normal for damped body tilt. */
        this._tiltN = new Vector3(0, 1, 0);

        this._depthMats = [0, 1].map((c) => this._makeDepthMaterial(c));
        this._prepassMat = this._makePrepassMaterial();

        /** @type {import("@babylonjs/core/Bones/bone").Bone[]} */
        this._strikeBones = [];
        /** Arrow impacts landed (drives every-Nth roar). */
        this._arrowHits = 0;
        /** 0..1 impact flash for the metal health bar. */
        this._hpFlash = 0;
        this._ready = this._load();
        void preloadSfx(HIT_SFX);
        void preloadSfx(ROAR_SFX);
    }

    async _load() {
        const result = await SceneLoader.ImportMeshAsync("", "", MODEL, this.scene);
        const root = result.meshes[0];
        root.name = "giantRoot";

        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh|null} */
        let body = null;
        for (const m of result.meshes) {
            if (m === root) continue;
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
                body = /** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (m);
                break;
            }
        }
        if (!body) throw new Error("giant.glb: no skinned mesh");

        // CPU skinning → position buffer is already posed; prop shaders stay rigid.
        body.computeBonesUsingShaders = false;
        if (body.skeleton) body.skeleton.returnToRest();

        this._bindPropMaterial(body);
        body.renderingGroupId = 1;
        body.isPickable = false;
        body.receiveShadows = true;
        this.shadows.registerCaster(body, (c) => this._depthMats[c], 2);
        this.depthPass.registerCaster(body, this._prepassMat);

        // Scale to target height from world bounds.
        root.computeWorldMatrix(true);
        body.computeWorldMatrix(true);
        const bi = body.getBoundingInfo();
        _min.copyFrom(bi.boundingBox.minimumWorld);
        _max.copyFrom(bi.boundingBox.maximumWorld);
        const h = Math.max(0.01, _max.y - _min.y);
        root.scaling.setAll(TARGET_HEIGHT / h);

        this.x = PATROL[0].x;
        this.z = PATROL[0].z;
        const dx0 = PATROL[1].x - PATROL[0].x;
        const dz0 = PATROL[1].z - PATROL[0].z;
        this.yaw = Math.atan2(dx0, dz0);
        this._placeRoot(root);
        root.computeWorldMatrix(true);
        body.computeWorldMatrix(true);

        this._root = root;
        this._mesh = body;

        // Cache strike bones for melee contact tests (no per-frame name search).
        this._strikeBones = [];
        if (body.skeleton) {
            for (const name of HAND_BONES) {
                const b = body.skeleton.bones.find((bone) => bone.name === name);
                if (b) this._strikeBones.push(b);
            }
        }

        // Walk is in-place; attacks are one-shots when the player is near.
        const groups = result.animationGroups || [];
        for (const g of groups) g.stop();
        this._walk = groups.find((g) => /walk/i.test(g.name)) || groups[0] || null;
        this._attacks = groups.filter(
            (g) => /attack/i.test(g.name) && !/hit/i.test(g.name)
        );
        this._hitBack = groups.find((g) => /hit_back|hit in back/i.test(g.name)) || null;
        this._hitWaist = groups.find((g) => /hit_waist/i.test(g.name)) || null;
        this._hitChest = groups.find((g) => /hit_chest|hit_reaction/i.test(g.name)) || null;
        // Runtime safety: pin Hit_Back hips XZ if keys still drift.
        if (this._hitBack) this._pinHipsXZ(this._hitBack);
        if (this._walk) {
            this._walk.start(true, WALK_ANIM_SPEED);
            this._anim = this._walk;
            // Match plant spacing to clip period so stamps land with gait.
            const span = Math.max(0.01, this._walk.to - this._walk.from);
            const fps = this._walk.targetedAnimations[0]?.animation?.framePerSecond || 30;
            const cycleSec = span / fps / WALK_ANIM_SPEED;
            // Two plants per full walk cycle.
            this._stride = Math.max(0.4, WALK_SPEED * cycleSec * 0.5);
        } else {
            this._stride = STRIDE;
        }

        return root;
    }

    _playWalk() {
        if (this._anim && this._anim !== this._walk) this._anim.stop();
        if (this._walk) {
            this._walk.start(true, WALK_ANIM_SPEED);
            this._anim = this._walk;
        }
        this._attacking = false;
        this._reacting = false;
    }

    /**
     * Arrow hit react by zone. Counts every land; roar every ROAR_EVERY.
     * Ignores react clip while already reacting.
     * @param {"back"|"waist"|"chest"|"head"} zone
     */
    playHit(zone) {
        this._arrowHits += 1;
        this._hpFlash = 1;
        if (this._arrowHits % ROAR_EVERY === 0) {
            unlockAudio();
            playSfx(ROAR_SFX, ROAR_SFX_VOL);
        }

        if (this._reacting) return;
        let clip = this._hitWaist;
        if (zone === "back") clip = this._hitBack || clip;
        else if (zone === "chest" || zone === "head") clip = this._hitChest || clip;
        else clip = this._hitWaist || this._hitChest || this._hitBack;
        if (!clip) return;

        if (this._anim) this._anim.stop();
        this._attacking = false;
        this._reacting = true;
        this._hitLanded = true; // suppress player hit mid-swing if interrupted
        clip.onAnimationGroupEndObservable.clear();
        clip.onAnimationGroupEndObservable.addOnce(() => {
            this._playWalk();
        });
        clip.start(false, 1.0);
        this._anim = clip;
    }

    /**
     * @param {Vector3} playerPos
     */
    getHealthView(playerPos) {
        if (!this._root?.isEnabled()) return null;
        const dx = playerPos.x - this.x;
        const dz = playerPos.z - this.z;
        if (dx * dx + dz * dz > HP_SHOW_RANGE * HP_SHOW_RANGE) return null;
        const ground = this.terrain.heightAt(this.x, this.z);
        return {
            id: "giant",
            name: "Laestrygonian",
            x: this.x,
            y: ground + TARGET_HEIGHT * 0.95,
            z: this.z,
            kind: /** @type {"metal"} */ ("metal"),
            ratio: 1,
            flash: this._hpFlash,
        };
    }

    /** Pin Hips XZ keys to first frame (safety for root-motion hit clips). */
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
     * True when the player is roughly in front of the giant (swing arc).
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
     * True when a swinging hand/forearm is near the player, or bodies are pressed.
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
     * Face the player and play a random attack once, then resume walking.
     * @param {number} playerX
     * @param {number} playerZ
     */
    _startAttack(playerX, playerZ) {
        if (!this._attacks.length || this._attacking || this._reacting) return;
        const clip = this._attacks[(Math.random() * this._attacks.length) | 0];
        if (this._anim) this._anim.stop();
        this._attacking = true;
        this._attackCd = ATTACK_COOLDOWN;
        this._hitT = 0;
        this._hitLanded = false;
        // Face toward player; _placeRoot + angleDamp during update refine it.
        this.yaw = Math.atan2(playerX - this.x, playerZ - this.z);
        if (this._root) this._placeRoot(this._root);

        clip.onAnimationGroupEndObservable.clear();
        clip.onAnimationGroupEndObservable.addOnce(() => {
            this._playWalk();
        });
        clip.start(false, 1.0);
        this._anim = clip;
    }

    /** Snap root to current x/z/yaw on the sand (damped tilt). */
    _placeRoot(root, dt = 1 / 60) {
        const groundY = this.terrain.heightAt(this.x, this.z);
        this.terrain.normalAt(this.x, this.z, _normal);
        // Ease tilt normal so the body doesn't snap on every dune ripple.
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
        const mat = this._makePropMaterial("giant:body", Color3.White(), albedoTex, mesh);
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
        if (!Giant._white) {
            Giant._white = RawTexture.CreateRGBATexture(
                new Uint8Array([180, 170, 155, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        mat.setTexture("albedoTex", textureOrNull || Giant._white);
        if (textureOrNull) {
            textureOrNull.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
            textureOrNull.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        }
        this._mats.push({ mat, mesh });
        return mat;
    }

    _makeDepthMaterial(cascade) {
        return new ShaderMaterial(
            "giantDepth" + cascade, this.scene,
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
            "giantPrepass", this.scene,
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
        await preloadSfx(HIT_SFX);
        await preloadSfx(ROAR_SFX);
        for (const { mat, mesh } of this._mats) {
            await whenReady(mat, mat.name, [mesh, false]);
        }
        if (this._mesh) {
            await whenReady(this._prepassMat, "giant prepass", [this._mesh, false]);
            for (let i = 0; i < this._depthMats.length; i++) {
                await whenReady(this._depthMats[i], "giant depth " + i, [this._mesh, false]);
            }
        }
    }

    /**
     * I while close → award Laestrygonians card (caller shows drop).
     * @param {Vector3} playerPos
     * @returns {{ x: number, z: number }|null}
     */
    pollCardInspect(playerPos) {
        if (!input.inspectPressed) return null;
        const dx = playerPos.x - this.x;
        const dz = playerPos.z - this.z;
        if (dx * dx + dz * dz > CARD_INSPECT_RANGE * CARD_INSPECT_RANGE) return null;
        return { x: this.x, z: this.z };
    }

    /** @param {Vector3} pos */
    resolveCollision(pos) {
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
        if (!this._mesh || !this._root) return;

        this.didHit = false;
        const h = Math.max(dt, 0);
        if (this._hpFlash > 0) this._hpFlash = Math.max(0, this._hpFlash - HP_FLASH_DECAY * h);
        if (this._attackCd > 0) this._attackCd -= h;

        const pdx = playerPos.x - this.x;
        const pdz = playerPos.z - this.z;
        const pDist = Math.hypot(pdx, pdz);
        const inRange = pDist < ATTACK_RANGE;

        // Proximity attack: when close and off cooldown, randomly swing.
        if (!this._attacking && !this._reacting && inRange && this._attackCd <= 0 && this._attacks.length) {
            // Higher chance the closer you are (always fire under ~4m).
            const chance = pDist < 4 ? 1 : 0.35 + (1 - pDist / ATTACK_RANGE) * 0.5;
            if (Math.random() < chance * Math.min(1, dt * 8)) {
                this._startAttack(playerPos.x, playerPos.z);
            }
        }

        // Timed melee window: needs near contact (hand or body press), not remote.
        if (this._attacking && !this._reacting) {
            this._hitT += Math.max(dt, 0);
            if (
                !this._hitLanded &&
                this._hitT >= HIT_DELAY &&
                this._hitT <= HIT_DELAY + HIT_WINDOW &&
                this._facingPlayer(pdx, pdz, pDist) &&
                this._inMeleeContact(playerPos, pDist)
            ) {
                this._hitLanded = true;
                this.didHit = true;
                unlockAudio();
                playSfx(HIT_SFX, HIT_SFX_VOL);
            }
        }

        // Patrol only while not attacking / reacting.
        if (!this._attacking && !this._reacting && dt > 0 && PATROL.length > 1) {
            const target = PATROL[this._patrolI];
            let dx = target.x - this.x;
            let dz = target.z - this.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 0.35) {
                this._patrolI = (this._patrolI + 1) % PATROL.length;
            } else {
                const step = Math.min(dist, WALK_SPEED * dt);
                dx /= dist;
                dz /= dist;
                this.x += dx * step;
                this.z += dz * step;
                this.yaw = angleDamp(this.yaw, Math.atan2(dx, dz), 8, dt);
            }
            this._placeRoot(this._root, dt);
        } else if (this._attacking || this._reacting) {
            // Ease face toward the player during the swing / keep plant during react.
            if (this._attacking) {
                const want = Math.atan2(pdx, pdz);
                this.yaw = angleDamp(this.yaw, want, 6, dt);
            }
            this._placeRoot(this._root, dt);
        } else {
            this._placeRoot(this._root, dt);
        }

        if (!this._attacking && !this._reacting) this._stampFeet();

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

    /** Plant alternating foot brushes — no continuous stance drag. */
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
        const px = this.x + rx * STANCE * side - fx * 0.08;
        const pz = this.z + rz * STANCE * side - fz * 0.08;
        field.brush(
            px, pz,
            FOOT_WIDTH,
            0.26 * cs,
            0.16 * cs * bs,
            Math.min(1, 0.95 * env.compressionScale),
            0,
            this.yaw,
            FOOT_ELONG,
            env.rimRoughness
        );
    }
}
