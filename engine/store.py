"""Price store: keeps the daily panel up to date and applies split/bonus adjustment.

Adjustment trick: on an ex-date the exchange publishes an *adjusted* previous
close. So  factor = prev_close(today) / close(yesterday)  reveals any split,
bonus or rights issue without needing a corporate-actions feed.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

import numpy as np
import pandas as pd

from . import config
from .sources import Fetcher, filter_day, trading_days_back, yfinance_fill

log = logging.getLogger(__name__)


def load_raw() -> pd.DataFrame:
    if config.PRICES.exists():
        return pd.read_parquet(config.PRICES)
    return pd.DataFrame()


CLOSED = config.META / "closed_days.json"


def closed_days() -> set:
    """Weekdays known to have no trading (holidays), so they are never re-requested."""
    import json
    try:
        return {date.fromisoformat(x) for x in json.loads(CLOSED.read_text())}
    except (FileNotFoundError, ValueError):
        return set()


def _save_closed(days: set):
    import json
    CLOSED.parent.mkdir(parents=True, exist_ok=True)
    CLOSED.write_text(json.dumps(sorted(d.isoformat() for d in days)))


def update(end: date | None = None, days: int | None = None) -> pd.DataFrame:
    """Download every missing trading day (self-healing backfill)."""
    end = end or date.today()
    days = days or config.BACKFILL_DAYS
    panel = load_raw()
    have = set(panel["date"].dt.date) if len(panel) else set()
    closed = closed_days()
    f = Fetcher()
    new, failed = [], []
    # calendar span ~ trading days * 7/5 plus holidays
    for d in sorted(trading_days_back(int(days * 1.48), end)):
        if d in have or d in closed:
            continue
        nse = f.nse(d)
        bse = f.bse(d, count_failure=nse is not None)   # a BSE miss only counts when NSE had the day
        if nse is None and bse is None:
            failed.append(d)          # holiday, not yet published, or blocked
            continue
        day = filter_day(nse, bse)
        if len(day):
            new.append(day)
            have.add(d)
            log.info("%s: %d stocks (%s)", d, len(day),
                     "NSE+BSE" if nse is not None and bse is not None else "NSE" if nse is not None else "BSE")
    if new:
        panel = pd.concat([panel, *new], ignore_index=True)
        panel = panel.drop_duplicates(["date", "isin"], keep="last").sort_values(["isin", "date"])
        config.PRICES.parent.mkdir(parents=True, exist_ok=True)
        panel.to_parquet(config.PRICES, index=False)
    # A weekday with no file on either exchange, at least 4 days old, with trading data on a
    # later day, was a market holiday: remember it so later runs don't ask again.
    later = max(have) if have else None
    holidays = {d for d in failed if (end - d).days > 3 and later and d < later}
    if holidays:
        _save_closed(closed | holidays)
        log.info("marked %d market holidays", len(holidays))
    recent_fail = [d for d in failed if (end - d).days <= 3]
    if recent_fail and _looks_blocked(recent_fail, end):
        log.warning("Exchange files unavailable for %s - trying yfinance", recent_fail)
        panel = _yf_patch(panel, min(recent_fail), end)
    return panel


def rebuild_from_raw() -> pd.DataFrame:
    """Re-parse every cached exchange file into the panel (after a format change)."""
    f = Fetcher()
    f._get = lambda *a, **k: None          # cache only, never download
    days = sorted({p.name.split(".")[0] for p in (config.RAW / "nse").glob("*")} |
                  {p.name.split(".")[0] for p in (config.RAW / "bse").glob("*")})
    parts = []
    for d in days:
        dt = date.fromisoformat(d)
        day = filter_day(f.nse(dt), f.bse(dt))
        if len(day):
            parts.append(day)
    panel = pd.concat(parts, ignore_index=True).sort_values(["isin", "date"])
    panel.to_parquet(config.PRICES, index=False)
    return panel


def _looks_blocked(days, end) -> bool:
    # A single missing weekday is usually a holiday; today's file appears ~6-7pm IST.
    return len(days) >= 2


def _yf_patch(panel: pd.DataFrame, start: date, end: date) -> pd.DataFrame:
    if not len(panel):
        return panel
    last = panel.sort_values("date").groupby("isin").tail(1)
    keys = last["key"].tolist()
    y = yfinance_fill(keys, start, end)
    if not len(y):
        return panel
    meta = last.set_index("key")[["isin", "symbol", "name", "series", "exchange"]]
    y = y.join(meta, on="key")
    y["prev_close"] = np.nan        # yfinance is already adjusted
    y["source"] = "yfinance"
    panel = pd.concat([panel, y], ignore_index=True).drop_duplicates(["date", "isin"], keep="first")
    panel.to_parquet(config.PRICES, index=False)
    return panel


def _clean_ratios() -> list[float]:
    r = {b / (a + b) for a in range(1, 11) for b in range(1, 11)}      # bonus a:b
    r |= {1 / n for n in (2, 4, 5, 10, 20, 25, 50, 100)}               # face-value splits
    r |= {x / 2 for x in list(r)} | {x / 5 for x in list(r)}           # split + bonus together
    r = {x for x in r if 0.005 < x < 0.95}
    return sorted(r | {1 / x for x in r if x >= 0.1})                  # consolidations


CLEAN_RATIOS = _clean_ratios()
COMMON_RATIOS = [1/2, 1/3, 1/4, 1/5, 1/10, 2/3, 2/5, 1/20, 2, 5, 10]


def _snap_ratio(jump: float, tol: float, ratios=None) -> float | None:
    """Nearest clean split/bonus ratio to an observed price jump, if within `tol` (relative)."""
    if not np.isfinite(jump) or jump <= 0:
        return None
    best = min(ratios or CLEAN_RATIOS, key=lambda r: abs(np.log(jump / r)))
    return best if abs(jump / best - 1) <= tol else None


def adjusted(panel: pd.DataFrame) -> pd.DataFrame:
    """Return panel with OHLC back-adjusted for splits/bonuses, keyed by latest symbol."""
    p = panel.sort_values("date").copy()
    # One identity per company. A symbol rename keeps the ISIN, so relabel old rows to the
    # ISIN's latest symbol; a face-value split often issues a NEW ISIN but keeps the symbol,
    # so the chain is then followed by symbol.
    latest_key = p.groupby("isin")["key"].last()
    nse_key = p[p["exchange"] == "NSE"].groupby("isin")["key"].last()
    latest_key.update(nse_key)                       # an NSE-listed company keeps its NSE symbol
    p["key"] = p["isin"].map(latest_key)
    p = p.drop_duplicates(["date", "key"], keep="last").sort_values(["key", "date"])
    base = p["close_official"] if "close_official" in p.columns else p["close"]
    prev_close_actual = base.groupby(p["key"]).shift(1)
    factor = (p["prev_close"] / prev_close_actual).where(lambda s: (s - 1).abs() > 0.01, 1.0)
    factor = factor.fillna(1.0)
    # Splits that come with a NEW ISIN are not reflected in prev_close. Detect them from the
    # price jump itself and snap it to the nearest clean split/bonus ratio.
    jump = base / prev_close_actual
    isin_changed = p["isin"].ne(p.groupby("key")["isin"].shift(1)) & prev_close_actual.notna()
    unexplained = (factor == 1.0) & (isin_changed | (jump < 0.55) | (jump > 1.8))
    snapped = pd.Series({i: (_snap_ratio(jump[i], 0.08) if isin_changed[i]
                             else _snap_ratio(jump[i], 0.025, COMMON_RATIOS))
                         for i in jump.index[unexplained]}, dtype=float)
    if len(snapped):
        factor.loc[snapped.index] = snapped.fillna(1.0)
    factor = factor.clip(0.01, 100)
    # cumulative product of all FUTURE factors -> multiply past prices
    rev = factor[::-1].groupby(p["key"][::-1]).cumprod()[::-1]
    future = rev / factor            # exclude today's own factor
    for c in ["open", "high", "low", "close"]:
        p[c] = p[c] * future
    p["volume"] = p["volume"] / future
    latest = p.groupby("key")[["name", "exchange", "series", "isin"]].last()
    p = p.drop(columns=["name", "exchange", "series", "isin"]).join(latest, on="key")
    return p


def wide(p: pd.DataFrame, field: str = "close") -> pd.DataFrame:
    return p.pivot_table(index="date", columns="key", values=field, aggfunc="last").sort_index()
