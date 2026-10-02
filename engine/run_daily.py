"""Daily job: download -> adjust -> compute -> write files for the website.

    python -m engine.run_daily              # normal daily run
    python -m engine.run_daily --classify   # also refresh industry data now (otherwise monthly)
"""
from __future__ import annotations

import argparse
import json
import logging

import pandas as pd

from . import breadth, config, indices, setups, store, universe
from .compute import compute
from .groups import group_index, group_stats, rrg
from .indicators import stage2_episodes

log = logging.getLogger("engine")


def _safe(key: str) -> str:
    return key.replace(":", "_").replace("/", "-")


def write_series(res, p: pd.DataFrame, days: int = 400):
    """One small JSON per stock for its detail page: OHLCV, averages, RS and stage history."""
    folder = config.OUT / "series"
    folder.mkdir(parents=True, exist_ok=True)
    keys = list(res.close.columns)
    q = p[p["key"].isin(keys)]
    frames = {f: store.wide(q, f).reindex(index=res.close.index, columns=keys).tail(days)
              for f in ("open", "high", "low", "volume")}
    c = res.close.tail(days)
    sma = {n: res.close.rolling(n).mean().tail(days) for n in (50, 150, 200)}
    rs12, rs3, st = res.rs12.tail(days), res.rs3.tail(days), res.stage.tail(days)
    dates = [d.strftime("%Y-%m-%d") for d in c.index]
    r2 = lambda s: [None if pd.isna(x) else round(float(x), 2) for x in s]  # noqa: E731
    r0 = lambda s: [None if pd.isna(x) else int(x) for x in s]              # noqa: E731
    for k in keys:
        if c[k].notna().sum() < 5:
            continue
        doc = dict(d=dates, o=r2(frames["open"][k]), h=r2(frames["high"][k]), l=r2(frames["low"][k]),
                   c=r2(c[k]), v=r0(frames["volume"][k]), s50=r2(sma[50][k]), s150=r2(sma[150][k]),
                   s200=r2(sma[200][k]), rs12=r0(rs12[k]), rs3=r0(rs3[k]), st=r0(st[k]))
        (folder / f"{_safe(k)}.json").write_text(json.dumps(doc, separators=(",", ":")))


def write_sparks(res, days: int = 63):
    """Last ~3 months of closes per stock, scaled 0-100, for the small in-row price lines."""
    c = res.close.tail(days)
    lo, hi = c.min(), c.max()
    scaled = ((c - lo) / (hi - lo).replace(0, 1) * 100).round()
    out = {k: [None if pd.isna(x) else int(x) for x in scaled[k]] for k in c.columns if c[k].notna().sum() > 5}
    (config.OUT / "sparks.json").write_text(json.dumps(out, separators=(",", ":")))


def write_setups(res, p: pd.DataFrame):
    """Cup & Handle / VCP and High Tight Flag setups (forming, fresh breakouts, continuation)."""
    keys = list(res.close.columns)
    wide = lambda f: store.wide(p[p["key"].isin(keys)], f).reindex(index=res.close.index, columns=keys)  # noqa: E731
    found = setups.scan(res.close, wide("high"), wide("low"), wide("volume"), res.snapshot["turnover_cr"], res.rs12)
    (config.OUT / "setups.json").write_text(json.dumps(dict(date=res.close.index[-1].strftime("%Y-%m-%d"),
        rules=dict(vcp=setups.VCP, htf=setups.HTF), setups=found), separators=(",", ":"), default=float))
    log.info("setups: %d found", len(found))
    return found


def write_rotation(res, snap: pd.DataFrame, idx_panel=None):
    """Sector rotation (RRG) data for each grouping level, against the Nifty 500 (or all stocks)."""
    bench, bench_name = None, "all tracked stocks (equal weight)"
    if idx_panel is not None and len(idx_panel):
        b = indices.col(indices.wide(idx_panel), "Nifty 500")
        if b is not None and b.notna().sum() > 100:
            bench, bench_name = b, "Nifty 500"
    if bench is None:
        bench = (1 + res.close.pct_change(fill_method=None).clip(-0.5, 1.0).mean(axis=1).fillna(0)).cumprod() * 100
    out = {"benchmark": bench_name, "levels": {}}
    for lvl in config.GROUP_LEVELS:
        gi = group_index(res.close, snap[lvl])
        if gi.shape[1]:
            out["levels"][lvl] = rrg(gi, bench)
    (config.OUT / "rrg.json").write_text(json.dumps(out, separators=(",", ":")))
    return out


def write_breadth(res, idx_panel=None):
    """Market breadth for all tracked stocks and for the Nifty 500, plus the rotation signal."""
    out = {"all": breadth.compute(res.close, res.stage, list(res.close.columns))}
    n500 = indices.members("nifty500")
    if n500:
        out["nifty500"] = breadth.compute(res.close, res.stage, n500)
    out["rotation"] = breadth.rotation(idx_panel)
    (config.OUT / "breadth.json").write_text(json.dumps(out, separators=(",", ":")))
    b = out["all"]["latest"]
    log.info("breadth: score %s (%s), A/D %s/%s, highs %s lows %s", b["score"], b["label"], b["adv"], b["dec"], b["nh"], b["nl"])
    return out


def write_outputs(res, snap: pd.DataFrame):
    out = config.OUT
    out.mkdir(parents=True, exist_ok=True)
    day = res.close.index[-1].date().isoformat()
    snap = snap.copy()
    snap["file"] = [_safe(k) for k in snap.index]
    s = snap.reset_index()
    s["s2_entry_date"] = pd.to_datetime(s["s2_entry_date"]).dt.strftime("%Y-%m-%d")
    s["stage"] = s["stage"].astype("Int64")
    s.to_json(out / "stocks.json", orient="records", date_format="iso", double_precision=2)

    groups = {}
    for lvl in config.GROUP_LEVELS:
        for per, col, hist in (("12m", "rs12", res.rs12), ("3m", "rs3", res.rs3)):
            g = group_stats(snap, lvl, hist, col)
            g.to_json(out / f"groups_{lvl}_{per}.json", orient="records", double_precision=2)
            groups[f"{lvl}_{per}"] = len(g)

    weekly_stage = res.stage.resample("W-FRI").last()
    ep = stage2_episodes(weekly_stage, res.close.resample("W-FRI").last())
    if len(ep):
        ep["entry"], ep["exit"] = ep["entry"].astype(str), ep["exit"].astype(str)
        ep = ep[ep["weeks"] >= 2]          # one-week blips are noise, not episodes
    ep.to_json(out / "stage2_episodes.json", orient="records")

    dist = snap["stage"].value_counts().sort_index()
    today, prev = res.stage.iloc[-1], res.stage.iloc[-2]
    entered = list(snap.index[(today == 2) & (prev != 2)])
    exited = list(snap.index[(today != 2) & (prev == 2)])
    wk = (res.rs12.iloc[-1] - res.rs12.iloc[-6]).dropna().sort_values()
    hist_counts = res.stage.tail(260).apply(lambda r: r.value_counts(), axis=1).fillna(0).astype(int)
    hist_counts.index = hist_counts.index.strftime("%Y-%m-%d")
    hist_counts.columns = [str(int(c)) for c in hist_counts.columns]
    hist_counts.to_json(out / "stage_history.json", orient="index")
    summary = dict(
        date=day, tracked=int(snap["rs12"].notna().sum()), universe=len(snap),
        stage_counts={int(k): int(v) for k, v in dist.items()},
        stage2=int((snap["stage"] == 2).sum()), candidates=int(snap["candidate"].sum()),
        entered_stage2=entered, exited_stage2=exited,
        rs_gainers_week=[dict(key=k, change=float(v)) for k, v in wk.tail(15)[::-1].items()],
        rs_losers_week=[dict(key=k, change=float(v)) for k, v in wk.head(15).items()],
        groups=groups,
    )
    (out / "summary.json").write_text(json.dumps(summary, indent=1))

    hist = config.HISTORY / f"{day}.parquet"          # Time Machine snapshots
    hist.parent.mkdir(parents=True, exist_ok=True)
    snap.to_parquet(hist)
    log.info("wrote outputs for %s: %d stocks, %d in Stage 2", day, len(snap), summary["stage2"])
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--classify", action="store_true", help="refresh industry classification now (otherwise monthly)")
    ap.add_argument("--days", type=int, default=None, help="history to backfill (trading days)")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

    panel = store.update(days=a.days)
    if not len(panel):
        raise SystemExit("No price data could be downloaded.")
    p = store.adjusted(panel)
    res = compute(p)
    universe.refresh(res.snapshot, force=a.classify)   # cached for 30 days
    snap = universe.attach(res.snapshot)
    summary = write_outputs(res, snap)
    write_series(res, p)
    write_sparks(res)
    try:
        idx_panel = indices.update(days=a.days)
    except Exception as e:  # noqa: BLE001 - index data is optional
        log.warning("index files unavailable (%s); rotation signal skipped", e)
        idx_panel = None
    write_breadth(res, idx_panel)
    write_rotation(res, snap, idx_panel)
    write_setups(res, p)
    print(json.dumps({k: v for k, v in summary.items() if not k.startswith("rs_")}, indent=1, default=str))


if __name__ == "__main__":
    main()
