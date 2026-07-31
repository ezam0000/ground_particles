/**
 * Static check: JS syntax + full WGSL validation, headless.
 *
 * Two layers, both cheap enough to run on every edit:
 *
 *   1. `node --check` over every src JS module. Catches broken syntax before
 *      vite serves a 500.
 *   2. Every WGSL shader pair is run through Babylon's real WGSL processor
 *      (includes expanded, attributes/varyings/uniforms lowered) and compiled
 *      by Dawn (the same validator Chrome uses) via the `webgpu` package. This
 *      is what catches semantic errors like textureSample in non-uniform
 *      control flow — a plain parser cannot.
 *
 * Run: npm run check
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { Initialize, Process, Finalize } from "@babylonjs/core/Engines/Processors/shaderProcessor.js";
import { WebGPUShaderProcessorWGSL } from "@babylonjs/core/Engines/WebGPU/webgpuShaderProcessorsWGSL.pure.js";
import { WebGPUShaderProcessingContext } from "@babylonjs/core/Engines/WebGPU/webgpuShaderProcessingContext.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { create, globals } from "webgpu";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;

// ---------------------------------------------------------------- JS syntax
{
    const walk = (dir, out = []) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p, out);
            else if (e.name.endsWith(".js")) out.push(p);
        }
        return out;
    };
    for (const file of walk(join(ROOT, "src"))) {
        try {
            execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
        } catch (err) {
            failures++;
            console.error(`JS FAIL  ${file}\n${err.stderr}`);
        }
    }
    console.log("JS syntax: done");
}

// ----------------------------------------------------------------- registry
// registry.js imports WGSL via vite's ?raw, which Node cannot. Mirror it:
// parse the import table and the INCLUDES / SHADERS blocks, then fill the same
// ShaderStore maps so #include<...> resolves exactly as it does at runtime.
const registrySrc = readFileSync(join(ROOT, "src/shaders/registry.js"), "utf8");
const shaderDir = join(ROOT, "src/shaders");

const imports = {};
for (const m of registrySrc.matchAll(/import\s+(\w+)\s+from\s+"(\.[^"]+\.wgsl)\?raw";/g)) {
    imports[m[1]] = readFileSync(join(shaderDir, m[2]), "utf8");
}
const block = (name) => {
    const m = registrySrc.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`));
    return m ? m[1] : "";
};
const mapEntries = (src) => {
    const out = {};
    for (const m of src.matchAll(/(\w+):\s*(\w+),/g)) out[m[1]] = imports[m[2]];
    return out;
};
const INCLUDES = mapEntries(block("INCLUDES"));
const SHADERS = mapEntries(block("SHADERS"));

for (const name in INCLUDES) ShaderStore.IncludesShadersStoreWGSL[name] = INCLUDES[name];

// Synthetic fullscreen vertex for the bake fragments (ProceduralTexture).
const FULLSCREEN_VERT = `
attribute position: vec2f;
varying vUV: vec2f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.position = vec4f(vertexInputs.position, 0.0, 1.0);
    vertexOutputs.vUV = vertexInputs.position * 0.5 + 0.5;
}
`;

// Every vertex/fragment combination the app can create.
const PAIRS = [
    ["snow", "snow"], ["sky", "sky"],
    ["terrainDepth", "terrainDepth"],
    ["char", "char"], ["cloth", "char"],
    ["fur", "fur"], ["spray", "spray"],
    ["charDepth", "terrainDepth"], ["clothDepth", "terrainDepth"],
    ["terrainPrepass", "prepass"], ["charPrepass", "prepass"],
    ["clothPrepass", "prepass"], ["staticPrepass", "prepass"],
    ["prop", "prop"], ["staticDepth", "terrainDepth"],
];
const FRAGMENT_ONLY = ["heightBake", "auxBake", "detailBake", "skyBake", "deformSim"];

function processPair(vertexCode, fragmentCode) {
    const processorOptions = {
        defines: [],
        indexParameters: undefined,
        isFragment: false,
        shouldUseHighPrecisionShader: false,
        processor: new WebGPUShaderProcessorWGSL(),
        supportsUniformBuffers: true,
        shadersRepository: "",
        includesShadersStore: ShaderStore.IncludesShadersStoreWGSL,
        version: "100",
        platformName: "WEBGPU",
        processingContext: new WebGPUShaderProcessingContext(ShaderLanguage.WGSL),
        isNDCHalfZRange: true,
        useReverseDepthBuffer: false,
    };

    return new Promise((resolve, reject) => {
        try {
            Initialize(processorOptions);
            Process(vertexCode, processorOptions, (migratedVertex) => {
                processorOptions.isFragment = true;
                Process(fragmentCode, processorOptions, (migratedFragment) => {
                    resolve(Finalize(migratedVertex, migratedFragment, processorOptions));
                });
            });
        } catch (err) {
            reject(err);
        }
    });
}

// ------------------------------------------------------------ Dawn validate
Object.assign(globalThis, globals);
const navigator = { gpu: create([]) };

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
    console.error("No WebGPU adapter available in this environment — skipping WGSL compile check");
    process.exit(failures ? 1 : 0);
}
const device = await adapter.requestDevice();

let compiled = 0;
async function compileModule(label, code) {
    const mod = device.createShaderModule({ code });
    const info = await mod.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length) {
        failures++;
        console.error(`WGSL FAIL  ${label}`);
        for (const e of errors.slice(0, 6)) {
            console.error(`  ${e.lineNum}:${e.linePos}  ${e.message.split("\n")[0]}`);
        }
    } else {
        compiled++;
    }
}

for (const [v, f] of PAIRS) {
    const vertexCode = SHADERS[v + "VertexShader"];
    const fragmentCode = SHADERS[f + "PixelShader"];
    if (!vertexCode || !fragmentCode) {
        failures++;
        console.error(`WGSL FAIL  ${v}/${f}: missing shader source (registry drift?)`);
        continue;
    }
    try {
        const { vertexCode: vFinal, fragmentCode: fFinal } = await processPair(vertexCode, fragmentCode);
        await compileModule(`${v}.vertex`, vFinal);
        await compileModule(`${f}.fragment`, fFinal);
    } catch (err) {
        failures++;
        console.error(`WGSL FAIL  ${v}/${f}: processor error: ${err.message}`);
    }
}

for (const f of FRAGMENT_ONLY) {
    const fragmentCode = SHADERS[f + "PixelShader"];
    if (!fragmentCode) {
        failures++;
        console.error(`WGSL FAIL  ${f}: missing shader source (registry drift?)`);
        continue;
    }
    try {
        const { fragmentCode: fFinal } = await processPair(FULLSCREEN_VERT, fragmentCode);
        await compileModule(`${f}.fragment`, fFinal);
    } catch (err) {
        failures++;
        console.error(`WGSL FAIL  ${f}: processor error: ${err.message}`);
    }
}

console.log(failures ? `\n${failures} check(s) FAILED` : `\nWGSL: ${compiled} modules compiled clean`);
device.destroy();
process.exit(failures ? 1 : 0);
