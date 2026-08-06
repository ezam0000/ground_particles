/**
 * Antinous — Iron Sentinel. Spawns after five sun-aimed shots.
 *
 * Patrol-only (no melee). Takes arrow hits; dies at 20 with zone death clips.
 * Fall_from_Bar is the spawn intro and a rare funny tantrum after first hit.
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
import { input } from "../core/input.js";

const MODEL = "/assets/odyssey/models/antinous.glb";
const IMPACT_SFX = "/assets/sfx/antinous_impact.mp3";
const DEATH_SFX = "/assets/sfx/antinous_death.mp3";
const WILL_NOT_SFX = "/assets/sfx/antinous_will_not.mp3";
const WILL_NOT_LINE = "Somebody get this beggars out of here";
const WILL_NOT_PORTRAIT = "/assets/odyssey/avatars/antinous.png";
const HEADSHOT_SFX = "/assets/sfx/headshot.mp3";
const IMPACT_VOL = 0.55;
const DEATH_VOL = 0.75;
const WILL_NOT_VOL = 0.75;
const HEADSHOT_VOL = 0.7;

const TARGET_HEIGHT = 1.85;
const COLLIDE_RADIUS = 0.42;
const CHAR_RADIUS = 0.45;
const BODY_R = 0.32;
const CHEST_Y = 1.15;
const HEAD_Y = 1.52;

const WALK_SPEED = 1.15;
const WALK_ANIM_SPEED = 1.0;
const HITS_TO_KILL = 20;
const INJURED_AT = 10;
/** Headshot damage vs body hit of 1. */
const HEAD_DAMAGE = 3;
const HP_FLASH_DECAY = 6;
const HP_SHOW_RANGE = 10;

const TANTRUM_COOLDOWN = 10;
const TANTRUM_CHANCE_PER_SEC = 0.12;
/** Player must be this close to the corpse to revive (I). */
const REVIVE_RANGE = 3.6;

const FOOT_WIDTH = 0.1;
const FOOT_ELONG = 1.4;
const STRIDE = 0.55;
const STANCE = 0.16;

const SUN_DOT = Math.cos((12 * Math.PI) / 180);

const _splits = new Vector4();
const _fill = new Color3(0.5, 0.42, 0.35);
const _min = new Vector3();
const _max = new Vector3();
const _normal = new Vector3();
const _yawQ = new Quaternion();
const _tiltQ = new Quaternion();
const _orient = new Quaternion();
const _keyPos = new Float32Array(24);
const _keyCol = new Float32Array(24);

export class Antinous {
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
        this.headY = HEAD_Y;

        /** @type {{ x:number, z:number }[]} */
        this._patrol = [];
        this._patrolI = 1;

        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._walk = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._injured = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._spawnClip = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._hitBack = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._hitWaist = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._hitChest = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._dieBack = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._dieWaist = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._dieChest = null;

        this._reacting = false;
        this._dying = false;
        this._corpse = false;
        this._tantrum = false;
        this._spawned = false;
        this._alive = false;
        this._arrowHits = 0;
        this._tantrumCd = 0;
        this._sunShots = 0;
        /** 0..1 impact flash for health bar. */
        this._hpFlash = 0;
        /** Accumulated damage toward HITS_TO_KILL (head = HEAD_DAMAGE). */
        this._damage = 0;

        /** @type {(() => void)|null} */
        this.onDeath = null;

        /** Nearby-corpse revive prompt (DOM). */
        this._hint = document.createElement("div");
        this._hint.id = "antinous-revive";
        this._hint.innerHTML = "Press <b>I</b> to revive Antinous";
        this._hint.hidden = true;
        document.body.appendChild(this._hint);

        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._anim = null;
        this._sinceSplat = 0;
        this._foot = 0;
        this._stride = STRIDE;
        this._prevX = 0;
        this._prevZ = 0;
        this._tiltN = new Vector3(0, 1, 0);

        this._depthMats = [0, 1].map((c) => this._makeDepthMaterial(c));
        this._prepassMat = this._makePrepassMaterial();

        this._ready = this._load();
        void preloadSfx(IMPACT_SFX);
        void preloadSfx(DEATH_SFX);
        void preloadSfx(WILL_NOT_SFX);
        void preloadSfx(HEADSHOT_SFX);
    }

    get alive() {
        return this._alive && !this._dying && !this._corpse;
    }

    /**
     * Health bar snapshot when near the player (null = hide).
     * @param {Vector3} playerPos
     */
    getHealthView(playerPos) {
        if (!this.alive || !this._spawned || !this._root?.isEnabled()) return null;
        const dx = playerPos.x - this.x;
        const dz = playerPos.z - this.z;
        if (dx * dx + dz * dz > HP_SHOW_RANGE * HP_SHOW_RANGE) return null;
        const ground = this.terrain.heightAt(this.x, this.z);
        return {
            id: "antinous",
            name: "Antinoös",
            x: this.x,
            y: ground + TARGET_HEIGHT * 0.95,
            z: this.z,
            kind: /** @type {"hp"} */ ("hp"),
            ratio: 1 - Math.min(1, this._damage / HITS_TO_KILL),
            flash: this._hpFlash,
        };
    }

    /** True while a dead body is left on the sand. */
    get isCorpse() {
        return this._corpse;
    }

    async _load() {
        const result = await SceneLoader.ImportMeshAsync("", "", MODEL, this.scene);
        const root = result.meshes[0];
        root.name = "antinousRoot";

        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh|null} */
        let body = null;
        for (const m of result.meshes) {
            if (m === root) continue;
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
                body = /** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (m);
                break;
            }
        }
        if (!body) throw new Error("antinous.glb: no skinned mesh");

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

        const groups = result.animationGroups || [];
        for (const g of groups) g.stop();

        this._walk = groups.find((g) => /^walking$/i.test(g.name))
            || groups.find((g) => /walking/i.test(g.name) && !/injur/i.test(g.name))
            || null;
        this._injured = groups.find((g) => /injured_walk/i.test(g.name)) || null;
        this._spawnClip = groups.find((g) => /fall_from_bar/i.test(g.name)) || null;
        this._hitBack = groups.find((g) => /hit_in_back|hit in back/i.test(g.name)) || null;
        this._hitWaist = groups.find((g) => /hit_reaction_to_waist/i.test(g.name)) || null;
        this._hitChest = groups.find((g) => /hit_reaction_1/i.test(g.name)) || null;
        this._dieBack = groups.find((g) => /dying_backwards/i.test(g.name)) || null;
        this._dieWaist = groups.find((g) => /fall_dead_from_abdominal|abdominal/i.test(g.name)) || null;
        this._dieChest = groups.find((g) => /^dead$/i.test(g.name))
            || groups.find((g) => /dead/i.test(g.name) && !/fall|abdominal|back/i.test(g.name))
            || null;

        for (const g of [this._spawnClip, this._hitBack, this._dieBack, this._dieWaist, this._dieChest]) {
            if (g) this._pinHipsXZ(g);
        }

        if (this._walk) {
            const span = Math.max(0.01, this._walk.to - this._walk.from);
            const fps = this._walk.targetedAnimations[0]?.animation?.framePerSecond || 30;
            const cycleSec = span / fps / WALK_ANIM_SPEED;
            this._stride = Math.max(0.35, WALK_SPEED * cycleSec * 0.5);
        }

        return root;
    }

    _setEnabled(on) {
        if (this._root) this._root.setEnabled(on);
        if (this._mesh) this._mesh.isVisible = on;
    }

    /**
     * Count a released shot toward the sun. Spawns on the 5th.
     * @param {Vector3} aimDir unit
     * @param {Vector3} playerPos
     */
    noteShot(aimDir, playerPos) {
        if (this._spawned) return;
        const sun = this.sky.sunDir;
        const d = aimDir.x * sun.x + aimDir.y * sun.y + aimDir.z * sun.z;
        if (d < SUN_DOT) return;
        this._sunShots += 1;
        if (this._sunShots >= 5) this.spawnNear(playerPos);
    }

    /**
     * @param {Vector3} playerPos
     */
    spawnNear(playerPos) {
        if (this._spawned || !this._root || !this._mesh) return;
        this._spawned = true;
        this._alive = true;
        this._arrowHits = 0;
        this._damage = 0;
        this._hpFlash = 0;
        this._dying = false;
        this._corpse = false;
        this._hint.hidden = true;

        const ang = Math.random() * Math.PI * 2;
        const dist = 8 + Math.random() * 4;
        this.x = playerPos.x + Math.sin(ang) * dist;
        this.z = playerPos.z + Math.cos(ang) * dist;
        this.yaw = Math.atan2(playerPos.x - this.x, playerPos.z - this.z);
        this._buildPatrol();
        this._prevX = this.x;
        this._prevZ = this.z;
        this._placeRoot(this._root, 1);
        this._setEnabled(true);

        unlockAudio();
        playVo(WILL_NOT_SFX, WILL_NOT_VOL, WILL_NOT_LINE, {
            portrait: WILL_NOT_PORTRAIT,
            featured: true,
            accentWord: "beggars",
        });

        this._tantrumCd = TANTRUM_COOLDOWN;
        const intro = this._spawnClip;
        if (intro) {
            if (this._anim) this._anim.stop();
            this._reacting = true;
            intro.onAnimationGroupEndObservable.clear();
            intro.onAnimationGroupEndObservable.addOnce(() => {
                this._playWalk();
            });
            intro.start(false, 1.0);
            this._anim = intro;
        } else {
            this._playWalk();
        }
    }

    _buildPatrol() {
        const cx = this.x;
        const cz = this.z;
        const r = 6;
        this._patrol = [
            { x: cx + r, z: cz },
            { x: cx, z: cz + r },
            { x: cx - r, z: cz },
            { x: cx, z: cz - r },
        ];
        this._patrolI = 0;
    }

    _activeWalk() {
        if (this._damage >= INJURED_AT && this._injured) return this._injured;
        return this._walk || this._injured;
    }

    _playWalk() {
        if (this._dying || this._corpse) return;
        const walk = this._activeWalk();
        if (this._anim && this._anim !== walk) this._anim.stop();
        if (walk) {
            walk.start(true, WALK_ANIM_SPEED);
            this._anim = walk;
        }
        this._reacting = false;
        this._tantrum = false;
    }

    /**
     * @param {"back"|"waist"|"chest"|"head"} zone
     */
    playHit(zone) {
        if (!this.alive) return;

        const dmg = zone === "head" ? HEAD_DAMAGE : 1;
        this._arrowHits += 1;
        this._damage += dmg;
        this._hpFlash = 1;
        unlockAudio();
        if (zone === "head") playSfx(HEADSHOT_SFX, HEADSHOT_VOL);
        else playSfx(IMPACT_SFX, IMPACT_VOL);

        if (this._damage >= HITS_TO_KILL) {
            this._die(zone === "head" ? "chest" : zone);
            return;
        }

        if (this._reacting || this._tantrum) return;

        let clip = this._hitWaist;
        if (zone === "back") clip = this._hitBack || clip;
        else if (zone === "chest" || zone === "head") clip = this._hitChest || clip;
        else clip = this._hitWaist || this._hitChest || this._hitBack;
        if (!clip) return;

        if (this._anim) this._anim.stop();
        this._reacting = true;
        clip.onAnimationGroupEndObservable.clear();
        clip.onAnimationGroupEndObservable.addOnce(() => {
            this._playWalk();
        });
        clip.start(false, 1.0);
        this._anim = clip;
    }

    /**
     * @param {"back"|"waist"|"chest"} zone
     */
    _die(zone) {
        this._dying = true;
        this._alive = false;
        this._corpse = false;
        this._hint.hidden = true;
        unlockAudio();
        playSfx(DEATH_SFX, DEATH_VOL);

        let clip = this._dieChest;
        if (zone === "back") clip = this._dieBack || clip;
        else if (zone === "waist") clip = this._dieWaist || clip;
        else clip = this._dieChest || this._dieWaist || this._dieBack;

        if (this._anim) this._anim.stop();
        if (!clip) {
            this._corpse = true;
            this._dying = false;
            if (this.onDeath) this.onDeath();
            return;
        }
        clip.onAnimationGroupEndObservable.clear();
        clip.onAnimationGroupEndObservable.addOnce(() => {
            // Leave the corpse posed on the sand — do not hide.
            this._corpse = true;
            this._dying = false;
            this._anim = clip;
            if (this.onDeath) this.onDeath();
        });
        clip.start(false, 1.0);
        this._anim = clip;
    }

    /**
     * If I is pressed near the corpse, revive in place with Fall_from_Bar.
     * @param {Vector3} playerPos
     * @returns {boolean} true if the key was consumed
     */
    pollRevive(playerPos) {
        if (!input.inspectPressed) return false;
        if (!this._corpse || !this._root?.isEnabled()) return false;
        const dx = playerPos.x - this.x;
        const dz = playerPos.z - this.z;
        if (dx * dx + dz * dz > REVIVE_RANGE * REVIVE_RANGE) return false;

        input.inspectPressed = false;
        this._revive();
        return true;
    }

    _revive() {
        this._corpse = false;
        this._dying = false;
        this._alive = true;
        this._arrowHits = 0;
        this._damage = 0;
        this._hpFlash = 0;
        this._reacting = false;
        this._tantrum = false;
        this._tantrumCd = TANTRUM_COOLDOWN;
        this._hint.hidden = true;
        // Same sand spot as the corpse.
        this._placeRoot(this._root, 1);

        unlockAudio();
        playVo(WILL_NOT_SFX, WILL_NOT_VOL, WILL_NOT_LINE, {
            portrait: WILL_NOT_PORTRAIT,
            featured: true,
            accentWord: "beggars",
        });

        const intro = this._spawnClip;
        if (intro) {
            if (this._anim) this._anim.stop();
            this._reacting = true;
            intro.onAnimationGroupEndObservable.clear();
            intro.onAnimationGroupEndObservable.addOnce(() => {
                this._playWalk();
            });
            intro.start(false, 1.0);
            this._anim = intro;
        } else {
            this._playWalk();
        }
    }

    _nearCorpse(playerPos) {
        if (!this._corpse) return false;
        const dx = playerPos.x - this.x;
        const dz = playerPos.z - this.z;
        return dx * dx + dz * dz <= REVIVE_RANGE * REVIVE_RANGE;
    }

    _tryTantrum(dt) {
        if (!this.alive || this._reacting || this._tantrum) return;
        if (this._arrowHits < 1) return;
        if (this._tantrumCd > 0) {
            this._tantrumCd -= dt;
            return;
        }
        if (!this._spawnClip) return;
        if (Math.random() > TANTRUM_CHANCE_PER_SEC * Math.max(dt, 0)) return;

        if (this._anim) this._anim.stop();
        this._tantrum = true;
        this._tantrumCd = TANTRUM_COOLDOWN;
        const clip = this._spawnClip;
        clip.onAnimationGroupEndObservable.clear();
        clip.onAnimationGroupEndObservable.addOnce(() => {
            this._playWalk();
        });
        clip.start(false, 1.0);
        this._anim = clip;
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
        const mat = this._makePropMaterial("antinous:body", Color3.White(), albedoTex, mesh);
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
        mat.setFloat("albedoGain", 1.1);
        mat.setColor3("fillRadiance", _fill.clone());
        mat.setFloat("keyLightCount", 0);
        mat.setArray4("keyLightPos", _keyPos);
        mat.setArray4("keyLightCol", _keyCol);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < 3; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        if (!Antinous._white) {
            Antinous._white = RawTexture.CreateRGBATexture(
                new Uint8Array([160, 150, 140, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        mat.setTexture("albedoTex", textureOrNull || Antinous._white);
        if (textureOrNull) {
            textureOrNull.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
            textureOrNull.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        }
        this._mats.push({ mat, mesh });
        return mat;
    }

    _makeDepthMaterial(cascade) {
        return new ShaderMaterial(
            "antinousDepth" + cascade, this.scene,
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
            "antinousPrepass", this.scene,
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
        await preloadSfx(IMPACT_SFX);
        await preloadSfx(DEATH_SFX);
        await preloadSfx(WILL_NOT_SFX);
        await preloadSfx(HEADSHOT_SFX);
        for (const { mat, mesh } of this._mats) {
            await whenReady(mat, mat.name, [mesh, false]);
        }
        if (this._mesh) {
            await whenReady(this._prepassMat, "antinous prepass", [this._mesh, false]);
            for (let i = 0; i < this._depthMats.length; i++) {
                await whenReady(this._depthMats[i], "antinous depth " + i, [this._mesh, false]);
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

        this._hint.hidden = !this._nearCorpse(playerPos);

        const h = Math.max(dt, 0);
        if (this._hpFlash > 0) this._hpFlash = Math.max(0, this._hpFlash - HP_FLASH_DECAY * h);
        this._tryTantrum(h);

        const busy = this._reacting || this._tantrum || this._dying || this._corpse;
        if (!busy && h > 0 && this._patrol.length > 1 && this.alive) {
            const target = this._patrol[this._patrolI];
            let dx = target.x - this.x;
            let dz = target.z - this.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 0.35) {
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
        } else {
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
            m.setFloat("ambientIntensity", S.ambientIntensity * 1.25);
            m.setColor3("fillRadiance", _fill);
            m.setFloat("albedoGain", 1.1);
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
        const px = this.x + rx * STANCE * side - fx * 0.06;
        const pz = this.z + rz * STANCE * side - fz * 0.06;
        field.brush(
            px, pz,
            FOOT_WIDTH,
            0.2 * cs,
            0.12 * cs * bs,
            Math.min(1, 0.9 * env.compressionScale),
            0,
            this.yaw,
            FOOT_ELONG,
            env.rimRoughness
        );
    }
}
