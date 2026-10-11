"""Blender offline simplification. Never overwrites the input assets.

Blender --background --python scripts/optimizeWeapons.py -- INPUT_DIR OUTPUT_DIR
Rigid weapons only; keeps the imported transforms, UVs, and original albedo.
"""
import bpy
import bmesh
from mathutils import Vector
import hashlib
import json
from pathlib import Path
import sys

source, destination = map(Path, sys.argv[sys.argv.index("--") + 1:])
destination.mkdir(parents=True, exist_ok=True)
receipts = []
for name, budget in (("arrow", 2000), ("bow", 6000)):
    original = source / (name + ".glb")
    output = destination / (name + ".glb")
    if original.resolve() == output.resolve() or output.exists():
        raise RuntimeError("Use a new output directory; source assets are never overwritten.")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(original), merge_vertices=True)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    before = 0
    after = 0
    for obj in meshes:
        obj.data.calc_loop_triangles()
        count = len(obj.data.loop_triangles)
        before += count
        protected = None
        protected_count = 0
        if name == "bow":
            # The thin chord is essential to the silhouette. A global collapse
            # can erase it, so retain faces in its corridor at authored quality.
            vertices = obj.data.vertices
            low = min(v.co.z for v in vertices); high = max(v.co.z for v in vertices)
            ends = [[v.co.copy() for v in vertices if v.co.z < low + .015],
                    [v.co.copy() for v in vertices if v.co.z > high - .015]]
            a, b = [sum(points, Vector()) / len(points) for points in ends]
            chord = b - a
            def near_chord(co):
                t = max(0, min(1, (co - a).dot(chord) / chord.length_squared))
                return .08 < t < .92 and (co - (a + chord * t)).length < .035
            keep = {p.index for p in obj.data.polygons if all(near_chord(vertices[i].co) for i in p.vertices)}
            if keep:
                protected = obj.copy(); protected.data = obj.data.copy()
                bpy.context.collection.objects.link(protected)
                for mesh, retain in ((protected.data, True), (obj.data, False)):
                    bm = bmesh.new(); bm.from_mesh(mesh); bm.faces.ensure_lookup_table()
                    remove = [f for f in bm.faces if (f.index in keep) != retain]
                    bmesh.ops.delete(bm, geom=remove, context="FACES")
                    bm.to_mesh(mesh); bm.free(); mesh.update()
                protected.data.calc_loop_triangles()
                protected_count = len(protected.data.loop_triangles)
                # Planar dissolves remove redundant axial edges without
                # collapsing a slender string into disconnected triangles.
                bpy.context.view_layer.objects.active = protected
                protected.select_set(True)
                dissolve = protected.modifiers.new("Keep chord connected", "DECIMATE")
                dissolve.decimate_type = "DISSOLVE"
                dissolve.angle_limit = .2
                dissolve.delimit = set()
                bpy.ops.object.modifier_apply(modifier=dissolve.name)
                protected.select_set(False)
                protected.data.calc_loop_triangles()
                protected_count = len(protected.data.loop_triangles)
                obj.data.calc_loop_triangles(); count = len(obj.data.loop_triangles)
                print("Protected bowstring triangles:", protected_count)
                if protected_count >= budget * .65:
                    raise RuntimeError("Bowstring exceeds budget; do not erase protected geometry.")
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        modifier = obj.modifiers.new("Web triangle budget", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = min(1.0, (budget - protected_count) / count)
        modifier.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        # Recompute smooth normals on collapsed surfaces instead of retaining
        # dense-source split normals on a radically different triangulation.
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        obj.data.normals_split_custom_set_from_vertices([v.normal.copy() for v in obj.data.vertices])
        if protected:
            protected.select_set(True)
            bpy.ops.object.join()
        obj.data.calc_loop_triangles()
        after += len(obj.data.loop_triangles)
        obj.select_set(False)
    bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_image_format="AUTO", export_animations=False)
    receipts.append({
        "asset": name, "sourceSha256": hashlib.sha256(original.read_bytes()).hexdigest(),
        "outputSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "sourceBytes": original.stat().st_size, "outputBytes": output.stat().st_size,
        "sourceTriangles": before, "outputTriangles": after,
        "method": "Blender collapse decimation; preserve node transforms and albedo",
    })
(destination / "receipts.json").write_text(json.dumps(receipts, indent=2))
print(json.dumps(receipts, indent=2))
