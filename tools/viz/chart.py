"""
chart.py — Render charts as PNG or SVG via matplotlib.

Chart types:
  • line       — single or multi-series line chart
  • bar        — vertical/horizontal, grouped or stacked
  • scatter    — with optional sizes / colors
  • pie / donut — labels + percentages
  • histogram  — frequency distribution
  • heatmap    — matrix visualisation
  • area       — stacked area chart
  • box        — box-and-whisker plot

Args:
  type:       chart type (required)
  data:       chart-type-specific data (see below)
  title, xlabel, ylabel, legend (bool), grid (bool)
  colors:     list of colors / colormap name
  width, height: pixels (default 900x540)
  dpi:        default 120
  dest:       output path (default /tmp/deeperseek_chart_<ts>.png)
  format:     "png" | "svg" | "pdf" (inferred from extension otherwise)

Data shapes:
  line/area:   {x: [...], series: {name: [y...]}}   OR   {rows: [{x,y,series}]}
  bar:         {categories: [...], series: {name: [v...]}, stacked: bool, horizontal: bool}
  scatter:     {x: [...], y: [...], sizes?: [...], colors?: [...], labels?: [...]}
  pie/donut:   {labels: [...], values: [...]}
  histogram:   {values: [...], bins: int}
  heatmap:     {matrix: [[...]], x_labels?, y_labels?}
  box:         {series: {name: [values...]}}
"""

from __future__ import annotations

import os
import time
from pathlib import Path


def execute(type: str = "line", data: dict | None = None,
            title: str = "", xlabel: str = "", ylabel: str = "",
            legend: bool = True, grid: bool = True,
            colors: list | str | None = None,
            width: int = 900, height: int = 540, dpi: int = 120,
            dest: str = "", format: str = "", **kwargs) -> dict:
    start = time.time()
    ctype = (type or "line").lower()
    data = data or {}

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return _err("matplotlib required", start)

    try:
        outp = _dest(dest, format)
        fig, ax = plt.subplots(figsize=(width / dpi, height / dpi), dpi=dpi)

        if ctype == "line":
            _draw_line(ax, data, colors)
        elif ctype == "area":
            _draw_area(ax, data, colors)
        elif ctype == "bar":
            _draw_bar(ax, data, colors)
        elif ctype == "scatter":
            _draw_scatter(ax, data, colors)
        elif ctype in ("pie", "donut"):
            _draw_pie(ax, data, colors, donut=(ctype == "donut"))
            legend = legend and False
        elif ctype in ("hist", "histogram"):
            _draw_hist(ax, data, colors)
        elif ctype == "heatmap":
            _draw_heatmap(fig, ax, data, colors)
            legend = False
        elif ctype == "box":
            _draw_box(ax, data, colors)
        else:
            plt.close(fig)
            return _err(f"unknown chart type '{ctype}'", start)

        if title: ax.set_title(title, fontsize=14, pad=10)
        if xlabel: ax.set_xlabel(xlabel)
        if ylabel: ax.set_ylabel(ylabel)
        if ctype not in ("pie", "donut", "heatmap") and grid:
            ax.grid(True, linestyle="--", alpha=0.35)
        if legend and ax.get_legend_handles_labels()[1]:
            ax.legend(loc="best", frameon=False, fontsize=9)

        fig.tight_layout()
        fig.savefig(outp, dpi=dpi, bbox_inches="tight")
        plt.close(fig)
    except Exception as e:
        try: plt.close(fig)  # type: ignore
        except Exception: pass
        return _err(f"{type(e).__name__}: {e}", start)

    return {"status": "ok", "result": {
        "dest": str(outp), "type": ctype,
        "size": [width, height], "dpi": dpi,
        "bytes": outp.stat().st_size,
    }, "error": None,
        "metadata": {"tool": "chart",
                     "duration_ms": int((time.time() - start) * 1000)}}


# ── Chart drawers ──────────────────────────────────────────────────────────

def _palette(colors, n):
    import matplotlib.pyplot as plt
    if isinstance(colors, list) and colors:
        return (colors * (n // len(colors) + 1))[:n]
    if isinstance(colors, str):
        cmap = plt.get_cmap(colors)
        return [cmap(i / max(1, n - 1)) for i in range(n)]
    cmap = plt.get_cmap("tab10")
    return [cmap(i % 10) for i in range(n)]


def _line_series(data):
    if "series" in data:
        x = data.get("x") or list(range(_series_len(data["series"])))
        return x, data["series"]
    if "rows" in data:
        rows = data["rows"]
        series: dict = {}
        x_set = []
        for r in rows:
            s = r.get("series", "series")
            series.setdefault(s, []).append((r["x"], r["y"]))
            if r["x"] not in x_set: x_set.append(r["x"])
        # align
        out = {}
        for s, pts in series.items():
            idx = {xv: yv for xv, yv in pts}
            out[s] = [idx.get(xv) for xv in x_set]
        return x_set, out
    raise ValueError("line data needs series= or rows=")


def _series_len(series: dict) -> int:
    for v in series.values():
        return len(v)
    return 0


def _draw_line(ax, data, colors):
    x, series = _line_series(data)
    cols = _palette(colors, len(series))
    for (name, ys), c in zip(series.items(), cols):
        ax.plot(x, ys, label=name, color=c, linewidth=2, marker="o",
                markersize=3)


def _draw_area(ax, data, colors):
    x, series = _line_series(data)
    cols = _palette(colors, len(series))
    bottom = [0] * len(x)
    for (name, ys), c in zip(series.items(), cols):
        top = [b + (y or 0) for b, y in zip(bottom, ys)]
        ax.fill_between(x, bottom, top, label=name, color=c, alpha=0.75)
        bottom = top


def _draw_bar(ax, data, colors):
    import numpy as np
    cats = data.get("categories") or []
    series = data.get("series") or {}
    stacked = bool(data.get("stacked"))
    horizontal = bool(data.get("horizontal"))
    names = list(series.keys())
    cols = _palette(colors, max(1, len(names)))
    n = len(names)
    positions = np.arange(len(cats))
    if stacked:
        acc = np.zeros(len(cats))
        for name, c in zip(names, cols):
            vals = np.array(series[name], dtype=float)
            if horizontal:
                ax.barh(positions, vals, left=acc, label=name, color=c)
            else:
                ax.bar(positions, vals, bottom=acc, label=name, color=c)
            acc = acc + vals
    else:
        w = 0.8 / max(1, n)
        for i, (name, c) in enumerate(zip(names, cols)):
            offs = (i - (n - 1) / 2) * w
            vals = series[name]
            if horizontal:
                ax.barh(positions + offs, vals, height=w, label=name, color=c)
            else:
                ax.bar(positions + offs, vals, width=w, label=name, color=c)
    if horizontal:
        ax.set_yticks(positions); ax.set_yticklabels(cats)
    else:
        ax.set_xticks(positions); ax.set_xticklabels(cats, rotation=0)


def _draw_scatter(ax, data, colors):
    x = data.get("x", []); y = data.get("y", [])
    sizes = data.get("sizes")
    cs = data.get("colors", colors)
    labels = data.get("labels")
    ax.scatter(x, y, s=sizes, c=cs if cs else None, alpha=0.75, edgecolors="w")
    if labels:
        for xv, yv, lb in zip(x, y, labels):
            ax.annotate(str(lb), (xv, yv), fontsize=8, alpha=0.75,
                        xytext=(4, 4), textcoords="offset points")


def _draw_pie(ax, data, colors, donut=False):
    labels = data.get("labels", [])
    values = data.get("values", [])
    cols = _palette(colors, len(values))
    wedgeprops = {"width": 0.42, "edgecolor": "w"} if donut else {"edgecolor": "w"}
    ax.pie(values, labels=labels, colors=cols,
           autopct="%1.1f%%", startangle=90,
           wedgeprops=wedgeprops, textprops={"fontsize": 9})
    ax.set_aspect("equal")


def _draw_hist(ax, data, colors):
    values = data.get("values", [])
    bins = data.get("bins", 30)
    cols = _palette(colors, 1)
    ax.hist(values, bins=bins, color=cols[0], alpha=0.85,
            edgecolor="white")


def _draw_heatmap(fig, ax, data, colors):
    import numpy as np
    mat = np.array(data.get("matrix", []), dtype=float)
    if mat.size == 0:
        raise ValueError("heatmap needs matrix=")
    cmap = colors if isinstance(colors, str) else "viridis"
    im = ax.imshow(mat, aspect="auto", cmap=cmap)
    fig.colorbar(im, ax=ax, fraction=0.03, pad=0.03)
    xl = data.get("x_labels"); yl = data.get("y_labels")
    if xl: ax.set_xticks(range(len(xl))); ax.set_xticklabels(xl, rotation=45, ha="right")
    if yl: ax.set_yticks(range(len(yl))); ax.set_yticklabels(yl)


def _draw_box(ax, data, colors):
    series = data.get("series", {})
    names = list(series.keys())
    vals = [series[n] for n in names]
    cols = _palette(colors, len(names))
    bp = ax.boxplot(vals, labels=names, patch_artist=True)
    for patch, c in zip(bp["boxes"], cols):
        patch.set_facecolor(c); patch.set_alpha(0.7)


# ── Output ─────────────────────────────────────────────────────────────────

def _dest(dest: str, fmt: str) -> Path:
    if dest:
        p = Path(dest).expanduser().resolve()
    else:
        ext = (fmt or "png").lower().lstrip(".")
        p = Path("/tmp") / f"deeperseek_chart_{int(time.time())}.{ext}"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _err(msg, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "chart",
                         "duration_ms": int((time.time() - start) * 1000)}}
