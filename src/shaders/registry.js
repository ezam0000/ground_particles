/**
 * Registers every WGSL source into Babylon's shader store.
 *
 * Shared libraries go in as `#include<...>` fragments so the height bake and the
 * runtime snow material compile literally the same text — the terrain would pull
 * apart at the seams if they ever drifted. Whole shaders go in under the names
 * Babylon expects: `<name>VertexShader` and `<name>PixelShader`.
 *
 * Import this once, before any material is constructed.
 */

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

import noiseLib from "./lib/noise.wgsl?raw";
import terrainLib from "./lib/terrain.wgsl?raw";
import shadingLib from "./lib/shading.wgsl?raw";
import shadowLookupLib from "./lib/shadowLookup.wgsl?raw";
import atmosphereLib from "./lib/atmosphere.wgsl?raw";
import clipmapLib from "./lib/clipmap.wgsl?raw";
import deformLib from "./lib/deform.wgsl?raw";
import charSkinLib from "./lib/charSkin.wgsl?raw";
import spellLightsLib from "./lib/spellLights.wgsl?raw";
import postCommonLib from "./lib/postCommon.wgsl?raw";
import ridgeLib from "./lib/ridge.wgsl?raw";

import heightBakeFrag from "./heightBake.fragment.wgsl?raw";
import auxBakeFrag from "./auxBake.fragment.wgsl?raw";
import detailBakeFrag from "./detailBake.fragment.wgsl?raw";
import skyBakeFrag from "./skyBake.fragment.wgsl?raw";
import deformSimFrag from "./deformSim.fragment.wgsl?raw";

import snowVert from "./snow.vertex.wgsl?raw";
import snowFrag from "./snow.fragment.wgsl?raw";
import depthVert from "./terrainDepth.vertex.wgsl?raw";
import depthFrag from "./terrainDepth.fragment.wgsl?raw";
import skyVert from "./sky.vertex.wgsl?raw";
import skyFrag from "./sky.fragment.wgsl?raw";

import charVert from "./char.vertex.wgsl?raw";
import charFrag from "./char.fragment.wgsl?raw";
import clothVert from "./cloth.vertex.wgsl?raw";
import charDepthVert from "./charDepth.vertex.wgsl?raw";
import clothDepthVert from "./clothDepth.vertex.wgsl?raw";
import furVert from "./fur.vertex.wgsl?raw";
import furFrag from "./fur.fragment.wgsl?raw";
import sprayVert from "./spray.vertex.wgsl?raw";
import sprayFrag from "./spray.fragment.wgsl?raw";

import prepassFrag from "./prepass.fragment.wgsl?raw";
import terrainPrepassVert from "./terrainPrepass.vertex.wgsl?raw";
import charPrepassVert from "./charPrepass.vertex.wgsl?raw";
import clothPrepassVert from "./clothPrepass.vertex.wgsl?raw";
import staticPrepassVert from "./staticPrepass.vertex.wgsl?raw";
import propVert from "./prop.vertex.wgsl?raw";
import propFrag from "./prop.fragment.wgsl?raw";
import staticDepthVert from "./staticDepth.vertex.wgsl?raw";


const INCLUDES = {
    snowNoise: noiseLib,
    snowTerrain: terrainLib,
    snowShading: shadingLib,
    snowShadowLookup: shadowLookupLib,
    snowAtmosphere: atmosphereLib,
    snowClipmap: clipmapLib,
    snowDeform: deformLib,
    snowCharSkin: charSkinLib,
    snowSpellLights: spellLightsLib,
    snowPostCommon: postCommonLib,
    snowRidge: ridgeLib,
};

const SHADERS = {
    heightBakePixelShader: heightBakeFrag,
    auxBakePixelShader: auxBakeFrag,
    detailBakePixelShader: detailBakeFrag,
    skyBakePixelShader: skyBakeFrag,
    deformSimPixelShader: deformSimFrag,

    snowVertexShader: snowVert,
    snowPixelShader: snowFrag,

    terrainDepthVertexShader: depthVert,
    terrainDepthPixelShader: depthFrag,

    skyVertexShader: skyVert,
    skyPixelShader: skyFrag,

    charVertexShader: charVert,
    charPixelShader: charFrag,
    clothVertexShader: clothVert,
    charDepthVertexShader: charDepthVert,
    clothDepthVertexShader: clothDepthVert,
    furVertexShader: furVert,
    furPixelShader: furFrag,
    sprayVertexShader: sprayVert,
    sprayPixelShader: sprayFrag,

    // The camera-space depth prepass. One fragment stage shared by everything.
    prepassPixelShader: prepassFrag,
    terrainPrepassVertexShader: terrainPrepassVert,
    charPrepassVertexShader: charPrepassVert,
    clothPrepassVertexShader: clothPrepassVert,
    staticPrepassVertexShader: staticPrepassVert,

    // Rigid portfolio props share `terrainDepthPixelShader` as their depth frag.
    propVertexShader: propVert,
    propPixelShader: propFrag,
    staticDepthVertexShader: staticDepthVert,
};

let registered = false;

export function registerShaders() {
    if (registered) return;
    registered = true;

    for (const name in INCLUDES) {
        ShaderStore.IncludesShadersStoreWGSL[name] = INCLUDES[name];
    }
    for (const name in SHADERS) {
        ShaderStore.ShadersStoreWGSL[name] = SHADERS[name];
    }
}
