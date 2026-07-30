# Environment surface detail

Place `detail.png` (1024×1024 RGBA) in each folder:
- RG = tangent normal XY (`n * 0.5 + 0.5`)
- B  = cavity
- A  = height

If missing, the runtime falls back to the procedural `detailBake`.
