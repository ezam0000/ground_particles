/**
 * Authored bow.glb on LeftHand.
 *
 * Uses bone world position after skeleton.computeAbsoluteTransforms (required
 * with CPU skinning), grip-centered mesh, limbs upright, window facing aim.
 */

import "@babylonjs/loaders/glTF";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4, Color3, Quaternion } from "@babylonjs/core/Maths/math";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { S } from "../core/settings.js";
import { bindMatrixArray, whenReady } from "../core/gpuUtil.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { preloadSfx, playSfx, unlockAudio } from "./sfx.js";

const MODEL = "/assets/character/bow.glb";
const SFX_URL = "/assets/sfx/bow.mp3";
/** World height of the bow limbs (m). */
const BOW_HEIGHT = 0.72;
const SHOOT_VOL = 0.28;

const _splits = new Vector4();
const _fill = new Color3(0.42, 0.3, 0.18);
const _keyPos = new Float32Array(24);
const _keyCol = new Float32Array(24);
const _muzzle = new Vector3();
const _aim = new Vector3();
const _hand = new Vector3();
const _draw = new Vector3();
const _up = new Vector3(0, 1, 0);
const _rot = new Quaternion();
const _min = new Vector3();
const _max = new Vector3();

export class Bow {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../spells/spellLights.js").SpellLights} lights
     * @param {import("./arrows.js").ArrowPool} arrows
     */
    constructor(scene, sky, shadows, lights, arrows) {
        this.scene = scene;
        this.sky = sky;
        this.shadows = shadows;
        this.lights = lights;
        this.arrows = arrows;

        this.equipped = false;
        /** @type {import("../character/avatar.js").PlayerAvatar|null} */
        this.avatar = null;

        /** World socket — position/rotation written each draw frame. */
        this._root = new TransformNode("bowRoot", scene);
        this._root.setEnabled(false);
        this._root.rotationQuaternion = Quaternion.Identity();

        /** Scaled/centered visual under _root. */
        this._visual = new TransformNode("bowVisual", scene);
        this._visual.parent = this._root;
        this._visual.position.set(0, 0, 0);
        this._visual.rotationQuaternion = Quaternion.Identity();

        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh[]} */
        this._meshes = [];
        /** @type {ShaderMaterial[]} */
        this._mats = [];

        this._ready = this._load();
        void preloadSfx(SFX_URL);
    }

    async _load() {
        const result = await SceneLoader.ImportMeshAsync("", "", MODEL, this.scene);
        const imported = result.meshes[0];
        imported.parent = this._visual;
        imported.position.setAll(0);
        imported.rotationQuaternion = Quaternion.Identity();

        for (const m of result.meshes) {
            if (m === imported) continue;
            if (!m.getTotalVertices || m.getTotalVertices() <= 0) continue;
            m.isPickable = false;
            m.renderingGroupId = 1;
            m.receiveShadows = true;
            this._bindProp(m);
            this._meshes.push(/** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (m));
        }

        this._visual.computeWorldMatrix(true);
        for (const m of this._meshes) m.computeWorldMatrix(true);

        let h = 0;
        for (const m of this._meshes) {
            const bi = m.getBoundingInfo();
            _min.copyFrom(bi.boundingBox.minimumWorld);
            _max.copyFrom(bi.boundingBox.maximumWorld);
            h = Math.max(h, _max.y - _min.y, _max.x - _min.x);
        }
        // Scale visual so limbs ≈ BOW_HEIGHT; grip-center offset scales with it.
        if (h > 1e-4) {
            this._visual.scaling.setAll(BOW_HEIGHT / h);
            // Authored origin is the bottom tip; pull the mid-grip onto the socket.
            this._visual.position.set(0, -BOW_HEIGHT * 0.5, 0);
        }

        this._root.setEnabled(false);
    }

    _bindProp(mesh) {
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
        const mat = new ShaderMaterial(
            "bowProp:" + mesh.name, this.scene,
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
        mat.backFaceCulling = false;
        mat.setColor3("albedoColor", Color3.White());
        mat.setFloat("useTex", albedoTex ? 1 : 0);
        mat.setFloat("panelGlow", 0.06);
        mat.setFloat("albedoGain", 1.1);
        mat.setColor3("fillRadiance", _fill.clone());
        mat.setFloat("keyLightCount", 0);
        mat.setArray4("keyLightPos", _keyPos);
        mat.setArray4("keyLightCol", _keyCol);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < 3; i++) mat.setTexture("cascade" + i, this.shadows.maps[i]);
        if (!Bow._white) {
            Bow._white = RawTexture.CreateRGBATexture(
                new Uint8Array([140, 100, 60, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        mat.setTexture("albedoTex", albedoTex || Bow._white);
        mesh.material = mat;
        this._mats.push(mat);
    }

    /** @param {import("../character/avatar.js").PlayerAvatar} avatar */
    attach(avatar) {
        this.avatar = avatar;
    }

    equip() {
        this.equipped = true;
        this.setVisible(true);
    }

    setVisible(v) {
        const on = !!(v && this.equipped);
        this._root.setEnabled(on);
        for (const m of this._meshes) m.isVisible = on;
    }

    /**
     * LeftHand grip + aim-facing upright limbs. RightHand = draw / muzzle.
     * @param {Vector3} aimDir unit
     */
    _sync(aimDir) {
        const av = this.avatar;
        if (!av) return false;

        _aim.copyFrom(aimDir);
        if (_aim.lengthSquared() < 1e-8) _aim.set(0, 0, 1);
        _aim.normalize();

        av.prepareSkeleton();
        const hasLeft = av.getHandWorldPos("LeftHand", _hand);
        const hasRight = av.getHandWorldPos("RightHand", _draw);

        if (!hasLeft) {
            // Last-resort body socket if skeleton isn't ready yet.
            const p = av.controller.position;
            _hand.set(p.x + _aim.x * 0.4, p.y + 1.2, p.z + _aim.z * 0.4);
        } else {
            // Sit the grip slightly forward of the palm along aim.
            _hand.x += _aim.x * 0.06;
            _hand.y += _aim.y * 0.06;
            _hand.z += _aim.z * 0.06;
        }

        if (!hasRight) {
            _draw.copyFrom(_hand);
            _draw.x -= _aim.x * 0.25;
            _draw.y += 0.05;
            _draw.z -= _aim.z * 0.25;
        }

        // Limbs stay world-up; bow window (+Z) faces the crosshair.
        _up.set(0, 1, 0);
        Quaternion.FromLookDirectionLHToRef(_aim, _up, _rot);

        this._root.position.copyFrom(_hand);
        this._root.rotationQuaternion.copyFrom(_rot);
        return true;
    }

    /**
     * @param {Vector3} aimDir unit-ish
     */
    releaseShot(aimDir) {
        this.equip();
        unlockAudio();
        _aim.copyFrom(aimDir);
        if (_aim.lengthSquared() < 1e-6) _aim.set(0, 0.08, 1);
        _aim.normalize();

        this._sync(_aim);

        // Leave from between the hands (string → window), along aim.
        _muzzle.set(
            (_hand.x + _draw.x) * 0.5 + _aim.x * 0.25,
            (_hand.y + _draw.y) * 0.5 + _aim.y * 0.25,
            (_hand.z + _draw.z) * 0.5 + _aim.z * 0.25
        );

        playSfx(SFX_URL, SHOOT_VOL);
        this.arrows.fire(_muzzle.x, _muzzle.y, _muzzle.z, _aim.x, _aim.y, _aim.z);
    }

    /**
     * @param {number} _dt
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     * @param {Vector3|null} [aimDir]
     */
    update(_dt, cameraPos, env, aimDir = null) {
        if (this._root.isEnabled() && aimDir) this._sync(aimDir);

        if (!this._root.isEnabled()) return;
        const sky = this.sky;
        _splits.set(
            this.shadows.splits[0], this.shadows.splits[1],
            this.shadows.splits[2], this.shadows.splits[3]
        );
        for (const m of this._mats) {
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
        await this._ready;
        await preloadSfx(SFX_URL);
        this.setVisible(true);
        this.equipped = true;
        for (let i = 0; i < this._mats.length; i++) {
            await whenReady(this._mats[i], "bow " + i, [this._meshes[i], false]);
        }
        this.equipped = false;
        this.setVisible(false);
    }
}
