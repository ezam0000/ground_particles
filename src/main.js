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
import { ArrowPool } from "./combat/arrows.js";
import { Bow } from "./combat/bow.js";
import { unlockAudio } from "./combat/sfx.js";
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

    await loading.phase("creating device", 0.05);

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

    await loading.phase("building scene", 0.12);

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
    await loading.phase("integrating atmosphere", 0.2);
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
    await loading.phase("baking heightfield", 0.34);
    const terrain = new Terrain(scene, sky, shadows);
    terrain.mesh.renderingGroupId = 1;
    await terrain.build();
    onChange("showTerrain", (v) => (terrain.mesh.isVisible = v));
    depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial());

    await loading.phase("placing character", 0.55);

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

    await loading.phase("planting monoliths", 0.62);

    // Three plazas + the colossus south of spawn.
    const pedestals = new Pedestals(scene, terrain, sky, shadows, depthPass, lights);
    const giant = new Giant(scene, terrain, sky, shadows, depthPass, lights);

    // Bow combat: pooled arrows + procedural bow on the player's hand.
    const arrows = new ArrowPool(scene, terrain, sky, shadows, lights);
    arrows.giant = giant;
    arrows.pedestals = pedestals;
    arrows.onGiantHit = (zone) => giant.playHit(zone);
    const bow = new Bow(scene, sky, shadows, lights, arrows);
    avatar.bow = bow;
    avatar.getAimDir = () => {
        rig.getLookDir(_aim);
        return _aim;
    };
    avatar.getCameraPos = () => rig.camera.position;

    // The rig needs ground heights to keep the spring arm above the sand.
    rig.groundAt = (x, z) => terrain.heightAt(x, z);

    const post = new PostChain(scene, rig.camera, depthPass, sky);

    initInput(canvas);
    canvas.addEventListener("click", () => unlockAudio());

    // ------------------------------------------------------------- warm-up
    // Everything that can compile, compiles here — behind the loading screen.
    await loading.phase("compiling pipelines", 0.8);
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
    await whenReady(sky.material, "sky material", [sky.mesh, false]);
    await depthPass.warmUp();
    post.update(0, rig.distance);
    const passes = post.passes;
    for (let i = 0; i < passes.length; i++) {
        await whenReady(passes[i], "post:" + passes[i].name);
    }

    await loading.phase("warming render targets", 0.94);
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

        pedestals.pollInspect(rig, character.position);
        character.update(dt, rig);
        pedestals.resolveCollision(character.position);
        giant.resolveCollision(character.position);
        terrain.heightfield.clampToPlayArea(character.position);
        contact.update(dt);

        _vel.copyFrom(character.velocity);
        rig.update(dt, character.position, _vel, character.lean, character.speed01);

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
        avatar.update(dt, rig.camera.position, getLerped());
        rig.getLookDir(_aim);
        bow.update(dt, rig.camera.position, getLerped(), _aim);
        arrows.update(dt, rig.camera.position, getLerped());
        // Pedestals just refilled the light pool — push it into the rest of the scene.
        for (const m of [terrain.material, spray.material]) {
            lights.apply(m);
        }
        terrain.update(rig.camera.position, character.position, dt);
        spray.update(dt, rig.camera.position);

        scene.render();
        post.endFrame();

        endFrame();
    });

    await loading.done();

    globalThis.DUNES = {
        engine, scene, rig, character, avatar, contact, spray, pedestals, giant,
        bow, arrows,
        terrain, sky, shadows, post, depthPass,
        S, input,
    };
}

boot().catch((err) => {
    console.error(err);
    loading.fail("Startup failed — see console.");
});
