"""Chart setups: Cup & Handle / VCP and High Tight Flag.

Each pattern is found as of a given day ("forming" if price is still below the
breakout level). Breakouts are found by checking whether a setup that was forming
on one of the last ~25 days has since closed above its breakout level:
  Forming          - pattern in place, price still below the breakout level
  Fresh breakout   - closed above the level within the last 5 sessions, still near/above it
  Continuation     - broke out earlier, still above the level and above the 50-day average

Cup & Handle / VCP rules follow a published screen's default settings:
  base 3-52 weeks, no deeper than 30%; prior run-up of 25%+ into the base;
  at least 2 pullbacks inside the base, the last no deeper than 12% and no more
  than 60% of the deepest one before it; volume in the last pullback below 75% of the
  base average; base volume no more than 1.1x the pre-base average;
  50 > 150 > 200-day averages; price within 30% of the 52-week high and no more
  than 5% below the 50-day average; RS 70+ when the breakout level formed,
  RS 60+ now; median daily turnover Rs 3 crore+.
High Tight Flag (our own rules):
  a 60%+ rise within 40 sessions (the pole), then a 10-30 session pause that
  gives back no more than 25%, RS 70+, turnover Rs 3 crore+.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

VCP = dict(base_min_days=15, base_max_days=260, depth_max=0.30, prior_gain_min=0.25,
           contractions_min=2, last_contraction_max=0.12, c_ratio_max=0.6, vol_ratio_max=0.75, vol_vs_prebase_max=1.10,
           dist_52wh_min=-0.30, close_vs_sma50_min=-0.05, rs_at_pivot_min=70, rs_now_min=60,
           turnover_cr_min=3.0, dist_to_pivot_min=-0.15, swing=0.04)
HTF = dict(pole_gain_min=0.60, pole_max_days=40, flag_min_days=10, flag_max_days=30,
           flag_depth_max=0.25, rs_min=70, turnover_cr_min=3.0, dist_to_pivot_min=-0.15)
LOOKBACK = 25          # days back to look for setups that have since broken out
FRESH_DAYS = 5


def _swings(h: np.ndarray, l: np.ndarray, thr: float):
    """Zig-zag: alternating swing highs/lows that reverse by at least `thr`. Returns [(i, price, 'H'|'L')]."""
    pts, mode = [], None
    hi_i, lo_i = 0, 0
    for i in range(len(h)):
        if h[i] >= h[hi_i]:
            hi_i = i
        if l[i] <= l[lo_i]:
            lo_i = i
        if mode != "down" and l[i] <= h[hi_i] * (1 - thr) and i > hi_i:
            pts.append((hi_i, h[hi_i], "H")); mode = "down"; lo_i = i
        elif mode != "up" and h[i] >= l[lo_i] * (1 + thr) and i > lo_i and mode is not None:
            pts.append((lo_i, l[lo_i], "L")); mode = "up"; hi_i = i
        elif mode is None and h[i] >= l[lo_i] * (1 + thr) and i > lo_i:
            mode = "up"; hi_i = i
    return pts


def vcp_at(t: int, c, h, l, v, s50, s150, s200, rs, p=VCP):
    """Cup & Handle / VCP evaluated on data up to and including index t. Returns dict or None.

    The base can start at any earlier swing high that is (nearly) as high as anything
    since - the left lip of the cup. The longest base that passes every rule wins.
    """
    if t < 260 or np.isnan(s200[t]):
        return None
    if not (s50[t] > s150[t] > s200[t]) or c[t] < s50[t] * (1 + p["close_vs_sma50_min"]):
        return None
    w0 = max(0, t - p["base_max_days"])
    hh = h[w0:t + 1]
    if c[t] < hh.max() * (1 + p["dist_52wh_min"]):
        return None
    run_max = np.maximum.accumulate(hh[::-1])[::-1]            # highest high from each day to today
    lips = sorted({w0 + i for i, _, kind in _swings(hh, l[w0:t + 1], p["swing"]) if kind == "H" and hh[i] >= 0.95 * run_max[i]}
                  | {w0 + int(np.argmax(hh))})
    for start in lips:                                          # farthest first = longest base
        res = _vcp_from(start, t, c, h, l, v, rs, p)
        if res:
            return res
    return None


def _vcp_from(start, t, c, h, l, v, rs, p):
    days = t - start
    if days < p["base_min_days"]:
        return None
    top = h[start]
    depth = 1 - np.min(l[start:t + 1]) / top
    if depth > p["depth_max"]:
        return None
    pre = c[max(0, start - 126):start]
    if not len(pre) or top / np.min(pre) - 1 < p["prior_gain_min"]:
        return None
    sw = [x for x in _swings(h[start:t + 1], l[start:t + 1], p["swing"]) if x[0] > 0]
    sw = [(0, top, "H")] + (sw[1:] if sw and sw[0][2] == "H" and sw[0][0] == 0 else sw)
    clean = [sw[0]]
    for x in sw[1:]:                                            # keep strict H/L alternation
        if x[2] == clean[-1][2]:
            if (x[2] == "H" and x[1] > clean[-1][1]) or (x[2] == "L" and x[1] < clean[-1][1]):
                clean[-1] = x
        else:
            clean.append(x)
    pulls = [(a[0], a[1], b[0], b[1], 1 - b[1] / a[1]) for a, b in zip(clean, clean[1:]) if a[2] == "H"]
    if clean[-1][2] == "H" and clean[-1][0] < days:             # the open pullback from the last swing high
        i0 = clean[-1][0]
        j = i0 + int(np.argmin(l[start + i0:t + 1]))
        d = 1 - l[start + j] / clean[-1][1]
        if d > 0:
            pulls.append((i0, clean[-1][1], j, l[start + j], d))
    if len(pulls) < p["contractions_min"]:
        return None
    depths = [x[4] for x in pulls]
    if depths[-1] > p["last_contraction_max"] or depths[-1] > p["c_ratio_max"] * max(depths[:-1]):
        return None
    piv_i = start + pulls[-1][0]
    pivot = h[piv_i]
    if c[t] < pivot * (1 + p["dist_to_pivot_min"]):
        return None
    base_vol = np.nanmean(v[start:t + 1])
    last_vol = np.nanmean(v[piv_i:t + 1]) if t > piv_i else v[t]
    pre_vol = np.nanmean(v[max(0, start - 50):start])
    if base_vol <= 0 or last_vol / base_vol > p["vol_ratio_max"] or (pre_vol > 0 and base_vol / pre_vol > p["vol_vs_prebase_max"]):
        return None
    if np.isnan(rs[piv_i]) or rs[piv_i] < p["rs_at_pivot_min"] or np.isnan(rs[t]) or rs[t] < p["rs_now_min"]:
        return None
    return dict(pattern="vcp", base_start=start, pivot_i=piv_i, pivot=float(pivot), depth=float(depth),
                contractions=[round(d * 100, 1) for d in depths], base_days=int(days),
                vol_ratio=round(float(last_vol / base_vol), 2), rs_at_pivot=float(rs[piv_i]))


def htf_at(t: int, c, h, l, v, s50, s150, s200, rs, p=HTF):
    """High Tight Flag evaluated on data up to index t."""
    if t < 60:
        return None
    for flag_days in range(p["flag_min_days"], p["flag_max_days"] + 1):
        top_i = t - flag_days
        if top_i < 1 or h[top_i] < np.max(h[top_i:t + 1]):
            continue                                          # flag high must be the pole top
        lo_i = max(0, top_i - p["pole_max_days"])
        base = np.min(l[lo_i:top_i])
        gain = h[top_i] / base - 1
        if gain < p["pole_gain_min"]:
            continue
        depth = 1 - np.min(l[top_i:t + 1]) / h[top_i]
        if depth > p["flag_depth_max"] or np.isnan(rs[t]) or rs[t] < p["rs_min"]:
            continue
        if c[t] < h[top_i] * (1 + p["dist_to_pivot_min"]):
            continue
        return dict(pattern="htf", base_start=top_i, pivot_i=top_i, pivot=float(h[top_i]), depth=float(depth),
                    pole_gain=round(float(gain) * 100, 1), base_days=int(flag_days), contractions=[],
                    vol_ratio=None, rs_at_pivot=float(rs[top_i]) if not np.isnan(rs[top_i]) else None)
    return None


def scan(close: pd.DataFrame, high: pd.DataFrame, low: pd.DataFrame, volume: pd.DataFrame,
         turnover_cr: pd.Series, rs12: pd.DataFrame) -> list[dict]:
    dates = close.index
    s50, s150, s200 = (close.rolling(n).mean() for n in (50, 150, 200))
    out = []
    for k in close.columns:
        if not turnover_cr.get(k, 0) >= min(VCP["turnover_cr_min"], HTF["turnover_cr_min"]):
            continue
        c = close[k].to_numpy(float)
        if np.isnan(c[-1]) or np.isnan(c[-260:]).sum() > 20:
            continue
        h = high[k].fillna(close[k]).to_numpy(float)
        l = low[k].fillna(close[k]).to_numpy(float)
        v = volume[k].fillna(0).to_numpy(float)
        a50, a150, a200 = s50[k].to_numpy(float), s150[k].to_numpy(float), s200[k].to_numpy(float)
        r = rs12[k].to_numpy(float)
        T = len(c) - 1
        for fn in (vcp_at, htf_at):
            found = None
            for back in range(0, LOOKBACK + 1):
                t = T - back
                setup = fn(t, c, h, l, v, a50, a150, a200, r)
                if not setup or c[t] >= setup["pivot"]:
                    continue
                after = np.where(c[t + 1:] > setup["pivot"])[0]
                if back == 0:
                    status = "forming"
                elif not len(after):
                    continue                                   # still forming today -> found at back=0 or no longer valid
                else:
                    bo = t + 1 + after[0]
                    since = T - bo
                    if since < FRESH_DAYS and c[T] >= setup["pivot"] * 0.97:
                        status = "fresh"
                    elif since >= FRESH_DAYS and c[T] > setup["pivot"] and c[T] > a50[T] and c[T] >= np.nanmax(c[-252:]) * 0.80:
                        status = "continuation"
                    else:
                        continue
                    setup["breakout_date"] = dates[bo].strftime("%Y-%m-%d")
                found = dict(setup, status=status, as_of=dates[t].strftime("%Y-%m-%d"))
                break
            if found:
                found.update(key=k, base_start=dates[found["base_start"]].strftime("%Y-%m-%d"),
                             pivot_date=dates[found.pop("pivot_i")].strftime("%Y-%m-%d"),
                             dist_to_pivot=round((c[T] / found["pivot"] - 1) * 100, 2),
                             depth=round(found["depth"] * 100, 1), rs_now=None if np.isnan(r[T]) else float(r[T]),
                             base_weeks=round(found.pop("base_days") / 5, 1))
                out.append(found)
    return out
