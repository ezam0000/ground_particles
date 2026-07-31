// Shadow-pass vertex shader for rigid props (portfolio pedestals).
// Paired with `terrainDepth.fragment.wgsl`, which writes the NDC z.

attribute position: vec3f;

uniform world: mat4x4f;
uniform lightViewProjection: mat4x4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.position =
        uniforms.lightViewProjection * uniforms.world * vec4f(vertexInputs.position, 1.0);
}
