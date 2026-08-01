/**
 * Crush odyssey GLB textures for web delivery.
 *
 * Runtime prop shading only samples base color. Drop extra maps and
 * downscale / re-JPEG the albedo hard. Skins + animations are preserved.
 *
 *   node scripts/crushPillarTextures.mjs
 *   node scripts/crushPillarTextures.mjs giant.glb
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "public/assets/odyssey/models");
const MAX_EDGE = 512;
const JPEG_Q = 12; // ffmpeg mjpeg: 2=best … 31=worst; 12 is rough but readable

function parseGlb(buf) {
    let o = 12;
    let json = null;
    const bins = [];
    while (o + 8 <= buf.length) {
        const len = buf.readUInt32LE(o); o += 4;
        const type = buf.toString("ascii", o, o + 4); o += 4;
        const data = buf.subarray(o, o + len); o += len;
        if (type === "JSON") {
            json = JSON.parse(Buffer.from(data).toString().replace(/\0+$/, ""));
        } else if (type === "BIN\0") {
            bins.push(data);
        }
    }
    return { json, bin: Buffer.concat(bins) };
}

function pad4(n) {
    return (n + 3) & ~3;
}

function writeGlb(json, bin) {
    const jsonStr = JSON.stringify(json);
    const jsonBytes = Buffer.from(jsonStr);
    const jsonPad = pad4(jsonBytes.length) - jsonBytes.length;
    const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);

    const binPad = pad4(bin.length) - bin.length;
    const binChunk = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;

    const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
    const out = Buffer.alloc(total);
    out.write("glTF", 0);
    out.writeUInt32LE(2, 4);
    out.writeUInt32LE(total, 8);
    let o = 12;
    out.writeUInt32LE(jsonChunk.length, o); o += 4;
    out.write("JSON", o); o += 4;
    jsonChunk.copy(out, o); o += jsonChunk.length;
    out.writeUInt32LE(binChunk.length, o); o += 4;
    out.write("BIN\0", o); o += 4;
    binChunk.copy(out, o);
    return out;
}

/** Pick the albedo image: material baseColor → named base_color → first. */
function pickAlbedoImage(json) {
    const images = json.images || [];
    for (const mat of json.materials || []) {
        const texIdx = mat.pbrMetallicRoughness?.baseColorTexture?.index;
        if (texIdx == null) continue;
        const src = json.textures?.[texIdx]?.source;
        if (src != null && images[src]) return images[src];
    }
    return images.find((im) => im.name === "base_color") || images[0] || null;
}

function crushImage(bytes, mime, workDir, tag) {
    const ext = mime === "image/png" ? ".png" : ".jpg";
    const inn = join(workDir, `${tag}-in${ext}`);
    const out = join(workDir, `${tag}-out.jpg`);
    writeFileSync(inn, bytes);
    execFileSync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", inn,
        "-vf", `scale='min(${MAX_EDGE},iw)':'min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease`,
        "-q:v", String(JPEG_Q),
        out,
    ], { stdio: "pipe" });
    return readFileSync(out);
}

function crushFile(file) {
    const src = join(DIR, file);
    const before = readFileSync(src);
    const { json, bin } = parseGlb(before);

    const work = mkdtempSync(join(tmpdir(), "pillar-crush-"));
    try {
        const baseImg = pickAlbedoImage(json);
        if (!baseImg || baseImg.bufferView == null) {
            console.warn("skip (no image):", file);
            return;
        }

        const bv = json.bufferViews[baseImg.bufferView];
        const raw = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
        const crushed = crushImage(
            raw, baseImg.mimeType || "image/jpeg", work, file.replace(/\.glb$/, "")
        );

        const keepView = new Set();
        for (const acc of json.accessors || []) {
            if (acc.bufferView != null) keepView.add(acc.bufferView);
            if (acc.sparse?.indices?.bufferView != null) keepView.add(acc.sparse.indices.bufferView);
            if (acc.sparse?.values?.bufferView != null) keepView.add(acc.sparse.values.bufferView);
        }

        const parts = [];
        const remap = new Map();
        let offset = 0;
        const oldViews = json.bufferViews || [];

        for (const idx of [...keepView].sort((a, b) => a - b)) {
            const v = oldViews[idx];
            const start = v.byteOffset || 0;
            const slice = bin.subarray(start, start + v.byteLength);
            const aligned = pad4(offset);
            if (aligned > offset) parts.push(Buffer.alloc(aligned - offset));
            offset = aligned;
            remap.set(idx, {
                newIndex: remap.size,
                byteOffset: offset,
                byteLength: slice.length,
                byteStride: v.byteStride,
                target: v.target,
            });
            parts.push(slice);
            offset += slice.length;
        }

        const imgAligned = pad4(offset);
        if (imgAligned > offset) parts.push(Buffer.alloc(imgAligned - offset));
        offset = imgAligned;
        const imgViewIndex = remap.size;
        parts.push(crushed);
        const imgByteOffset = offset;

        const newBin = Buffer.concat(parts);
        const newViews = [];
        for (const [, meta] of [...remap.entries()].sort((a, b) => a[1].newIndex - b[1].newIndex)) {
            const entry = {
                buffer: 0,
                byteOffset: meta.byteOffset,
                byteLength: meta.byteLength,
            };
            if (meta.byteStride != null) entry.byteStride = meta.byteStride;
            if (meta.target != null) entry.target = meta.target;
            newViews.push(entry);
        }
        newViews.push({
            buffer: 0,
            byteOffset: imgByteOffset,
            byteLength: crushed.length,
        });

        for (const acc of json.accessors || []) {
            if (acc.bufferView != null) acc.bufferView = remap.get(acc.bufferView).newIndex;
            if (acc.sparse?.indices?.bufferView != null) {
                acc.sparse.indices.bufferView = remap.get(acc.sparse.indices.bufferView).newIndex;
            }
            if (acc.sparse?.values?.bufferView != null) {
                acc.sparse.values.bufferView = remap.get(acc.sparse.values.bufferView).newIndex;
            }
        }

        json.bufferViews = newViews;
        json.buffers = [{ byteLength: newBin.length }];
        json.images = [{ name: "base_color", mimeType: "image/jpeg", bufferView: imgViewIndex }];
        json.textures = [{ sampler: 0, source: 0 }];
        json.samplers = json.samplers?.length
            ? [json.samplers[0]]
            : [{ magFilter: 9729, minFilter: 9987 }];

        for (const mat of json.materials || []) {
            delete mat.emissiveTexture;
            delete mat.normalTexture;
            delete mat.occlusionTexture;
            delete mat.emissiveFactor;
            delete mat.extensions;
            mat.alphaMode = "OPAQUE";
            mat.pbrMetallicRoughness = {
                baseColorTexture: { index: 0 },
                metallicFactor: 0,
                roughnessFactor: 0.75,
            };
        }

        const out = writeGlb(json, newBin);
        writeFileSync(src, out);
        const pct = ((1 - out.length / before.length) * 100).toFixed(0);
        console.log(
            `${file.padEnd(24)} ${(before.length / 1e6).toFixed(2)}MB → ${(out.length / 1e6).toFixed(2)}MB  (−${pct}%)  albedo ${(crushed.length / 1024).toFixed(0)}KB`
        );
        return { before: before.length, after: out.length };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

const only = process.argv.slice(2).filter((a) => a.endsWith(".glb"));
const files = only.length
    ? only
    : readdirSync(DIR).filter((f) => f.endsWith(".glb")).sort();

let before = 0, after = 0;
for (const f of files) {
    const r = crushFile(f);
    if (r) { before += r.before; after += r.after; }
}
if (before) {
    console.log(
        `\nTOTAL  ${(before / 1e6).toFixed(1)}MB → ${(after / 1e6).toFixed(1)}MB  (−${((1 - after / before) * 100).toFixed(0)}%)`
    );
}
