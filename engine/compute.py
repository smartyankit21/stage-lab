"""Turn the adjusted price panel into every metric the screens need."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import config
from . import indicators as ind
from .store import wide


@dataclass
class Result:
    snapshot: pd.DataFrame          # one row per stock, latest day
    close: pd.DataFrame
    rs12: pd.DataFrame
    rs3: pd.DataFrame
    stage: pd.DataFrame


def liquid_universe(turnover: pd.DataFrame, close: pd.DataFrame) -> list[str]:
    med = (turnover.tail(20).median() / 1e7)
    alive = close.iloc[-1].notna() & close.tail(5).notna().any()
    return list(med[(med >= config.MIN_MEDIAN_TURNOVER_CR) & alive].index)


def compute(p: pd.DataFrame, overrides: dict | None = None) -> Result:
    o = overrides or {}
    close, high, low = wide(p, "close"), wide(p, "high"), wide(p, "low")
    turnover = wide(p, "turnover")
    keys = o.get("universe") or liquid_universe(turnover, close)
    close, high, low = close[keys], high[keys], low[keys]
    close = close.ffill(limit=5)        # brief suspensions / holidays on one exchange

    rs = ind.rs_table(close, mode=o.get("rs_mode"), scale=o.get("rs_scale"))
    stage_p = {**config.STAGE, **o.get("stage", {})}
    m = ind.weekly_mas(close, partial=stage_p["use_partial_week"], slope_weeks=stage_p["slope_weeks"],
                      mode=stage_p.get("ma_mode"))
    h52, l52 = ind.range52(close, high, low, stage_p["high_low_from"])
    rules = ind.stage_rules(close, m, h52, l52, rs["rs12"], stage_p)
    stage, cand, met = ind.classify(close, m, rules, o.get("cand_min"))
    entry_date, entry_px, days = ind.stage2_runs(stage, close)

    last = close.index[-1]
    info = p.sort_values("date").groupby("key")[["name", "isin", "exchange"]].last()
    snap = pd.DataFrame({
        "close": close.loc[last],
        "chg_pct": (close.loc[last] / close.iloc[-2] - 1) * 100,
        "stage": stage.loc[last],
        "candidate": cand.loc[last],
        "rules_met": met.loc[last],
        "rs12": rs["rs12"].loc[last],
        "rs3": rs["rs3"].loc[last],
        "rs12_d1": rs["rs12"].loc[last] - rs["rs12"].iloc[-2],
        "rs12_d7": rs["rs12"].loc[last] - rs["rs12"].iloc[-6],
        "rs12_d30": rs["rs12"].loc[last] - rs["rs12"].iloc[-22],
        "wma10": m["wma10"].loc[last], "wma30": m["wma30"].loc[last], "wma40": m["wma40"].loc[last],
        "h52": h52.loc[last], "l52": l52.loc[last],
        "s2_entry_date": entry_date, "s2_entry_price": entry_px, "days_in_s2": days,
        "turnover_cr": turnover[keys].tail(20).median() / 1e7,
    }).join(info)
    for r, frame in rules.items():
        snap["rule_" + r] = frame.loc[last]
    snap.index.name = "key"
    return Result(snap, close, rs["rs12"], rs["rs3"], stage)
