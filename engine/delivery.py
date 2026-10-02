"""NSE delivery and trade-count history for the Screener page (Match Score, PDV_Persist+Mom).

Source: NSE "Full Bhavcopy and Security Deliverable Data", one CSV per trading day:
  https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv
It is the same file Accumulation Lab reads, and it is read the same way (engine.mjs normalizeRows):
  symbol, series, date, prevClose, open, high, low, close (CLOSE_PRICE), volume (TTL_TRD_QNTY),
  delivery (DELIV_QTY), trades (NO_OF_TRADES), turnover in rupees (TURNOVER_LACS x 1e5).
Prices here are the exchange's own, unadjusted, exactly as Accumulation Lab uses them.

Only equity-like series are kept (config.NSE_SERIES, never BL). Accumulation Lab keeps every series;
this is the one known difference and it only affects non-equity lines such as bonds.
"""
from __future__ import annotations

import io
import logging
import time
from datetime import date

import pandas as pd
import requests

from . import config

log = logging.getLogger(__name__)

URL = "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{d:%d%m%Y}.csv"
FILE = config.DATA / "delivery.parquet"
KEEP_SESSIONS = 300          # Accumulation Lab keeps about one year (~267 sessions); a little extra for SMA(45)
BACKFILL_SESSIONS = 270      # how far back to fill when sessions are missing
SERIES = set(config.NSE_SERIES)
COLS = ["date", "symbol", "series", "prevClose", "open", "high", "low", "close",
        "volume", "delivery", "trades", "turnover"]

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/127.0 Safari/537.36")


def _num(s: pd.Series) -> pd.Series:
    """Same as Accumulation Lab's `numeric`: blank or '-' is missing, commas removed."""
    t = s.astype(str).str.replace(",", "", regex=False).str.strip()
    return pd.to_numeric(t.where(~t.isin(["", "-", "nan", "None"])), errors="coerce")


def parse(text: str, expect: date) -> pd.DataFrame:
    df = pd.read_csv(io.StringIO(text.lstrip("﻿")), dtype=str, skipinitialspace=True)
    df.columns = [c.strip().upper() for c in df.columns]
    need = {"SYMBOL", "SERIES", "DATE1", "PREV_CLOSE", "OPEN_PRICE", "HIGH_PRICE", "LOW_PRICE",
            "CLOSE_PRICE", "TTL_TRD_QNTY", "TURNOVER_LACS", "NO_OF_TRADES", "DELIV_QTY"}
    missing = need - set(df.columns)
    if missing:
        raise ValueError(f"unexpected columns, missing {sorted(missing)}")
    for c in df.columns:
        df[c] = df[c].astype(str).str.strip()
    out = pd.DataFrame({
        "date": pd.to_datetime(df["DATE1"], format="%d-%b-%Y"),
        "symbol": df["SYMBOL"].str.upper(), "series": df["SERIES"].str.upper(),
        "prevClose": _num(df["PREV_CLOSE"]), "open": _num(df["OPEN_PRICE"]), "high": _num(df["HIGH_PRICE"]),
        "low": _num(df["LOW_PRICE"]), "close": _num(df["CLOSE_PRICE"]), "volume": _num(df["TTL_TRD_QNTY"]),
        "delivery": _num(df["DELIV_QTY"]), "trades": _num(df["NO_OF_TRADES"]),
        "turnover": _num(df["TURNOVER_LACS"]) * 100000,
    })
    if not len(out) or (out["date"].dt.date != expect).any():
        raise ValueError("file is empty or has an unexpected date")
    return out[out["series"].isin(SERIES)][COLS]


def load() -> pd.DataFrame:
    if FILE.exists():
        return pd.read_parquet(FILE)
    return pd.DataFrame(columns=COLS)


def update(sessions: list[date]) -> pd.DataFrame:
    """Fill every missing session from `sessions` (the trading days Stage Lab already has)."""
    panel = load()
    have = set(panel["date"].dt.date) if len(panel) else set()
    want = sorted(sessions)[-BACKFILL_SESSIONS:]
    todo = [d for d in want if d not in have]
    log.info("delivery: %d sessions stored, %d to download", len(have), len(todo))
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "text/csv,*/*", "Referer": "https://www.nseindia.com/"})
    new, fails, streak = [], [], 0
    for d in todo:
        day = None
        for attempt in range(3):
            try:
                r = s.get(URL.format(d=d), timeout=30)
                if r.status_code == 200 and r.text.lstrip("﻿").startswith("SYMBOL"):
                    day = parse(r.text, d)
                    break
                if r.status_code == 404:
                    break
            except (requests.RequestException, ValueError) as e:
                log.warning("delivery %s: %s", d, e)
            time.sleep(2 * (attempt + 1))
        time.sleep(0.6)
        if day is None:
            fails.append(d)
            streak += 1
            if streak >= 8:          # NSE is refusing us; keep what we have and try next run
                log.warning("delivery: %d failures in a row, stopping this run", streak)
                break
            continue
        streak = 0
        new.append(day)
    if new:
        panel = pd.concat([panel, *new], ignore_index=True) if len(panel) else pd.concat(new, ignore_index=True)
        panel = panel.drop_duplicates(["date", "symbol", "series"], keep="last")
        keep = sorted(panel["date"].unique())[-KEEP_SESSIONS:]
        panel = panel[panel["date"].isin(keep)].sort_values(["symbol", "date", "series"]).reset_index(drop=True)
        FILE.parent.mkdir(parents=True, exist_ok=True)
        panel.to_parquet(FILE, index=False)
    log.info("delivery: added %d sessions, %d unavailable%s", len(new), len(fails),
             f" (latest miss {fails[-1]})" if fails else "")
    return panel
