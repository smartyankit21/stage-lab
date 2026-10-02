"""NSE index closing values (one small CSV per trading day) and index membership lists.

Daily file:  https://nsearchives.nseindia.com/content/indices/ind_close_all_DDMMYYYY.csv
  ~170 indices: Nifty 50/100/500, sectoral, thematic, MidSmallcap 400, India VIX, ...
Members:     https://nsearchives.nseindia.com/content/indices/ind_<name>list.csv
"""
from __future__ import annotations

import io
import logging
from datetime import date, datetime, timedelta

import pandas as pd

from . import config
from .sources import Fetcher, trading_days_back

log = logging.getLogger(__name__)
CLOSE_URL = "https://nsearchives.nseindia.com/content/indices/ind_close_all_{d}.csv"
MEMBERS_URL = "https://nsearchives.nseindia.com/content/indices/ind_{slug}list.csv"
PANEL = config.DATA / "indices.parquet"
MEMBERS = config.META / "index_members"


def _is_index_csv(b: bytes | None) -> bool:
    return bool(b) and b.lstrip(b"\xef\xbb\xbf")[:10] == b"Index Name" and len(b) > 1000


def _is_members_csv(b: bytes | None) -> bool:
    return bool(b) and b.lstrip(b"\xef\xbb\xbf")[:12] == b"Company Name"


def parse_day(blob: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(blob))
    df = df.rename(columns={"Index Name": "index", "Index Date": "date", "Open Index Value": "open",
                            "High Index Value": "high", "Low Index Value": "low",
                            "Closing Index Value": "close", "P/E": "pe", "P/B": "pb"})
    df["date"] = pd.to_datetime(df["date"], format="%d-%m-%Y", errors="coerce")
    df["index"] = df["index"].astype(str).str.strip()
    for c in ["open", "high", "low", "close", "pe", "pb"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df[["date", "index", "open", "high", "low", "close", "pe", "pb"]].dropna(subset=["date", "close"])


def update(end: date | None = None, days: int | None = None) -> pd.DataFrame:
    """Download any missing daily index files and return the long panel."""
    end = end or date.today()
    days = days or config.BACKFILL_DAYS
    f = Fetcher()
    panel = pd.read_parquet(PANEL) if PANEL.exists() else pd.DataFrame()
    have = set(panel["date"].dt.date) if len(panel) else set()
    from .store import closed_days
    have |= closed_days()                       # known market holidays
    new, misses = [], 0
    for d in sorted(trading_days_back(int(days * 1.48), end)):
        if d in have:
            continue
        blob = f._cached(config.RAW / "indices" / f"{d:%Y-%m-%d}.csv",
                         CLOSE_URL.format(d=f"{d:%d%m%Y}"), "https://www.nseindia.com/", _is_index_csv)
        if blob is None:
            misses += 1
            continue
        new.append(parse_day(blob))
    if new:
        panel = pd.concat([panel, *new], ignore_index=True).drop_duplicates(["date", "index"], keep="last")
        PANEL.parent.mkdir(parents=True, exist_ok=True)
        panel.to_parquet(PANEL, index=False)
        log.info("index files: +%d days (%d indices)", len(new), panel["index"].nunique())
    return panel


def wide(panel: pd.DataFrame, field: str = "close") -> pd.DataFrame:
    """dates x index-name; names are matched case-insensitively elsewhere via `col()`."""
    return panel.pivot_table(index="date", columns="index", values=field, aggfunc="last").sort_index()


def col(w: pd.DataFrame, name: str) -> pd.Series | None:
    """Pick an index column by name, ignoring case and spacing ('NIFTY Midcap 100' == 'Nifty Midcap 100')."""
    norm = lambda s: "".join(s.lower().split())  # noqa: E731
    for c in w.columns:
        if norm(c) == norm(name):
            return w[c]
    return None


def members(slug: str, max_age_days: int = 30) -> list[str]:
    """Engine keys ('NSE:SYMBOL') of an index's members, e.g. slug='nifty500'. Cached."""
    path = MEMBERS / f"{slug}.csv"
    fresh = path.exists() and datetime.fromtimestamp(path.stat().st_mtime) > datetime.now() - timedelta(days=max_age_days)
    if not fresh:
        f = Fetcher(pause=0)
        blob = f._get(MEMBERS_URL.format(slug=slug), "https://www.nseindia.com/", _is_members_csv)
        if blob:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(blob)
        elif not path.exists():
            log.warning("index members for %s unavailable", slug)
            return []
    df = pd.read_csv(path)
    return ("NSE:" + df["Symbol"].astype(str).str.strip()).tolist()
