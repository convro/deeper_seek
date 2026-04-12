"""
image_analyze.py — Advanced local image understanding tool.

Extracts maximum visual information using only local Python libraries:
  PIL/Pillow  — metadata, color, EXIF
  numpy       — statistics, histograms, spatial analysis
  OpenCV      — edges, contours, circles, faces, regions, sharpness
  pytesseract — OCR text extraction (primary)
  easyocr     — OCR text extraction (fallback, multi-language)

No external AI API calls. All processing is local.
The output is a rich structured description that gives the LLM
as close to "native vision" as possible.
"""

import sys
import os
import json
import time
import math
from pathlib import Path
from collections import Counter

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


# ── Auto-install missing packages ─────────────────────────────────────────────

def _ensure_packages():
    """
    Install required vision packages on first run if they are missing.
    Runs silently; individual import errors are handled gracefully later.
    """
    import subprocess

    # module_name → pip package name
    REQUIRED = [
        ("numpy",        "numpy"),
        ("PIL",          "Pillow"),
        ("cv2",          "opencv-python-headless"),
        ("pytesseract",  "pytesseract"),
    ]

    missing = []
    for mod, pkg in REQUIRED:
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)

    if missing:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet", "--upgrade"] + missing,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass  # Tool functions handle ImportError gracefully

    # easyocr is large — install separately, don't fail hard
    try:
        __import__("easyocr")
    except ImportError:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet", "easyocr"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass


# ── Color utilities ───────────────────────────────────────────────────────────

def _name_color(r, g, b):
    """Name a color by its HSL properties."""
    r_n, g_n, b_n = r / 255.0, g / 255.0, b / 255.0
    max_c = max(r_n, g_n, b_n)
    min_c = min(r_n, g_n, b_n)
    delta = max_c - min_c
    l = (max_c + min_c) / 2.0

    if delta < 0.04:
        if l < 0.10: return "black"
        if l < 0.22: return "very dark gray"
        if l < 0.40: return "dark gray"
        if l < 0.60: return "gray"
        if l < 0.78: return "light gray"
        if l < 0.92: return "very light gray"
        return "white"

    s = delta / (2 * l if l < 0.5 else 2 - 2 * l)

    if max_c == r_n:
        h = ((g_n - b_n) / delta) % 6
    elif max_c == g_n:
        h = (b_n - r_n) / delta + 2
    else:
        h = (r_n - g_n) / delta + 4
    h = h * 60.0
    if h < 0: h += 360

    if   l < 0.18: lp = "very dark "
    elif l < 0.35: lp = "dark "
    elif l < 0.65: lp = ""
    elif l < 0.82: lp = "light "
    else:          lp = "very light "

    if s < 0.18: lp = "muted " + lp

    if   h < 15  or h >= 345: hue = "red"
    elif h < 45:               hue = "orange"
    elif h < 70:               hue = "yellow"
    elif h < 150:              hue = "green"
    elif h < 195:              hue = "cyan"
    elif h < 250:              hue = "blue"
    elif h < 290:              hue = "purple/violet"
    else:                      hue = "pink/magenta"

    return f"{lp}{hue}".strip()


def _dominant_colors(img_rgb, n=8):
    """K-means-like dominant color extraction via binned quantization."""
    try:
        import numpy as np
        thumb = img_rgb.resize((120, 120))
        arr = np.array(thumb).reshape(-1, 3)
        # Bin into 24-step buckets (256/24 ≈ 11 levels per channel → ~1331 possible bins)
        binned = (arr // 24) * 24
        keys = [tuple(int(c) for c in p) for p in binned]
        counter = Counter(keys)
        total = len(keys)
        result = []
        for color, count in counter.most_common(n):
            r, g, b = color
            result.append({
                "hex":   "#{:02x}{:02x}{:02x}".format(r, g, b),
                "rgb":   [r, g, b],
                "name":  _name_color(r, g, b),
                "pct":   round(count / total * 100, 1),
            })
        return result
    except Exception:
        return []


# ── OCR ───────────────────────────────────────────────────────────────────────

def _ocr_pytesseract(img_pil):
    try:
        import pytesseract
        # Run with two page-segmentation modes and merge
        configs = [
            "--psm 3 --oem 3",   # fully automatic
            "--psm 6 --oem 3",   # uniform block of text
            "--psm 11 --oem 3",  # sparse text
        ]
        texts = set()
        words_data = []
        for cfg in configs:
            try:
                t = pytesseract.image_to_string(img_pil, config=cfg).strip()
                if t:
                    texts.add(t)
                data = pytesseract.image_to_data(img_pil, config=cfg,
                                                 output_type=pytesseract.Output.DICT)
                for i, w in enumerate(data["text"]):
                    w = w.strip()
                    conf = float(data["conf"][i])
                    if w and conf > 35:
                        words_data.append({
                            "text": w,
                            "conf": round(conf, 1),
                            "x": data["left"][i],
                            "y": data["top"][i],
                        })
            except Exception:
                pass

        full_text = "\n".join(texts)
        # Deduplicate words by (text, approximate position)
        seen = set()
        unique_words = []
        for w in sorted(words_data, key=lambda x: -x["conf"]):
            key = (w["text"].lower(), w["x"] // 20, w["y"] // 20)
            if key not in seen:
                seen.add(key)
                unique_words.append(w)

        return {
            "engine": "pytesseract",
            "full_text": full_text[:3000],
            "words": unique_words[:60],
            "has_text": bool(full_text.strip()),
        }
    except ImportError:
        return None
    except Exception as e:
        return {"engine": "pytesseract", "error": str(e), "has_text": False}


def _ocr_easyocr(img_path):
    try:
        import easyocr
        reader = easyocr.Reader(["en", "pl"], gpu=False, verbose=False)
        results = reader.readtext(str(img_path))
        detections = []
        for (bbox, text, conf) in results:
            if conf > 0.25:
                detections.append({
                    "text":       text,
                    "confidence": round(conf, 3),
                    "bbox":       [[int(p[0]), int(p[1])] for p in bbox],
                })
        full = " ".join(d["text"] for d in detections)
        return {
            "engine":     "easyocr",
            "full_text":  full[:3000],
            "detections": detections[:50],
            "has_text":   bool(detections),
        }
    except ImportError:
        return None
    except Exception as e:
        return {"engine": "easyocr", "error": str(e), "has_text": False}


# ── OpenCV analysis ───────────────────────────────────────────────────────────

def _cv_analysis(img_path):
    try:
        import cv2
        import numpy as np

        img = cv2.imread(str(img_path))
        if img is None:
            return {"error": "cv2.imread returned None"}

        H, W = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        out = {"width": W, "height": H}

        # ── Sharpness (Laplacian variance) ──
        lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        out["sharpness_score"] = round(lap_var, 2)
        out["sharpness_label"] = (
            "very blurry" if lap_var < 50
            else "blurry" if lap_var < 150
            else "slightly soft" if lap_var < 500
            else "sharp" if lap_var < 2000
            else "very sharp / high detail"
        )

        # ── Brightness & contrast ──
        out["brightness_mean"] = round(float(np.mean(gray)), 2)
        out["contrast_std"]    = round(float(np.std(gray)), 2)

        # ── Canny edges ──
        edges = cv2.Canny(gray, 50, 150)
        edge_density = float(np.sum(edges > 0)) / (H * W)
        out["edge_density"] = round(edge_density, 5)
        out["edge_label"] = (
            "minimal / very clean" if edge_density < 0.02
            else "clean / simple"  if edge_density < 0.05
            else "moderate detail" if edge_density < 0.10
            else "detailed"        if edge_density < 0.18
            else "highly complex / photo-like"
        )

        # ── Contours ──
        cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if cnts:
            areas = sorted([cv2.contourArea(c) for c in cnts], reverse=True)
            total_area = H * W
            # Classify top contours by shape
            shape_tags = []
            for c in cnts[:10]:
                area = cv2.contourArea(c)
                if area < 50:
                    continue
                peri = cv2.arcLength(c, True)
                approx = cv2.approxPolyDP(c, 0.04 * peri, True)
                sides = len(approx)
                circularity = 4 * math.pi * area / (peri * peri + 1e-6)
                if circularity > 0.78:
                    shape_tags.append("circle/ellipse")
                elif sides == 3:
                    shape_tags.append("triangle")
                elif sides == 4:
                    shape_tags.append("rectangle/square")
                elif sides <= 6:
                    shape_tags.append("polygon")
                else:
                    shape_tags.append("irregular shape")

            shape_counter = Counter(shape_tags)
            out["contours"] = {
                "count": len(cnts),
                "top3_area_pct": [round(a / total_area * 100, 1) for a in areas[:3]],
                "dominant_largest_pct": round(areas[0] / total_area * 100, 1),
                "shape_summary": dict(shape_counter),
            }
        else:
            out["contours"] = {"count": 0}

        # ── Circles (Hough) ──
        circles = cv2.HoughCircles(
            gray, cv2.HOUGH_GRADIENT, 1, 20,
            param1=50, param2=30,
            minRadius=max(5, min(W, H) // 40),
            maxRadius=min(W, H) // 2,
        )
        out["hough_circles"] = int(len(circles[0])) if circles is not None else 0

        # ── Face detection ──
        try:
            fc_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            fc = cv2.CascadeClassifier(fc_path)
            faces = fc.detectMultiScale(gray, 1.1, 5, minSize=(30, 30))
            n_faces = int(len(faces)) if not isinstance(faces, tuple) else 0
            out["faces"] = {
                "count": n_faces,
                "bboxes": [
                    {"x": int(x), "y": int(y), "w": int(w), "h": int(h),
                     "center_pct": [round((x + w/2) / W * 100, 1), round((y + h/2) / H * 100, 1)]}
                    for (x, y, w, h) in (faces if n_faces > 0 else [])
                ][:6],
            }
        except Exception:
            out["faces"] = {"count": 0}

        # ── Per-region analysis (4×4 grid) ──
        G = 4
        gh, gw = H // G, W // G
        regions = {}
        for row in range(G):
            for col in range(G):
                y1, y2 = row * gh, (row + 1) * gh
                x1, x2 = col * gw, (col + 1) * gw
                patch_gray  = gray[y1:y2, x1:x2]
                patch_edges = edges[y1:y2, x1:x2]
                patch_color = img[y1:y2, x1:x2]
                label = f"r{row+1}c{col+1}"
                b_mean = float(np.mean(patch_color[:,:,0]))
                g_mean = float(np.mean(patch_color[:,:,1]))
                r_mean = float(np.mean(patch_color[:,:,2]))
                dom_hex = "#{:02x}{:02x}{:02x}".format(
                    int(r_mean), int(g_mean), int(b_mean)
                )
                e_density = float(np.sum(patch_edges > 0)) / (gh * gw + 1)
                regions[label] = {
                    "brightness": round(float(np.mean(patch_gray)), 1),
                    "edge_density": round(e_density, 4),
                    "dominant_hex": dom_hex,
                    "dominant_color_name": _name_color(int(r_mean), int(g_mean), int(b_mean)),
                }
        out["regions_4x4"] = regions

        # ── Channel histograms (8 buckets each) ──
        total_px = H * W
        hists = {}
        for ch_idx, ch_name in [(2, "red"), (1, "green"), (0, "blue")]:
            h = cv2.calcHist([img], [ch_idx], None, [8], [0, 256]).flatten()
            hists[ch_name] = [round(float(v) / total_px * 100, 2) for v in h]
        out["channel_histograms_pct"] = hists

        # ── Dominant quadrant content ──
        quad_labels = {
            (0, 0): "top-left",    (0, 1): "top-right",
            (1, 0): "bottom-left", (1, 1): "bottom-right",
        }
        quads = {}
        for (row, col), name in quad_labels.items():
            y1, y2 = row * (H // 2), (row + 1) * (H // 2)
            x1, x2 = col * (W // 2), (col + 1) * (W // 2)
            q_edges = edges[y1:y2, x1:x2]
            q_gray  = gray[y1:y2, x1:x2]
            quads[name] = {
                "brightness":    round(float(np.mean(q_gray)), 1),
                "edge_activity": round(float(np.sum(q_edges > 0)) / ((H // 2) * (W // 2)), 4),
            }
        out["quadrant_analysis"] = quads

        return out

    except ImportError:
        return {"error": "OpenCV (cv2) not installed"}
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()[-400:]}


# ── Image type classifier ─────────────────────────────────────────────────────

def _classify(colors, edge_label, has_text, faces, w, h, brightness):
    tags = []

    if faces and faces > 0:
        tags.append(f"{'portrait' if faces == 1 else 'group photo'} — {faces} face(s) detected")

    if edge_label:
        if "minimal" in edge_label or "clean" in edge_label:
            tags.append("flat design / logo / icon / solid background")
        elif "complex" in edge_label or "photo" in edge_label:
            tags.append("photograph or complex illustration")
        else:
            tags.append("graphic design / illustration")

    if has_text:
        tags.append("contains readable text")

    if w and h:
        r = w / h
        if 0.9 < r < 1.1:    tags.append("square format (icon/avatar/logo)")
        elif r > 1.7:         tags.append("wide/landscape (banner/screenshot/wallpaper)")
        elif r < 0.65:        tags.append("tall/portrait format")

    if brightness is not None:
        if brightness < 60:   tags.append("dark-themed")
        elif brightness > 190: tags.append("light/white-themed")

    return tags or ["general image"]


# ── Main ──────────────────────────────────────────────────────────────────────

def execute(
    path: str,
    question: str = "Describe this image in full detail — content, style, colors, text, composition.",
):
    t0 = time.time()

    # Ensure required packages are installed (installs on first run if missing)
    _ensure_packages()

    if not os.path.exists(path):
        return {
            "status": "error", "result": None,
            "error": f"File not found: {path}",
            "metadata": {"tool": "image_analyze", "duration_ms": 0},
        }

    report = {"question": question, "path": path}

    # ── 1. PIL metadata + color ───────────────────────────────────────────
    img_pil = None
    try:
        from PIL import Image, ExifTags
        import numpy as np

        img_pil = Image.open(path)
        W, H = img_pil.size

        report["file"] = {
            "name":         Path(path).name,
            "format":       str(img_pil.format or Path(path).suffix.lstrip(".").upper()),
            "width":        W,
            "height":       H,
            "megapixels":   round(W * H / 1_000_000, 3),
            "aspect_ratio": round(W / H, 3),
            "mode":         img_pil.mode,
            "size_kb":      round(os.path.getsize(path) / 1024, 1),
        }

        # EXIF
        try:
            exif_raw = img_pil._getexif()
            if exif_raw:
                skip = {"MakerNote", "UserComment", "PrintImageMatching"}
                exif = {}
                for tid, val in exif_raw.items():
                    tag = ExifTags.TAGS.get(tid, str(tid))
                    if tag not in skip and isinstance(val, (str, int, float)):
                        exif[tag] = str(val)[:120]
                if exif:
                    report["exif"] = exif
        except Exception:
            pass

        img_rgb = img_pil.convert("RGB")
        arr = np.array(img_rgb, dtype=np.float32)

        # Color statistics
        brightness = float(np.mean(arr))
        r_mean = float(np.mean(arr[:, :, 0]))
        g_mean = float(np.mean(arr[:, :, 1]))
        b_mean = float(np.mean(arr[:, :, 2]))
        max_c  = max(r_mean, g_mean, b_mean)
        min_c  = min(r_mean, g_mean, b_mean)
        saturation = (max_c - min_c) / (max_c + 1.0)
        gray_arr = np.mean(arr, axis=2)
        contrast = float(np.std(gray_arr))

        if r_mean > b_mean * 1.15:
            temp = "warm (red/yellow dominant)"
        elif b_mean > r_mean * 1.15:
            temp = "cool (blue dominant)"
        else:
            temp = "neutral/balanced"

        report["color_analysis"] = {
            "dominant_colors": _dominant_colors(img_rgb, n=8),
            "brightness":      round(brightness, 1),
            "brightness_label": (
                "very dark" if brightness < 50
                else "dark" if brightness < 100
                else "medium-dark" if brightness < 128
                else "medium-light" if brightness < 165
                else "light" if brightness < 200
                else "very bright/white-heavy"
            ),
            "contrast":        round(contrast, 1),
            "contrast_label":  (
                "very low (flat/washed)" if contrast < 20
                else "low"          if contrast < 40
                else "medium"       if contrast < 70
                else "high"         if contrast < 95
                else "very high"
            ),
            "saturation":       round(saturation, 3),
            "saturation_label": (
                "grayscale/desaturated" if saturation < 0.08
                else "low/muted"   if saturation < 0.25
                else "moderate"    if saturation < 0.50
                else "vivid/high"  if saturation < 0.75
                else "intense/neon"
            ),
            "color_temperature": temp,
            "channel_means": {
                "red":   round(r_mean, 1),
                "green": round(g_mean, 1),
                "blue":  round(b_mean, 1),
            },
        }

    except Exception as e:
        report["pil_error"] = str(e)
        img_pil = None
        W, H, brightness = None, None, None

    # ── 2. OCR text ───────────────────────────────────────────────────────
    ocr = None
    if img_pil:
        ocr = _ocr_pytesseract(img_pil)
    if not ocr or not ocr.get("has_text"):
        easyocr_result = _ocr_easyocr(path)
        if easyocr_result and easyocr_result.get("has_text"):
            ocr = easyocr_result

    if ocr and not ocr.get("error"):
        report["text"] = {
            "has_text":      ocr.get("has_text", False),
            "engine":        ocr.get("engine"),
            "extracted":     (ocr.get("full_text") or "").strip()[:2500],
        }
        if ocr.get("detections"):
            report["text"]["detections"] = [
                {"text": d["text"], "confidence": d["confidence"]}
                for d in ocr["detections"][:30]
            ]
        if ocr.get("words"):
            report["text"]["top_words"] = [
                w["text"]
                for w in sorted(ocr["words"], key=lambda x: -x.get("conf", 0))[:25]
            ]
    else:
        report["text"] = {
            "has_text": False,
            "note": "No text detected (or pytesseract/easyocr not installed)",
        }

    # ── 3. OpenCV structural analysis ────────────────────────────────────
    cv = _cv_analysis(path)
    report["structure"] = cv

    edge_label  = cv.get("edge_label")  if cv and not cv.get("error") else None
    faces_count = cv.get("faces", {}).get("count", 0) if cv and not cv.get("error") else 0

    # ── 4. Image type classification ─────────────────────────────────────
    dom_colors = report.get("color_analysis", {}).get("dominant_colors", [])
    report["image_type"] = _classify(
        dom_colors, edge_label,
        report.get("text", {}).get("has_text", False),
        faces_count, W, H, brightness,
    )

    # ── 5. Human-readable summary string ─────────────────────────────────
    lines = []

    # Header
    f = report.get("file", {})
    if f:
        lines.append(
            f"=== IMAGE ANALYSIS: {f.get('name','?')} ==="
            f"\nFormat: {f.get('format','?')} | "
            f"Size: {f.get('width','?')}×{f.get('height','?')}px | "
            f"Aspect: {f.get('aspect_ratio','?')}:1 | "
            f"Weight: {f.get('size_kb','?')}KB | "
            f"Color mode: {f.get('mode','?')}"
        )

    # Type hints
    if report.get("image_type"):
        lines.append("TYPE HINTS: " + ", ".join(report["image_type"]))

    # Colors
    ca = report.get("color_analysis", {})
    if ca:
        pal = " | ".join(
            f"{c['hex']} {c['name']} ({c['pct']}%)"
            for c in ca.get("dominant_colors", [])[:6]
        )
        lines.append(
            f"\nCOLOR PALETTE:\n  {pal}"
            f"\n  Brightness: {ca.get('brightness_label','?')} ({ca.get('brightness','?')}/255)"
            f"  |  Contrast: {ca.get('contrast_label','?')}"
            f"  |  Saturation: {ca.get('saturation_label','?')}"
            f"  |  Temperature: {ca.get('color_temperature','?')}"
        )

    # Text
    tx = report.get("text", {})
    if tx.get("has_text") and tx.get("extracted"):
        lines.append(f"\nEXTRACTED TEXT (via {tx.get('engine','?')}):\n  {tx['extracted'][:800]}")
        if tx.get("detections"):
            det_str = " | ".join(
                f'"{d["text"]}" ({int(d["confidence"]*100)}%)'
                for d in tx["detections"][:15]
            )
            lines.append(f"  Text detections: {det_str}")
    else:
        lines.append("\nTEXT: No readable text detected")

    # Structure
    if cv and not cv.get("error"):
        lines.append(
            f"\nSTRUCTURE & COMPOSITION:"
            f"\n  Edges: {cv.get('edge_label','?')} (density={cv.get('edge_density','?')})"
            f"\n  Sharpness: {cv.get('sharpness_label','?')} (score={cv.get('sharpness_score','?')})"
            f"\n  Circles detected: {cv.get('hough_circles', 0)}"
            f"\n  Faces detected: {cv.get('faces',{}).get('count', 0)}"
        )

        cnts = cv.get("contours", {})
        if cnts.get("count", 0) > 0:
            shapes = cnts.get("shape_summary", {})
            shapes_str = ", ".join(f"{v}× {k}" for k, v in sorted(shapes.items(), key=lambda x: -x[1]))
            lines.append(
                f"  Contours: {cnts['count']} total | "
                f"Largest covers {cnts.get('dominant_largest_pct', 0):.1f}% of image | "
                f"Shapes: {shapes_str or 'mixed'}"
            )

        # Quadrant map
        quads = cv.get("quadrant_analysis", {})
        if quads:
            quad_str = "  | ".join(
                f"{name}: bright={v['brightness']:.0f}, activity={v['edge_activity']:.3f}"
                for name, v in quads.items()
            )
            lines.append(f"  QUADRANT MAP: {quad_str}")

        # 4×4 region color map (condensed)
        regions = cv.get("regions_4x4", {})
        if regions:
            region_lines = []
            for label, v in sorted(regions.items()):
                region_lines.append(
                    f"{label}→{v.get('dominant_color_name','?')} "
                    f"(bright={v['brightness']:.0f}, edges={v['edge_density']:.3f})"
                )
            lines.append("  4×4 REGION MAP:\n  " + " | ".join(region_lines))

    # EXIF notable
    exif = report.get("exif", {})
    if exif:
        notable = {k: v for k, v in exif.items()
                   if k in ("DateTime", "Make", "Model", "Software", "ImageDescription",
                            "Artist", "Copyright", "GPSLatitude", "GPSLongitude")}
        if notable:
            lines.append("\nEXIF: " + " | ".join(f"{k}={v}" for k, v in notable.items()))

    summary = "\n".join(lines)

    duration_ms = round((time.time() - t0) * 1000)
    return {
        "status": "ok",
        "result": {
            "summary":     summary,
            "full_report": report,
            "question":    question,
            "path":        path,
        },
        "error": None,
        "metadata": {"tool": "image_analyze", "duration_ms": duration_ms},
    }


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    args = data.get("args", data)
    print(json.dumps(execute(**args), ensure_ascii=False, default=str))
