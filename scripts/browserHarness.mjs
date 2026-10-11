import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CDP {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.id = 0;
        this.pending = new Map();
        this.errors = [];
        this.warnings = [];
        this.ready = new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
        });
        this.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            } else if (msg.method === "Runtime.exceptionThrown") {
                const d = msg.params.exceptionDetails;
                this.errors.push(d.exception?.description || d.text);
            } else if (msg.method === "Runtime.consoleAPICalled") {
                const p = msg.params;
                const line = p.args.map((a) => a.value ?? a.description ?? "").join(" ");
                if (p.type === "error") this.errors.push(line);
                if (p.type === "warning") this.warnings.push(line);
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
    async eval(expression) {
        const r = await this.send("Runtime.evaluate", {
            expression, returnByValue: true, awaitPromise: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
    }
    async waitFor(expression, timeoutMs = 90000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.eval(expression)) return;
            await delay(250);
        }
        throw new Error("Timed out: " + expression);
    }
    async key(code) {
        const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code === "Space" ? " " : code;
        await this.send("Input.dispatchKeyEvent", { type: "keyDown", code, key });
        await delay(100);
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", code, key });
    }
    async click(selector) {
        const point = await this.eval(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error("Missing click target");
            const r = el.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 };
        })()`);
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    }
    async screenshot(path) {
        const r = await this.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(path, Buffer.from(r.data, "base64"));
    }
    async reloadReady() {
        const origin = await this.eval("performance.timeOrigin");
        await this.send("Page.reload");
        await this.waitFor(`performance.timeOrigin !== ${origin} && !!globalThis.DUNES?.modes`);
        await this.waitFor("!document.getElementById('boot')");
    }
}

export async function launchBrowser(url, width = 1280, height = 720) {
    const profile = mkdtempSync(join(tmpdir(), "dunes-verify-"));
    const chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        "--headless=new", "--enable-unsafe-webgpu", "--no-first-run",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--user-data-dir=" + profile, "--remote-debugging-port=0",
        `--window-size=${width},${height}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    try {
        const socket = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Chrome did not expose DevTools: " + stderr)), 15000);
            chrome.stderr.on("data", (data) => {
                stderr += data;
                const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
                if (m) { clearTimeout(timeout); resolve(m[1]); }
            });
            chrome.on("exit", () => { clearTimeout(timeout); reject(new Error("Chrome exited: " + stderr)); });
        });
        const list = await (await fetch(socket.replace("ws://", "http://").replace(/\/devtools\/browser.*$/, "/json/list"))).json();
        const page = new CDP(list.find((t) => t.type === "page").webSocketDebuggerUrl);
        await page.ready;
        await page.send("Runtime.enable");
        await page.send("Page.enable");
        await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        await page.send("Page.navigate", { url });
        return { page, close: () => {
            page.ws.close();
            chrome.kill("SIGKILL");
            setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
        } };
    } catch (err) {
        chrome.kill("SIGKILL");
        rmSync(profile, { recursive: true, force: true });
        throw err;
    }
}
