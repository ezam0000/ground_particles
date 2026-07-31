// Depth-prepass vertex shader for rigid props (portfolio pedestals).
// Shares the common `prepass` fragment: linear view depth, matte mask.

attribute position: vec3f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let clip = uniforms.viewProjection * uniforms.world * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = 0.0;
    vertexOutputs.position = clip;
}
