/** Browser integration coverage of input ownership, reading, preferences, and the Odyssey. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, delay } from "./browserHarness.mjs";

const output = process.env.SMOKE_OUTPUT || "/tmp/dunes-polish-1280";
const width = Number(process.env.BENCH_WIDTH || 1280), height = Number(process.env.BENCH_HEIGHT || 720);
mkdirSync(output, { recursive: true });
const { page, close } = await launchBrowser(process.env.SMOKE_URL || "http://localhost:5173/", width, height);
const passed = [];
const check = async (expression, label) => {
    if (!await page.eval(expression)) throw new Error(label);
    passed.push(label); console.log("ok:", label);
};
const shot = (name) => page.screenshot(join(output, name + ".png"));
const move = async (expression) => {
    await page.eval(`(() => { const D = DUNES; const p = (${expression});
        D.character.position.set(p.x, D.terrain.heightAt(p.x, p.z), p.z);
        D.character.velocity.setAll(0); D.character.airborne = false; })()`);
    await delay(350);
};
try {
    await page.waitFor("!!globalThis.DUNES?.modes");
    await page.waitFor("!document.getElementById('boot')");
    await check("DUNES.modes.playing", "exploration starts with original controls");
    await shot("spawn");
    await page.eval("window.__opened = []; window.open = (...args) => { window.__opened.push(args); return null; }");

    for (const id of ["project", "job", "school", "odyssey"]) {
        await page.click('#experience-toolbar [data-action="destinations"]');
        await page.waitFor("DUNES.modes.mode === 'destinations'");
        await page.click(`[data-action="destination"][data-value="${id}"]`);
        await check(`DUNES.guide.selected === '${id}' && DUNES.modes.playing`, "destination selection: " + id);
    }
    await page.key("KeyB"); await page.waitFor("DUNES.modes.mode === 'book'");
    await check("document.querySelector('.ob-progress').textContent === 'Collected 0 of 6' && document.querySelectorAll('.ob-slot.locked').length === 6", "empty book includes six unnamed discovery slots");
    await shot("book-empty");
    const frozen = await page.eval("({time:DUNES.gameTime, animation:DUNES.scene._animationTime, x:DUNES.giant.x, shots:DUNES.bow._shots})");
    await page.key("KeyR"); await page.key("KeyE"); await page.key("KeyI"); await delay(400);
    await check(`DUNES.gameTime === ${frozen.time} && DUNES.scene._animationTime === ${frozen.animation} && DUNES.giant.x === ${frozen.x} && DUNES.bow._shots === ${frozen.shots} && __opened.length === 0`, "book freezes simulation/animations and consumes gameplay keys");
    await page.key("Escape"); await check("DUNES.modes.playing && !DUNES.cardBook.visible", "Escape closes the collection book");
    await page.key("KeyH"); await page.waitFor("DUNES.modes.mode === 'help'"); await shot("help");
    await check("document.querySelectorAll('.controls-grid div').length === 16", "Help exposes the complete control list");
    await page.key("Escape");

    await page.key("KeyP"); await page.waitFor("DUNES.modes.mode === 'preferences'");
    await page.eval(`(() => { const slider = document.querySelector('[data-preference="volume"]'); slider.value = '.35'; slider.dispatchEvent(new Event('input',{bubbles:true}));
        const sensitivity = document.querySelector('[data-preference="sensitivity"]'); sensitivity.value = '1.25'; sensitivity.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await page.click('[data-preference="reducedMotion"]');
    await check("JSON.parse(localStorage.getItem('dunes.preferences.v1')).volume === .35 && document.documentElement.classList.contains('reduced-motion')", "preferences save volume and reduced motion");
    await shot("preferences"); await page.key("Escape");
    await page.reloadReady();
    await check("document.documentElement.classList.contains('reduced-motion') && JSON.parse(localStorage.getItem('dunes.preferences.v1')).sensitivity === 1.25", "preferences survive reload without touching collected cards");
    await page.eval("window.__opened=[]; window.open=(...args)=>{ __opened.push(args); return null; }");

    await move("(() => { const p=D.pedestals._points.find(p=>p.project.kind==='school'); return {x:p.x+1.2,z:p.z+1.2}; })()");
    await check("!!DUNES.pedestals.card.active", "portfolio proximity card appears"); await shot("portfolio");
    await page.key("KeyI"); await page.waitFor("DUNES.modes.mode === 'inspect'");
    const inspectTime = await page.eval("DUNES.gameTime");
    const yaw = await page.eval("DUNES.rig.yaw");
    await page.eval("DUNES.input.lookX=.2"); await delay(150);
    await check(`DUNES.gameTime === ${inspectTime} && DUNES.rig.yaw !== ${yaw}`, "inspection orbits while gameplay stays frozen");
    await shot("inspection"); await page.key("KeyR");
    await check("DUNES.avatar._busy !== 'draw'", "inspection cannot draw the bow");
    await page.key("Escape"); await check("DUNES.modes.playing && !DUNES.input.inspecting && !DUNES.rig.inspecting", "Escape exits inspection cleanly");
    await move("(() => { const p=D.pedestals._points.find(p=>p.project.link); return {x:p.x+1.1,z:p.z+1.1}; })()");
    await page.key("KeyE"); await check("__opened.length === 1", "E opens exactly one active project link");

    await page.eval("window.dispatchEvent(new Event('blur'))");
    const pauseTime = await page.eval("DUNES.gameTime");
    await page.key("KeyW"); await page.eval("window.dispatchEvent(new Event('focus'))"); await delay(300);
    await check(`DUNES.modes.suspended && DUNES.gameTime === ${pauseTime}`, "focus loss pauses and focus return does not auto-resume");
    await shot("paused"); await page.click('[data-action="resume"]');
    await page.waitFor("!DUNES.modes.suspended", 5000);
    await check("DUNES.modes.playing", "intentional Resume click restores play");
    // Release through a menu so this does not count as an accidental focus loss.
    await page.key("KeyH"); await page.key("Escape");

    await move("(() => { const e=D.eumaeus,a=D.argos; const n=Math.hypot(e.x-a.x,e.z-a.z)||1; return {x:e.x+(e.x-a.x)/n,z:e.z+(e.z-a.z)/n}; })()");
    await page.key("KeyI"); await page.waitFor("DUNES.dropCard.activeId === 'eumaeus'");
    await check("DUNES.avatar.hasBow && DUNES.modes.mode === 'drop'", "Eumaeus grants the bow and opens a paused reward");
    await page.key("KeyF");
    await check("DUNES.dropCard.flipped && getComputedStyle(document.querySelector('.od-card')).transitionDuration === '0s'", "reduced motion makes card flips instant");
    await shot("reward-lore"); await page.key("KeyE");
    await check("DUNES.modes.playing && !DUNES.dropCard.visible && __opened.length === 1", "reward continue does not also open a portfolio site");
    await move("({x:0,z:0})"); await page.key("KeyR"); await page.waitFor("DUNES.bow._shots === 1");
    await check("DUNES.arrows._state.some(s=>s!==0)", "R releases a rendered projectile through the real bow animation");
    await delay(1800); await page.eval("DUNES.arrows.clearFlying()");
    await move("({x:D.argos.x+.5,z:D.argos.z+.5})"); await page.key("KeyI");
    await page.waitFor("DUNES.dropCard.activeId === 'argos'"); await page.key("Escape");
    await move("({x:D.giant.x+2.5,z:D.giant.z})"); await page.key("KeyI");
    await page.waitFor("DUNES.dropCard.activeId === 'laestrygonians'"); await page.key("KeyE");
    await move("({x:0,z:0})"); await page.waitFor("DUNES.gameTime >= 30", 60000);
    await move("({x:D.sheep.sheep[0].x+.7,z:D.sheep.sheep[0].z+.7})"); await page.key("KeyI");
    await page.waitFor("DUNES.dropCard.activeId === 'sheep'"); await page.key("KeyE");
    await check("JSON.parse(localStorage.getItem('dunes.cards.v1')).length === 4", "peaceful discoveries preserve existing unlock rules and storage");
    // Deterministic damage fixtures exercise the same callbacks used by arrow collisions.
    await page.eval("for(const s of DUNES.sheep.sheep){ DUNES.arrows.onSheepHit(s); DUNES.arrows.onSheepHit(s); }");
    await page.waitFor("DUNES.cyclops.alive");
    await move("({x:D.cyclops.x+8,z:D.cyclops.z})"); await page.eval("DUNES.arrows.onCyclopsHit('head')");
    await page.key("KeyB"); const headClock = await page.eval("DUNES.cyclops._elapsedMs"); await delay(600);
    await check(`DUNES.cyclops._elapsedMs === ${headClock} && DUNES.cyclops._headTimes.length === 1`, "Cyclops damage window pauses with the book");
    await page.key("KeyB");
    await page.eval("for(let i=0;i<4;i++) DUNES.arrows.onCyclopsHit('head')");
    await page.waitFor("DUNES.dropCard.activeId === 'polyphemus'"); await page.key("KeyE");
    await check("!DUNES.cyclops.alive", "five headshots still defeat Polyphemus");
    await move("({x:0,z:0})");
    await page.eval("DUNES.rig.yaw=Math.atan2(DUNES.sky.sunDir.x,DUNES.sky.sunDir.z); DUNES.rig.pitch=-Math.asin(DUNES.sky.sunDir.y)");
    for(let i=0;i<5;i++) { await page.waitFor("!DUNES.avatar._busy"); await page.key("KeyR"); await delay(1200); }
    await page.waitFor("DUNES.antinous._spawned");
    await page.eval("for(let i=0;i<20;i++) DUNES.arrows.onAntinousHit('head')");
    await page.waitFor("DUNES.dropCard.activeId === 'antinous'"); await page.key("KeyE");
    await page.key("KeyB");
    await check("document.querySelector('.ob-progress').textContent === 'Collected 6 of 6' && !document.querySelector('.ob-slot.locked')", "complete book shows all six saved collectibles");
    await shot("book-complete"); await page.key("KeyF"); await shot("book-lore"); await page.key("KeyB");

    await move("({x:0,z:0})");
    await page.eval("const e=DUNES.eumaeus; DUNES.arrows.fire(e.x,DUNES.terrain.heightAt(e.x,e.z)+.75,e.z-1,0,0,1)");
    await page.waitFor("DUNES.zeusDeath.visible"); await shot("zeus"); await page.key("KeyE");
    await check("DUNES.modes.playing && !DUNES.avatar.hasBow && Math.abs(DUNES.character.position.x)<.01 && __opened.length===1", "sacred-NPC impact and respawn preserve bow loss and isolate Continue");
    await page.key("KeyB"); await check("document.querySelector('.ob-progress').textContent === 'Collected 6 of 6'", "respawn retains collected cards"); await page.key("KeyB");

    await page.eval("Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'))");
    await check("DUNES.engine._activeRenderLoops.length===0 && DUNES.modes.suspended", "hidden-tab event stops the render loop");
    await page.eval("delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))");
    await page.waitFor("DUNES.engine._activeRenderLoops.length===1");
    await check("DUNES.modes.suspended", "visibility return waits for explicit resume");
    await page.click('[data-action="resume"]'); await page.waitFor("!DUNES.modes.suspended");
    await check("Number.isFinite(DUNES.character.acceleration.x) && Number.isFinite(DUNES.character.position.y)", "resume resets timing without NaN or catch-up jumps");
    for(const [w,h] of [[960,600],[width,height]]) {
        await page.send("Emulation.setDeviceMetricsOverride",{width:w,height:h,deviceScaleFactor:1,mobile:false}); await delay(350);
    }
    await check("!/[←→↑↓↔↕➜➔]/.test(document.body.innerText)", "interface contains no arrow glyphs");
    await page.reloadReady();
    await page.key("KeyB"); await check("document.querySelector('.ob-progress').textContent === 'Collected 6 of 6'", "collected-card storage survives a fresh world visit");
    if (page.errors.length) throw new Error(page.errors.join("\n"));
    if (page.warnings.some((w) => /GPUValidation|Destroyed texture/.test(w))) throw new Error("WebGPU validation warning: " + page.warnings.join("\n"));
    writeFileSync(join(output, "results.json"), JSON.stringify({ width,height,passed,warnings:page.warnings,errors:page.errors },null,2));
    console.log("Polish smoke passed. Screenshots:", output);
} catch (err) {
    await shot("failure");
    console.error(err, page.errors, page.warnings);
    process.exitCode = 1;
} finally { close(); }
