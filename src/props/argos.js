/**
 * Argos — Odysseus’s dog. Idles beside Eumaeus, then follows his limp patrol.
 * I inspect → collectible + bark + particle ascend. Sacred to Zeus.
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

const MODEL = "/assets/odyssey/models/argos.glb";
const BARK_SFX = "/assets/sfx/argos_bark.mp3";
const BARK_VOL = 0.7;

const TARGET_HEIGHT = 1.65;
const COLLIDE_RADIUS = 0.48;
const CHAR_RADIUS = 0.45;
const BODY_R = 0.38;
const HIT_PAD = 0.55;
const INSPECT_RANGE = 4.2;
/** Orbit radius around Eumaeus while he sits / limps. */
const ORBIT_R = 3.2;
const ORBIT_SPEED = 0.7;
const WALK_SPEED = 1.15;
const WALK_ANIM = 1.15;

const _splits = new Vector4();
const _fill = new Color3(0.55, 0.45, 0.35);
const _min = new Vector3();
const _max = new Vector3();
const _normal = new Vector3();
const _yawQ = new Quaternion();
const _tiltQ = new Quaternion();
const _orient = new Quaternion();
const _keyPos = new Float32Array(24);
const _keyCol = new Float32Array(24);

export class Argos {
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

        /** @type {import("./eumaeus.js").Eumaeus|null} */
        this.leader = null;

        this.x = -24 + ORBIT_R;
        this.z = 14;
        this.yaw = Math.PI * 0.25;
        this.radius = COLLIDE_RADIUS;
        this.bodyRadius = BODY_R;
        this.hitPad = HIT_PAD;
        this.height = TARGET_HEIGHT;

        this.visible = true;
        this._ascending = false;
        this._ascendT = 0;
        this._baseScale = 1;
        this._orbitA = 0;

        /** @type {import("@babylonjs/core/Meshes/transformNode").TransformNode|null} */
        this._root = null;
        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh|null} */
        this._mesh = null;
        /** @type {import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null} */
        this._walk = null;
        this._walking = false;
        this._tiltN = new Vector3(0, 1, 0);

        this._mats = [];
        this._depthMats = [0, 1].map((c) => this._makeDepthMaterial(c));
        this._prepassMat = this._makePrepassMaterial();

        this._ready = this._load();
        void preloadSfx(BARK_SFX);
    }

    get present() {
        return this.visible && !this._ascending;
    }

    async _load() {
        const result = await SceneLoader.ImportMeshAsync("", "", MODEL, this.scene);
        const root = result.meshes[0];
        root.name = "argosRoot";

        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh|null} */
        let body = null;
        for (const m of result.meshes) {
            if (m === root) continue;
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
                body = /** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (m);
                break;
            }
        }
        if (!body) throw new Error("argos.glb: no skinned mesh");

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
        this._baseScale = TARGET_HEIGHT / h;
        root.scaling.setAll(this._baseScale);

        this._root = root;
        this._mesh = body;

        const groups = result.animationGroups || [];
        for (const g of groups) g.stop();
        this._walk = groups[0] || null;
        // Start walking immediately — Argos orbits Eumaeus from spawn.
        if (this._walk) {
            this._walk.start(true, WALK_ANIM);
            this._walking = true;
        }

        this._placeRoot(0);
        return root;
    }

    _setWalk(on) {
        if (!this._walk) return;
        if (on === this._walking) {
            // Keep the clip alive if Babylon stopped it.
            if (on && !this._walk.isPlaying) this._walk.start(true, WALK_ANIM);
            return;
        }
        this._walking = on;
        if (on) this._walk.start(true, WALK_ANIM);
        else this._walk.pause();
    }

    /**
     * @param {Vector3} playerPos
     * @returns {{ x: number, z: number }|null}
     */
    pollCardInspect(playerPos) {
        if (!input.inspectPressed || !this.present) return null;
        const dx = playerPos.x - this.x;
        const dz = playerPos.z - this.z;
        if (dx * dx + dz * dz > INSPECT_RANGE * INSPECT_RANGE) return null;
        unlockAudio();
        playSfx(BARK_SFX, BARK_VOL);
        return { x: this.x, z: this.z };
    }

    /**
     * Particle burst then hide for the session.
     * @param {import("../vfx/particles.js").SprayField} spray
     */
    ascend(spray) {
        if (!this.present) return;
        this._ascending = true;
        this._ascendT = 0;
        this._setWalk(false);
        const gy = this.terrain.heightAt(this.x, this.z) + 0.25;
        for (let i = 0; i < 28; i++) {
            const a = (i / 28) * Math.PI * 2;
            const sp = 0.6 + Math.random() * 1.4;
            spray.emit(
                this.x, gy, this.z,
                Math.cos(a) * sp * 0.35,
                1.2 + Math.random() * 2.4,
                Math.sin(a) * sp * 0.35,
                0.04 + Math.random() * 0.05,
                0.9 + Math.random() * 0.6,
                0,
                1.4
            );
        }
    }

    _hide() {
        this.visible = false;
        this._ascending = false;
        if (this._root) this._root.setEnabled(false);
        if (this._mesh) this._mesh.isVisible = false;
    }

    hitTest(px, py, pz) {
        if (!this.present) return false;
        const dx = px - this.x;
        const dz = pz - this.z;
        const r = this.bodyRadius + this.hitPad;
        if (dx * dx + dz * dz > r * r) return false;
        const ground = this.terrain.heightAt(this.x, this.z);
        return py >= ground - 0.1 && py <= ground + this.height + 0.25;
    }

    /**
     * Look-ray proximity for aim warn. Closest approach in XZ along the 3D ray
     * (must divide by dx²+dz² — bare dot fails on pitched OTS aim at a low dog).
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
        const r = this.bodyRadius + this.hitPad + 0.45;
        if (lx * lx + lz * lz > r * r) return false;
        const cy = oy + dy * t;
        const ground = this.terrain.heightAt(this.x, this.z);
        return cy >= ground - 0.5 && cy <= ground + this.height + 0.55;
    }

    /** @param {Vector3} pos */
    resolveCollision(pos) {
        if (!this.present) return;
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
        if (!root || !this.visible) return;
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

        let yOff = 0;
        if (this._ascending) {
            yOff = this._ascendT * 1.8;
            root.scaling.setAll(this._baseScale * Math.max(0.05, 1 - this._ascendT / 1.1));
        } else {
            root.scaling.setAll(this._baseScale);
        }
        root.position.set(this.x, groundY + yOff, this.z);
    }

    /**
     * @param {number} dt
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     */
    update(dt, cameraPos, env) {
        const h = Math.max(dt, 0);
        if (this._ascending) {
            this._ascendT += h;
            this._placeRoot(h);
            if (this._ascendT >= 1.1) this._hide();
        } else if (this.present && this.leader) {
            const L = this.leader;
            // Always orbit Eumaeus (sit or limp) so the walk clip stays alive.
            this._orbitA += ORBIT_SPEED * h;
            const tx = L.x + Math.cos(this._orbitA) * ORBIT_R;
            const tz = L.z + Math.sin(this._orbitA) * ORBIT_R;
            let dx = tx - this.x;
            let dz = tz - this.z;
            const dist = Math.hypot(dx, dz);
            if (dist > 0.02 && h > 0) {
                const step = Math.min(dist, WALK_SPEED * h);
                dx /= dist;
                dz /= dist;
                this.x += dx * step;
                this.z += dz * step;
                this.yaw = angleDamp(this.yaw, Math.atan2(dx, dz), 10, h);
            }
            this._setWalk(true);
            this._placeRoot(h);
        }

        if (!this.visible) return;
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
            m.setFloat("ambientIntensity", S.ambientIntensity * 1.15);
            m.setColor3("fillRadiance", _fill);
            m.setFloat("albedoGain", 1.25);
            m.setFloat("panelGlow", 0.08);
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
        const mat = this._makePropMaterial("argos", Color3.White(), albedoTex, mesh);
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
        mat.backFaceCulling = false;
        mat.setColor3("albedoColor", albedo);
        mat.setFloat("useTex", textureOrNull ? 1 : 0);
        mat.setFloat("panelGlow", 0.08);
        mat.setFloat("albedoGain", 1.25);
        mat.setColor3("fillRadiance", _fill.clone());
        mat.setFloat("keyLightCount", 0);
        mat.setArray4("keyLightPos", _keyPos);
        mat.setArray4("keyLightCol", _keyCol);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < 3; i++) mat.setTexture("cascade" + i, this.shadows.maps[i]);
        if (!Argos._white) {
            Argos._white = RawTexture.CreateRGBATexture(
                new Uint8Array([210, 160, 110, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        const tex = textureOrNull || Argos._white;
        mat.setTexture("albedoTex", tex);
        if (textureOrNull) {
            textureOrNull.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
            textureOrNull.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
            // Authored Meshy albedos are linear-ish after crush; keep sampling consistent with sheep.
            textureOrNull.gammaSpace = true;
        }
        this._mats.push({ mat, mesh });
        return mat;
    }

    _makeDepthMaterial(cascade) {
        return new ShaderMaterial(
            "argosDepth" + cascade, this.scene,
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
            "argosPrepass", this.scene,
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
        await preloadSfx(BARK_SFX);
        for (const { mat, mesh } of this._mats) {
            await whenReady(mat, mat.name, [mesh, false]);
        }
        if (this._mesh) {
            await whenReady(this._prepassMat, "argos prepass", [this._mesh, false]);
            for (let i = 0; i < this._depthMats.length; i++) {
                await whenReady(this._depthMats[i], "argos depth " + i, [this._mesh, false]);
            }
        }
    }
}
