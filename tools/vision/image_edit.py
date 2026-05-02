"""
image_edit.py — Image manipulation via Pillow.

Operations (pass as `op`):
  • resize        — resize to (w,h) or scale factor, keeping aspect unless force
  • crop          — crop to (left, top, right, bottom) or center/smart crop
  • rotate        — rotate by degrees (expand canvas)
  • flip          — horizontal / vertical
  • filter        — blur/sharpen/edge/grayscale/sepia/invert/contour
  • adjust        — brightness / contrast / saturation / gamma
  • watermark     — overlay text or an image with opacity + position
  • compose       — paste one image onto another at (x, y) with opacity
  • collage       — grid collage from a list of images
  • convert       — change format / quality / strip metadata
  • thumbnail     — create a max-box thumbnail
  • annotate      — draw boxes / circles / text with color + width
  • pad           — add border of given color
  • info          — report width/height/mode/format/exif (read-only)

Args are op-specific. Common:
  src     — input path (required for most ops)
  dest    — output path (default: <src>.edit.<ext>)
  quality — JPEG quality 1-95 (default 88)
  keep_exif — preserve EXIF (default False)
"""

from __future__ import annotations

import os
import time
from pathlib import Path


def execute(op: str, **kwargs) -> dict:
    start = time.time()
    op = (op or "").lower().strip()
    if op not in _DISPATCH:
        return _err(f"unknown op '{op}'. "
                    f"Allowed: {sorted(_DISPATCH.keys())}", start, op)
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        return _err("Pillow required", start, op)
    try:
        return _DISPATCH[op](start=start, **kwargs)
    except FileNotFoundError as e:
        return _err(f"not found: {e}", start, op)
    except ValueError as e:
        return _err(str(e), start, op)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}", start, op)


# ── Ops ─────────────────────────────────────────────────────────────────────

def _op_info(start, src: str, **_):
    from PIL import Image, ExifTags
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        info = {"path": str(p), "width": im.width, "height": im.height,
                "mode": im.mode, "format": im.format,
                "has_alpha": im.mode in ("RGBA", "LA", "PA")}
        try:
            exif = im.getexif()
            info["exif"] = {ExifTags.TAGS.get(k, str(k)): str(v)[:200]
                            for k, v in exif.items()} if exif else {}
        except Exception:
            info["exif"] = {}
    return _ok(info, start, "info")


def _op_resize(start, src: str, dest: str = "", width: int | None = None,
               height: int | None = None, scale: float | None = None,
               force: bool = False, **kw):
    from PIL import Image
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        if scale:
            w = int(im.width * scale); h = int(im.height * scale)
        elif width and height:
            if force: w, h = width, height
            else:
                w, h = _fit((im.width, im.height), (width, height))
        elif width:
            w = width; h = int(im.height * (width / im.width))
        elif height:
            h = height; w = int(im.width * (height / im.height))
        else:
            raise ValueError("width/height/scale required")
        out = im.resize((max(1, w), max(1, h)), Image.LANCZOS)
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp), "size": (out.width, out.height)},
               start, "resize")


def _op_crop(start, src: str, dest: str = "", box: list | None = None,
             mode: str = "box", width: int | None = None,
             height: int | None = None, **kw):
    from PIL import Image
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        if mode == "box" and box and len(box) == 4:
            out = im.crop(tuple(box))
        elif mode == "center" and width and height:
            left = (im.width - width) // 2
            top = (im.height - height) // 2
            out = im.crop((max(0, left), max(0, top),
                           min(im.width, left + width),
                           min(im.height, top + height)))
        else:
            raise ValueError("crop needs box=[l,t,r,b] OR mode='center' with width/height")
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp), "size": (out.width, out.height)},
               start, "crop")


def _op_rotate(start, src: str, degrees: float, dest: str = "",
               expand: bool = True, fill: str = "white", **kw):
    from PIL import Image
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        out = im.rotate(-float(degrees), expand=expand, fillcolor=fill)
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp),
                "size": (out.width, out.height), "degrees": degrees},
               start, "rotate")


def _op_flip(start, src: str, direction: str = "horizontal",
             dest: str = "", **kw):
    from PIL import Image, ImageOps
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        if direction in ("h", "horizontal", "x"):
            out = ImageOps.mirror(im)
        elif direction in ("v", "vertical", "y"):
            out = ImageOps.flip(im)
        else:
            raise ValueError("direction must be horizontal|vertical")
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp), "direction": direction},
               start, "flip")


def _op_filter(start, src: str, name: str, dest: str = "",
               radius: float = 2.0, **kw):
    from PIL import Image, ImageFilter, ImageOps
    p = _path(src, must_exist=True)
    name = name.lower()
    with Image.open(p) as im:
        if name == "blur": out = im.filter(ImageFilter.GaussianBlur(radius))
        elif name == "sharpen": out = im.filter(ImageFilter.SHARPEN)
        elif name == "edge": out = im.filter(ImageFilter.FIND_EDGES)
        elif name == "contour": out = im.filter(ImageFilter.CONTOUR)
        elif name == "grayscale": out = ImageOps.grayscale(im)
        elif name == "invert": out = ImageOps.invert(im.convert("RGB"))
        elif name == "sepia": out = _sepia(im)
        elif name == "emboss": out = im.filter(ImageFilter.EMBOSS)
        else: raise ValueError(f"unknown filter '{name}'")
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp), "filter": name},
               start, "filter")


def _op_adjust(start, src: str, dest: str = "",
               brightness: float = 1.0, contrast: float = 1.0,
               saturation: float = 1.0, gamma: float | None = None, **kw):
    from PIL import Image, ImageEnhance
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        out = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im.copy()
        if brightness != 1.0:
            out = ImageEnhance.Brightness(out).enhance(brightness)
        if contrast != 1.0:
            out = ImageEnhance.Contrast(out).enhance(contrast)
        if saturation != 1.0:
            out = ImageEnhance.Color(out).enhance(saturation)
        if gamma and gamma > 0:
            out = _gamma(out, gamma)
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp),
                "brightness": brightness, "contrast": contrast,
                "saturation": saturation, "gamma": gamma},
               start, "adjust")


def _op_watermark(start, src: str, text: str = "", image: str = "",
                  dest: str = "", position: str = "br",
                  opacity: float = 0.5, margin: int = 16,
                  font_size: int = 24, color: str = "white", **kw):
    from PIL import Image, ImageDraw, ImageFont
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        base = im.convert("RGBA")
        overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
        if text:
            draw = ImageDraw.Draw(overlay)
            font = _font(font_size)
            tw, th = _text_size(draw, text, font)
            x, y = _position(position, base.size, (tw, th), margin)
            rgba = _rgba(color, opacity)
            draw.text((x, y), text, font=font, fill=rgba)
        elif image:
            wm = Image.open(_path(image, must_exist=True)).convert("RGBA")
            if opacity < 1.0:
                a = wm.split()[-1].point(lambda px: int(px * opacity))
                wm.putalpha(a)
            x, y = _position(position, base.size, wm.size, margin)
            overlay.paste(wm, (x, y), wm)
        else:
            raise ValueError("watermark needs text= or image=")
        out = Image.alpha_composite(base, overlay).convert("RGB")
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp)}, start, "watermark")


def _op_compose(start, base: str, overlay: str, dest: str = "",
                x: int = 0, y: int = 0, opacity: float = 1.0, **kw):
    from PIL import Image
    bp = _path(base, must_exist=True)
    op_ = _path(overlay, must_exist=True)
    with Image.open(bp) as b, Image.open(op_) as o:
        base_im = b.convert("RGBA")
        ov = o.convert("RGBA")
        if opacity < 1.0:
            a = ov.split()[-1].point(lambda px: int(px * opacity))
            ov.putalpha(a)
        canvas = Image.new("RGBA", base_im.size, (0, 0, 0, 0))
        canvas.paste(ov, (x, y), ov)
        out = Image.alpha_composite(base_im, canvas).convert("RGB")
        outp = _save(out, bp, dest, **kw)
    return _ok({"dest": str(outp)}, start, "compose")


def _op_collage(start, sources: list, dest: str, cols: int = 0,
                cell: int = 256, padding: int = 8,
                bg: str = "white", **kw):
    from PIL import Image
    if not sources: raise ValueError("sources= required")
    n = len(sources)
    cols = cols or max(1, int(n ** 0.5))
    rows = (n + cols - 1) // cols
    W = cols * cell + (cols + 1) * padding
    H = rows * cell + (rows + 1) * padding
    canvas = Image.new("RGB", (W, H), bg)
    for i, s in enumerate(sources):
        sp = _path(s, must_exist=True)
        with Image.open(sp) as im:
            im = im.convert("RGB")
            im.thumbnail((cell, cell), Image.LANCZOS)
            r, c = divmod(i, cols)
            x = padding + c * (cell + padding) + (cell - im.width) // 2
            y = padding + r * (cell + padding) + (cell - im.height) // 2
            canvas.paste(im, (x, y))
    outp = Path(dest).expanduser().resolve()
    outp.parent.mkdir(parents=True, exist_ok=True)
    _save(canvas, outp, str(outp), **kw)
    return _ok({"dest": str(outp), "grid": [rows, cols],
                "size": [W, H], "count": n}, start, "collage")


def _op_convert(start, src: str, dest: str, quality: int = 88,
                keep_exif: bool = False, **kw):
    from PIL import Image
    p = _path(src, must_exist=True)
    outp = Path(dest).expanduser().resolve()
    outp.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(p) as im:
        if outp.suffix.lower() in (".jpg", ".jpeg") and im.mode != "RGB":
            im = im.convert("RGB")
        save_kw = {"quality": quality}
        if keep_exif and "exif" in im.info:
            save_kw["exif"] = im.info["exif"]
        im.save(outp, **save_kw)
    return _ok({"src": str(p), "dest": str(outp), "quality": quality},
               start, "convert")


def _op_thumbnail(start, src: str, dest: str = "", max_size: int = 256, **kw):
    from PIL import Image
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        out = im.copy()
        out.thumbnail((max_size, max_size), Image.LANCZOS)
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp),
                "size": (out.width, out.height)}, start, "thumbnail")


def _op_annotate(start, src: str, dest: str = "",
                 shapes: list | None = None, **kw):
    from PIL import Image, ImageDraw
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        out = im.convert("RGB").copy()
        draw = ImageDraw.Draw(out)
        for sh in (shapes or []):
            kind = sh.get("type", "rect")
            color = sh.get("color", "red")
            width = sh.get("width", 3)
            if kind == "rect":
                draw.rectangle(tuple(sh["box"]), outline=color, width=width)
            elif kind == "circle":
                draw.ellipse(tuple(sh["box"]), outline=color, width=width)
            elif kind == "line":
                draw.line(tuple(sh["points"]), fill=color, width=width)
            elif kind == "text":
                font = _font(sh.get("font_size", 20))
                draw.text(tuple(sh["xy"]), sh.get("text", ""),
                          fill=color, font=font)
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp),
                "shapes": len(shapes or [])}, start, "annotate")


def _op_pad(start, src: str, dest: str = "", pad: int = 20,
            color: str = "white", **kw):
    from PIL import Image, ImageOps
    p = _path(src, must_exist=True)
    with Image.open(p) as im:
        out = ImageOps.expand(im.convert("RGB"), border=pad, fill=color)
        outp = _save(out, p, dest, **kw)
    return _ok({"src": str(p), "dest": str(outp),
                "size": (out.width, out.height)}, start, "pad")


_DISPATCH = {
    "info": _op_info, "resize": _op_resize, "crop": _op_crop,
    "rotate": _op_rotate, "flip": _op_flip, "filter": _op_filter,
    "adjust": _op_adjust, "watermark": _op_watermark,
    "compose": _op_compose, "collage": _op_collage,
    "convert": _op_convert, "thumbnail": _op_thumbnail,
    "annotate": _op_annotate, "pad": _op_pad,
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _path(p: str, must_exist: bool = False) -> Path:
    pp = Path(p).expanduser().resolve()
    if must_exist and not pp.exists():
        raise FileNotFoundError(str(pp))
    return pp


def _save(im, src: Path, dest: str, quality: int = 88,
          keep_exif: bool = False, **_kw) -> Path:
    if dest:
        outp = Path(dest).expanduser().resolve()
    else:
        outp = src.with_name(f"{src.stem}.edit{src.suffix}")
    outp.parent.mkdir(parents=True, exist_ok=True)
    save_kw = {}
    ext = outp.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        if im.mode != "RGB":
            im = im.convert("RGB")
        save_kw["quality"] = quality; save_kw["optimize"] = True
    elif ext == ".png":
        save_kw["optimize"] = True
    if keep_exif and hasattr(im, "info") and "exif" in im.info:
        save_kw["exif"] = im.info["exif"]
    im.save(outp, **save_kw)
    return outp


def _fit(src: tuple, box: tuple) -> tuple[int, int]:
    sw, sh = src; bw, bh = box
    r = min(bw / sw, bh / sh)
    return max(1, int(sw * r)), max(1, int(sh * r))


def _font(size: int):
    from PIL import ImageFont
    for name in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf",
                 "Arial.ttf", "LiberationSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _text_size(draw, text, font) -> tuple[int, int]:
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        return bbox[2] - bbox[0], bbox[3] - bbox[1]
    except AttributeError:
        return draw.textsize(text, font=font)


def _position(pos: str, base: tuple, obj: tuple, margin: int) -> tuple[int, int]:
    W, H = base; w, h = obj
    pos = (pos or "br").lower()
    if pos in ("tl", "top-left"): return (margin, margin)
    if pos in ("tr", "top-right"): return (W - w - margin, margin)
    if pos in ("bl", "bottom-left"): return (margin, H - h - margin)
    if pos in ("c", "center"): return ((W - w) // 2, (H - h) // 2)
    # default bottom-right
    return (W - w - margin, H - h - margin)


def _rgba(color: str, opacity: float):
    from PIL import ImageColor
    r, g, b = ImageColor.getrgb(color)[:3]
    return (r, g, b, max(0, min(255, int(255 * opacity))))


def _sepia(im):
    from PIL import Image
    g = im.convert("L")
    sepia = Image.merge("RGB", (
        g.point(lambda x: min(255, int(x * 1.07))),
        g.point(lambda x: min(255, int(x * 0.74))),
        g.point(lambda x: min(255, int(x * 0.43))),
    ))
    return sepia


def _gamma(im, gamma: float):
    inv = 1.0 / gamma
    lut = [min(255, int(((i / 255.0) ** inv) * 255 + 0.5)) for i in range(256)]
    return im.point(lut * len(im.getbands()))


def _ok(result, start, op):
    return {"status": "ok", "result": result, "error": None,
            "metadata": {"tool": "image_edit", "op": op,
                         "duration_ms": int((time.time() - start) * 1000)}}


def _err(msg, start, op):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "image_edit", "op": op,
                         "duration_ms": int((time.time() - start) * 1000)}}
