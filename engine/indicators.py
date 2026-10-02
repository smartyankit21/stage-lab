"""Relative Strength, weekly moving averages, 52-week range and Stage classification."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config


# ---------------------------------------------------------------- RS --------
def rs_score(close: pd.DataFrame, windows, weights=config.RS_WEIGHTS, mode=None) -> pd.DataFrame:
    """Weighted return score for every date x stock (NaN when history is too short)."""
    mode = mode or config.RS_MODE
    score = 0
    for i, (n, w) in enumerate(zip(windows, weights)):
        if mode == "cumulative":
            r = close / close.shift(n) - 1
        else:  # "quarterly": return of the i-th slice only
            prev = windows[i - 1] if i else 0
            r = close.shift(prev) / close.shift(n) - 1
        score = score + w * r
    return score.where(close.shift(max(windows)).notna())


def to_percentile(score: pd.DataFrame, scale=None) -> pd.DataFrame:
    scale = scale or config.RS_SCALE
    pct = score.rank(axis=1, pct=True)          # (0, 1]
    if scale == "1-99":
        return (pct * 98 + 1).round()
    if scale == "round":
        return (pct * 100).round().clip(1, 100)
    return np.ceil(pct * 100).clip(1, 100)


def rs_table(close: pd.DataFrame, mode=None, scale=None) -> dict[str, pd.DataFrame]:
    return {
        "rs12": to_percentile(rs_score(close, config.RS_12M_WINDOWS, mode=mode), scale),
        "rs3": to_percentile(rs_score(close, config.RS_3M_WINDOWS, mode=mode), scale),
    }


# ------------------------------------------------------- weekly MAs ---------
def _week_label(idx: pd.DatetimeIndex) -> pd.DatetimeIndex:
    """Friday that ends each day's week."""
    return idx + pd.to_timedelta((4 - idx.weekday) % 7, unit="D")


def weekly_mas(close: pd.DataFrame, partial: bool | None = None,
               slope_weeks: int | None = None, mode: str | None = None) -> dict[str, pd.DataFrame]:
    """The '10/30/40-week' averages.

    mode="daily" (matches the reference snapshot): 50/150/200-day
    simple averages of daily closes. mode="weekly": true weekly closes.
    The slope check compares the long average with its value `slope_weeks` weeks ago.
    """
    mode = mode or config.STAGE.get("ma_mode", "daily")
    partial = config.STAGE["use_partial_week"] if partial is None else partial
    slope_weeks = slope_weeks or config.STAGE["slope_weeks"]
    out = {}
    if mode == "daily":
        for n, key in ((50, "wma10"), (150, "wma30"), (200, "wma40")):
            out[key] = close.rolling(n).mean()
        out["wma40_prev"] = out["wma40"].shift(5 * slope_weeks)
        return out
    wk = close.resample("W-FRI").last()                     # Friday-labelled weekly closes
    lab = _week_label(close.index)
    for n in (10, 30, 40):
        if partial:
            prev_sum = wk.shift(1).rolling(n - 1).sum()     # n-1 completed weeks before this week
            prev = prev_sum.reindex(lab).set_axis(close.index)
            out[f"wma{n}"] = (prev + close) / n
        else:
            done = wk.shift(1).rolling(n).mean()
            out[f"wma{n}"] = done.reindex(lab).set_axis(close.index)
    sma40 = wk.rolling(40).mean()
    out["wma40_prev"] = sma40.shift(slope_weeks).reindex(lab).set_axis(close.index)
    return out


def range52(close, high=None, low=None, src=None):
    src = src or config.STAGE["high_low_from"]
    if src == "high_low" and high is not None:
        return high.rolling(252, min_periods=200).max(), low.rolling(252, min_periods=200).min()
    return close.rolling(252, min_periods=200).max(), close.rolling(252, min_periods=200).min()


# ------------------------------------------------------------ Stage ---------
RULES = ["c>10w", "c>30w", "c>40w", "30w>=40w", "40w rising", "off_low", "near_high", "rs"]


def stage_rules(c, m, h52, l52, rs, p=None) -> dict[str, pd.DataFrame]:
    p = p or config.STAGE
    return {
        "c>10w": c >= m["wma10"],
        "c>30w": c > m["wma30"],
        "c>40w": c > m["wma40"],
        "30w>=40w": m["wma30"] >= m["wma40"],
        "40w rising": m["wma40"] > m["wma40_prev"],
        "off_low": c >= p["min_close_vs_low52"] * l52,
        "near_high": c >= p["min_close_vs_high52"] * h52,
        "rs": rs.fillna(0) >= p["min_rs"],
    }


def classify(c, m, rules: dict, cand_min: int | None = None):
    """Returns (stage 1-4, candidate flag, rules-met count) for every date x stock.

    Stage 2 = all 8 rules. Other stages follow the moving-average structure
    (fitted to a reference snapshot, ~90% agreement):
      long average falling: 50<150 -> Stage 4 if price < 200d else 3;  50>150 -> Stage 1 if 150<200 else 3
      long average rising : 150<200 -> Stage 3 if price well below 150d else 1;  otherwise Stage 3
    Candidate = not Stage 2, price above the 150 and 200-day averages, near the high and
    well off the low, missing only 'pullback' rules (price < 50d, 150 < 200, 200d flat),
    at least `cand_min` of 8 rules met.
    """
    cand_min = cand_min or config.CANDIDATE_MIN_RULES
    met = sum(r.astype(int) for r in rules.values())
    s2 = met == len(rules)
    core = rules["c>30w"] & rules["c>40w"] & rules["off_low"] & rules["near_high"] & rules["rs"]
    cand = (~s2) & core & (met >= cand_min)
    rising = m["wma40"] > m["wma40_prev"]
    m50_150 = m["wma10"] / m["wma30"]
    m150_200 = m["wma30"] / m["wma40"]
    c150 = c / m["wma30"]
    falling_stage = np.where(m50_150 <= 1.01, np.where(c <= 0.99 * m["wma40"], 4, 3),
                             np.where(m150_200 <= 1.0, 1, 3))
    rising_stage = np.where(m150_200 <= 1.0, np.where(c150 <= 0.97, 3, 1), 3)
    stage = pd.DataFrame(np.where(rising, rising_stage, falling_stage), index=c.index, columns=c.columns, dtype=float)
    valid = m["wma40_prev"].notna()
    stage = stage.mask(s2, 2).where(valid)
    return stage, cand & valid, met


def stage2_runs(stage: pd.DataFrame, close: pd.DataFrame):
    """Entry date and entry close of the current Stage 2 run, per stock (latest day)."""
    in2 = stage.eq(2).to_numpy()
    idx = stage.index
    entry_i = np.full(stage.shape[1], -1)
    for i in range(len(idx)):
        entry_i = np.where(in2[i], np.where(entry_i < 0, i, entry_i), -1)
    last = stage.columns
    entry_date = pd.Series([idx[i] if i >= 0 else pd.NaT for i in entry_i], index=last)
    entry_px = pd.Series([close.iloc[i, j] if i >= 0 else np.nan for j, i in enumerate(entry_i)], index=last)
    days = (idx[-1] - entry_date).dt.days
    return entry_date, entry_px, days


def stage2_episodes(stage: pd.DataFrame, close: pd.DataFrame) -> pd.DataFrame:
    """Every completed Stage 2 run: entry, exit, weeks, peak % (Episode Ledger)."""
    rows = []
    for k in stage.columns:
        s = stage[k].eq(2)
        if not s.any():
            continue
        grp = (s != s.shift()).cumsum()
        for _, seg in s[s].groupby(grp[s]):
            start, end = seg.index[0], seg.index[-1]
            after = stage.index[stage.index > end]
            if not len(after):        # still running -> not completed
                continue
            px = close.loc[start:end, k]
            entry = px.iloc[0]
            peak_i = px.idxmax()
            rows.append(dict(symbol=k, entry=start.date(), exit=after[0].date(),
                             weeks=round((after[0] - start).days / 7, 1),
                             peak_pct=round((px.max() / entry - 1) * 100, 1),
                             weeks_to_peak=round((peak_i - start).days / 7, 1)))
    return pd.DataFrame(rows)
