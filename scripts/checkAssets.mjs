/** Validate the admitted weapon/portrait bytes against their optimization receipts. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const receipts = JSON.parse(readFileSync(new URL("../docs/asset-optimization.json", import.meta.url)));
const components = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
let sourceBytes = 0, outputBytes = 0;
for (const receipt of receipts) {
    const bytes = readFileSync(new URL("../" + receipt.asset, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.outputSha256, receipt.asset + " digest");
    assert.equal(bytes.length, receipt.outputBytes);
    sourceBytes += receipt.sourceBytes; outputBytes += bytes.length;
    if (receipt.asset.endsWith(".png")) {
        assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
        assert.equal(bytes.readUInt32BE(16), 256); assert.equal(bytes.readUInt32BE(20), 256);
        assert.equal(bytes[25], 6, "Portrait must retain RGBA transparency");
    } else {
        assert.equal(bytes.toString("ascii", 0, 4), "glTF");
        assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
        const jsonLength = bytes.readUInt32LE(12);
        const doc = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
        const bin = bytes.subarray(28 + jsonLength);
        assert.equal(doc.nodes.length, 1); assert.equal(doc.nodes[0].name, "Mesh_0");
        assert.ok(!doc.nodes[0].matrix && !doc.nodes[0].translation && !doc.nodes[0].rotation && !doc.nodes[0].scale, "Keep authored weapon transform");
        for (const view of doc.bufferViews) assert.ok((view.byteOffset || 0) + view.byteLength <= bin.length);
        const primitive = doc.meshes[0].primitives[0];
        const positions = doc.accessors[primitive.attributes.POSITION];
        const indices = doc.accessors[primitive.indices];
        assert.equal(indices.count / 3, receipt.outputTriangles);
        assert.ok(indices.count / 3 <= (receipt.asset.endsWith("arrow.glb") ? 2100 : 6300));
        for (const attribute of ["POSITION", "NORMAL", "TEXCOORD_0"]) {
            const accessor = doc.accessors[primitive.attributes[attribute]];
            assert.equal(accessor.count, positions.count);
            assert.equal(accessor.componentType, 5126);
            const view = doc.bufferViews[accessor.bufferView];
            const size = sizes[accessor.type]; const stride = view.byteStride || size * 4;
            const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
            for (let i = 0; i < accessor.count; i++) {
                for (let j = 0; j < size; j++) assert.ok(Number.isFinite(bin.readFloatLE(start + i * stride + j * 4)), "Finite " + attribute);
            }
        }
        const view = doc.bufferViews[indices.bufferView];
        const start = (view.byteOffset || 0) + (indices.byteOffset || 0);
        const size = components[indices.componentType];
        for (let i = 0; i < indices.count; i++) assert.ok(bin.readUIntLE(start + i * size, size) < positions.count, "Valid vertex index");
        for (let axis = 0; axis < 3; axis++) {
            const tolerance = Math.max((receipt.sourceBounds[1][axis] - receipt.sourceBounds[0][axis]) * .02, .002);
            assert.ok(Math.abs(positions.min[axis] - receipt.sourceBounds[0][axis]) < tolerance);
            assert.ok(Math.abs(positions.max[axis] - receipt.sourceBounds[1][axis]) < tolerance);
        }
    }
    console.log("ok:", receipt.asset);
}
console.log(`Validated ${receipts.length} assets: ${sourceBytes} to ${outputBytes} bytes (${((1-outputBytes/sourceBytes)*100).toFixed(1)}% smaller).`);
