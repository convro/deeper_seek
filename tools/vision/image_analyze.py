"""
image_analyze.py — Analyze an image using the best available vision AI.

Priority order:
  1. Anthropic Claude (ANTHROPIC_API_KEY)   — best quality
  2. OpenAI GPT-4o-mini  (OPENAI_API_KEY)  — good quality
  3. PIL metadata only                      — fallback (no semantic understanding)

Returns a detailed description + technical metadata.
"""

import sys
import os
import json
import base64
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

def _b64_from_path(image_path: str) -> tuple[str, str]:
    """Return (base64_string, media_type)."""
    ext = Path(image_path).suffix.lower()
    media_type_map = {
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png':  'image/png',
        '.gif':  'image/gif',
        '.webp': 'image/webp',
        '.bmp':  'image/bmp',
        '.tiff': 'image/tiff',
        '.tif':  'image/tiff',
    }
    media_type = media_type_map.get(ext, 'image/jpeg')
    with open(image_path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('utf-8')
    return b64, media_type


def _pil_metadata(image_path: str) -> dict:
    """Extract technical metadata using PIL (always available as fallback)."""
    try:
        from PIL import Image, ExifTags
        img = Image.open(image_path)
        info = {
            'format': img.format,
            'mode':   img.mode,
            'width':  img.size[0],
            'height': img.size[1],
            'size_bytes': os.path.getsize(image_path),
        }
        # Try dominant colors (only for RGB/RGBA)
        if img.mode in ('RGB', 'RGBA') and img.size[0] * img.size[1] < 4_000_000:
            small = img.convert('RGB').resize((50, 50))
            pixels = list(small.getdata())
            # Just sample a few pixels for representative colors
            sample = pixels[::25][:5]
            info['sample_colors_rgb'] = [f'#{r:02x}{g:02x}{b:02x}' for r, g, b in sample]
        # EXIF data (photos)
        try:
            exif_data = img._getexif()
            if exif_data:
                exif = {}
                for tag_id, val in exif_data.items():
                    tag = ExifTags.TAGS.get(tag_id, str(tag_id))
                    if isinstance(val, (str, int, float)):
                        exif[tag] = str(val)[:100]
                if exif:
                    info['exif'] = exif
        except Exception:
            pass
        return info
    except Exception as e:
        return {'error': str(e)}


def _analyze_with_anthropic(image_path: str, question: str) -> str | None:
    """Use Claude for vision analysis. Returns description string or None on failure."""
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        return None
    try:
        import anthropic
        b64, media_type = _b64_from_path(image_path)
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model='claude-haiku-4-5-20251001',
            max_tokens=1500,
            messages=[{
                'role': 'user',
                'content': [
                    {
                        'type': 'image',
                        'source': {
                            'type': 'base64',
                            'media_type': media_type,
                            'data': b64,
                        },
                    },
                    {'type': 'text', 'text': question},
                ],
            }],
        )
        return response.content[0].text
    except Exception as e:
        return None


def _analyze_with_openai(image_path: str, question: str) -> str | None:
    """Use GPT-4o-mini for vision analysis. Returns description string or None on failure."""
    api_key = os.environ.get('OPENAI_API_KEY')
    if not api_key:
        return None
    try:
        import openai
        b64, media_type = _b64_from_path(image_path)
        client = openai.OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model='gpt-4o-mini',
            max_tokens=1500,
            messages=[{
                'role': 'user',
                'content': [
                    {
                        'type': 'image_url',
                        'image_url': {'url': f'data:{media_type};base64,{b64}'},
                    },
                    {'type': 'text', 'text': question},
                ],
            }],
        )
        return response.choices[0].message.content
    except Exception as e:
        return None


def execute(path: str, question: str = 'Describe this image in detail. Include what you see, any text, colors, objects, people, context, and any notable features.'):
    """
    Analyze an image file and return a detailed description.

    Args:
        path     — absolute path to the image file
        question — specific question or instruction for the analysis
    """
    t0 = time.time()

    if not os.path.exists(path):
        return {
            'status': 'error',
            'result': None,
            'error': f'File not found: {path}',
            'metadata': {'tool': 'image_analyze', 'duration_ms': 0},
        }

    # Always collect PIL metadata (fast, never fails)
    meta = _pil_metadata(path)
    meta_str = (
        f"{meta.get('format','?')}, {meta.get('width','?')}×{meta.get('height','?')}px, "
        f"{round(meta.get('size_bytes', 0) / 1024)}KB"
    )

    # Try AI vision in priority order
    source = None
    description = None

    description = _analyze_with_anthropic(path, question)
    if description:
        source = 'claude-haiku'
    else:
        description = _analyze_with_openai(path, question)
        if description:
            source = 'gpt-4o-mini'

    if not description:
        # Pure metadata fallback — let the AI at least know dimensions/format
        source = 'pil-metadata'
        description = (
            f'No vision AI key available (set ANTHROPIC_API_KEY or OPENAI_API_KEY for full analysis).\n'
            f'Technical metadata: {meta_str}'
        )
        if meta.get('exif'):
            description += f'\nEXIF: {json.dumps(meta["exif"])[:300]}'
        if meta.get('sample_colors_rgb'):
            description += f'\nSample colors: {", ".join(meta["sample_colors_rgb"])}'

    duration_ms = round((time.time() - t0) * 1000)
    return {
        'status': 'ok',
        'result': {
            'description': description,
            'metadata': meta_str,
            'source': source,
            'path': path,
        },
        'error': None,
        'metadata': {'tool': 'image_analyze', 'duration_ms': duration_ms},
    }


if __name__ == '__main__':
    inp = json.loads(sys.stdin.read())
    out = execute(**inp.get('args', inp))
    print(json.dumps(out))
