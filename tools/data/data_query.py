"""
data_query.py — Schema + query over CSV, TSV, Excel, Parquet, JSON, JSONL, SQLite.

Operations (pass as `op`):
  • schema  — detect columns, types, row count, null counts, sample values
  • head    — first N rows
  • sample  — random sample of N rows (seed= for reproducibility)
  • stats   — per-column statistics (numeric: min/max/mean/std/quantiles;
              object: unique / top values)
  • query   — run a SQL query (auto-registers the file as a DuckDB view
              if DuckDB is installed; falls back to SQLite / pandas.query).
  • filter  — row filter via a pandas-style boolean expression
  • unique  — distinct values in a column (with counts)
  • groupby — group + aggregate (sum/mean/count/min/max)
  • pivot   — pivot table
  • join    — left/right/inner/outer join two files

Inputs:
  src:      path to file (required for most ops)
  src2:     second file (for join)
  table:    table name for SQLite, or custom alias for query (default "data")
  format:   "auto" or csv|tsv|json|jsonl|xlsx|parquet|sqlite

Output is capped at `max_rows` (default 1000) for safety.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path


MAX_ROWS = 1000


def execute(op: str, **kwargs) -> dict:
    start = time.time()
    op = (op or "").lower().strip()
    if op not in _DISPATCH:
        return _err(f"unknown op '{op}'. Allowed: {sorted(_DISPATCH.keys())}",
                    start, op)
    try:
        return _DISPATCH[op](start=start, **kwargs)
    except FileNotFoundError as e:
        return _err(f"not found: {e}", start, op)
    except ImportError as e:
        return _err(f"missing dep: {e}", start, op)
    except ValueError as e:
        return _err(str(e), start, op)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}", start, op)


# ── Loading ─────────────────────────────────────────────────────────────────

def _detect_format(p: Path, fmt: str) -> str:
    if fmt and fmt != "auto": return fmt
    name = p.name.lower()
    if name.endswith(".csv"): return "csv"
    if name.endswith((".tsv", ".tab")): return "tsv"
    if name.endswith(".jsonl") or name.endswith(".ndjson"): return "jsonl"
    if name.endswith(".json"): return "json"
    if name.endswith((".xlsx", ".xls")): return "xlsx"
    if name.endswith(".parquet") or name.endswith(".pq"): return "parquet"
    if name.endswith((".sqlite", ".db", ".sqlite3")): return "sqlite"
    return "csv"


def _load_df(src: str, format: str = "auto", table: str = "data",
             max_rows: int | None = None, **_):
    import pandas as pd  # type: ignore
    p = Path(src).expanduser().resolve()
    if not p.exists(): raise FileNotFoundError(str(p))
    fmt = _detect_format(p, format)

    nrows = max_rows if max_rows and max_rows > 0 else None
    if fmt == "csv":
        df = pd.read_csv(p, nrows=nrows, low_memory=False,
                         on_bad_lines="skip")
    elif fmt == "tsv":
        df = pd.read_csv(p, sep="\t", nrows=nrows, low_memory=False,
                         on_bad_lines="skip")
    elif fmt == "json":
        df = pd.read_json(p)
        if nrows: df = df.head(nrows)
    elif fmt == "jsonl":
        df = pd.read_json(p, lines=True, nrows=nrows)
    elif fmt == "xlsx":
        df = pd.read_excel(p, nrows=nrows)
    elif fmt == "parquet":
        df = pd.read_parquet(p)
        if nrows: df = df.head(nrows)
    elif fmt == "sqlite":
        with sqlite3.connect(str(p)) as con:
            tables = [r[0] for r in con.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' ORDER BY name").fetchall()]
            target = table if table in tables else (tables[0] if tables else "data")
            lim = f"LIMIT {int(nrows)}" if nrows else ""
            df = pd.read_sql(f"SELECT * FROM {target} {lim}", con)
    else:
        raise ValueError(f"unsupported format '{fmt}'")
    return df, fmt


# ── Ops ─────────────────────────────────────────────────────────────────────

def _op_schema(start, src, format: str = "auto", table: str = "data",
               sample_values: int = 3, **_):
    df, fmt = _load_df(src, format, table)
    cols = []
    for c in df.columns:
        col = df[c]
        nonnull = col.dropna()
        samples = [_jsonable(v) for v in nonnull.head(sample_values).tolist()]
        cols.append({
            "name": str(c), "dtype": str(col.dtype),
            "nulls": int(col.isna().sum()),
            "unique": int(col.nunique(dropna=True)),
            "samples": samples,
        })
    return _ok({"src": src, "format": fmt,
                "rows": int(len(df)), "columns": len(cols),
                "schema": cols}, start, "schema")


def _op_head(start, src, n: int = 20, format: str = "auto",
             table: str = "data", **_):
    df, fmt = _load_df(src, format, table, max_rows=max(n * 5, 1000))
    return _ok({"src": src, "format": fmt,
                "rows": _to_records(df.head(n)),
                "count": int(min(n, len(df)))}, start, "head")


def _op_sample(start, src, n: int = 20, seed: int = 0,
               format: str = "auto", table: str = "data", **_):
    df, fmt = _load_df(src, format, table)
    if len(df) == 0:
        return _ok({"rows": [], "count": 0}, start, "sample")
    n = min(n, len(df))
    sample = df.sample(n, random_state=seed or None)
    return _ok({"src": src, "format": fmt,
                "rows": _to_records(sample),
                "count": len(sample)}, start, "sample")


def _op_stats(start, src, columns: list | None = None,
              format: str = "auto", table: str = "data", **_):
    import pandas as pd  # type: ignore
    df, fmt = _load_df(src, format, table)
    if columns: df = df[[c for c in columns if c in df.columns]]
    out = {}
    for c in df.columns:
        col = df[c]
        dtype = str(col.dtype)
        if pd.api.types.is_numeric_dtype(col):
            s = col.dropna()
            if len(s) == 0:
                out[c] = {"dtype": dtype, "empty": True}; continue
            out[c] = {
                "dtype": dtype,
                "count": int(s.count()),
                "min": _jsonable(s.min()),
                "max": _jsonable(s.max()),
                "mean": float(s.mean()),
                "std": float(s.std()) if len(s) > 1 else 0.0,
                "q25": _jsonable(s.quantile(0.25)),
                "q50": _jsonable(s.quantile(0.50)),
                "q75": _jsonable(s.quantile(0.75)),
                "nulls": int(col.isna().sum()),
            }
        else:
            vc = col.astype(str).value_counts().head(10)
            out[c] = {
                "dtype": dtype,
                "unique": int(col.nunique(dropna=True)),
                "nulls": int(col.isna().sum()),
                "top": [{"value": k, "count": int(v)}
                        for k, v in vc.items()],
            }
    return _ok({"src": src, "format": fmt,
                "rows": int(len(df)), "stats": out},
               start, "stats")


def _op_query(start, src, sql: str, format: str = "auto",
              table: str = "data", max_rows: int = MAX_ROWS, **_):
    import pandas as pd  # type: ignore
    if not sql: raise ValueError("sql= required")

    # Try DuckDB first — handles CSV/Parquet/SQLite natively
    try:
        import duckdb  # type: ignore
        df, fmt = _load_df(src, format, table)
        con = duckdb.connect()
        con.register(table, df)
        res = con.execute(sql).fetchdf()
        con.close()
        return _ok({"src": src, "format": fmt,
                    "sql": sql, "backend": "duckdb",
                    "rows": _to_records(res.head(max_rows)),
                    "count": int(min(max_rows, len(res))),
                    "total": int(len(res))},
                   start, "query")
    except ImportError:
        pass

    # Fallback: SQLite in-memory
    df, fmt = _load_df(src, format, table)
    with sqlite3.connect(":memory:") as con:
        df.to_sql(table, con, index=False)
        res = pd.read_sql(sql, con)
    return _ok({"src": src, "format": fmt,
                "sql": sql, "backend": "sqlite",
                "rows": _to_records(res.head(max_rows)),
                "count": int(min(max_rows, len(res))),
                "total": int(len(res))},
               start, "query")


def _op_filter(start, src, expr: str, format: str = "auto",
               table: str = "data", max_rows: int = MAX_ROWS, **_):
    df, fmt = _load_df(src, format, table)
    res = df.query(expr)
    return _ok({"src": src, "format": fmt, "expr": expr,
                "rows": _to_records(res.head(max_rows)),
                "count": int(min(max_rows, len(res))),
                "total": int(len(res))}, start, "filter")


def _op_unique(start, src, column: str, limit: int = 100,
               format: str = "auto", table: str = "data", **_):
    df, fmt = _load_df(src, format, table)
    if column not in df.columns:
        raise ValueError(f"column '{column}' not found")
    vc = df[column].astype(str).value_counts().head(limit)
    return _ok({"src": src, "format": fmt, "column": column,
                "values": [{"value": k, "count": int(v)}
                           for k, v in vc.items()],
                "total_unique": int(df[column].nunique(dropna=True))},
               start, "unique")


def _op_groupby(start, src, by: list | str, agg: dict,
                format: str = "auto", table: str = "data",
                max_rows: int = MAX_ROWS, **_):
    df, fmt = _load_df(src, format, table)
    if isinstance(by, str): by = [by]
    res = df.groupby(by).agg(agg).reset_index()
    return _ok({"src": src, "format": fmt, "by": by, "agg": agg,
                "rows": _to_records(res.head(max_rows)),
                "count": int(min(max_rows, len(res)))},
               start, "groupby")


def _op_pivot(start, src, index: list | str, columns: str,
              values: str, aggfunc: str = "sum",
              format: str = "auto", table: str = "data",
              max_rows: int = MAX_ROWS, **_):
    df, fmt = _load_df(src, format, table)
    res = df.pivot_table(index=index, columns=columns,
                         values=values, aggfunc=aggfunc,
                         fill_value=0).reset_index()
    res.columns = [str(c) for c in res.columns]
    return _ok({"src": src, "format": fmt,
                "rows": _to_records(res.head(max_rows)),
                "count": int(min(max_rows, len(res)))},
               start, "pivot")


def _op_join(start, src, src2, on: str | list,
             how: str = "inner", format: str = "auto",
             format2: str = "auto", max_rows: int = MAX_ROWS, **_):
    left, fmt1 = _load_df(src, format)
    right, fmt2 = _load_df(src2, format2)
    res = left.merge(right, how=how, on=on)
    return _ok({"left": src, "right": src2, "how": how,
                "rows": _to_records(res.head(max_rows)),
                "count": int(min(max_rows, len(res))),
                "total": int(len(res))}, start, "join")


_DISPATCH = {
    "schema": _op_schema, "head": _op_head, "sample": _op_sample,
    "stats": _op_stats, "query": _op_query, "filter": _op_filter,
    "unique": _op_unique, "groupby": _op_groupby,
    "pivot": _op_pivot, "join": _op_join,
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _jsonable(v):
    try:
        if v is None: return None
        if isinstance(v, (bool, int, str)): return v
        if isinstance(v, float):
            import math
            return v if math.isfinite(v) else None
        return str(v)
    except Exception:
        return str(v)


def _to_records(df) -> list:
    rows = []
    for _, r in df.iterrows():
        rows.append({str(k): _jsonable(v) for k, v in r.items()})
    return rows


def _ok(result, start, op):
    return {"status": "ok", "result": result, "error": None,
            "metadata": {"tool": "data_query", "op": op,
                         "duration_ms": int((time.time() - start) * 1000)}}


def _err(msg, start, op):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "data_query", "op": op,
                         "duration_ms": int((time.time() - start) * 1000)}}
