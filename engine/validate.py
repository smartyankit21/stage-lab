"""Compare the engine with the reference snapshot (kept locally, not in the repo) and pick the best settings.

    python -m engine.validate            # needs prices downloaded up to 2026-10-01

Writes data/validation_report.md and data/best_settings.json.
"""
from __future__ import annotations

import itertools
import json
import logging

import numpy as np
import pandas as pd

from . import config, store
from .compute import compute

REF = config.ROOT / "reference" / "2026-10-01" / "stocks_universe.csv"
REF_DATE = pd.Timestamp("2026-10-01")


def _err(a, b):
    m = a.notna() & b.notna()
    d = (a[m] - b[m])
    return dict(n=int(m.sum()), mae=round(float(d.abs().mean()), 2),
                within3=round(float((d.abs() <= 3).mean() * 100), 1),
                corr=round(float(np.corrcoef(a[m], b[m])[0, 1]), 4))


def _relerr(a, b):
    m = a.notna() & b.notna() & (b != 0)
    r = ((a[m] / b[m]) - 1).abs()
    return dict(n=int(m.sum()), median_pct=round(float(r.median() * 100), 3),
                within_0_5pct=round(float((r <= 0.005).mean() * 100), 1))


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ref = pd.read_csv(REF)
    ref["symbol"] = ref["symbol"].str.replace("_", "-", regex=False)   # the reference writes BAJAJ-AUTO as BAJAJ_AUTO
    ref = ref.set_index("symbol")
    p = store.adjusted(store.load_raw())
    p = p[p["date"] <= REF_DATE]
    if not len(p) or p["date"].max() < REF_DATE:
        raise SystemExit(f"Need prices up to {REF_DATE.date()} (have {p['date'].max() if len(p) else 'none'}).")
    have = set(p["key"])
    uni = [k for k in ref.index if k in have]
    lines = [f"# Validation vs reference ({REF_DATE.date()})", "",
             f"Reference stocks: {len(ref)}, found in downloaded data: {len(uni)} "
             f"({len(uni)/len(ref)*100:.1f}%)", ""]
    missing = [k for k in ref.index if k not in have]
    if missing:
        lines += [f"Missing examples: {', '.join(missing[:15])}", ""]

    # --- 1. data alignment: moving averages and 52-week range --------------------
    lines.append("## Moving averages and 52-week range (checks data + weekly convention)")
    for partial, hl in itertools.product([True, False], ["close", "high_low"]):
        r = compute(p, dict(universe=uni, stage=dict(use_partial_week=partial, high_low_from=hl)))
        s = r.snapshot.reindex(uni)
        stats = {c: _relerr(s[c], ref.loc[uni, c]) for c in ["wma10", "wma30", "wma40"]}
        stats["h52"] = _relerr(s["h52"], ref.loc[uni, "h52"])
        stats["l52"] = _relerr(s["l52"], ref.loc[uni, "l52"])
        stats["price"] = _relerr(s["close"], ref.loc[uni, "price"])
        lines.append(f"- partial_week={partial}, 52w from {hl}: " +
                     ", ".join(f"{k} median err {v['median_pct']}% ({v['within_0_5pct']}% within 0.5%)" for k, v in stats.items()))
    lines.append("")

    # --- 2. RS -------------------------------------------------------------------
    lines.append("## Relative Strength")
    best_rs = None
    for mode, scale in itertools.product(["quarterly", "cumulative"], ["round", "1-100"]):
        r = compute(p, dict(universe=uni, rs_mode=mode, rs_scale=scale))
        s = r.snapshot.reindex(uni)
        e12, e3 = _err(s["rs12"], ref.loc[uni, "rs12"]), _err(s["rs3"], ref.loc[uni, "rs3"])
        lines.append(f"- {mode}, {scale}: RS12 MAE {e12['mae']} ({e12['within3']}% within ±3, corr {e12['corr']}); "
                     f"RS3 MAE {e3['mae']} ({e3['within3']}% within ±3, corr {e3['corr']})")
        if best_rs is None or e12["mae"] + e3["mae"] < best_rs[0]:
            best_rs = (e12["mae"] + e3["mae"], mode, scale)
    lines.append("")

    # --- 3. Stage grid -----------------------------------------------------------
    lines.append("## Stage classification")
    ref_stage = ref.loc[uni, "stage"].rename_axis("key")
    ref_s2 = ref_stage == 2
    results = []
    grid = itertools.product([2, 3, 4, 5, 6], [True], [1.1, 1.15, 1.2, 1.25], [0.75, 0.78, 0.8])
    for slope, partial, lo, hi in grid:
        st = dict(slope_weeks=slope, use_partial_week=partial, min_close_vs_low52=lo,
                  min_close_vs_high52=hi, high_low_from="close", min_rs=0)
        r = compute(p, dict(universe=uni, rs_mode=best_rs[1], rs_scale=best_rs[2], stage=st))
        s = r.snapshot.reindex(uni)
        s2 = s["stage"] == 2
        tp, fp, fn = int((s2 & ref_s2).sum()), int((s2 & ~ref_s2).sum()), int((~s2 & ref_s2).sum())
        acc = float((s["stage"] == ref_stage).mean())
        results.append(dict(slope_weeks=slope, use_partial_week=partial, min_close_vs_low52=lo,
                            min_close_vs_high52=hi, s2_tp=tp, s2_fp=fp, s2_fn=fn,
                            s2_errors=fp + fn, stage_accuracy=round(acc * 100, 1)))
    res = pd.DataFrame(results).sort_values(["s2_errors", "stage_accuracy"], ascending=[True, False])
    lines.append(res.head(10).to_markdown(index=False))
    best = res.iloc[0].to_dict()

    # candidate threshold
    st = {k: best[k] for k in ["slope_weeks", "use_partial_week", "min_close_vs_low52", "min_close_vs_high52"]}
    lines += ["", "## Stage 2 Candidate threshold"]
    for cm in (5, 6, 7):
        r = compute(p, dict(universe=uni, rs_mode=best_rs[1], rs_scale=best_rs[2], stage=st, cand_min=cm))
        s = r.snapshot.reindex(uni)
        agree = float((s["candidate"].astype(bool) == ref.loc[uni, "cand"].astype(bool)).mean())
        lines.append(f"- {cm}+ of 8 rules: candidate agreement {agree*100:.1f}% "
                     f"(ours {int(s['candidate'].sum())} vs reference {int(ref.loc[uni,'cand'].sum())})")

    r = compute(p, dict(universe=uni, rs_mode=best_rs[1], rs_scale=best_rs[2], stage=st))
    s = r.snapshot.reindex(uni)
    lines += ["", "## Confusion matrix (rows = reference, cols = ours)",
              pd.crosstab(ref_stage, s["stage"]).to_markdown()]
    mask = s["stage"].eq(2).to_numpy() != ref_s2.to_numpy()
    wrong = s[mask].copy()
    wrong["wl_stage"] = ref_stage.to_numpy()[mask]
    rule_cols = [c for c in s.columns if c.startswith("rule_")]
    lines += ["", "## Stage 2 disagreements (first 25)", wrong[["wl_stage", "stage", "rules_met", *rule_cols]].head(25).to_markdown()]

    (config.DATA / "validation_report.md").write_text("\n".join(lines))
    best_settings = dict(rs_mode=best_rs[1], rs_scale=best_rs[2], stage=st)
    (config.DATA / "best_settings.json").write_text(json.dumps(best_settings, indent=1, default=str))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
