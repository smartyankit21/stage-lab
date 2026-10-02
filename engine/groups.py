"""Industry / sector group statistics (Industries Explorer, rankings, RS movers)."""
from __future__ import annotations

import pandas as pd


def group_stats(snap: pd.DataFrame, level: str, rs_hist: pd.DataFrame | None = None,
                rs_col: str = "rs12") -> pd.DataFrame:
    """snap: one row per stock (index=key) with stage, rs12, rs3, and the `level` column.
    rs_hist: dates x stocks RS percentile, used for week-on-week / 5-week change.
    """
    snap = snap[snap[level] != "Unclassified"]
    g = snap.groupby(level)
    out = pd.DataFrame({
        "total_stocks": g.size(),
        "stage2_pct": g["stage"].apply(lambda s: round((s == 2).mean() * 100, 2)),
        "avg_rs": g[rs_col].mean().round(2),
        "median_rs": g[rs_col].median(),
    })
    if rs_hist is not None and len(rs_hist) > 25:
        members = snap[level]
        def avg_at(i):
            row = rs_hist.iloc[i].reindex(members.index)
            return row.groupby(members).mean()
        now = avg_at(-1)
        out["rs_change_wow"] = (now - avg_at(-6)).round(2)
        out["rs_change_5w"] = (now - avg_at(-26)).round(2)
    out = out.sort_values("avg_rs", ascending=False)
    out["rank"] = range(1, len(out) + 1)
    out["total_groups"] = len(out)
    return out.reset_index().rename(columns={level: "name"})


def group_index(close: pd.DataFrame, members: pd.Series, min_stocks: int = 3) -> pd.DataFrame:
    """Equal-weight price index per group (dates x group), starting at 100.

    Uses each day's average return of the group's stocks, so one big stock can't dominate
    and stocks that list later join without a jump.
    """
    ret = close.pct_change(fill_method=None).clip(-0.5, 1.0)        # guard against bad ticks
    grp = members.reindex(close.columns)
    counts = grp.value_counts()
    keep = counts[counts >= min_stocks].index.difference(["Unclassified"])
    daily = ret.T.groupby(grp).mean().T[keep]
    return (1 + daily.fillna(0)).cumprod() * 100


def rrg(group_idx: pd.DataFrame, bench: pd.Series, trail: int = 5, ratio_weeks: int = 13,
        mom_weeks: int = 4) -> list[dict]:
    """Relative Rotation Graph points: weekly, the latest `trail`+1 positions per group.

    RS score (x)    = 100 x (group / benchmark) / its own 13-week average
                      above 100 -> outperforming the market lately
    RS momentum (y) = 100 x RS score / RS score 4 weeks earlier
                      above 100 -> that outperformance is growing
    Quadrants: Leading (x>100, y>100), Weakening (x>100, y<100),
               Lagging (x<100, y<100), Improving (x<100, y>100).
    The current week uses the latest close (week to date).
    """
    wk_g = group_idx.resample("W-FRI").last()
    wk_b = bench.reindex(group_idx.index).ffill().resample("W-FRI").last()
    rs = wk_g.div(wk_b, axis=0)
    x = 100 * rs / rs.rolling(ratio_weeks).mean()
    y = 100 * x / x.shift(mom_weeks)
    out = []
    for g in group_idx.columns:
        pts = pd.DataFrame({"x": x[g], "y": y[g]}).dropna().tail(trail + 1)
        if len(pts) < 2:
            continue
        lx, ly = pts["x"].iloc[-1], pts["y"].iloc[-1]
        quad = ("Leading" if ly >= 100 else "Weakening") if lx >= 100 else ("Improving" if ly >= 100 else "Lagging")
        px, py = pts["x"].iloc[-2], pts["y"].iloc[-2]
        prev = ("Leading" if py >= 100 else "Weakening") if px >= 100 else ("Improving" if py >= 100 else "Lagging")
        out.append(dict(name=g, quadrant=quad, prev_quadrant=prev,
                        trail=[[round(float(a), 2), round(float(b), 2)] for a, b in zip(pts["x"], pts["y"])],
                        weeks=[d.strftime("%Y-%m-%d") for d in pts.index]))
    return out
