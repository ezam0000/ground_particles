/**
 * Four sheep patrol east of spawn. Arrow hits play a random baa; die after 2 hits.
 * When the flock is wiped, `onAllDead` fires once (Polyphemus spawn hook).
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

const MODEL = "/assets/odyssey/models/sheep.glb";
const SFX = [
    "/assets/sfx/sheep_1.mp3",
    "/assets/sfx/sheep_2.mp3",
    "/assets/sfx/sheep_3.mp3",
];
const SFX_VOL = 0.55;

const COUNT = 4;
const HITS_TO_KILL = 2;
const TARGET_HEIGHT = 0.95;
const COLLIDE_RADIUS = 0.38;
const CHAR_RADIUS = 0.45;
const HIT_PAD = 0.55;
const BODY_R = 0.28;
const WALK_SPEED = 0.85;
const WALK_ANIM_SPEED = 1.0;
const SINK_DUR = 0.85;
/** Alive flock + I after this many play-seconds awards the Sheep card (if none killed). */
const CARD_DELAY = 30;
const CARD_INSPECT_RANGE = 3.8;

/** Pasture center east of spawn (away from other landmarks). */
const PASTURE = { x: 28, z: -12 };
const PASTURE_R = 5.5;

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

/**
 * @typedef {{
 *   root: import("@babylonjs/core/Meshes/transformNode").TransformNode,
 *   mesh: import("@babylonjs/core/Meshes/mesh").Mesh,
 *   walk: import("@babylonjs/core/Animations/animationGroup").AnimationGroup|null,
 *   x: number, z: number, yaw: number,
 *   hits: number, alive: boolean, sinking: boolean, sinkT: number,
 *   patrol: {x:number,z:number}[], patrolI: number,
 *   tiltN: Vector3,
 * }} SheepUnit
 */

export class SheepFlock {
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

        /** @type {SheepUnit[]} */
        this.sheep = [];
        this.radius = COLLIDE_RADIUS;
        this.bodyRadius = BODY_R;
        this.hitPad = HIT_PAD;

        /** @type {(() => void)|null} */
        this.onAllDead = null;
        this._allDeadFired = false;
        /** True once any sheep dies — locks out the peaceful Sheep card. */
        this._killedAny = false;

        /** @type {{ mat: import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial, mesh: import("@babylonjs/core/Meshes/mesh").Mesh }[]} */
        this._mats = [];
        this._depthMats = [0, 1].map((c) => this._makeDepthMaterial(c));
        this._prepassMat = this._makePrepassMaterial();

        this._ready = this._loadAll();
        for (const u of SFX) void preloadSfx(u);
    }

    get allDead() {
        return this.sheep.length > 0 && this.sheep.every((s) => !s.alive && !s.sinking);
    }

    async _loadAll() {
        const loads = [];
        for (let i = 0; i < COUNT; i++) loads.push(this._loadOne(i));
        await Promise.all(loads);
    }

    /**
     * @param {number} index
     */
    async _loadOne(index) {
        const result = await SceneLoader.ImportMeshAsync("", "", MODEL, this.scene);
        const root = result.meshes[0];
        root.name = "sheepRoot" + index;

        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh|null} */
        let body = null;
        for (const m of result.meshes) {
            if (m === root) continue;
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
                body = /** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (m);
                break;
            }
        }
        if (!body) throw new Error("sheep.glb: no skinned mesh");

        body.computeBonesUsingShaders = false;
        if (body.skeleton) body.skeleton.returnToRest();

        this._bindPropMaterial(body, index);
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

        const ang = (index / COUNT) * Math.PI * 2 + 0.4;
        const dist = 2.2 + (index % 2) * 1.4;
        const x = PASTURE.x + Math.sin(ang) * dist;
        const z = PASTURE.z + Math.cos(ang) * dist;
        const patrol = this._ringPatrol(x, z, PASTURE_R * (0.55 + (index % 3) * 0.12));

        /** @type {SheepUnit} */
        const unit = {
            root,
            mesh: body,
            walk: null,
            x,
            z,
            yaw: Math.atan2(patrol[1].x - x, patrol[1].z - z),
            hits: 0,
            alive: true,
            sinking: false,
            sinkT: 0,
            patrol,
            patrolI: 1,
            tiltN: new Vector3(0, 1, 0),
            bodyRadius: BODY_R,
        };

        this._placeRoot(unit, 1);

        const groups = result.animationGroups || [];
        for (const g of groups) g.stop();
        unit.walk = groups[0] || null;
        if (unit.walk) {
            unit.walk.start(true, WALK_ANIM_SPEED);
        }

        this.sheep.push(unit);
    }

    /**
     * @param {number} cx
     * @param {number} cz
     * @param {number} r
     */
    _ringPatrol(cx, cz, r) {
        return [
            { x: cx + r, z: cz },
            { x: cx, z: cz + r },
            { x: cx - r, z: cz },
            { x: cx, z: cz - r },
        ];
    }

    /**
     * @param {SheepUnit} unit
     * @param {number} [dt]
     */
    _placeRoot(unit, dt = 1 / 60) {
        const root = unit.root;
        const groundY = this.terrain.heightAt(unit.x, unit.z);
        this.terrain.normalAt(unit.x, unit.z, _normal);
        const k = 1 - Math.exp(-6 * Math.max(dt, 1 / 120));
        unit.tiltN.x += (_normal.x * 0.45 - unit.tiltN.x) * k;
        unit.tiltN.y += (_normal.y - unit.tiltN.y) * k;
        unit.tiltN.z += (_normal.z * 0.45 - unit.tiltN.z) * k;
        const nLen = Math.hypot(unit.tiltN.x, unit.tiltN.y, unit.tiltN.z) || 1;
        _normal.set(unit.tiltN.x / nLen, unit.tiltN.y / nLen, unit.tiltN.z / nLen);

        Quaternion.RotationAxisToRef(Vector3.UpReadOnly, unit.yaw, _yawQ);
        Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, _normal, _tiltQ);
        _tiltQ.multiplyToRef(_yawQ, _orient);
        if (!root.rotationQuaternion) root.rotationQuaternion = _orient.clone();
        else {
            const sk = 1 - Math.exp(-10 * Math.max(dt, 1 / 120));
            Quaternion.SlerpToRef(root.rotationQuaternion, _orient, sk, root.rotationQuaternion);
        }
        const sink = unit.sinking ? (unit.sinkT / SINK_DUR) * 0.55 : 0;
        root.position.set(unit.x, groundY - sink, unit.z);
    }

    /**
     * @param {import("@babylonjs/core/Meshes/mesh").Mesh} mesh
     * @param {number} index
     */
    _bindPropMaterial(mesh, index) {
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
        const mat = this._makePropMaterial("sheep:" + index, Color3.White(), albedoTex, mesh);
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
        mat.setFloat("panelGlow", 0.08);
        mat.setFloat("albedoGain", 1.12);
        mat.setColor3("fillRadiance", _fill.clone());
        mat.setFloat("keyLightCount", 0);
        mat.setArray4("keyLightPos", _keyPos);
        mat.setArray4("keyLightCol", _keyCol);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < 3; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        if (!SheepFlock._white) {
            SheepFlock._white = RawTexture.CreateRGBATexture(
                new Uint8Array([210, 205, 195, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        mat.setTexture("albedoTex", textureOrNull || SheepFlock._white);
        if (textureOrNull) {
            textureOrNull.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
            textureOrNull.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        }
        this._mats.push({ mat, mesh });
        return mat;
    }

    _makeDepthMaterial(cascade) {
        return new ShaderMaterial(
            "sheepDepth" + cascade, this.scene,
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
            "sheepPrepass", this.scene,
            { vertex: "staticPrepass", fragment: "prepass" },
            {
                attributes: ["position"],
                uniforms: ["world", "viewProjection"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
    }

    /**
     * Arrow impact on a living sheep.
     * @param {SheepUnit} unit
     */
    playHit(unit) {
        if (!unit?.alive) return;
        unlockAudio();
        playSfx(SFX[(Math.random() * SFX.length) | 0], SFX_VOL);
        unit.hits += 1;
        if (unit.hits < HITS_TO_KILL) return;

        unit.alive = false;
        unit.sinking = true;
        unit.sinkT = 0;
        this._killedAny = true;
        if (unit.walk) unit.walk.stop();
    }

    /**
     * Peaceful inspect: after CARD_DELAY with no kills, I near a living sheep
     * plays a baa and returns that sheep’s xz for the collectible drop.
     * @param {Vector3} playerPos
     * @param {number} gameTime seconds since play start
     * @returns {{ x: number, z: number }|null}
     */
    pollCardInspect(playerPos, gameTime) {
        if (!input.inspectPressed) return null;
        if (this._killedAny || gameTime < CARD_DELAY) return null;

        let best = null;
        let bestD2 = CARD_INSPECT_RANGE * CARD_INSPECT_RANGE;
        for (let i = 0; i < this.sheep.length; i++) {
            const s = this.sheep[i];
            if (!s.alive) continue;
            const dx = playerPos.x - s.x;
            const dz = playerPos.z - s.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = s;
            }
        }
        if (!best) return null;

        unlockAudio();
        playSfx(SFX[(Math.random() * SFX.length) | 0], SFX_VOL);
        return { x: best.x, z: best.z };
    }

    _notifyAllDead() {
        if (this._allDeadFired || !this.allDead) return;
        this._allDeadFired = true;
        if (this.onAllDead) this.onAllDead();
    }

    async warmUp() {
        await this._ready;
        for (const u of SFX) await preloadSfx(u);
        for (const { mat, mesh } of this._mats) {
            await whenReady(mat, mat.name, [mesh, false]);
        }
        const first = this.sheep[0]?.mesh;
        if (first) {
            await whenReady(this._prepassMat, "sheep prepass", [first, false]);
            for (let i = 0; i < this._depthMats.length; i++) {
                await whenReady(this._depthMats[i], "sheep depth " + i, [first, false]);
            }
        }
    }

    /** @param {Vector3} pos */
    resolveCollision(pos) {
        for (let i = 0; i < this.sheep.length; i++) {
            const s = this.sheep[i];
            if (!s.alive && !s.sinking) continue;
            const dx = pos.x - s.x;
            const dz = pos.z - s.z;
            const min = COLLIDE_RADIUS + CHAR_RADIUS;
            const d2 = dx * dx + dz * dz;
            if (d2 >= min * min || d2 < 1e-8) continue;
            const d = Math.sqrt(d2);
            const k = min / d;
            pos.x = s.x + dx * k;
            pos.z = s.z + dz * k;
        }
    }

    /**
     * @param {number} dt
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     */
    update(dt, cameraPos, env) {
        const h = Math.max(dt, 0);
        for (let i = 0; i < this.sheep.length; i++) {
            const s = this.sheep[i];
            if (s.sinking) {
                s.sinkT += h;
                this._placeRoot(s, h);
                if (s.sinkT >= SINK_DUR) {
                    s.sinking = false;
                    s.root.setEnabled(false);
                    s.mesh.isVisible = false;
                    this._notifyAllDead();
                }
                continue;
            }
            if (!s.alive) continue;

            const target = s.patrol[s.patrolI];
            let dx = target.x - s.x;
            let dz = target.z - s.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 0.3) {
                s.patrolI = (s.patrolI + 1) % s.patrol.length;
            } else if (h > 0) {
                const step = Math.min(dist, WALK_SPEED * h);
                dx /= dist;
                dz /= dist;
                s.x += dx * step;
                s.z += dz * step;
                s.yaw = angleDamp(s.yaw, Math.atan2(dx, dz), 7, h);
            }
            this._placeRoot(s, h);
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
            m.setFloat("panelGlow", 0.08);
            m.setFloat("keyLightCount", 0);
            this.lights.apply(m);
        }
    }
}
