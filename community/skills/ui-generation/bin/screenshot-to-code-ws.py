#!/usr/bin/env python3
"""WebSocket client for abi/screenshot-to-code backend.

Connects to ws://localhost:7001/generate-code, sends image + config, captures
streaming setCode messages, writes final TSX to disk.

Usage:
  screenshot-to-code-ws.py --screenshot /path/to.png \\
                          --stack react_tailwind \\
                          --model gemini-3-flash-preview-high \\
                          --out /tmp/ui-generation/<task-id>/page.tsx
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time
from pathlib import Path

try:
    import websockets
except ImportError:
    print("ERROR: install `websockets` in the same venv: pip install websockets", file=sys.stderr)
    sys.exit(2)


async def run(screenshot: Path, stack: str, model: str, out_path: Path, endpoint: str):
    img_b64 = base64.b64encode(screenshot.read_bytes()).decode("ascii")
    image_data_url = f"data:image/png;base64,{img_b64}"

    params = {
        "generationType": "create",
        "inputMode": "image",
        "image": image_data_url,
        "generatedCodeConfig": stack,
        "codeGenerationModel": model,
        "isImportedFromCode": False,
        "history": [],
    }

    code_buf = ""
    err_buf = []
    status_buf = []
    t0 = time.time()

    async with websockets.connect(endpoint, max_size=64 * 1024 * 1024) as ws:
        await ws.send(json.dumps(params))
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=180)
            except asyncio.TimeoutError:
                err_buf.append("timeout waiting for response")
                break
            except websockets.ConnectionClosed as e:
                if e.code != 1000:
                    err_buf.append(f"ws closed with code {e.code} reason={e.reason}")
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            t = msg.get("type")
            if t == "setCode":
                code_buf = msg.get("value", "")
            elif t == "chunk":
                code_buf += msg.get("value", "")
            elif t == "status":
                status_buf.append(msg.get("value", ""))
            elif t == "error":
                err_buf.append(msg.get("value", ""))

    elapsed = int((time.time() - t0) * 1000)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(code_buf or "")

    summary = {
        "elapsed_ms": elapsed,
        "stack": stack,
        "model": model,
        "out_path": str(out_path),
        "bytes": len(code_buf),
        "errors": err_buf,
        "status": status_buf[-3:] if status_buf else [],
    }
    print(json.dumps(summary, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--screenshot", required=True, type=Path)
    ap.add_argument("--stack", default="react_tailwind")
    ap.add_argument("--model", default="gemini-3-flash-preview (high thinking)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--endpoint", default=os.environ.get("SC2C_WS", "ws://127.0.0.1:7001/generate-code"))
    args = ap.parse_args()

    if not args.screenshot.exists():
        print(f"ERROR: screenshot {args.screenshot} not found", file=sys.stderr)
        sys.exit(2)

    asyncio.run(run(args.screenshot, args.stack, args.model, args.out, args.endpoint))


if __name__ == "__main__":
    main()
