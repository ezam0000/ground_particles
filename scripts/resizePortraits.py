"""Create 256px PNG portrait candidates; preserves RGBA and never overwrites sources."""
from PIL import Image
from pathlib import Path
import hashlib
import json
import sys

source, destination = map(Path, sys.argv[1:])
destination.mkdir(parents=True, exist_ok=True)
receipts = []
for original in sorted(source.glob("*.png")):
    output = destination / original.name
    if original.resolve() == output.resolve() or output.exists():
        raise RuntimeError("Choose a fresh candidate destination.")
    with Image.open(original) as image:
        image = image.convert("RGBA")
        image.thumbnail((256, 256), Image.Resampling.LANCZOS)
        image.save(output, optimize=True, compress_level=9)
        receipts.append({"asset": original.name, "dimensions": list(image.size),
                         "sourceBytes": original.stat().st_size, "outputBytes": output.stat().st_size,
                         "sourceSha256": hashlib.sha256(original.read_bytes()).hexdigest(),
                         "outputSha256": hashlib.sha256(output.read_bytes()).hexdigest()})
(destination / "receipts.json").write_text(json.dumps(receipts, indent=2))
print(json.dumps(receipts, indent=2))
