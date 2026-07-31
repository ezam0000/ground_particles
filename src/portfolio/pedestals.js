/**
 * Portfolio pedestals — authored GLB pillars in three plazas.
 *
 * Education and jobs each get a unique model; every project reuses
 * `projects.glb`. Approach for the DOM card; E opens a link when present.
 * Pillars collide. Dedicated key lights (not the soft spell pool) keep
 * dark authored GLBs readable from every camera angle.
 */

import "@babylonjs/loaders/glTF";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4, Quaternion, Color3 } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { bindMatrixArray, whenReady } from "../core/gpuUtil.js";
import { input } from "../core/input.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { ProjectCard } from "./card.js";
import projects from "./projects.json";
import experience from "./experience.json";
import education from "./education.json";

const MODEL_DIR = "/assets/odyssey/models/";

/** Per-entry GLB. Projects fall through to PROJECTS_GLB. */
const MODEL_BY_ID = {
    "columbia-university": "columbia.glb",
    "baruch-college": "baruch.glb",
    "northeastern-university": "neu2.glb",
    carebeam: "carebeam.glb",
    "apple-inc": "apple.glb",
    "goldman-sachs": "goldman.glb",
    secret: "latest_job_secret.glb",
};
const PROJECTS_GLB = "projects.glb";

/** Target world height for a pillar, metres. */
const TARGET_HEIGHT = 2.2;
const CARD_RANGE = 3.8;
const INSPECT_RANGE = 5.2;
const CHAR_RADIUS = 0.45;
const COLLIDE_RADIUS = 0.85;

const PLAZAS = {
    school: {
        cx: -14, cz: 5, radius: 6.5,
        arcStart: -0.55, arcSpan: 2.4,
        light: [1.0, 0.90, 0.70],
    },
    job: {
        cx: 2, cz: 16, radius: 7.5,
        arcStart: 0.25, arcSpan: 2.8,
        light: [1.0, 0.78, 0.48],
    },
    project: {
        cx: 18, cz: -6, radius: 12.0,
        arcStart: -2.6, arcSpan: 4.0,
        light: [0.95, 0.85, 0.58],
    },
};

const _normal = new Vector3();
const _yawQ = new Quaternion();
const _tiltQ = new Quaternion();
const _orient = new Quaternion();
const _splits = new Vector4();
const _min = new Vector3();
const _max = new Vector3();
const _fill = new Color3(0.55, 0.48, 0.38);
const _near = [];
/** Prop-only key lights (6 slots × vec4). Pre-sized — no alloc in update. */
const KEY_LIGHT_MAX = 6;
const _keyPos = new Float32Array(KEY_LIGHT_MAX * 4);
const _keyCol = new Float32Array(KEY_LIGHT_MAX * 4);

function pushKey(n, x, y, z, radius, r, g, b, intensity) {
    if (n >= KEY_LIGHT_MAX) return n;
    const i = n * 4;
    _keyPos[i] = x; _keyPos[i + 1] = y; _keyPos[i + 2] = z; _keyPos[i + 3] = radius;
    _keyCol[i] = r; _keyCol[i + 1] = g; _keyCol[i + 2] = b; _keyCol[i + 3] = intensity;
    return n + 1;
}

function glbFor(entry) {
    if (entry.kind === "project") return PROJECTS_GLB;
    return MODEL_BY_ID[entry.id] || PROJECTS_GLB;
}

export class Pedestals {
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
        this.card = new ProjectCard();

        this._mats = [];
        this._points = [];
        this._plazas = Object.entries(PLAZAS).map(([zone, p]) => ({ zone, ...p }));
        this._depthMats = [0, 1].map((c) => this._makeDepthMaterial(c));
        this._prepassMat = this._makePrepassMaterial();
        /** @type {Map<string, import("@babylonjs/core/Meshes/mesh").Mesh>} */
        this._templates = new Map();
        /** @type {object|null} */
        this._inspectPoint = null;

        this._ready = this._loadAll();
    }

    /**
     * Toggle camera inspect on the nearest pillar. Call once per frame before
     * character / camera update so movement freezes the same frame.
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {Vector3} playerPos
     */
    pollInspect(rig, playerPos) {
        if (!input.inspectPressed) return;

        if (input.inspecting || rig.inspecting) {
            rig.endInspect();
            input.inspecting = false;
            this._inspectPoint = null;
            this.card.setInspecting(false);
            return;
        }

        let best = null;
        let bestD2 = INSPECT_RANGE * INSPECT_RANGE;
        for (let i = 0; i < this._points.length; i++) {
            const pt = this._points[i];
            const d2 = (playerPos.x - pt.x) ** 2 + (playerPos.z - pt.z) ** 2;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = pt;
            }
        }
        if (!best) return;

        this._inspectPoint = best;
        input.inspecting = true;
        rig.beginInspect(best.x, best.y, best.z);
        this.card.show(best.project);
        this.card.setInspecting(true);
    }

    async _loadAll() {
        const needed = new Set([PROJECTS_GLB]);
        for (const e of [...education, ...experience]) {
            needed.add(glbFor(e));
        }
        await Promise.all([...needed].map((f) => this._loadTemplate(f)));

        const groups = [
            { zone: "school", list: education },
            { zone: "job", list: experience },
            { zone: "project", list: projects },
        ];

        for (const { zone, list } of groups) {
            const plaza = PLAZAS[zone];
            const n = list.length;
            for (let i = 0; i < n; i++) {
                const entry = { ...list[i], _zone: zone, _i: i };
                const t = n === 1 ? 0.5 : i / (n - 1);
                const a = plaza.arcStart + t * plaza.arcSpan;
                const r = plaza.radius * 0.72;
                const x = plaza.cx + Math.cos(a) * r;
                const z = plaza.cz + Math.sin(a) * r;
                this._plant(entry, x, z, plaza);
            }
        }
    }

    async _loadTemplate(file) {
        if (this._templates.has(file)) return this._templates.get(file);

        const result = await SceneLoader.ImportMeshAsync(
            null, MODEL_DIR, file, this.scene
        );
        // Hide the imported root; we clone it per placement.
        const roots = result.meshes.filter((m) => !m.parent);
        const root = roots[0] || result.meshes[0];
        if (!root) throw new Error("empty glb: " + file);

        // Collect renderable children (skip empty transform nodes).
        const solids = [];
        for (const m of result.meshes) {
            if (!m.getTotalVertices || m.getTotalVertices() === 0) {
                m.isVisible = false;
                continue;
            }
            solids.push(m);
            this._bindPropMaterial(m);
            m.renderingGroupId = 1;
            m.isPickable = false;
            m.receiveShadows = true;
        }

        // Parent everything under one root for easy clone + place.
        for (const m of solids) {
            if (m === root) continue;
            // Keep existing local transforms relative to file root.
        }
        root.setEnabled(false);
        root.isVisible = false;
        this._templates.set(file, root);
        this._templates.set(file + ":solids", solids);
        return root;
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
        const mat = this._makePropMaterial(
            "glb:" + mesh.name, Color3.White(), albedoTex, mesh
        );
        mesh.material = mat;
        if (old && old !== mat) {
            // Don't dispose — glTF may share textures we still hold.
        }
    }

    _plant(entry, x, z, plaza) {
        const file = glbFor(entry);
        const template = this._templates.get(file);
        const clone = template.clone("ped:" + entry.kind + ":" + entry.id, null);
        clone.setEnabled(true);
        clone.isVisible = true;

        // Walk hierarchy: show solid meshes, register casters.
        const stack = [clone];
        const solids = [];
        while (stack.length) {
            const m = stack.pop();
            if (m.getChildMeshes) stack.push(...m.getChildMeshes(false));
            if (m.getTotalVertices && m.getTotalVertices() > 0) {
                m.isVisible = true;
                m.renderingGroupId = 1;
                m.isPickable = false;
                solids.push(m);
                this.shadows.registerCaster(m, (c) => this._depthMats[c], 2);
                this.depthPass.registerCaster(m, this._prepassMat);
            }
        }

        // Scale to target height from the clone's world bounds.
        clone.computeWorldMatrix(true);
        for (const m of solids) m.computeWorldMatrix(true);
        _min.set(Infinity, Infinity, Infinity);
        _max.set(-Infinity, -Infinity, -Infinity);
        for (const m of solids) {
            const bi = m.getBoundingInfo();
            const mn = bi.boundingBox.minimumWorld;
            const mx = bi.boundingBox.maximumWorld;
            _min.minimizeInPlace(mn);
            _max.maximizeInPlace(mx);
        }
        const h = Math.max(0.01, _max.y - _min.y);
        const s = TARGET_HEIGHT / h;
        clone.scaling.setAll(s);
        clone.computeWorldMatrix(true);

        const groundY = this.terrain.heightAt(x, z);
        this.terrain.normalAt(x, z, _normal);

        // Face plaza centre.
        const yaw = Math.atan2(plaza.cx - x, plaza.cz - z);
        Quaternion.RotationAxisToRef(Vector3.UpReadOnly, yaw, _yawQ);
        Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, _normal, _tiltQ);
        _tiltQ.multiplyToRef(_yawQ, _orient);
        clone.rotationQuaternion = _orient.clone();
        clone.position.set(x, groundY, z);

        // Recompute after scale for collision height / light anchor.
        for (const m of solids) m.computeWorldMatrix(true);
        this._points.push({
            project: entry, x, z,
            radius: COLLIDE_RADIUS,
            y: groundY + TARGET_HEIGHT * 0.55,
            root: clone,
        });
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
        // Crushed albedos are already bright — keep lift modest so bloom stays calm.
        mat.setFloat("panelGlow", 0.12);
        mat.setFloat("albedoGain", 1.15);
        mat.setColor3("fillRadiance", new Color3(0.55, 0.48, 0.38));
        mat.setFloat("keyLightCount", 0);
        mat.setArray4("keyLightPos", _keyPos);
        mat.setArray4("keyLightCol", _keyCol);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < 3; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        if (!Pedestals._white) {
            Pedestals._white = RawTexture.CreateRGBATexture(
                new Uint8Array([220, 200, 170, 255]), 1, 1, this.scene,
                false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE
            );
        }
        mat.setTexture("albedoTex", textureOrNull || Pedestals._white);
        if (textureOrNull) {
            textureOrNull.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
            textureOrNull.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        }
        this._mats.push({ mat, mesh: mesh || null });
        return mat;
    }

    _makeDepthMaterial(cascade) {
        return new ShaderMaterial(
            "staticDepth" + cascade, this.scene,
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
            "staticPrepass", this.scene,
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
        const anyMesh = this._mats.find((m) => m.mesh)?.mesh || null;
        if (anyMesh) {
            await whenReady(this._prepassMat, "static prepass", [anyMesh, false]);
            for (let i = 0; i < this._depthMats.length; i++) {
                await whenReady(this._depthMats[i], "static depth " + i, [anyMesh, false]);
            }
        }
    }

    /** @param {Vector3} pos */
    resolveCollision(pos) {
        for (let i = 0; i < this._points.length; i++) {
            const p = this._points[i];
            const dx = pos.x - p.x;
            const dz = pos.z - p.z;
            const d = Math.hypot(dx, dz);
            const min = CHAR_RADIUS + p.radius;
            if (d >= min) continue;
            if (d < 1e-4) { pos.x = p.x + min; continue; }
            const k = min / d;
            pos.x = p.x + dx * k;
            pos.z = p.z + dz * k;
        }
    }

    /**
     * @param {Vector3} playerPos
     * @param {Vector3} cameraPos
     * @param {ReturnType<import("../core/envProfile.js").getLerped>} env
     */
    update(playerPos, cameraPos, env) {
        const sky = this.sky;
        _splits.set(
            this.shadows.splits[0], this.shadows.splits[1],
            this.shadows.splits[2], this.shadows.splits[3]
        );

        const lights = this.lights;
        lights.begin();

        const inspecting = !!this._inspectPoint && input.inspecting;
        const focus = inspecting ? this._inspectPoint : null;

        // Plaza dome fill — high and wide over the nearest zone (sand + props).
        let bestPlaza = this._plazas[0];
        let bestPD = Infinity;
        for (let i = 0; i < this._plazas.length; i++) {
            const p = this._plazas[i];
            const d = Math.hypot(playerPos.x - p.cx, playerPos.z - p.cz);
            if (d < bestPD) { bestPD = d; bestPlaza = p; }
        }
        lights.add(
            bestPlaza.cx, playerPos.y + 5.5, bestPlaza.cz,
            bestPlaza.radius * 2.0,
            bestPlaza.light[0], bestPlaza.light[1], bestPlaza.light[2],
            inspecting ? 6.0 : 4.5
        );

        _near.length = 0;
        for (let i = 0; i < this._points.length; i++) {
            const p = this._points[i];
            const d2 = (playerPos.x - p.x) ** 2 + (playerPos.z - p.z) ** 2;
            _near.push({ p, d2 });
        }
        _near.sort((a, b) => a.d2 - b.d2);

        // Prop-only key lights — soft, bright, independent of spell attenuation.
        let kn = 0;
        if (focus) {
            // Studio ring around the inspected pillar — every face gets light.
            const col = PLAZAS[focus.project._zone]?.light || [1, 0.85, 0.55];
            const px = focus.x;
            const py = focus.y;
            const pz = focus.z;
            let fx = cameraPos.x - px;
            let fz = cameraPos.z - pz;
            const fl = Math.hypot(fx, fz) || 1;
            fx /= fl; fz /= fl;
            const rx = -fz;
            const rz = fx;
            kn = pushKey(kn, px + fx * 2.4, py + 0.9, pz + fz * 2.4, 8.0, col[0], col[1], col[2], 7.0);
            kn = pushKey(kn, px - fx * 2.2, py + 1.1, pz - fz * 2.2, 7.5, col[0], col[1], col[2], 4.5);
            kn = pushKey(kn, px + rx * 2.3, py + 1.2, pz + rz * 2.3, 7.0, col[0], col[1], col[2], 5.5);
            kn = pushKey(kn, px - rx * 2.3, py + 1.2, pz - rz * 2.3, 7.0, col[0], col[1], col[2], 5.5);
            kn = pushKey(kn, px, py + 3.2, pz, 9.0, 1.0, 0.95, 0.85, 6.0);
            kn = pushKey(kn, cameraPos.x, cameraPos.y + 0.4, cameraPos.z, 6.0, 1.0, 0.96, 0.88, 3.5);
            lights.add(px + fx * 2.4, py + 0.9, pz + fz * 2.4, 8.0, col[0], col[1], col[2], 4.0);
            lights.add(px, py + 3.0, pz, 9.0, col[0], col[1], col[2], 3.5);
        } else {
            kn = pushKey(
                kn,
                bestPlaza.cx, playerPos.y + 6.5, bestPlaza.cz,
                bestPlaza.radius * 2.2,
                bestPlaza.light[0], bestPlaza.light[1], bestPlaza.light[2],
                5.0
            );
            kn = pushKey(
                kn,
                playerPos.x, playerPos.y + 4.0, playerPos.z,
                10.0, 1.0, 0.92, 0.78, 3.5
            );
            for (let i = 0; i < 3 && i < _near.length; i++) {
                const p = _near[i].p;
                const col = PLAZAS[p.project._zone]?.light || [1, 0.85, 0.55];
                let fx = cameraPos.x - p.x;
                let fz = cameraPos.z - p.z;
                const fl = Math.hypot(fx, fz) || 1;
                fx /= fl; fz /= fl;
                kn = pushKey(
                    kn,
                    p.x + fx * 2.6, p.y + 1.2, p.z + fz * 2.6,
                    7.5, col[0], col[1], col[2], 5.5
                );
                if (i < 2) {
                    lights.add(
                        p.x + fx * 2.6, p.y + 1.2, p.z + fz * 2.6,
                        7.0, col[0], col[1], col[2], 3.0
                    );
                }
            }
            if (_near.length > 0 && kn < KEY_LIGHT_MAX) {
                const p = _near[0].p;
                const col = PLAZAS[p.project._zone]?.light || [1, 0.85, 0.55];
                let fx = cameraPos.x - p.x;
                let fz = cameraPos.z - p.z;
                const fl = Math.hypot(fx, fz) || 1;
                fx /= fl; fz /= fl;
                const rx = -fz;
                const rz = fx;
                kn = pushKey(
                    kn,
                    p.x + rx * 2.4, p.y + 1.4, p.z + rz * 2.4,
                    6.5, col[0], col[1], col[2], 4.0
                );
            }
        }

        const ambientMul = inspecting ? 1.45 : 1.25;
        const gain = inspecting ? 1.25 : 1.15;
        const glow = inspecting ? 0.18 : 0.12;

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
            m.setFloat("ambientIntensity", S.ambientIntensity * ambientMul);
            m.setColor3("fillRadiance", _fill);
            m.setFloat("albedoGain", gain);
            m.setFloat("panelGlow", glow);
            m.setArray4("keyLightPos", _keyPos);
            m.setArray4("keyLightCol", _keyCol);
            m.setFloat("keyLightCount", kn);
            lights.apply(m);
        }

        if (focus) {
            this.card.show(focus.project);
        } else {
            let best = null;
            let bestD2 = CARD_RANGE * CARD_RANGE;
            for (let i = 0; i < this._points.length; i++) {
                const pt = this._points[i];
                const dx = playerPos.x - pt.x;
                const dz = playerPos.z - pt.z;
                const d2 = dx * dx + dz * dz;
                if (d2 < bestD2) {
                    bestD2 = d2;
                    best = pt.project;
                }
            }
            if (best) this.card.show(best);
            else this.card.hide();
        }

        if (input.openPressed && this.card.active?.link) {
            window.open(this.card.active.link, "_blank", "noopener");
        }
    }
}
