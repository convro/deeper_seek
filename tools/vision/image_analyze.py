"""
image_analyze.py — Vision analysis via Claude Haiku (Anthropic API).

Replaces the previous local OpenCV/pytesseract tool which caused frequent
timeouts and required heavy dependencies.

Supports 1–5 images per call. All images are sent to Claude Haiku in a
single API request for efficient, accurate multi-image analysis.

Requires env var: ANTHROPIC_API_KEY
"""

import os
import sys
import time
import base64
from pathlib import Path

MODEL = "claude-haiku-4-5-20251001"
MAX_IMAGES = 5
MAX_OUTPUT_TOKENS = 1500

DEFAULT_QUESTION = (
    "Describe this image in full detail: all visible objects, people, text, "
    "colors, spatial layout, style, and anything else notable or interesting."
)

MIME_MAP = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
}


def _read_image_b64(path: str) -> tuple:
    """Return (base64_data, mime_type) for an image file."""
    p = Path(path).resolve()
    if not p.exists():
        raise FileNotFoundError(f"Image not found: {path}")
    mime = MIME_MAP.get(p.suffix.lower(), "image/jpeg")
    with open(p, "rb") as f:
        data = base64.standard_b64encode(f.read()).decode("utf-8")
    return data, mime


def execute(
    path: str = "",
    paths: list = None,
    question: str = "",
    context: str = "",
    **_,
) -> dict:
    start = time.time()

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return _err(
            "ANTHROPIC_API_KEY not set — add ANTHROPIC_API_KEY=sk-ant-... to .env",
            start,
        )

    # Normalise paths: path= (single) and paths= (list) are both accepted
    all_paths: list = []
    if path:
        all_paths.append(str(path))
    if paths:
        for p in paths:
            sp = str(p)
            if sp not in all_paths:
                all_paths.append(sp)
    all_paths = all_paths[:MAX_IMAGES]

    if not all_paths:
        return _err(
            "Provide path= (single image) or paths= (list of up to 5 paths).",
            start,
        )

    # Load images -> base64 content blocks
    content: list = []
    loaded: list = []
    load_errors: list = []

    for img_path in all_paths:
        try:
            b64, mime = _read_image_b64(img_path)
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": mime, "data": b64},
            })
            loaded.append(img_path)
        except Exception as exc:
            load_errors.append(f"{img_path}: {exc}")

    if not content:
        return _err(
            "Could not load any images. " + "; ".join(load_errors),
            start,
        )

    # Build text prompt
    n = len(loaded)
    q = question.strip() or DEFAULT_QUESTION
    text_parts: list = []
    if context.strip():
        text_parts.append(f"Context: {context.strip()}")
    if n > 1:
        text_parts.append(
            f"There are {n} images attached. Analyze each one individually "
            f"and note any relationships, comparisons, or patterns across them."
        )
    text_parts.append(q)
    content.append({"type": "text", "text": "\n\n".join(text_parts)})

    # Call Claude Haiku
    try:
        try:
            import anthropic
        except ImportError:
            import subprocess
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet", "anthropic"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            import anthropic

        client = anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model=MODEL,
            max_tokens=MAX_OUTPUT_TOKENS,
            messages=[{"role": "user", "content": content}],
        )
        analysis = msg.content[0].text if msg.content else ""
        usage = {
            "input_tokens":  msg.usage.input_tokens,
            "output_tokens": msg.usage.output_tokens,
        }
        return {
            "status": "ok",
            "result": {
                "analysis":        analysis,
                "images_analyzed": loaded,
                "image_count":     n,
                "model":           MODEL,
                "usage":           usage,
            },
            "error": None,
            "metadata": {
                "tool":        "image_analyze",
                "duration_ms": int((time.time() - start) * 1000),
                "load_errors": load_errors,
            },
        }
    except Exception as exc:
        return _err(f"Claude API error: {exc}", start)


def _err(msg: str, start: float) -> dict:
    return {
        "status": "error",
        "result": None,
        "error":  msg,
        "metadata": {
            "tool":        "image_analyze",
            "duration_ms": int((time.time() - start) * 1000),
        },
    }
