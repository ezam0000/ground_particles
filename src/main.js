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

import "./ui/polish.css";
import { InteractionModes } from "./core/interactionModes.js";
import { DestinationGuide } from "./core/destinations.js";
import { ExperienceUI } from "./ui/experience.js";
import { applyMotionPreference, onPreferenceChange } from "./core/preferences.js";

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
    // Resize at a frame boundary, never while a swapchain texture is in use.
    let needsResize = false;
    window.addEventListener("resize", () => { needsResize = true; });

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
    // Start along the fall line so the idle stance sits across a contour,
    // instead of placing one foot uphill and the other well below it.
    terrain.normalAt(0, 0, character.groundNormal);
    character.facing = Math.atan2(character.groundNormal.x, character.groundNormal.z);

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
    setVoSubtitleHandler((text, dur, opts) => subtitles.show(text, dur, opts));

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
        modes.showDrop(id, x, z, terrain.heightAt(x, z) + 1.6);
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
        modes.showDeath();
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
    const world = { avatar, character, eumaeus, argos, sheep, cyclops, antinous, giant, pedestals };
    const guide = new DestinationGuide(world);
    const ui = new ExperienceUI(guide);
    cardBook.getDiscoveryHint = (id) => guide.discoveryHint(id);
    const modes = new InteractionModes({
        canvas, scene, rig, input, ui, cardBook, dropCard, zeusDeath, pedestals,
        onDropClose: (id) => { if (id === "eumaeus" && avatar.hasBow) bowToast.show(); },
        onRespawn: softRespawn,
    });
    applyMotionPreference();
    onPreferenceChange(applyMotionPreference);
    const viewSystems = [avatar, giant, antinous, sheep, cyclops, eumaeus, argos, arrows];
    const litMaterials = [terrain.material, spray.material];


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
    spray.update(0, rig.camera.position);
    pedestals.update(character.position, rig.camera.position, getLerped());
    giant.update(0, character.position, rig.camera.position, getLerped());
    antinous.update(0, character.position, rig.camera.position, getLerped());
    sheep.update(0, rig.camera.position, getLerped());
    cyclops.update(0, character.position, rig.camera.position, getLerped());
    eumaeus.update(0, rig.camera.position, getLerped());
    argos.update(0, rig.camera.position, getLerped());
    // Constructors already download in parallel. These independent consumers
    // can also decode/compile together, after the player skeleton is ready.
    await Promise.all([
        bow.warmUp(), arrows.warmUp(), spray.warmUp(), pedestals.warmUp(),
        giant.warmUp(), antinous.warmUp(), sheep.warmUp(), cyclops.warmUp(),
        eumaeus.warmUp(), argos.warmUp(), zeusDeath.warmUp(),
    ]);
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
        // Submit while the canvas texture is still alive, before yielding.
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await loading.nextFrame();
    }

    // ------------------------------------------------------------- run loop
    let prev = performance.now();
    let time = 0;
    const takeArgos = () => {
        const a = argos.pollCardInspect(character.position);
        if (!a) return false;
        showDrop("argos", a.x, a.z);
        argos.ascend(spray);
        return true;
    };
    const interact = () => {
        const pos = character.position;
        if (antinous.pollRevive(pos)) { input.inspectPressed = false; return; }
        const argosNear = !hasCard("argos") && argos.inInspectRange(pos);
        const wantGift = !avatar.hasBow;
        let argosFirst = argosNear;
        if (argosNear && wantGift) {
            const ex = pos.x - eumaeus.x, ez = pos.z - eumaeus.z;
            argosFirst = argos.dist2To(pos) <= ex * ex + ez * ez;
        }
        if (argosFirst && takeArgos()) return;
        if (eumaeus.pollGift(pos, wantGift)) { input.inspectPressed = false; return; }
        if (!argosFirst && argosNear && takeArgos()) return;
        if (!hasCard("laestrygonians")) {
            const g = giant.pollCardInspect(pos);
            if (g) { showDrop("laestrygonians", g.x, g.z); return; }
        }
        if (!hasCard("sheep")) {
            const s = sheep.pollCardInspect(pos, time);
            if (s) { showDrop("sheep", s.x, s.z); return; }
        }
        pedestals.pollInspect(rig, pos);
        if (input.inspecting) modes.set("inspect");
    };

    const renderFrame = () => {
        if (document.hidden) return;
        const now = performance.now();
        const elapsed = Math.max(0.0001, (now - prev) / 1000);
        const renderDt = Math.min(0.1, elapsed);
        prev = now;
        if (needsResize) { needsResize = false; engine.resize(); }
        pollInput();
        modes.routeInput();
        if (modes.playing) interact();
        if ((modes.playing || (modes.mode === "inspect" && !modes.suspended)) && input.openPressed) {
            pedestals.openActiveProject();
            input.openPressed = false;
        }
        const simulate = modes.playing && !S.freezeTime;
        const dt = simulate ? renderDt : 0;
        scene.animationTimeScale = simulate ? 1 : 0;
        if (simulate) {
            time += dt;
            updateEnv(dt);
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
        }

        if (modes.cameraActive || (!modes.suspended && modes.mode === "drop")) {
            if (simulate) _vel.copyFrom(character.velocity);
            else _vel.setAll(0);
            rig.update(renderDt, character.position, _vel, simulate ? character.lean : 0, simulate ? character.speed01 : 0);
        }
        const target = guide.update(time);
        compass.update(rig.yaw, target, character.position.x, character.position.z);
        post.update(renderDt, rig.distance);
        sky.update();
        sky.render(rig, time);
        shadows.update(rig.camera, sky.sunDir);
        const env = getLerped();
        pedestals.update(character.position, rig.camera.position, env, dt);
        if (simulate) {
            giant.update(dt, character.position, rig.camera.position, env);
            if (giant.didHit) { character.applyHit(giant.x, giant.z); avatar.playHit(); }
            sheep.update(dt, rig.camera.position, env);
            cyclops.update(dt, character.position, rig.camera.position, env, elapsed);
            if (cyclops.didHit) { character.applyHit(cyclops.x, cyclops.z, 5.4); avatar.playHit(); }
            antinous.update(dt, character.position, rig.camera.position, env);
            eumaeus.update(dt, rig.camera.position, env);
            argos.update(dt, rig.camera.position, env);
            avatar.update(dt, rig.camera.position, env);
            rig.getLookDir(_aim);
            if (avatar.hasBow) {
                const cam = rig.camera.position;
                loading.setCrosshairWarn(
                    argos.aimHit(cam.x, cam.y, cam.z, _aim.x, _aim.y, _aim.z) ||
                    eumaeus.aimHit(cam.x, cam.y, cam.z, _aim.x, _aim.y, _aim.z)
                );
            }
            bow.update(dt, rig.camera.position, env, _aim);
            arrows.update(dt, rig.camera.position, env);
        } else {
            // Updating dt=0 still lets some actors attack/change animation.
            // Only their view-dependent material bindings run during reading.
            for (const system of viewSystems) system.refreshLighting(rig.camera.position, env);
            bow.update(0, rig.camera.position, env);
        }
        const pos = character.position;
        const argosNear = !hasCard("argos") && argos.inInspectRange(pos);
        let preferArgos = argosNear && avatar.hasBow;
        if (argosNear && !avatar.hasBow) {
            const ex = pos.x - eumaeus.x, ez = pos.z - eumaeus.z;
            preferArgos = argos.dist2To(pos) <= ex * ex + ez * ez;
        }
        eumaeus.updateTalkHint(pos, !avatar.hasBow && !preferArgos);
        argos.updateInspectHint(pos, preferArgos);
        for (const material of litMaterials) lights.apply(material);
        terrain.update(rig.camera.position, pos, dt);
        if (simulate) spray.update(dt, rig.camera.position);
        healthBars.beginFrame();
        if (modes.playing) {
            const gv = giant.getHealthView(pos); if (gv) healthBars.track(gv);
            const av = antinous.getHealthView(pos); if (av) healthBars.track(av);
            const cv = cyclops.getHealthView(pos); if (cv) healthBars.track(cv);
        }
        healthBars.endFrame();
        ui.update(modes.mode, modes.suspended, target, avatar.hasBow, pedestals.card.active, input.locked);
        scene.render();
        post.endFrame();
        endFrame();
    };
    const resetFrameTime = () => { prev = performance.now(); scene.resetLastAnimationTimeFrame(); };
    window.addEventListener("focus", resetFrameTime);
    document.addEventListener("visibilitychange", () => {
        resetFrameTime();
        if (document.hidden) engine.stopRenderLoop(renderFrame);
        else engine.runRenderLoop(renderFrame);
    });
    engine.runRenderLoop(renderFrame);
    if (document.hidden) { modes.pause(); engine.stopRenderLoop(renderFrame); }

    await loading.done();
    modes.activate();

    globalThis.DUNES = {
        engine, scene, rig, character, avatar, contact, spray, pedestals, giant,
        antinous, sheep, cyclops, eumaeus, argos, dropCard, cardBook, zeusDeath,
        bowToast, healthBars, subtitles, compass, bow, arrows,
        terrain, sky, shadows, post, depthPass,
        S, input, modes, guide, ui,
        loadingTimings: loading.timings,
        get gameTime() { return time; },
    };
}

boot().catch((err) => {
    console.error(err);
    loading.fail("Startup failed — see console.");
});
