/**
 * Runtime smoke test — boots the demo in headless Chrome (real WebGPU), then
 * verifies the three things `npm run check` cannot:
 *
 *   1. the app reaches `loading.done()` (every pipeline compiled, zero throw)
 *   2. the proximity card opens near a pedestal and hides away from it
 *   3. Space jumps (airborne flag flips) and the landing print path survives
 *
 * Run with the dev server up:  npm run dev  &  npm run smoke
 * Exits non-zero on any failure and drops screenshots in /tmp for eyeballing.
 */

import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const URL = process.env.SMOKE_URL || "http://localhost:5173/";
const CHROME =
    process.env.CHROME_BIN ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BOOT_TIMEOUT_MS = 90_000;

// ------------------------------------------------------------------- plumbing

/** Minimal CDP client over the page target's WebSocket. */
class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.errors = [];
        this.ready = new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
        });
        this.ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            } else if (msg.method === "Runtime.exceptionThrown") {
                const d = msg.params.exceptionDetails;
                this.errors.push("page exception: " + (d.exception?.description || d.text));
            } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
                this.errors.push(
                    "console.error: " +
                    msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")
                );
            }
        };
    }

    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Evaluate an expression, returning the JSON-safe value. */
    async eval(expression) {
        const r = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
        });
        if (r.exceptionDetails) {
            throw new Error("eval failed: " + expression + " — " +
                (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        }
        return r.result.value;
    }

    /** Poll `expr` until it is truthy or the deadline passes. */
    async waitFor(expr, timeoutMs, label) {
        const t0 = Date.now();
        for (;;) {
            try {
                if (await this.eval(expr)) return;
            } catch { /* page may still be parsing */ }
            if (Date.now() - t0 > timeoutMs) {
                throw new Error("timed out waiting for " + label);
            }
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    async screenshot(path) {
        const r = await this.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(path, Buffer.from(r.data, "base64"));
    }
}

// ----------------------------------------------------------------------- main

// Fresh profile every run — a warm one caches Vite dep chunks by content hash,
// and any re-optimization 404s Babylon's lazy `procedural.vertex` import.
rmSync("/tmp/dunes-smoke-profile", { recursive: true, force: true });

const chrome = spawn(CHROME, [
    ...(process.env.HEADED ? [] : ["--headless=new"]),
    "--enable-unsafe-webgpu",
    "--no-first-run",
    "--user-data-dir=/tmp/dunes-smoke-profile",
    "--remote-debugging-port=0",
    "--window-size=1280,800",
    URL,
], { stdio: ["ignore", "ignore", "pipe"] });

let chromeStderr = "";
const wsUrl = await new Promise((resolve, reject) => {
    chrome.stderr.on("data", (d) => {
        chromeStderr += d;
        const m = chromeStderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
    });
    chrome.on("exit", () => reject(new Error("Chrome exited early:\n" + chromeStderr)));
    setTimeout(() => reject(new Error("no DevTools socket")), 15_000);
});

const failures = [];
try {
    // Discover the page target's own DevTools socket off the browser one.
    const listUrl = wsUrl
        .replace("ws://", "http://")
        .replace(/\/devtools\/browser.*$/, "/json/list");
    const targets = await (await fetch(listUrl)).json();
    const page = targets.find((t) => t.type === "page" && t.url.startsWith("http"));
    const pageCdp = new CDP(page.webSocketDebuggerUrl);
    await pageCdp.ready;
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");

    // ---------------------------------------------------------- 1. boot
    try {
        await pageCdp.waitFor("!!globalThis.DUNES", BOOT_TIMEOUT_MS, "DUNES (boot)");
    } catch (err) {
        for (const e of pageCdp.errors) console.log(" ", e);
        throw err;
    }
    console.log("boot: ok");
    await pageCdp.screenshot("/tmp/smoke_spawn.png");

    // --------------------------------------------- 2. proximity card
    // Prefer a school pedestal (near spawn) so the résumé zones are covered.
    await pageCdp.eval(`(() => {
        const D = globalThis.DUNES;
        const pts = D.pedestals._points;
        const p = pts.find((t) => t.project && t.project.kind === "school")
            || pts.find((t) => t.project)
            || pts[0];
        D.character.position.set(p.x + 1.2, 0, p.z + 1.2);
        D.character.position.y = D.terrain.heightAt(p.x + 1.2, p.z + 1.2);
        return p.project ? p.project.kind : "none";
    })()`);
    await new Promise((r) => setTimeout(r, 800)); // a few frames
    const cardShown = await pageCdp.eval(
        `document.getElementById("pcard").classList.contains("show")`
    );
    const cardTitle = await pageCdp.eval(
        `document.querySelector("#pcard .t").textContent`
    );
    if (!cardShown) failures.push("card did not open next to a pedestal");
    console.log("card:", cardShown ? `ok ("${cardTitle}")` : "FAIL");
    await pageCdp.screenshot("/tmp/smoke_card.png");

    // Walk away again — card must hide.
    await pageCdp.eval("globalThis.DUNES.character.position.set(0, 0, 0)");
    await new Promise((r) => setTimeout(r, 800));
    const cardHidden = await pageCdp.eval(
        `!document.getElementById("pcard").classList.contains("show")`
    );
    if (!cardHidden) failures.push("card stayed open away from pedestals");
    console.log("card hides:", cardHidden ? "ok" : "FAIL");

    // --------------------------------------------------------- 3. jump
    await pageCdp.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }))`
    );
    await new Promise((r) => setTimeout(r, 250));
    const airborne = await pageCdp.eval("globalThis.DUNES.character.airborne");
    if (!airborne) failures.push("Space did not start a jump");
    console.log("jump:", airborne ? "ok" : "FAIL");
    await pageCdp.waitFor("globalThis.DUNES.character.airborne === false", 5000, "landing");
    console.log("landing: ok");
    await pageCdp.screenshot("/tmp/smoke_landed.png");

    if (pageCdp.errors.length) {
        failures.push(...pageCdp.errors);
    }
} catch (err) {
    failures.push(err.message);
} finally {
    chrome.kill("SIGKILL");
}

if (failures.length) {
    console.error("\nSMOKE FAIL:");
    for (const f of failures) console.error(" - " + f.split("\n")[0]);
    process.exit(1);
}
console.log("\nsmoke: all checks passed — screenshots in /tmp/smoke_*.png");
