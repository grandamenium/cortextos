#!/usr/bin/env python3
"""ollama-vision-to-code.py — Mode C of ui-generation skill.

Sends a screenshot to a local Ollama vision model (qwen2.5vl:7b by default),
asks for production React + Tailwind code, returns the TSX.

No API key, no quota, no Docker. Just Ollama on the Mac mini.

Usage:
  ollama-vision-to-code.py --screenshot /path/to.png \\
                           [--stack react_tailwind|html_tailwind|html_css] \\
                           [--model qwen2.5vl:7b] \\
                           [--ollama-host http://mac-mini.local:11434] \\
                           [--out /tmp/.../page.tsx]

The Ollama host defaults to env OLLAMA_HOST or http://127.0.0.1:11434.
For Mac mini access from MacBook, set OLLAMA_HOST=http://mac-mini.tailscale-ip:11434
or use SSH port-forwarding.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

try:
    import urllib.request
except ImportError:
    print("ERROR: urllib not available", file=sys.stderr)
    sys.exit(2)


STACK_PROMPTS = {
    "react_tailwind": """You are an expert frontend engineer. Convert the screenshot into a SINGLE, complete, production-ready React + Tailwind CSS component.

Constraints:
- Output ONLY the code (no prose, no markdown fences) inside a ```tsx``` block.
- Use TypeScript and `export default function Page()` as the entry point.
- All styling via Tailwind utility classes — no custom CSS files, no inline styles unless absolutely necessary.
- Use lucide-react for icons if any are visible.
- Preserve the exact layout, color palette, typography, and visual hierarchy of the screenshot.
- For dynamic data (numbers, timestamps), use realistic placeholders that match what is visible.
- The component must be self-contained: a developer should be able to drop the file into a Next.js 14 app and see the rendered result identical to the screenshot.""",

    "html_tailwind": """You are an expert frontend engineer. Convert the screenshot into a SINGLE, complete HTML page using Tailwind CSS via CDN.

Constraints:
- Output ONLY the code (no prose, no markdown fences) inside a ```html``` block.
- Single <!DOCTYPE html> file, Tailwind via <script src="https://cdn.tailwindcss.com"></script>.
- All styling via Tailwind utility classes — no <style> tag unless absolutely necessary.
- Use heroicons or feather icons via SVG inline if any icons are visible.
- Preserve the exact layout, color palette, typography, and visual hierarchy of the screenshot.""",

    "html_css": """You are an expert frontend engineer. Convert the screenshot into a SINGLE, complete HTML page using pure CSS (no framework).

Constraints:
- Output ONLY the code (no prose, no markdown fences) inside a ```html``` block.
- Single <!DOCTYPE html> file with <style> in the <head>.
- Preserve the exact layout, color palette, typography, and visual hierarchy of the screenshot.""",
}


def call_ollama(host: str, model: str, prompt: str, image_b64: str, timeout_s: int = 600) -> dict:
    """Call Ollama /api/generate with image. Returns parsed JSON response."""
    url = host.rstrip("/") + "/api/generate"
    payload = {
        "model": model,
        "prompt": prompt,
        "images": [image_b64],
        "stream": False,
        "options": {
            "num_predict": 4096,
            "temperature": 0.2,
        },
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8"))


def extract_code(text: str) -> str:
    """Strip markdown code fences. Returns the longest fenced block, or raw text."""
    import re
    blocks = re.findall(r"```(?:tsx|jsx|html|javascript|typescript|js|ts)?\n(.*?)```", text, re.DOTALL)
    if blocks:
        return max(blocks, key=len).strip()
    return text.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--screenshot", required=True, type=Path)
    ap.add_argument("--stack", default="react_tailwind", choices=list(STACK_PROMPTS.keys()))
    ap.add_argument("--model", default=os.environ.get("OLLAMA_VISION_MODEL", "qwen2.5vl:7b"))
    ap.add_argument("--ollama-host", default=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--timeout", type=int, default=600)
    args = ap.parse_args()

    if not args.screenshot.exists():
        envelope = {"verdict": "error", "error": f"screenshot {args.screenshot} not found"}
        print(json.dumps(envelope, indent=2))
        sys.exit(2)

    img_b64 = base64.b64encode(args.screenshot.read_bytes()).decode("ascii")
    prompt = STACK_PROMPTS[args.stack]

    t0 = time.time()
    try:
        result = call_ollama(args.ollama_host, args.model, prompt, img_b64, args.timeout)
    except Exception as e:
        envelope = {
            "verdict": "error",
            "error": f"ollama call failed: {e}",
            "elapsed_s": int(time.time() - t0),
            "host": args.ollama_host,
            "model": args.model,
        }
        print(json.dumps(envelope, indent=2))
        sys.exit(3)

    elapsed = time.time() - t0
    raw = result.get("response", "")
    code = extract_code(raw)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(code)

    envelope = {
        "verdict": "ok" if code else "empty",
        "provider": "ollama-vision",
        "model": args.model,
        "host": args.ollama_host,
        "stack": args.stack,
        "elapsed_s": round(elapsed, 1),
        "out_path": str(args.out),
        "out_bytes": len(code),
        "prompt_eval_count": result.get("prompt_eval_count"),
        "eval_count": result.get("eval_count"),
        "eval_duration_s": round(result.get("eval_duration", 0) / 1e9, 1) if result.get("eval_duration") else None,
    }
    print(json.dumps(envelope, indent=2))


if __name__ == "__main__":
    main()
