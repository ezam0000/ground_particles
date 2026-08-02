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

const MODEL = "/assets/character/main_man.glb";
/** Match authored mesh (~1.82 m). */
const TARGET_HEIGHT = 1.82;
/** Sprint / high-speed threshold for the Running clip. */
const RUN_CLIP_SPEED = 3.6;
/** Below this ground speed we treat the avatar as idle (Alert). */
const IDLE_SPEED = 0.35;
/** Wait this long after stopping before playing Alert. */
const IDLE_DELAY = 0.25;

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
        this._active = null;
        this._visible = true;
        /** Seconds spent below IDLE_SPEED on the ground. */
        this._stillT = 0;

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
        if (!this._walk && groups[0]) this._walk = groups[0];

        // Initial state: alert at rest (basic game design).
        const start = this._idle || this._walk;
        if (start) {
            start.start(true, 1);
            this._active = start;
        }

        return root;
    }

    _placeRoot() {
        const root = this._root;
        if (!root) return;
        const ch = this.controller;
        const x = ch.position.x;
        const z = ch.position.z;
        this.terrain.normalAt(x, z, _normal);
        Quaternion.RotationAxisToRef(Vector3.UpReadOnly, ch.facing, _yawQ);
        Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, _normal, _tiltQ);
        _tiltQ.multiplyToRef(_yawQ, _orient);
        if (!root.rotationQuaternion) root.rotationQuaternion = _orient.clone();
        else root.rotationQuaternion.copyFrom(_orient);
        root.position.set(x, ch.position.y, z);
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
        const ch = this.controller;
        const moving = !ch.airborne && ch.speed > IDLE_SPEED;
        let want = null;
        let speed = 1;

        if (ch.airborne) {
            // Hold the last locomotion pose in the air.
            if (this._active) this._active.speedRatio = 0;
            this._stillT = 0;
            return;
        }

        if (moving) {
            this._stillT = 0;
            if (ch.speed >= RUN_CLIP_SPEED && this._run) {
                want = this._run;
                speed = Math.min(1.35, 0.85 + ch.speed01 * 0.5);
            } else if (this._walk) {
                want = this._walk;
                speed = Math.min(1.25, 0.7 + ch.speed01 * 0.55);
            }
        } else {
            this._stillT += Math.max(dt, 0);
            // After stopping: hold the last walk/run frame briefly, then Alert.
            if (this._stillT >= IDLE_DELAY && this._idle) {
                want = this._idle;
                speed = 1;
            } else if (this._active && this._active !== this._idle) {
                want = this._active;
                speed = 0;
            } else if (this._idle) {
                // Fresh load / never moved: Alert immediately.
                want = this._idle;
                speed = 1;
            }
        }

        if (want !== this._active) {
            if (this._active) this._active.stop();
            this._active = want;
            if (want) want.start(true, speed);
        } else if (want) {
            want.speedRatio = speed;
        }
    }

    /**
     * @param {number} dt
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     */
    update(dt, cameraPos, env) {
        if (!this._mesh || !this._root) return;

        this._syncAnim(dt);
        this._placeRoot();

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
