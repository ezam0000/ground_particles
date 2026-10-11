import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, delay } from "./browserHarness.mjs";

const output = process.env.BENCH_OUTPUT || "/tmp/dunes-benchmark";
const width = Number(process.env.BENCH_WIDTH || 1280);
const height = Number(process.env.BENCH_HEIGHT || 720);
mkdirSync(output, { recursive: true });
const { page, close } = await launchBrowser(process.env.SMOKE_URL || "http://localhost:5173/", width, height);
try {
    await page.waitFor("!!globalThis.DUNES");
    const startup = await page.eval(`(() => {
        const resources = performance.getEntriesByType("resource").filter((r) => r.name.startsWith(location.origin));
        return { readyMs: performance.now(), requests: resources.length,
            transferBytes: resources.reduce((n, r) => n + r.transferSize, 0),
            decodedBytes: resources.reduce((n, r) => n + r.decodedBodySize, 0),
            loading: DUNES.loadingTimings || null };
    })()`);
    await page.eval("if (DUNES.modes) DUNES.modes.resume(false)");
    const results = { width, height, startup, scenes: {}, warnings: page.warnings };
    for (const name of ["spawn", "pillars", "combat"]) {
        await page.eval(`(() => {
            const D = DUNES;
            if (${JSON.stringify(name)} === "pillars") {
                const p = D.pedestals._points.find((p) => p.project.kind === "school");
                D.character.position.set(p.x + 1.2, D.terrain.heightAt(p.x + 1.2, p.z + 1.2), p.z + 1.2);
            }
            if (${JSON.stringify(name)} === "combat") {
                D.character.position.set(0, D.terrain.heightAt(0, 0), 0);
                for (let i = 0; i < 10; i++) D.arrows.fire(i * .08, D.character.position.y + 1.5, 0, 0, -.05, 1);
            }
        })()`);
        await delay(1000);
        const samples = await page.eval(`new Promise((resolve) => {
            const samples = []; let prev = performance.now();
            const observer = DUNES.scene.onAfterRenderObservable.add(() => {
                const now = performance.now(); samples.push(now - prev); prev = now;
                if (samples.length >= 240) {
                    DUNES.scene.onAfterRenderObservable.remove(observer); resolve(samples);
                }
            });
        })`);
        samples.shift(); samples.sort((a, b) => a - b);
        results.scenes[name] = {
            medianMs: samples[Math.floor(samples.length / 2)],
            p95Ms: samples[Math.floor(samples.length * .95)], frames: samples.length,
        };
        await page.screenshot(join(output, name + ".png"));
        console.log(name, results.scenes[name]);
    }
    results.errors = page.errors;
    writeFileSync(join(output, "metrics.json"), JSON.stringify(results, null, 2));
    console.log("startup:", startup, "output:", output);
    if (page.errors.length) process.exitCode = 1;
} finally { close(); }
