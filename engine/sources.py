"""Download daily end-of-day prices with a fallback chain.

Order per trading day:  NSE archive bhavcopy -> BSE bhavcopy -> (yfinance, per symbol, later)
Files are cached in data/raw so a day is only ever downloaded once.
Both exchanges publish the "UDiFF" common format since July 2024.
"""
from __future__ import annotations

import io
import logging
import time
import zipfile
from datetime import date, timedelta

import pandas as pd
import requests

from . import config

log = logging.getLogger(__name__)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/127.0 Safari/537.36")

NSE_URL = "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{d}_F_0000.csv.zip"
BSE_URL = "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{d}_F_0000.CSV"

COLS = {
    "TradDt": "date", "TckrSymb": "symbol", "ISIN": "isin", "SctySrs": "series",
    "FinInstrmNm": "name", "OpnPric": "open", "HghPric": "high", "LwPric": "low",
    "ClsPric": "close_official", "LastPric": "last", "PrvsClsgPric": "prev_close", "TtlTradgVol": "volume",
    "TtlTrfVal": "turnover",
}


class Fetcher:
    def __init__(self, pause: float = 1.0):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "*/*"})
        self.pause = pause
        self.bse_failures = 0

    def _get(self, url: str, referer: str, valid) -> bytes | None:
        """Download, accepting the response only if `valid(content)` says it is a price file."""
        for attempt in range(3):
            try:
                r = self.s.get(url, headers={"Referer": referer}, timeout=30)
                if r.status_code == 200 and valid(r.content):
                    return r.content
                if r.status_code in (403, 404) or r.status_code == 200:
                    return None          # holiday, not published yet, blocked, or an HTML page
            except requests.RequestException:
                pass
            time.sleep(2 * (attempt + 1))
        return None

    def _cached(self, cache, url, referer, valid) -> bytes | None:
        if cache.exists():
            blob = cache.read_bytes()
            if valid(blob):
                return blob
            cache.unlink()               # a bad file from an earlier run
        blob = self._get(url, referer, valid)
        time.sleep(self.pause)
        if blob is not None:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(blob)
        return blob

    def nse(self, d: date) -> pd.DataFrame | None:
        blob = self._cached(config.RAW / "nse" / f"{d:%Y-%m-%d}.csv.zip",
                            NSE_URL.format(d=f"{d:%Y%m%d}"), "https://www.nseindia.com/", _is_zip)
        if blob is None:
            return None
        try:
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                df = pd.read_csv(z.open(z.namelist()[0]))
            return _normalise(df, "NSE")
        except Exception as e:  # noqa: BLE001
            log.warning("NSE file for %s unreadable: %s", d, e)
            return None

    def bse(self, d: date, count_failure: bool = True) -> pd.DataFrame | None:
        if self.bse_failures >= 5:       # BSE keeps refusing -> skip it for this run
            return None
        blob = self._cached(config.RAW / "bse" / f"{d:%Y-%m-%d}.csv",
                            BSE_URL.format(d=f"{d:%Y%m%d}"), "https://www.bseindia.com/", _is_udiff_csv)
        if blob is None:
            self.bse_failures += int(count_failure)
            if self.bse_failures == 5:
                log.warning("BSE files unavailable - continuing with NSE only (BSE-only stocks skipped)")
            return None
        try:
            df = _normalise(pd.read_csv(io.BytesIO(blob)), "BSE")
            self.bse_failures = 0
            return df
        except Exception as e:  # noqa: BLE001
            log.warning("BSE file for %s unreadable: %s", d, e)
            return None


def _is_zip(b: bytes | None) -> bool:
    return bool(b) and b[:2] == b"PK" and len(b) > 1000


def _is_udiff_csv(b: bytes | None) -> bool:
    return bool(b) and b.lstrip(b"\xef\xbb\xbf")[:6] == b"TradDt" and len(b) > 1000


def _normalise(df: pd.DataFrame, exchange: str) -> pd.DataFrame:
    df = df.rename(columns={k: v for k, v in COLS.items() if k in df.columns})
    if "FinInstrmTp" in df.columns:
        df = df[df["FinInstrmTp"].astype(str).str.upper().isin(["STK", "EQ"])]
    keep = [c for c in COLS.values() if c in df.columns]
    df = df[keep].copy()
    df["exchange"] = exchange
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    df["series"] = df["series"].astype(str).str.strip()
    df["symbol"] = df["symbol"].astype(str).str.strip()
    for c in ["open", "high", "low", "close_official", "last", "prev_close", "volume", "turnover"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    # Use the last traded price (matches the reference); the official close is kept for split detection.
    df["close"] = df["last"].where(df["last"] > 0, df["close_official"])
    return df.dropna(subset=["close"])


def filter_day(nse: pd.DataFrame | None, bse: pd.DataFrame | None) -> pd.DataFrame:
    """One row per company (by ISIN): NSE if listed there, else BSE."""
    parts = []
    if nse is not None:
        parts.append(nse[nse["series"].isin(config.NSE_SERIES)])
    if bse is not None:
        b = bse[bse["series"].isin(config.BSE_GROUPS)]
        if nse is not None and config.INCLUDE_BSE_ONLY:
            b = b[~b["isin"].isin(set(nse["isin"]))]
        elif nse is not None:
            b = b.iloc[0:0]
        parts.append(b)
    if not parts:
        return pd.DataFrame()
    day = pd.concat(parts, ignore_index=True)
    day = day[day["close"] >= config.MIN_PRICE]
    day["key"] = day["exchange"] + ":" + day["symbol"]
    # A stock can appear in several series the same day; keep NSE before BSE, then the
    # regular series (EQ first) over special ones.
    prio = {s: i for i, s in enumerate(config.NSE_SERIES)}
    day["_p"] = (day["exchange"] != "NSE") * 100 + day["series"].map(prio).fillna(50)
    return day.sort_values("_p").drop_duplicates("isin", keep="first").drop(columns="_p")


def trading_days_back(n_calendar: int, end: date | None = None):
    end = end or date.today()
    d = end
    while (end - d).days <= n_calendar:
        if d.weekday() < 5:
            yield d
        d -= timedelta(days=1)


def yfinance_fill(symbols: list[str], start: date, end: date) -> pd.DataFrame:
    """Last-resort source. Returns adjusted closes in the same long format."""
    import yfinance as yf
    tick = {s: (s.split(":")[1] + (".NS" if s.startswith("NSE") else ".BO")) for s in symbols}
    out = []
    for i in range(0, len(symbols), 200):
        batch = symbols[i:i + 200]
        data = yf.download([tick[s] for s in batch], start=start, end=end + timedelta(days=1),
                           auto_adjust=True, progress=False, group_by="ticker", threads=True)
        for s in batch:
            try:
                x = data[tick[s]].dropna(subset=["Close"]).reset_index()
            except KeyError:
                continue
            x = x.rename(columns=str.lower)
            x["key"] = s
            x["turnover"] = x["close"] * x["volume"]
            out.append(x[["date", "key", "open", "high", "low", "close", "volume", "turnover"]])
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()
