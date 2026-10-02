"""Market breadth: how many stocks are taking part in a move.

Per trading day, for a universe of stocks:
  advancers / decliners, A/D ratio, cumulative A/D line
  new 52-week highs / lows (close above/below the prior 251-day closing range)
  % of stocks above their 50, 100 and 200-day averages
  sharp moves: up/down 4%+ in a day, up/down 10%+ over 5 days
  % of stocks in Stage 2
  health score 0-100

Health score (our own weighting of three standard inputs):
  equal-weight average of three 0-100 parts
    A/D part     = advancers / (advancers + decliners) x 100
    Highs part   = 50 + 50 x (new highs - new lows) / (new highs + new lows)
    Average part = mean of % above 50, 100 and 200-day averages
  60 and above = bullish, 40 and below = bearish, between = neutral.

Rotation signal: Nifty MidSmallcap 400 / Nifty 100 against its own 200-day average.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import indices

DAYS = 252


def _r(x, d=2):
    return None if x is None or pd.isna(x) else round(float(x), d)


def health_parts(adv, dec, nh, nl, ma_avg):
    ad_part = np.where(adv + dec > 0, adv / np.maximum(adv + dec, 1) * 100, 50)
    hl_part = np.where(nh + nl > 0, 50 + 50 * (nh - nl) / np.maximum(nh + nl, 1), 50)
    score = (ad_part + hl_part + ma_avg) / 3
    return ad_part, hl_part, score


def label(score: float) -> str:
    return "Bullish" if score >= 60 else "Bearish" if score <= 40 else "Neutral"


def compute(close: pd.DataFrame, stage: pd.DataFrame, keys: list[str]) -> dict:
    keys = [k for k in keys if k in close.columns]
    c = close[keys]
    chg = c.pct_change(fill_method=None)
    adv, dec = (chg > 0).sum(axis=1), (chg < 0).sum(axis=1)
    prior = c.shift(1)
    hi = prior.rolling(251, min_periods=200).max()
    lo = prior.rolling(251, min_periods=200).min()
    nh, nl = (c > hi).sum(axis=1), (c < lo).sum(axis=1)
    pct = {}
    for n in (50, 100, 200):
        sma = c.rolling(n).mean()
        valid = sma.notna() & c.notna()
        pct[n] = ((c > sma) & valid).sum(axis=1) / valid.sum(axis=1).replace(0, np.nan) * 100
    r5 = c / c.shift(5) - 1
    moves = dict(up4=(chg >= 0.04).sum(axis=1), down4=(chg <= -0.04).sum(axis=1),
                 up10_5d=(r5 >= 0.10).sum(axis=1), down10_5d=(r5 <= -0.10).sum(axis=1))
    st = stage[keys]
    s2pct = (st == 2).sum(axis=1) / st.notna().sum(axis=1).replace(0, np.nan) * 100
    ma_avg = (pct[50] + pct[100] + pct[200]) / 3
    ad_part, hl_part, score = health_parts(adv.to_numpy(), dec.to_numpy(), nh.to_numpy(), nl.to_numpy(), ma_avg.to_numpy())
    df = pd.DataFrame({
        "adv": adv, "dec": dec, "ad_line": (adv - dec).cumsum(), "nh": nh, "nl": nl,
        "above50": pct[50], "above100": pct[100], "above200": pct[200], **moves,
        "stage2_pct": s2pct, "ad_part": ad_part, "hl_part": hl_part, "score": score,
    }, index=c.index)
    df = df[df["above200"].notna()].tail(DAYS)
    df["ad_line"] = df["ad_line"] - df["ad_line"].iloc[0]          # start the line at zero
    last = df.iloc[-1]
    ago = lambda n, k: df[k].iloc[-1 - n] if len(df) > n else np.nan  # noqa: E731
    latest = dict(
        date=df.index[-1].strftime("%Y-%m-%d"), stocks=len(keys),
        adv=int(last["adv"]), dec=int(last["dec"]),
        ad_ratio=_r(last["adv"] / last["dec"]) if last["dec"] else None,
        nh=int(last["nh"]), nl=int(last["nl"]), net_highs=int(last["nh"] - last["nl"]),
        score=_r(last["score"], 0), label=label(last["score"]),
        parts=dict(ad=_r(last["ad_part"], 0), highs=_r(last["hl_part"], 0),
                   averages=_r((last["above50"] + last["above100"] + last["above200"]) / 3, 0)),
        participation={str(n): dict(now=_r(last[f"above{n}"], 1), w1=_r(ago(5, f"above{n}"), 1),
                                    m1=_r(ago(21, f"above{n}"), 1)) for n in (50, 100, 200)},
        moves={k: dict(now=int(last[k]), w1=int(ago(5, k)) if not pd.isna(ago(5, k)) else None) for k in moves},
        stage2_pct=_r(last["stage2_pct"], 1),
    )
    series = {"d": [d.strftime("%Y-%m-%d") for d in df.index]}
    for k in df.columns:
        series[k] = [_r(v, 1) for v in df[k]]
    return dict(latest=latest, series=series)


def rotation(idx_panel: pd.DataFrame) -> dict | None:
    if idx_panel is None or not len(idx_panel):
        return None
    w = indices.wide(idx_panel)
    mid, big = indices.col(w, "Nifty MidSmallcap 400"), indices.col(w, "Nifty 100")
    if mid is None or big is None:
        return None
    ratio = (mid / big).dropna()
    sma = ratio.rolling(200, min_periods=150).mean()
    df = pd.DataFrame({"ratio": ratio, "sma200": sma}).dropna().tail(DAYS)
    if not len(df):
        return None
    above = bool(df["ratio"].iloc[-1] > df["sma200"].iloc[-1])
    flips = (df["ratio"] > df["sma200"]).astype(int).diff().fillna(0) != 0
    since = df.index[flips][-1] if flips.any() else df.index[0]
    return dict(
        leading="Mid and small caps" if above else "Large caps", above=above,
        since=since.strftime("%Y-%m-%d"),
        gap_pct=_r((df["ratio"].iloc[-1] / df["sma200"].iloc[-1] - 1) * 100, 2),
        series={"d": [d.strftime("%Y-%m-%d") for d in df.index],
                "ratio": [_r(v, 4) for v in df["ratio"]], "sma200": [_r(v, 4) for v in df["sma200"]]})
