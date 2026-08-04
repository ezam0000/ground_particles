/**
 * PORTFOLIO DUNES — entry point and frame orchestration.
 *
 * A walkable portfolio on the SNOWFLOW engine: sand-only, no surf, no spells.
 * The character strolls a dune field where each project stands as a monolith;
 * approach one and its card appears, press E and the site opens.
 *
 * WebGPU only, by design. No WebGL path, no feature-detect branches: if the
 * adapter isn't there we say so once and stop.
 */

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";

import { registerShaders } from "./shaders/registry.js";
import { S, onChange } from "./core/settings.js";
import { initInput, pollInput, endFrame, input } from "./core/input.js";
import { CameraRig } from "./core/camera.js";
import { CharacterController } from "./character/controller.js";
import { PlayerAvatar } from "./character/avatar.js";
import { SnowContact } from "./character/snowContact.js";
import { SprayField } from "./vfx/particles.js";
import { SpellLights } from "./spells/spellLights.js";
import { Sky } from "./render/sky.js";
import { ShadowSystem } from "./render/shadows.js";
import { Terrain } from "./terrain/terrain.js";
import { DepthPass } from "./render/depthPass.js";
import { PostChain } from "./post/postChain.js";
import { Pedestals } from "./portfolio/pedestals.js";
import { Giant } from "./props/giant.js";
import { Antinous } from "./props/antinous.js";
import { SheepFlock } from "./props/sheep.js";
import { Cyclops } from "./props/cyclops.js";
import { DropCard } from "./props/cards/dropCard.js";
import { CardBook } from "./props/cards/cardBook.js";
import { has as hasCard } from "./props/cards/collection.js";
import { Eumaeus } from "./props/eumaeus.js";
import { Argos } from "./props/argos.js";
import { ZeusDeath } from "./ui/zeusDeath.js";
import { BowToast } from "./ui/bowToast.js";
import { HealthBars } from "./ui/healthBars.js";
import { Subtitles } from "./ui/subtitles.js";
import { Compass } from "./ui/compass.js";
import { ArrowPool } from "./combat/arrows.js";
import { Bow } from "./combat/bow.js";
import { unlockAudio, setVoSubtitleHandler } from "./combat/sfx.js";
import { updateEnv, getLerped } from "./core/envProfile.js";
import { whenReady } from "./core/gpuUtil.js";
import * as loading from "./core/loading.js";

// ------------------------------------------------------- module-scope scratch
const _vel = new Vector3();
const _aim = new Vector3();

async function boot() {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("view"));

    if (!navigator.gpu) {
        loading.fail("WebGPU is not available in this browser.");
        return;
    }

    await loading.phase("waking the dunes", 0.05);

    const engine = new WebGPUEngine(canvas, {
        antialias: false, // TAA handles edges; MSAA here would just cost bandwidth
        stencil: false,
        powerPreference: "high-performance",
        enableAllFeatures: true,
        setMaximumLimits: true,
    });

    try {
        await engine.initAsync();
    } catch (err) {
        console.error(err);
        loading.fail("WebGPU device initialisation failed.");
        return;
    }

    // The heightfield is R32F and is filtered in the vertex shader, which needs
    // this feature. Every desktop GPU that can run this demo has it.
    const filterable = engine.getCaps().textureFloatLinearFiltering;
    if (!filterable) {
        console.warn("[dunes] float32-filterable unavailable; height will step");
    }

    const applyScale = () => engine.setHardwareScalingLevel(1 / S.resolutionScale);
    applyScale();
    onChange("resolutionScale", applyScale);
    window.addEventListener("resize", () => engine.resize());

    registerShaders();

    await loading.phase("shaping the sand", 0.12);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    scene.autoClear = true;
    // Do NOT clear depth between rendering groups. Babylon clears depth before
    // every group by default; here group 1 is the opaque scene and group 2 is
    // the alpha-blended spray, which must depth-test against it.
    scene.setRenderingAutoClearDepthStencil(1, false);
    scene.setRenderingAutoClearDepthStencil(2, false);
    // No stock lights: every material here computes its own lighting.
    scene.ambientColor = new Color3(0, 0, 0);

    const rig = new CameraRig(scene, canvas);
    scene.activeCamera = rig.camera;

    // ------------------------------------------------------------------ sky
    await loading.phase("gathering light", 0.2);
    const sky = new Sky(scene);
    sky.mesh.renderingGroupId = 0;
    await sky.solve();

    // -------------------------------------------------------------- shadows
    const shadows = new ShadowSystem(scene);

    // The camera-space depth prepass. It is a custom render target, and the
    // scene renders those in registration order — so creating it here, after
    // the cascades and before anything that draws, is the whole of the
    // scheduling.
    const depthPass = new DepthPass(scene);

    // -------------------------------------------------------------- terrain
    await loading.phase("packing the dunes", 0.34);
    const terrain = new Terrain(scene, sky, shadows);
    terrain.mesh.renderingGroupId = 1;
    await terrain.build();
    onChange("showTerrain", (v) => (terrain.mesh.isVisible = v));
    depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial());

    await loading.phase("calling the walker", 0.55);

    const character = new CharacterController(terrain);
    character.position.set(0, 0, 0);
    character.position.y = terrain.heightAt(0, 0);

    // Airborne grit: footfall kicks and jump-landing bursts.
    const spray = new SprayField(scene, terrain, sky, shadows);

    // Every lit material declares the spell-light pool uniforms. Pedestals fill
    // the pool each frame with plaza / pedestal spots; everyone else reads it.
    const lights = new SpellLights();
    for (const m of [terrain.material, spray.material]) {
        lights.apply(m);
    }

    // Authored skinned player (crushed main_man.glb).
    const avatar = new PlayerAvatar(scene, terrain, sky, shadows, depthPass, lights, character);
    onChange("showCharacter", (v) => avatar.setVisible(v));

    // Feet write into the terrain state buffer — controller footfalls (no IK figure).
    const contact = new SnowContact(character, terrain.deform, null, spray);

    await loading.phase("raising the pillars", 0.62);

    // Three plazas + the colossus south of spawn + Antinous (sun-summon).
    // Sheep pasture east of spawn; Polyphemus after the flock is wiped.
    // Eumaeus + Argos west — bow gift gate.
    const pedestals = new Pedestals(scene, terrain, sky, shadows, depthPass, lights);
    const giant = new Giant(scene, terrain, sky, shadows, depthPass, lights);
    const antinous = new Antinous(scene, terrain, sky, shadows, depthPass, lights);
    const sheep = new SheepFlock(scene, terrain, sky, shadows, depthPass, lights);
    const cyclops = new Cyclops(scene, terrain, sky, shadows, depthPass, lights);
    const eumaeus = new Eumaeus(scene, terrain, sky, shadows, depthPass, lights);
    const argos = new Argos(scene, terrain, sky, shadows, depthPass, lights);
    argos.leader = eumaeus;
    const dropCard = new DropCard();
    const cardBook = new CardBook();
    const zeusDeath = new ZeusDeath();
    const bowToast = new BowToast();
    const healthBars = new HealthBars(scene);
    const subtitles = new Subtitles();
    const compass = new Compass();
    setVoSubtitleHandler((text, dur) => subtitles.show(text, dur));

    /** Nearest incomplete Odyssey objective for the compass needle. */
    const objectiveAt = () => {
        if (!avatar.hasBow) return { x: eumaeus.x, z: eumaeus.z, label: "Eumaeus" };
        if (!hasCard("argos") && argos.present) return { x: argos.x, z: argos.z, label: "Argos" };
        if (!sheep.allDead) {
            let best = null;
            let bestD = Infinity;
            for (const s of sheep.sheep) {
                if (!s.alive) continue;
                const dx = s.x - character.position.x;
                const dz = s.z - character.position.z;
                const d2 = dx * dx + dz * dz;
                if (d2 < bestD) {
                    bestD = d2;
                    best = s;
                }
            }
            if (best) return { x: best.x, z: best.z, label: "Pasture" };
            return { x: 28, z: -12, label: "Pasture" };
        }
        if (!cyclops._spawned || cyclops.alive) {
            if (cyclops._spawned && cyclops.alive) {
                return { x: cyclops.x, z: cyclops.z, label: "Polyphemus" };
            }
            return { x: 28, z: -12, label: "Polyphemus" };
        }
        if (antinous._spawned && antinous.alive) {
            return { x: antinous.x, z: antinous.z, label: "Antinoös" };
        }
        if (!hasCard("laestrygonians")) return { x: giant.x, z: giant.z, label: "Giant" };
        if (!hasCard("sheep")) return { x: 28, z: -12, label: "Sheep" };
        return null;
    };

    // Bow combat: pooled arrows + procedural bow on the player's hand.
    const arrows = new ArrowPool(scene, terrain, sky, shadows, lights);
    arrows.giant = giant;
    arrows.antinous = antinous;
    arrows.sheep = sheep;
    arrows.cyclops = cyclops;
    arrows.pedestals = pedestals;
    arrows.eumaeus = eumaeus;
    arrows.argos = argos;
    arrows.onGiantHit = (zone) => giant.playHit(zone);
    arrows.onAntinousHit = (zone) => antinous.playHit(zone);
    arrows.onSheepHit = (unit) => sheep.playHit(unit);
    arrows.onCyclopsHit = (zone) => cyclops.playHit(zone);
    const bow = new Bow(scene, sky, shadows, lights, arrows);
    avatar.bow = bow;
    avatar.hasBow = false;
    avatar.getAimDir = () => {
        rig.getLookDir(_aim);
        return _aim;
    };
    avatar.getCameraPos = () => rig.camera.position;
    avatar.onShot = (aimDir) => antinous.noteShot(aimDir, character.position);

    sheep.onAllDead = () => {
        const s0 = sheep.sheep[0];
        cyclops.spawn({ x: s0?.x ?? 28, z: s0?.z ?? -12 });
    };

    const showDrop = (id, x, z) => {
        character.locked = true;
        const gy = terrain.heightAt(x, z) + 1.6;
        rig.beginInspect(x, gy, z);
        dropCard.show(id);
    };

    const grantBow = () => {
        avatar.hasBow = true;
        loading.setCrosshair(true);
        loading.setCrosshairTeach(true);
        // Never leave the grip mesh enabled outside a draw (reads as a dark blob).
        bow.equipped = false;
        bow.setVisible(false);
    };

    const revokeBow = () => {
        avatar.hasBow = false;
        loading.setCrosshair(false);
        bow.equipped = false;
        bow.setVisible(false);
        bowToast.hide();
    };

    eumaeus.onGift = () => {
        const firstCard = !hasCard("eumaeus");
        grantBow();
        if (firstCard) {
            showDrop("eumaeus", eumaeus.x, eumaeus.z);
        } else {
            // Re-gift after Zeus (card already owned) — toast is the only cue.
            bowToast.show({ restored: true });
        }
    };

    const prevOnShot = avatar.onShot;
    avatar.onShot = (aimDir) => {
        loading.setCrosshairTeach(false);
        bowToast.hide();
        if (prevOnShot) prevOnShot(aimDir);
    };

    const strikeZeus = (/** @type {"argos"|"eumaeus"} */ who) => {
        if (zeusDeath.visible) return;
        if (who === "argos") argos.banish();
        arrows.clearFlying();
        if (dropCard.visible) dropCard.hide();
        if (cardBook.visible) cardBook.close();
        if (rig.inspecting) rig.endInspect();
        input.inspecting = false;
        character.locked = true;
        zeusDeath.show();
    };
    arrows.onSacredHit = strikeZeus;

    const softRespawn = () => {
        zeusDeath.hide();
        revokeBow();
        character.locked = false;
        character.velocity.set(0, 0, 0);
        if ("vy" in character) character.vy = 0;
        character.position.set(0, terrain.heightAt(0, 0), 0);
        if (rig.inspecting) rig.endInspect();
        input.inspecting = false;
    };

    cyclops.onDeath = () => showDrop("polyphemus", cyclops.x, cyclops.z);
    antinous.onDeath = () => showDrop("antinous", antinous.x, antinous.z);

    // The rig needs ground heights to keep the spring arm above the sand.
    rig.groundAt = (x, z) => terrain.heightAt(x, z);

    const post = new PostChain(scene, rig.camera, depthPass, sky);

    initInput(canvas);
    canvas.addEventListener("click", () => unlockAudio());

    // ------------------------------------------------------------- warm-up
    // Everything that can compile, compiles here — behind the loading screen.
    await loading.phase("tempering the bow", 0.8);
    shadows.update(rig.camera, sky.sunDir);
    sky.render(rig, 0);
    await terrain.warmUp();
    terrain.update(rig.camera.position, character.position, 0);
    avatar.update(0, rig.camera.position, getLerped());
    await avatar.warmUp();
    bow.attach(avatar);
    await bow.warmUp();
    await arrows.warmUp();
    spray.update(0, rig.camera.position);
    await spray.warmUp();
    pedestals.update(character.position, rig.camera.position, getLerped());
    await pedestals.warmUp();
    giant.update(0, character.position, rig.camera.position, getLerped());
    await giant.warmUp();
    antinous.update(0, character.position, rig.camera.position, getLerped());
    await antinous.warmUp();
    sheep.update(0, rig.camera.position, getLerped());
    await sheep.warmUp();
    cyclops.update(0, character.position, rig.camera.position, getLerped());
    await cyclops.warmUp();
    eumaeus.update(0, rig.camera.position, getLerped());
    await eumaeus.warmUp();
    argos.update(0, rig.camera.position, getLerped());
    await argos.warmUp();
    await zeusDeath.warmUp();
    await whenReady(sky.material, "sky material", [sky.mesh, false]);
    await depthPass.warmUp();
    post.update(0, rig.distance);
    const passes = post.passes;
    for (let i = 0; i < passes.length; i++) {
        await whenReady(passes[i], "post:" + passes[i].name);
    }

    await loading.phase("heat shimmer", 0.94);
    // A few real frames so every render target is allocated and every pipeline
    // has actually been bound at least once.
    for (let i = 0; i < 3; i++) {
        scene.render();
        await loading.nextFrame();
    }

    // ------------------------------------------------------------- run loop
    let prev = performance.now();
    let time = 0;

    engine.runRenderLoop(() => {
        const now = performance.now();
        let dtMs = now - prev;
        prev = now;
        if (dtMs > 100) dtMs = 100;
        const dt = S.freezeTime ? 0 : dtMs / 1000;
        time += dt;

        pollInput();
        updateEnv(dt);

        if (zeusDeath.visible) {
            if (input.openPressed) softRespawn();
        } else if (dropCard.visible) {
            if (input.flipPressed) dropCard.toggleFlip();
            if (input.openPressed) {
                const taughtBow = dropCard.activeId === "eumaeus";
                dropCard.hide();
                character.locked = false;
                if (rig.inspecting) rig.endInspect();
                if (taughtBow && avatar.hasBow) bowToast.show();
            }
        } else if (cardBook.visible) {
            if (input.flipPressed) cardBook.toggleFlip();
            if (input.navLeftPressed) cardBook.browse(-1);
            if (input.navRightPressed) cardBook.browse(1);
            if (input.bookPressed) {
                cardBook.close();
                character.locked = false;
            }
        } else {
            if (input.bookPressed) {
                cardBook.open();
                character.locked = true;
            } else if (!antinous.pollRevive(character.position)) {
                let awarded = false;
                if (!input.inspecting && !rig.inspecting) {
                    const pos = character.position;
                    const needsArgosCard = !hasCard("argos");
                    const argosNear = needsArgosCard && argos.inInspectRange(pos);
                    const wantGift = !avatar.hasBow;
                    let tryArgosFirst = argosNear;
                    if (argosNear && wantGift) {
                        const ad2 = argos.dist2To(pos);
                        const edx = pos.x - eumaeus.x;
                        const edz = pos.z - eumaeus.z;
                        tryArgosFirst = ad2 <= edx * edx + edz * edz;
                    }

                    const takeArgos = () => {
                        const a = argos.pollCardInspect(pos);
                        if (!a) return false;
                        showDrop("argos", a.x, a.z);
                        argos.ascend(spray);
                        return true;
                    };

                    if (tryArgosFirst && takeArgos()) {
                        awarded = true;
                    } else if (eumaeus.pollGift(pos, wantGift)) {
                        awarded = true;
                    } else if (!tryArgosFirst && argosNear && takeArgos()) {
                        awarded = true;
                    }

                    if (!awarded && !hasCard("laestrygonians")) {
                        const g = giant.pollCardInspect(character.position);
                        if (g) {
                            showDrop("laestrygonians", g.x, g.z);
                            awarded = true;
                        }
                    }
                    if (!awarded && !hasCard("sheep")) {
                        const s = sheep.pollCardInspect(character.position, time);
                        if (s) {
                            showDrop("sheep", s.x, s.z);
                            awarded = true;
                        }
                    }
                }
                if (!awarded) pedestals.pollInspect(rig, character.position);
            }
        }

        character.update(dt, rig);
        pedestals.resolveCollision(character.position);
        giant.resolveCollision(character.position);
        antinous.resolveCollision(character.position);
        sheep.resolveCollision(character.position);
        cyclops.resolveCollision(character.position);
        eumaeus.resolveCollision(character.position);
        argos.resolveCollision(character.position);
        terrain.heightfield.clampToPlayArea(character.position);
        contact.update(dt);

        _vel.copyFrom(character.velocity);
        rig.update(dt, character.position, _vel, character.lean, character.speed01);
        compass.update(rig.yaw, objectiveAt(), character.position.x, character.position.z);

        // Jitters the projection and republishes everything the screen-space
        // passes derive from the camera. Must be after the rig has moved and
        // before anything reads `scene.getTransformMatrix()` — which the depth
        // prepass and the beauty pass both do.
        post.update(dt, rig.distance);
        sky.update();
        sky.render(rig, time);
        shadows.update(rig.camera, sky.sunDir);
        // After the shadow refit, so every lit material carries this frame's
        // cascade matrices; before the terrain, so the brushes are in the
        // staging array when the simulation pass runs.
        pedestals.update(character.position, rig.camera.position, getLerped());
        giant.update(dt, character.position, rig.camera.position, getLerped());
        if (giant.didHit) {
            character.applyHit(giant.x, giant.z);
            avatar.playHit();
        }
        sheep.update(dt, rig.camera.position, getLerped());
        cyclops.update(dt, character.position, rig.camera.position, getLerped());
        if (cyclops.didHit) {
            character.applyHit(cyclops.x, cyclops.z, 5.4);
            avatar.playHit();
        }
        antinous.update(dt, character.position, rig.camera.position, getLerped());
        eumaeus.update(dt, rig.camera.position, getLerped());
        {
            const pos = character.position;
            const needsArgosCard = !hasCard("argos");
            const argosNear = needsArgosCard && argos.inInspectRange(pos);
            let preferArgosHint = argosNear && avatar.hasBow;
            if (argosNear && !avatar.hasBow) {
                const ad2 = argos.dist2To(pos);
                const edx = pos.x - eumaeus.x;
                const edz = pos.z - eumaeus.z;
                preferArgosHint = ad2 <= edx * edx + edz * edz;
            }
            eumaeus.updateTalkHint(pos, !avatar.hasBow && !preferArgosHint);
            argos.updateInspectHint(pos, preferArgosHint);
        }
        argos.update(dt, rig.camera.position, getLerped());
        avatar.update(dt, rig.camera.position, getLerped());
        rig.getLookDir(_aim);
        if (avatar.hasBow) {
            const cam = rig.camera.position;
            const warn =
                argos.aimHit(cam.x, cam.y, cam.z, _aim.x, _aim.y, _aim.z) ||
                eumaeus.aimHit(cam.x, cam.y, cam.z, _aim.x, _aim.y, _aim.z);
            loading.setCrosshairWarn(warn);
        }
        bow.update(dt, rig.camera.position, getLerped(), _aim);
        arrows.update(dt, rig.camera.position, getLerped());
        // Pedestals just refilled the light pool — push it into the rest of the scene.
        for (const m of [terrain.material, spray.material]) {
            lights.apply(m);
        }
        terrain.update(rig.camera.position, character.position, dt);
        spray.update(dt, rig.camera.position);

        healthBars.beginFrame();
        {
            const gv = giant.getHealthView(character.position);
            if (gv) healthBars.track(gv);
            const av = antinous.getHealthView(character.position);
            if (av) healthBars.track(av);
            const cv = cyclops.getHealthView(character.position);
            if (cv) healthBars.track(cv);
        }
        healthBars.endFrame();

        scene.render();
        post.endFrame();

        endFrame();
    });

    await loading.done();

    globalThis.DUNES = {
        engine, scene, rig, character, avatar, contact, spray, pedestals, giant,
        antinous, sheep, cyclops, eumaeus, argos, dropCard, cardBook, zeusDeath,
        bowToast, healthBars, subtitles, compass, bow, arrows,
        terrain, sky, shadows, post, depthPass,
        S, input,
    };
}

boot().catch((err) => {
    console.error(err);
    loading.fail("Startup failed — see console.");
});
