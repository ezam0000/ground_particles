/**
 * Pooled ballistic arrows — no allocation in the fire/update path.
 */

import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4, Color3, Quaternion, Axis } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { bindMatrixArray, whenReady } from "../core/gpuUtil.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";

import { preloadSfx, playSfx, unlockAudio } from "./sfx.js";

const POOL = 12;
const ARROW_LEN = 0.85;
const ARROW_SPEED = 48;
const GRAVITY = 9.5;
const LIFE = 4.5;
const HIT_RADIUS = 0.9;
/** Chest/head band starts this high above giant feet (m). */
const CHEST_Y = 1.7;
const IMPACT_SFX = "/assets/sfx/arrow_impact.mp3";
const IMPACT_VOL = 0.55;

const _splits = new Vector4();
const _fill = new Color3(0.45, 0.4, 0.32);
const _dir = new Vector3();
const _orient = new Quaternion();
const _keyPos = new Float32Array(24);
const _keyCol = new Float32Array(24);
const _up = Axis.Y;

export class ArrowPool {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../spells/spellLights.js").SpellLights} lights
     */
    constructor(scene, terrain, sky, shadows, lights) {
        this.scene = scene;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;
        this.lights = lights;

        this._alive = new Uint8Array(POOL);
        this._life = new Float32Array(POOL);
        this._px = new Float32Array(POOL);
        this._py = new Float32Array(POOL);
        this._pz = new Float32Array(POOL);
        this._vx = new Float32Array(POOL);
        this._vy = new Float32Array(POOL);
        this._vz = new Float32Array(POOL);
        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh[]} */
        this._meshes = [];
        this._mats = [];
        /** @type {((zone: "back"|"waist"|"chest", x:number, y:number, z:number) => void)|null} */
        this.onGiantHit = null;
        /** @type {import("../props/giant.js").Giant|null} */
        this.giant = null;

        void preloadSfx(IMPACT_SFX);

        for (let i = 0; i < POOL; i++) {
            const m = CreateCylinder(
                "arrow" + i,
                { height: ARROW_LEN, diameterTop: 0.012, diameterBottom: 0.028, tessellation: 6 },
                scene
            );
            m.isVisible = false;
            m.isPickable = false;
            m.renderingGroupId = 1;
            m.rotationQuaternion = Quaternion.Identity();
            this._bindProp(m, new Color3(0.55, 0.42, 0.28));
            this._meshes.push(m);
        }
    }

    _bindProp(mesh, albedo) {
        const mat = new ShaderMaterial(
            "arrowProp:" + mesh.name, this.scene,
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
        mat.setFloat("useTex", 0);
        mat.setFloat("panelGlow", 0.05);
        mat.setFloat("albedoGain", 1.1);
        mat.setColor3("fillRadiance", _fill.clone());
        mat.setFloat("keyLightCount", 0);
        mat.setArray4("keyLightPos", _keyPos);
        mat.setArray4("keyLightCol", _keyCol);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < 3; i++) mat.setTexture("cascade" + i, this.shadows.maps[i]);
        if (!ArrowPool._white) {
            ArrowPool._white = RawTexture.CreateRGBATexture(
                new Uint8Array([160, 140, 110, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        mat.setTexture("albedoTex", ArrowPool._white);
        mesh.material = mat;
        this._mats.push(mat);
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} dx
     * @param {number} dy
     * @param {number} dz
     */
    fire(x, y, z, dx, dy, dz) {
        let slot = -1;
        for (let i = 0; i < POOL; i++) {
            if (!this._alive[i]) { slot = i; break; }
        }
        if (slot < 0) slot = 0; // recycle oldest-ish

        const len = Math.hypot(dx, dy, dz) || 1;
        this._alive[slot] = 1;
        this._life[slot] = LIFE;
        this._px[slot] = x;
        this._py[slot] = y;
        this._pz[slot] = z;
        this._vx[slot] = (dx / len) * ARROW_SPEED;
        this._vy[slot] = (dy / len) * ARROW_SPEED;
        this._vz[slot] = (dz / len) * ARROW_SPEED;
        this._meshes[slot].isVisible = true;
        this._orientMesh(slot);
    }

    _orientMesh(i) {
        _dir.set(this._vx[i], this._vy[i], this._vz[i]);
        const s = _dir.length();
        if (s < 1e-5) return;
        _dir.scaleInPlace(1 / s);
        Quaternion.FromUnitVectorsToRef(_up, _dir, _orient);
        this._meshes[i].rotationQuaternion.copyFrom(_orient);
        this._meshes[i].position.set(this._px[i], this._py[i], this._pz[i]);
    }

    _kill(i) {
        this._alive[i] = 0;
        this._meshes[i].isVisible = false;
    }

    _playImpact() {
        unlockAudio();
        playSfx(IMPACT_SFX, IMPACT_VOL);
    }

    /**
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @param {number} vx
     * @param {number} vz
     * @returns {"back"|"waist"|"chest"|null}
     */
    _classifyGiantHit(px, py, pz, vx, vz) {
        const g = this.giant;
        if (!g) return null;
        const dx = px - g.x;
        const dz = pz - g.z;
        const r = g.radius + HIT_RADIUS;
        if (dx * dx + dz * dz > r * r) return null;
        const ground = this.terrain.heightAt(g.x, g.z);
        if (py < ground - 0.2 || py > ground + 3.4) return null;

        const fx = Math.sin(g.yaw);
        const fz = Math.cos(g.yaw);
        const h = Math.hypot(vx, vz) || 1;
        const fromBack = (vx / h) * fx + (vz / h) * fz > 0.25;
        if (fromBack) return "back";
        const localY = py - ground;
        return localY >= CHEST_Y ? "chest" : "waist";
    }

    /**
     * @param {number} dt
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     */
    update(dt, cameraPos, env) {
        const h = Math.min(dt, 1 / 20);
        const g = this.giant;

        for (let i = 0; i < POOL; i++) {
            if (!this._alive[i]) continue;
            this._life[i] -= h;
            if (this._life[i] <= 0) { this._kill(i); continue; }

            this._vy[i] -= GRAVITY * h;
            this._px[i] += this._vx[i] * h;
            this._py[i] += this._vy[i] * h;
            this._pz[i] += this._vz[i] * h;

            const ground = this.terrain.heightAt(this._px[i], this._pz[i]);
            if (this._py[i] <= ground + 0.02) {
                this._kill(i);
                continue;
            }

            if (g) {
                const zone = this._classifyGiantHit(
                    this._px[i], this._py[i], this._pz[i],
                    this._vx[i], this._vz[i]
                );
                if (zone) {
                    const hx = this._px[i], hy = this._py[i], hz = this._pz[i];
                    this._kill(i);
                    this._playImpact();
                    if (this.onGiantHit) this.onGiantHit(zone, hx, hy, hz);
                    continue;
                }
            }

            this._orientMesh(i);
        }

        const sky = this.sky;
        _splits.set(
            this.shadows.splits[0], this.shadows.splits[1],
            this.shadows.splits[2], this.shadows.splits[3]
        );
        for (let i = 0; i < this._mats.length; i++) {
            if (!this._alive[i]) continue;
            const m = this._mats[i];
            m.setVector3("cameraPos", cameraPos);
            m.setVector3("sunDir", sky.sunDir);
            m.setColor3("sunRadiance", sky.sunRadiance);
            m.setArray4("shR", sky.sh);
            bindMatrixArray(m, "cascadeMatrices", this.shadows.matrixData);
            m.setVector4("cascadeSplits", _splits);
            m.setArray4("cascadeParams", this.shadows.paramData);
            m.setFloat("shadowTexel", this.shadows.texelSize);
            m.setFloat("shadowSoftness", 1.5);
            m.setFloat("shadowBias", 0.02);
            m.setFloat("fogDensity", env.fogDensity);
            m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
            m.setFloat("fogStart", S.fogStart);
            m.setFloat("aerialStrength", env.aerialStrength);
            m.setFloat("ambientIntensity", S.ambientIntensity * 1.1);
            m.setColor3("fillRadiance", _fill);
            m.setFloat("keyLightCount", 0);
            this.lights.apply(m);
        }
    }

    async warmUp() {
        for (let i = 0; i < POOL; i++) {
            this._meshes[i].isVisible = true;
            await whenReady(this._mats[i], "arrow " + i, [this._meshes[i], false]);
            this._meshes[i].isVisible = false;
        }
        await preloadSfx(IMPACT_SFX);
    }
}
