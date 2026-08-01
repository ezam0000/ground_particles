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
import { bindMatrixArray, whenReady } from "../core/gpuUtil.js";
import { getLerped } from "../core/envProfile.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";

const MODEL = "/assets/odyssey/models/giant.glb";

/** World height of the giant, metres. Source mesh is ~3m tall. */
const TARGET_HEIGHT = 3;
/** Feet collision radius. */
const COLLIDE_RADIUS = 0.75;
const CHAR_RADIUS = 0.45;

/** Walk speed (m/s) — clip is in-place, so we drive the root ourselves. */
const WALK_SPEED = 1.35;
/** Animation playback rate matched to WALK_SPEED stride feel. */
const WALK_ANIM_SPEED = 1.0;

/** Foot print — larger than a human boot. */
const FOOT_WIDTH = 0.16;
const FOOT_ELONG = 1.55;
const STRIDE = 0.62;
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
const _keyPos = new Float32Array(24);
const _keyCol = new Float32Array(24);

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
        this._anim = null;
        this._sinceSplat = 0;
        this._foot = 0;
        this._prevX = PATROL[0].x;
        this._prevZ = PATROL[0].z;

        this._depthMats = [0, 1].map((c) => this._makeDepthMaterial(c));
        this._prepassMat = this._makePrepassMaterial();

        this._ready = this._load();
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

        // Walk clip is in-place (hips loop with no net travel) — we translate the root.
        const groups = result.animationGroups || [];
        for (const g of groups) g.stop();
        const walk = groups.find((g) => /walk/i.test(g.name)) || groups[0];
        if (walk) {
            walk.start(true, WALK_ANIM_SPEED);
            this._anim = walk;
        }

        return root;
    }

    /** Snap root to current x/z/yaw on the sand. */
    _placeRoot(root) {
        const groundY = this.terrain.heightAt(this.x, this.z);
        this.terrain.normalAt(this.x, this.z, _normal);
        Quaternion.RotationAxisToRef(Vector3.UpReadOnly, this.yaw, _yawQ);
        Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, _normal, _tiltQ);
        _tiltQ.multiplyToRef(_yawQ, _orient);
        if (!root.rotationQuaternion) root.rotationQuaternion = _orient.clone();
        else root.rotationQuaternion.copyFrom(_orient);
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
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     */
    update(dt, cameraPos, env) {
        if (!this._mesh || !this._root) return;

        // Patrol — clip has no root motion, so translate toward the next waypoint.
        if (dt > 0 && PATROL.length > 1) {
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
                this.yaw = Math.atan2(dx, dz);
            }
            this._placeRoot(this._root);
        } else {
            this._root.position.y = this.terrain.heightAt(this.x, this.z);
        }

        this._stampFeet();

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

    /** Plant alternating foot brushes + a light drag under the stance. */
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

        // Continuous drag so the trail reads between discrete plants.
        const k = Math.min(moved, 0.4);
        field.brush(
            this.x, this.z,
            0.28,
            0.16 * k * cs,
            0.18 * k * cs * bs,
            Math.min(1, 0.7 * k * env.compressionScale),
            0,
            this.yaw,
            1.4,
            0.8 * env.rimRoughness
        );

        this._sinceSplat += moved;
        if (this._sinceSplat < STRIDE) return;
        this._sinceSplat = 0;

        const side = this._foot ? 1 : -1;
        this._foot ^= 1;
        const px = this.x + rx * STANCE * side - fx * 0.08;
        const pz = this.z + rz * STANCE * side - fz * 0.08;
        field.brush(
            px, pz,
            FOOT_WIDTH,
            0.22 * cs,
            0.14 * cs * bs,
            Math.min(1, 0.95 * env.compressionScale),
            0,
            this.yaw,
            FOOT_ELONG,
            env.rimRoughness
        );
    }
}
