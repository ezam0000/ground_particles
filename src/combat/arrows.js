/**
 * Pooled arrow.glb — visible in flight, stuck on giant/ground impact.
 * Max 10 FIFO (flight + stuck share the same meshes).
 */

import "@babylonjs/loaders/glTF";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4, Color3, Quaternion, Matrix } from "@babylonjs/core/Maths/math";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { S } from "../core/settings.js";
import { bindMatrixArray, whenReady } from "../core/gpuUtil.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { preloadSfx, playSfx, unlockAudio } from "./sfx.js";

const MODEL = "/assets/character/arrow.glb";
const POOL = 10;
const ARROW_LEN = 0.82;
const ARROW_SPEED = 48;
const GRAVITY = 9.5;
const LIFE = 4.5;
/** Trigger radius pad outside giant.radius (plant snaps inward). */
const HIT_RADIUS = 0.9;
/** Approx torso surface radius for a 3 m giant — plant here, not at the hit capsule. */
const GIANT_BODY_R = 0.42;
/** How deep the tip digs past the surface (m). */
const PENETRATE = 0.16;
/** Chest/head band starts this high above giant feet (m). */
const CHEST_Y = 1.7;
/** Giant face band (front only) — above this local Y is a headshot. */
const GIANT_FACE_Y = 2.35;
/** Antinous head band (any facing) — above this local Y is a headshot. */
const ANTI_HEAD_Y = 1.52;
const IMPACT_SFX = "/assets/sfx/arrow_impact.mp3";
const IMPACT_VOL = 0.55;
const HEADSHOT_SFX = "/assets/sfx/headshot.mp3";
const HEADSHOT_VOL = 0.7;
const PILLAR_SFX = "/assets/sfx/arrow_impact_pillar.mp3";
const PILLAR_SFX_VOL = 0.55;
/** Hit pad outside each pillar's visual hitRadius. */
const PILLAR_HIT_PAD = 0.12;

/** Slot state: 0 free, 1 flying, 2 stuck. */
const FREE = 0;
const FLYING = 1;
const STUCK = 2;

/** Tip is authored toward −Z — flip so +look matches tip. */
const _tipFix = Quaternion.FromEulerAngles(0, Math.PI, 0);

/** Skip non-body / tip bones when picking an attach socket. */
const BONE_SKIP = /armature|^char|toe|end$|front$/i;

const _splits = new Vector4();
const _fill = new Color3(0.45, 0.4, 0.32);
const _dir = new Vector3();
const _up = new Vector3(0, 1, 0);
const _orient = new Quaternion();
const _pos = new Vector3();
const _bonePos = new Vector3();
const _localPos = new Vector3();
const _localRot = new Quaternion();
const _boneWorld = Matrix.Identity();
const _invBone = Matrix.Identity();
const _keyPos = new Float32Array(24);
const _keyCol = new Float32Array(24);
const _min = new Vector3();
const _max = new Vector3();

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

        /** @type {Uint8Array} FREE | FLYING | STUCK */
        this._state = new Uint8Array(POOL);
        this._life = new Float32Array(POOL);
        this._px = new Float32Array(POOL);
        this._py = new Float32Array(POOL);
        this._pz = new Float32Array(POOL);
        this._vx = new Float32Array(POOL);
        this._vy = new Float32Array(POOL);
        this._vz = new Float32Array(POOL);
        /** FIFO claim index for recycle. */
        this._next = 0;

        /** @type {TransformNode[]} */
        this._roots = [];
        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh[][]} */
        this._meshes = [];
        /** @type {ShaderMaterial[][]} */
        this._mats = [];

        /** @type {((zone: "back"|"waist"|"chest"|"head", x:number, y:number, z:number) => void)|null} */
        this.onGiantHit = null;
        /** @type {import("../props/giant.js").Giant|null} */
        this.giant = null;
        /** @type {((zone: "back"|"waist"|"chest"|"head", x:number, y:number, z:number) => void)|null} */
        this.onAntinousHit = null;
        /** @type {import("../props/antinous.js").Antinous|null} */
        this.antinous = null;
        /** @type {import("../portfolio/pedestals.js").Pedestals|null} */
        this.pedestals = null;

        this._arrowScale = 1;
        void preloadSfx(IMPACT_SFX);
        void preloadSfx(PILLAR_SFX);
        void preloadSfx(HEADSHOT_SFX);
        this._ready = this._load();
    }

    async _load() {
        const proto = await SceneLoader.ImportMeshAsync("", "", MODEL, this.scene);
        const protoRoot = proto.meshes[0];
        protoRoot.setEnabled(false);

        /** @type {import("@babylonjs/core/Meshes/mesh").Mesh[]} */
        const protoMeshes = [];
        for (const m of proto.meshes) {
            if (m === protoRoot) continue;
            if (!m.getTotalVertices || m.getTotalVertices() <= 0) continue;
            protoMeshes.push(/** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (m));
        }

        let lenZ = 0;
        for (const m of protoMeshes) {
            m.computeWorldMatrix(true);
            const bi = m.getBoundingInfo();
            _min.copyFrom(bi.boundingBox.minimumWorld);
            _max.copyFrom(bi.boundingBox.maximumWorld);
            lenZ = Math.max(lenZ, _max.z - _min.z, _max.y - _min.y);
        }
        this._arrowScale = lenZ > 1e-4 ? ARROW_LEN / lenZ : 1;

        for (let i = 0; i < POOL; i++) {
            const root = new TransformNode("arrowRoot" + i, this.scene);
            root.setEnabled(false);
            root.rotationQuaternion = Quaternion.Identity();
            root.scaling.setAll(this._arrowScale);

            /** @type {import("@babylonjs/core/Meshes/mesh").Mesh[]} */
            const meshes = [];
            /** @type {ShaderMaterial[]} */
            const mats = [];

            if (i === 0) {
                protoRoot.parent = root;
                protoRoot.position.setAll(0);
                protoRoot.rotationQuaternion = _tipFix.clone();
                protoRoot.setEnabled(true);
                for (const m of protoMeshes) {
                    m.isPickable = false;
                    m.renderingGroupId = 1;
                    m.receiveShadows = true;
                    m.isVisible = false;
                    mats.push(this._bindProp(m, "arrow0:" + m.name));
                    meshes.push(m);
                }
            } else {
                for (const src of protoMeshes) {
                    const c = /** @type {import("@babylonjs/core/Meshes/mesh").Mesh} */ (src.clone("arrow" + i + ":" + src.name, root));
                    c.isPickable = false;
                    c.renderingGroupId = 1;
                    c.receiveShadows = true;
                    c.isVisible = false;
                    c.rotationQuaternion = _tipFix.clone();
                    mats.push(this._bindProp(c, "arrow" + i + ":" + src.name));
                    meshes.push(c);
                }
            }

            this._roots.push(root);
            this._meshes.push(meshes);
            this._mats.push(mats);
        }
    }

    _bindProp(mesh, name) {
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
        mat.setColor3("albedoColor", Color3.White());
        mat.setFloat("useTex", albedoTex ? 1 : 0);
        mat.setFloat("panelGlow", 0.05);
        mat.setFloat("albedoGain", 1.15);
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
        mat.setTexture("albedoTex", albedoTex || ArrowPool._white);
        mesh.material = mat;
        return mat;
    }

    _setVisible(i, on) {
        this._roots[i].setEnabled(!!on);
        for (const m of this._meshes[i]) m.isVisible = !!on;
    }

    _claimSlot() {
        // Prefer a free slot; else FIFO recycle.
        for (let n = 0; n < POOL; n++) {
            const i = (this._next + n) % POOL;
            if (this._state[i] === FREE) {
                this._next = (i + 1) % POOL;
                return i;
            }
        }
        const i = this._next;
        this._next = (i + 1) % POOL;
        this._clearSlot(i);
        return i;
    }

    _clearSlot(i) {
        this._state[i] = FREE;
        this._life[i] = 0;
        const root = this._roots[i];
        if (root.detachFromBone) root.detachFromBone();
        root.setParent(null);
        root.scaling.setAll(this._arrowScale);
        this._setVisible(i, false);
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
        const slot = this._claimSlot();
        const len = Math.hypot(dx, dy, dz) || 1;
        this._state[slot] = FLYING;
        this._life[slot] = LIFE;
        this._px[slot] = x;
        this._py[slot] = y;
        this._pz[slot] = z;
        this._vx[slot] = (dx / len) * ARROW_SPEED;
        this._vy[slot] = (dy / len) * ARROW_SPEED;
        this._vz[slot] = (dz / len) * ARROW_SPEED;

        const root = this._roots[slot];
        root.setParent(null);
        root.scaling.setAll(this._arrowScale);
        this._setVisible(slot, true);
        this._orientFlight(slot);
    }

    _orientFlight(i) {
        _dir.set(this._vx[i], this._vy[i], this._vz[i]);
        const s = _dir.length();
        if (s < 1e-5) return;
        _dir.scaleInPlace(1 / s);
        _up.set(0, 1, 0);
        Quaternion.FromLookDirectionLHToRef(_dir, _up, _orient);
        const root = this._roots[i];
        root.rotationQuaternion.copyFrom(_orient);
        root.position.set(this._px[i], this._py[i], this._pz[i]);
    }

    /**
     * Closest skinned bone to a world point — arrows ride attack/walk anims.
     * @param {import("@babylonjs/core/Meshes/mesh").Mesh} mesh
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {import("@babylonjs/core/Bones/bone").Bone|null}
     */
    _closestBone(mesh, x, y, z) {
        const sk = mesh?.skeleton;
        if (!sk) return null;
        sk.computeAbsoluteTransforms();

        let best = null;
        let bestD = Infinity;
        for (const bone of sk.bones) {
            const n = bone.name || "";
            if (BONE_SKIP.test(n)) continue;
            bone.getAbsolutePositionToRef(mesh, _bonePos);
            const dx = _bonePos.x - x;
            const dy = _bonePos.y - y;
            const dz = _bonePos.z - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) {
                bestD = d;
                best = bone;
            }
        }
        return best;
    }

    _closestGiantBone(x, y, z) {
        const mesh = this.giant?._mesh;
        return mesh ? this._closestBone(mesh, x, y, z) : null;
    }

    /**
     * Freeze arrow at impact with tip penetration.
     * @param {number} i
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} dx unit dir
     * @param {number} dy
     * @param {number} dz
     * @param {"ground"|"giant"|"pillar"|"antinous"} kind
     * @param {{ x:number, z:number, radius:number, root: import("@babylonjs/core/Meshes/transformNode").TransformNode }|null} [pillar]
     */
    _plant(i, x, y, z, dx, dy, dz, kind, pillar = null) {
        _dir.set(dx, dy, dz);
        if (_dir.lengthSquared() < 1e-8) _dir.set(0, -1, 0);
        _dir.normalize();

        let sx = x;
        let sy = y;
        let sz = z;

        if (kind === "giant" && this.giant) {
            const g = this.giant;
            const ox = x - g.x;
            const oz = z - g.z;
            const horiz = Math.hypot(ox, oz) || 1;
            sx = g.x + (ox / horiz) * GIANT_BODY_R;
            sz = g.z + (oz / horiz) * GIANT_BODY_R;
            sy = y;
        } else if (kind === "antinous" && this.antinous) {
            const a = this.antinous;
            const bodyR = a.bodyRadius || 0.32;
            const ox = x - a.x;
            const oz = z - a.z;
            const horiz = Math.hypot(ox, oz) || 1;
            sx = a.x + (ox / horiz) * bodyR;
            sz = a.z + (oz / horiz) * bodyR;
            sy = y;
        } else if (kind === "pillar" && pillar) {
            const ox = x - pillar.x;
            const oz = z - pillar.z;
            const horiz = Math.hypot(ox, oz) || 1;
            // Embed into the shaft (surfaceRadius), not the fat detect radius.
            const surfaceR = Math.max(
                0.2,
                (pillar.surfaceRadius ?? pillar.hitRadius ?? pillar.radius) - 0.08
            );
            sx = pillar.x + (ox / horiz) * surfaceR;
            sz = pillar.z + (oz / horiz) * surfaceR;
            sy = y;
        }

        // Mesh origin is mid-shaft; pull back so the tip (not the center) hits.
        const mid = ARROW_LEN * 0.5 - PENETRATE;
        _pos.set(
            sx - _dir.x * mid,
            sy - _dir.y * mid,
            sz - _dir.z * mid
        );

        _up.set(0, 1, 0);
        Quaternion.FromLookDirectionLHToRef(_dir, _up, _orient);

        const root = this._roots[i];
        if (root.detachFromBone) root.detachFromBone();
        root.setParent(null);
        root.scaling.setAll(this._arrowScale);
        root.rotationQuaternion.copyFrom(_orient);
        root.position.copyFrom(_pos);

        const host =
            kind === "giant" ? this.giant
            : kind === "antinous" ? this.antinous
            : null;
        if (host?._mesh) {
            const mesh = host._mesh;
            const bone = this._closestBone(mesh, _pos.x, _pos.y, _pos.z);
            if (bone) {
                _boneWorld.copyFrom(bone.getAbsoluteTransform());
                _boneWorld.multiplyToRef(mesh.getWorldMatrix(), _boneWorld);
                _boneWorld.invertToRef(_invBone);
                Vector3.TransformCoordinatesToRef(_pos, _invBone, _localPos);

                root.attachToBone(bone, mesh);
                root.position.copyFrom(_localPos);
                Quaternion.FromRotationMatrixToRef(_boneWorld, _localRot);
                Quaternion.InverseToRef(_localRot, _localRot);
                _localRot.multiplyToRef(_orient, _localRot);
                root.rotationQuaternion.copyFrom(_localRot);
                const wm = mesh.getWorldMatrix().m;
                const sxn = Math.hypot(wm[0], wm[1], wm[2]) || 1;
                root.scaling.setAll(this._arrowScale / sxn);
            } else if (host._root) {
                root.setParent(host._root, true);
            }
        } else if (kind === "pillar" && pillar?.root) {
            root.setParent(pillar.root, true);
        }

        this._state[i] = STUCK;
        this._life[i] = 0;
        this._setVisible(i, true);
    }

    _playImpact() {
        unlockAudio();
        playSfx(IMPACT_SFX, IMPACT_VOL);
    }

    _playHeadshot() {
        unlockAudio();
        playSfx(HEADSHOT_SFX, HEADSHOT_VOL);
    }

    _playPillarImpact() {
        unlockAudio();
        playSfx(PILLAR_SFX, PILLAR_SFX_VOL);
    }

    /**
     * Hit any plaza pillar (education, jobs, projects) using visual footprints.
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @returns {{ x:number, z:number, radius:number, hitRadius?:number, surfaceRadius?:number, height?:number, groundY?:number, root: import("@babylonjs/core/Meshes/transformNode").TransformNode }|null}
     */
    _classifyPillarHit(px, py, pz) {
        const points = this.pedestals?._points;
        if (!points || !points.length) return null;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const dx = px - p.x;
            const dz = pz - p.z;
            const r = (p.hitRadius || p.radius) + PILLAR_HIT_PAD;
            if (dx * dx + dz * dz > r * r) continue;
            const ground = p.groundY != null ? p.groundY : this.terrain.heightAt(p.x, p.z);
            const top = ground + (p.height || 2.4);
            if (py < ground + 0.02 || py > top + 0.15) continue;
            return p;
        }
        return null;
    }

    /**
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @param {number} vx
     * @param {number} vz
     * @returns {"back"|"waist"|"chest"|"head"|null}
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
        // Face only (front + head height).
        if (localY >= GIANT_FACE_Y) return "head";
        return localY >= CHEST_Y ? "chest" : "waist";
    }

    /**
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @param {number} vx
     * @param {number} vz
     * @returns {"back"|"waist"|"chest"|"head"|null}
     */
    _classifyAntinousHit(px, py, pz, vx, vz) {
        const a = this.antinous;
        if (!a?.alive) return null;
        const dx = px - a.x;
        const dz = pz - a.z;
        const r = a.radius + HIT_RADIUS;
        if (dx * dx + dz * dz > r * r) return null;
        const ground = this.terrain.heightAt(a.x, a.z);
        const top = ground + 2.2;
        if (py < ground - 0.15 || py > top) return null;

        const localY = py - ground;
        // Head band from any direction (front or back of skull).
        if (localY >= (a.headY || ANTI_HEAD_Y)) return "head";

        const fx = Math.sin(a.yaw);
        const fz = Math.cos(a.yaw);
        const h = Math.hypot(vx, vz) || 1;
        const fromBack = (vx / h) * fx + (vz / h) * fz > 0.25;
        if (fromBack) return "back";
        const chestY = a.chestY || 1.15;
        return localY >= chestY ? "chest" : "waist";
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
            if (this._state[i] !== FLYING) continue;

            this._life[i] -= h;
            if (this._life[i] <= 0) {
                this._clearSlot(i);
                continue;
            }

            this._vy[i] -= GRAVITY * h;
            this._px[i] += this._vx[i] * h;
            this._py[i] += this._vy[i] * h;
            this._pz[i] += this._vz[i] * h;

            const ground = this.terrain.heightAt(this._px[i], this._pz[i]);
            if (this._py[i] <= ground + 0.02) {
                const spd = Math.hypot(this._vx[i], this._vy[i], this._vz[i]) || 1;
                this._plant(
                    i,
                    this._px[i], ground, this._pz[i],
                    this._vx[i] / spd, this._vy[i] / spd, this._vz[i] / spd,
                    "ground"
                );
                continue;
            }

            if (g) {
                const zone = this._classifyGiantHit(
                    this._px[i], this._py[i], this._pz[i],
                    this._vx[i], this._vz[i]
                );
                if (zone) {
                    const hx = this._px[i], hy = this._py[i], hz = this._pz[i];
                    const spd = Math.hypot(this._vx[i], this._vy[i], this._vz[i]) || 1;
                    this._plant(
                        i, hx, hy, hz,
                        this._vx[i] / spd, this._vy[i] / spd, this._vz[i] / spd,
                        "giant"
                    );
                    if (zone === "head") this._playHeadshot();
                    else this._playImpact();
                    if (this.onGiantHit) this.onGiantHit(zone, hx, hy, hz);
                    continue;
                }
            }

            if (this.antinous?.alive) {
                const zone = this._classifyAntinousHit(
                    this._px[i], this._py[i], this._pz[i],
                    this._vx[i], this._vz[i]
                );
                if (zone) {
                    const hx = this._px[i], hy = this._py[i], hz = this._pz[i];
                    const spd = Math.hypot(this._vx[i], this._vy[i], this._vz[i]) || 1;
                    this._plant(
                        i, hx, hy, hz,
                        this._vx[i] / spd, this._vy[i] / spd, this._vz[i] / spd,
                        "antinous"
                    );
                    if (this.onAntinousHit) this.onAntinousHit(zone, hx, hy, hz);
                    continue;
                }
            }

            const pillar = this._classifyPillarHit(this._px[i], this._py[i], this._pz[i]);
            if (pillar) {
                const hx = this._px[i], hy = this._py[i], hz = this._pz[i];
                const spd = Math.hypot(this._vx[i], this._vy[i], this._vz[i]) || 1;
                this._plant(
                    i, hx, hy, hz,
                    this._vx[i] / spd, this._vy[i] / spd, this._vz[i] / spd,
                    "pillar",
                    pillar
                );
                this._playPillarImpact();
                continue;
            }

            this._orientFlight(i);
        }

        const sky = this.sky;
        _splits.set(
            this.shadows.splits[0], this.shadows.splits[1],
            this.shadows.splits[2], this.shadows.splits[3]
        );
        for (let i = 0; i < POOL; i++) {
            if (this._state[i] === FREE) continue;
            for (const m of this._mats[i]) {
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
    }

    async warmUp() {
        await this._ready;
        await preloadSfx(IMPACT_SFX);
        await preloadSfx(HEADSHOT_SFX);
        await preloadSfx(PILLAR_SFX);
        for (let i = 0; i < POOL; i++) {
            this._setVisible(i, true);
            for (let j = 0; j < this._mats[i].length; j++) {
                await whenReady(this._mats[i][j], "arrow " + i + ":" + j, [this._meshes[i][j], false]);
            }
            this._setVisible(i, false);
        }
    }
}
