/**
 * Eumaeus the swineherd — sits west of spawn until I, then gifts the bow and limp-patrols.
 * Sacred: arrows must not harm him (ArrowPool routes to Zeus).
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
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { angleDamp } from "../character/controller.js";
import { preloadSfx, playSfx, unlockAudio } from "../combat/sfx.js";

const MODEL = "/assets/odyssey/models/eumaeus.glb";
const BOW_SFX = "/assets/sfx/eumaeus_bow.mp3";
const BOW_VOL = 0.78;

const SPAWN = { x: -24, z: 14 };
const TARGET_HEIGHT = 1.72;
const COLLIDE_RADIUS = 0.4;
const CHAR_RADIUS = 0.45;
const BODY_R = 0.3;
const HIT_PAD = 0.55;
const GIFT_RANGE = 5.2;
const LIMP_SPEED = 0.72;
const LIMP_ANIM = 1.0;
const PATROL_R = 4.5;

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

export class Eumaeus {
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

        this.x = SPAWN.x;
        this.z = SPAWN.z;
        this.yaw = Math.PI * 0.25;
        this.radius = COLLIDE_RADIUS;
        this.bodyRadius = BODY_R;
        this.hitPad = HIT_PAD;
        this.height = TARGET_HEIGHT;

        /** Sitting until first gift; then limps. */
        this.sitting = true;
        this._standingUp = false;
        this._giftedOnce = false;

        /** @type {(() => void)|null} */
        this.onGift = null;

        /** Nearby talk prompt (DOM). */
        this._hint = document.createElement("div");
        this._hint.id = "eumaeus-talk";
        this._hint.innerHTML = "Press <b>I</b> to speak with Eumaeus";
        this._hint.hidden = true;
        document.body.appendChild(this._hint);

        /** @type {import("@babylonjs/core/Meshes/transformNode").TransformNode|null} */
        this._root = null;
        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh|null} */
        this._mesh = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._sit = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._stand = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._limp = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._anim = null;

        /** @type {{x:number,z:number}[]} */
        this._patrol = [];
        this._patrolI = 0;
        this._tiltN = new Vector3(0, 1, 0);

        this._mats = [];
        this._depthMats = [0, 1].map((c) => this._makeDepthMaterial(c));
        this._prepassMat = this._makePrepassMaterial();

        this._ready = this._load();
        void preloadSfx(BOW_SFX);
    }

    get present() {
        return !!this._root?.isEnabled();
    }

    async _load() {
        const result = await SceneLoader.ImportMeshAsync("", "", MODEL, this.scene);
        const root = result.meshes[0];
        root.name = "eumaeusRoot";

        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh|null} */
        let body = null;
        for (const m of result.meshes) {
            if (m === root) continue;
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
                body = /** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (m);
                break;
            }
        }
        if (!body) throw new Error("eumaeus.glb: no skinned mesh");

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

        const groups = result.animationGroups || [];
        for (const g of groups) g.stop();

        this._sit = groups.find((g) => /sit_cross_legged/i.test(g.name)) || null;
        this._stand = groups.find((g) => /stand_up/i.test(g.name)) || null;
        this._limp = groups.find((g) => /limping_walk_2_inplace/i.test(g.name))
            || groups.find((g) => /limping_walk_inplace/i.test(g.name))
            || groups.find((g) => /limping_walk/i.test(g.name) && /inplace/i.test(g.name))
            || groups.find((g) => /limping_walk/i.test(g.name))
            || null;

        this._buildPatrol();
        this._playSitHold();
        this._placeRoot(0);
        return root;
    }

    _buildPatrol() {
        const cx = SPAWN.x;
        const cz = SPAWN.z;
        this._patrol = [
            { x: cx + PATROL_R, z: cz },
            { x: cx, z: cz + PATROL_R },
            { x: cx - PATROL_R, z: cz },
            { x: cx, z: cz - PATROL_R },
        ];
        this._patrolI = 0;
    }

    /** Loop sit, or hold last frame if the clip is a one-shot. */
    _playSitHold() {
        const clip = this._sit;
        if (!clip) return;
        if (this._anim && this._anim !== clip) this._anim.stop();
        clip.onAnimationGroupEndObservable.clear();
        clip.start(true, 1.0);
        this._anim = clip;
        this.sitting = true;
    }

    _playLimp() {
        const clip = this._limp;
        if (!clip) return;
        if (this._anim && this._anim !== clip) this._anim.stop();
        clip.onAnimationGroupEndObservable.clear();
        clip.start(true, LIMP_ANIM);
        this._anim = clip;
        this.sitting = false;
    }

    /**
     * I while close and needing a bow → stand, VO, onGift, limp.
     * @param {Vector3} playerPos
     * @param {boolean} needsBow
     * @returns {boolean} true if gift started / consumed I
     */
    pollGift(playerPos, needsBow) {
        if (!input.inspectPressed || !needsBow) return false;
        if (this._standingUp) return false;
        const dx = playerPos.x - this.x;
        const dz = playerPos.z - this.z;
        if (dx * dx + dz * dz > GIFT_RANGE * GIFT_RANGE) return false;

        this._beginGift();
        return true;
    }

    _beginGift() {
        unlockAudio();
        playSfx(BOW_SFX, BOW_VOL);
        this._giftedOnce = true;
        this._hint.hidden = true;
        if (this.onGift) this.onGift();

        const finish = () => {
            this._standingUp = false;
            this._playLimp();
        };

        if (this.sitting && this._stand) {
            this._standingUp = true;
            if (this._anim) this._anim.stop();
            this._stand.onAnimationGroupEndObservable.clear();
            this._stand.onAnimationGroupEndObservable.addOnce(finish);
            this._stand.start(false, 1.0);
            this._anim = this._stand;
            this.sitting = false;
        } else {
            finish();
        }
    }

    /**
     * Show/hide the I-to-speak cue when the player still needs a bow.
     * @param {Vector3} playerPos
     * @param {boolean} needsBow
     */
    updateTalkHint(playerPos, needsBow) {
        if (!needsBow || this._standingUp) {
            this._hint.hidden = true;
            return;
        }
        const dx = playerPos.x - this.x;
        const dz = playerPos.z - this.z;
        this._hint.hidden = dx * dx + dz * dz > GIFT_RANGE * GIFT_RANGE;
    }

    /** Sacred hit capsule — XZ near body. */
    hitTest(px, py, pz) {
        const dx = px - this.x;
        const dz = pz - this.z;
        const r = this.bodyRadius + this.hitPad;
        if (dx * dx + dz * dz > r * r) return false;
        const ground = this.terrain.heightAt(this.x, this.z);
        return py >= ground - 0.15 && py <= ground + this.height + 0.2;
    }

    /**
     * Look-ray proximity for aim warn. Closest approach in XZ along the 3D ray
     * (must divide by dx²+dz² — bare dot fails on pitched OTS aim).
     * @param {number} ox @param {number} oy @param {number} oz origin
     * @param {number} dx @param {number} dy @param {number} dz unit dir
     */
    aimHit(ox, oy, oz, dx, dy, dz) {
        if (!this.present) return false;
        const gx = this.x - ox;
        const gz = this.z - oz;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1e-6) return false;
        const t = (gx * dx + gz * dz) / d2;
        if (t < 0.35 || t > 40) return false;
        const lx = gx - dx * t;
        const lz = gz - dz * t;
        const r = this.bodyRadius + this.hitPad + 0.35;
        if (lx * lx + lz * lz > r * r) return false;
        const cy = oy + dy * t;
        const ground = this.terrain.heightAt(this.x, this.z);
        return cy >= ground - 0.45 && cy <= ground + this.height + 0.7;
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

    _placeRoot(dt) {
        const root = this._root;
        if (!root) return;
        const groundY = this.terrain.heightAt(this.x, this.z);
        this.terrain.normalAt(this.x, this.z, _normal);
        const k = 1 - Math.exp(-10 * Math.max(dt, 0));
        this._tiltN.x += (_normal.x - this._tiltN.x) * k;
        this._tiltN.y += (_normal.y - this._tiltN.y) * k;
        this._tiltN.z += (_normal.z - this._tiltN.z) * k;
        this._tiltN.normalize();

        _yawQ.set(0, Math.sin(this.yaw * 0.5), 0, Math.cos(this.yaw * 0.5));
        const nx = this._tiltN.x;
        const ny = this._tiltN.y;
        const nz = this._tiltN.z;
        const roll = Math.atan2(nx, ny);
        const pitch = Math.atan2(nz, Math.hypot(nx, ny) || 1e-6);
        Quaternion.RotationYawPitchRollToRef(0, -pitch, -roll, _tiltQ);
        _tiltQ.multiplyToRef(_yawQ, _orient);
        root.rotationQuaternion = _orient;
        root.position.set(this.x, groundY, this.z);
    }

    /**
     * @param {number} dt
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     */
    update(dt, cameraPos, env) {
        const h = Math.max(dt, 0);
        if (!this.sitting && !this._standingUp && this._limp) {
            const target = this._patrol[this._patrolI];
            let dx = target.x - this.x;
            let dz = target.z - this.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 0.35) {
                this._patrolI = (this._patrolI + 1) % this._patrol.length;
            } else if (h > 0) {
                const step = Math.min(dist, LIMP_SPEED * h);
                dx /= dist;
                dz /= dist;
                this.x += dx * step;
                this.z += dz * step;
                this.yaw = angleDamp(this.yaw, Math.atan2(dx, dz), 6, h);
            }
        }
        this._placeRoot(h);

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
            m.setFloat("albedoGain", 1.08);
            m.setFloat("panelGlow", 0.06);
            m.setFloat("keyLightCount", 0);
            this.lights.apply(m);
        }
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
        const mat = this._makePropMaterial("eumaeus", Color3.White(), albedoTex, mesh);
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
        mat.setFloat("panelGlow", 0.06);
        mat.setFloat("albedoGain", 1.08);
        mat.setColor3("fillRadiance", _fill.clone());
        mat.setFloat("keyLightCount", 0);
        mat.setArray4("keyLightPos", _keyPos);
        mat.setArray4("keyLightCol", _keyCol);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < 3; i++) mat.setTexture("cascade" + i, this.shadows.maps[i]);
        if (!Eumaeus._white) {
            Eumaeus._white = RawTexture.CreateRGBATexture(
                new Uint8Array([200, 185, 165, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        mat.setTexture("albedoTex", textureOrNull || Eumaeus._white);
        if (textureOrNull) {
            textureOrNull.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
            textureOrNull.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        }
        this._mats.push({ mat, mesh });
        return mat;
    }

    _makeDepthMaterial(cascade) {
        return new ShaderMaterial(
            "eumaeusDepth" + cascade, this.scene,
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
            "eumaeusPrepass", this.scene,
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
        await preloadSfx(BOW_SFX);
        for (const { mat, mesh } of this._mats) {
            await whenReady(mat, mat.name, [mesh, false]);
        }
        if (this._mesh) {
            await whenReady(this._prepassMat, "eumaeus prepass", [this._mesh, false]);
            for (let i = 0; i < this._depthMats.length; i++) {
                await whenReady(this._depthMats[i], "eumaeus depth " + i, [this._mesh, false]);
            }
        }
    }
}
