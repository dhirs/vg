"""Render a .drawio diagram as a local HTML page and open it in the browser.

Usage: python3 preview.py [diagram.drawio]   (defaults to architecture.drawio)

The diagram XML is embedded in the generated page and drawn client-side by the
diagrams.net viewer script, so the diagram itself is never uploaded anywhere.
"""
import html
import subprocess
import json
import sys
import webbrowser
from pathlib import Path

here = Path(__file__).resolve().parent
src = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else here / "architecture.drawio"
out = src.with_suffix(".preview.html")

# zoom > 1 and no fit-to-width, so the diagram renders at readable size (scroll to pan)
config = {"xml": src.read_text(), "nav": True, "resize": False, "zoom": 1.3, "toolbar": "zoom layers lightbox"}
out.write_text(f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{html.escape(src.name)}</title></head>
<body style="margin:16px;background:#fff">
<div class="mxgraph" data-mxgraph="{html.escape(json.dumps(config), quote=True)}"></div>
<script src="https://viewer.diagrams.net/js/viewer-static.min.js"></script>
</body></html>
""")
opened_in_chrome = sys.platform == "darwin" and subprocess.run(["open", "-a", "Google Chrome", str(out)]).returncode == 0
if not opened_in_chrome:
    webbrowser.open(out.as_uri())
print(f"Opened {out}")
