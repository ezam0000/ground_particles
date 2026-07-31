// Portfolio pedestal — beauty pass. Rigid box geometry, world matrix only.

attribute position: vec3f;
attribute normal: vec3f;
attribute uv: vec2f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;

varying vWorld: vec3f;
varying vNormal: vec3f;
varying vUV: vec2f;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let world = uniforms.world * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.vWorld = world.xyz;
    // Pedestals are uniformly scaled, so the plain matrix is the normal matrix.
    vertexOutputs.vNormal = (uniforms.world * vec4f(vertexInputs.normal, 0.0)).xyz;
    vertexOutputs.vUV = vertexInputs.uv;
    let clip = uniforms.viewProjection * world;
    vertexOutputs.vViewDist = clip.w;
    vertexOutputs.position = clip;
}
