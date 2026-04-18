"""
audio_transcribe.py — Transcribe audio/video with Whisper.

Backends (picked automatically):
  • faster-whisper — CTranslate2 port, ~4x faster, lower memory
  • openai-whisper — original PyTorch implementation (fallback)

Args:
  src:           path to audio/video file (required)
  model:         "tiny" | "base" | "small" | "medium" | "large-v3"
                 (default "base" — good quality, ~140MB download)
  language:      ISO code, "auto" for detection (default "auto")
  task:          "transcribe" | "translate" (translate → English)
  vad:           voice-activity detection (faster-whisper only, default True)
  word_timestamps: include per-word times (default False)
  max_duration:  cap length in seconds (default 3600)

Returns:
  {status, result: {
      language, language_probability, duration,
      segments: [{start, end, text, words?}],
      text, model, backend
  }, ...}

The model files download to ~/.cache/whisper/ on first use.
"""

from __future__ import annotations

import os
import time
from pathlib import Path


def execute(src: str, model: str = "base", language: str = "auto",
            task: str = "transcribe", vad: bool = True,
            word_timestamps: bool = False, max_duration: int = 3600,
            beam_size: int = 5, **kwargs) -> dict:
    start = time.time()
    p = Path(src).expanduser().resolve()
    if not p.exists():
        return _err(f"not found: {p}", start)
    if task not in ("transcribe", "translate"):
        return _err("task must be transcribe|translate", start)

    duration = _probe_duration(str(p))
    if duration and duration > max_duration:
        return _err(f"duration {duration:.1f}s exceeds max_duration={max_duration}s."
                    f" Split first or pass max_duration=…", start)

    # Prefer faster-whisper
    try:
        return _run_faster(p, model, language, task, vad,
                           word_timestamps, beam_size, start, duration)
    except ImportError:
        pass
    except Exception as e:
        # Only fall back on hard failures, not model issues
        if "could not find" in str(e).lower() or "not supported" in str(e).lower():
            pass
        else:
            return _err(f"faster-whisper: {e}", start)

    try:
        return _run_whisper(p, model, language, task,
                            word_timestamps, start, duration)
    except ImportError:
        return _err("Neither faster-whisper nor openai-whisper is available",
                    start)
    except Exception as e:
        return _err(f"whisper: {e}", start)


# ── faster-whisper ──────────────────────────────────────────────────────────

def _run_faster(p: Path, model: str, language: str, task: str,
                vad: bool, words: bool, beam: int,
                start: float, duration: float | None) -> dict:
    from faster_whisper import WhisperModel  # type: ignore
    lang = None if language in ("auto", "", None) else language
    m = _get_fw_model(model)
    segs, info = m.transcribe(
        str(p),
        language=lang, task=task,
        vad_filter=vad,
        word_timestamps=words,
        beam_size=beam,
    )
    segments = []
    full = []
    for s in segs:
        seg = {"start": round(s.start, 2), "end": round(s.end, 2),
               "text": s.text.strip()}
        if words and getattr(s, "words", None):
            seg["words"] = [{"start": round(w.start, 2),
                             "end": round(w.end, 2),
                             "text": w.word} for w in s.words]
        segments.append(seg); full.append(s.text)
    return {"status": "ok", "result": {
        "language": info.language,
        "language_probability": round(float(info.language_probability), 4),
        "duration": round(float(info.duration or (duration or 0.0)), 2),
        "segments": segments,
        "text": " ".join(full).strip(),
        "model": model, "backend": "faster-whisper",
    }, "error": None,
        "metadata": {"tool": "audio_transcribe",
                     "duration_ms": int((time.time() - start) * 1000)}}


_FW_CACHE: dict = {}


def _get_fw_model(model: str):
    if model in _FW_CACHE:
        return _FW_CACHE[model]
    from faster_whisper import WhisperModel  # type: ignore
    device = "cuda" if _has_cuda() else "cpu"
    compute = "float16" if device == "cuda" else "int8"
    m = WhisperModel(model, device=device, compute_type=compute)
    _FW_CACHE[model] = m
    return m


def _has_cuda() -> bool:
    try:
        import torch  # type: ignore
        return bool(torch.cuda.is_available())
    except Exception:
        return False


# ── openai-whisper fallback ────────────────────────────────────────────────

def _run_whisper(p: Path, model: str, language: str, task: str,
                 words: bool, start: float, duration: float | None) -> dict:
    import whisper  # type: ignore
    m = _get_w_model(model)
    opts = {"task": task, "word_timestamps": words,
            "fp16": _has_cuda()}
    if language not in ("auto", "", None):
        opts["language"] = language
    res = m.transcribe(str(p), **opts)
    segments = []
    for s in res.get("segments") or []:
        seg = {"start": round(float(s["start"]), 2),
               "end": round(float(s["end"]), 2),
               "text": s["text"].strip()}
        if words and s.get("words"):
            seg["words"] = [{"start": round(float(w["start"]), 2),
                             "end": round(float(w["end"]), 2),
                             "text": w["word"]} for w in s["words"]]
        segments.append(seg)
    return {"status": "ok", "result": {
        "language": res.get("language"),
        "language_probability": None,
        "duration": duration,
        "segments": segments,
        "text": (res.get("text") or "").strip(),
        "model": model, "backend": "openai-whisper",
    }, "error": None,
        "metadata": {"tool": "audio_transcribe",
                     "duration_ms": int((time.time() - start) * 1000)}}


_W_CACHE: dict = {}


def _get_w_model(model: str):
    if model in _W_CACHE:
        return _W_CACHE[model]
    import whisper  # type: ignore
    m = whisper.load_model(model)
    _W_CACHE[model] = m
    return m


# ── ffprobe duration ────────────────────────────────────────────────────────

def _probe_duration(path: str) -> float | None:
    import subprocess
    for cmd in (
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
    ):
        try:
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL,
                                          timeout=10).decode().strip()
            if out: return float(out)
        except Exception:
            continue
    return None


def _err(msg, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "audio_transcribe",
                         "duration_ms": int((time.time() - start) * 1000)}}
