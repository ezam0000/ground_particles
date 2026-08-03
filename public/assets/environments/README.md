# Environment surface detail

Place `sand/detail.png` (RGBA; 512–1024) for the sand walk:
- RG = tangent normal XY (`n * 0.5 + 0.5`)
- B  = cavity
- A  = height

If missing, the runtime falls back to the procedural `detailBake`.
Snow detail is not shipped (sand-only product).
