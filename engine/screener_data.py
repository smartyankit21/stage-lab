"""Files for the Screener page.

  site/data/dseries/<NSE_SYMBOL>.json   one per stock: the delivery-bhavcopy rows (column arrays)
  site/data/screener/master.json        symbol -> name, market cap (Rs crore), Stage Lab page file

The screener lists themselves are computed by engine/run_screeners.mjs, which runs Accumulation Lab's
own JavaScript (site/screeners/*.mjs) on exactly these files. The website runs the same code on the
same per-stock file when you click a stock, so the list and the detail always agree.
"""
from __future__ import annotations

import json
import logging
import shutil

import pandas as pd
import requests

from . import config

log = logging.getLogger(__name__)

SERIES_DIR = config.OUT / "dseries"
OUT_DIR = config.OUT / "screener"
PRIORITY = {s: i for i, s in enumerate(config.NSE_SERIES)}   # EQ first
CAP_URL = "https://accumulation-lab-ankit.pages.dev/market-cap.json"
CAP_FILE = config.META / "accumulation_market_cap.json"


def market_cap_snapshot() -> dict | None:
    """Accumulation Lab's own market-cap snapshot (so the Rs 1,000 crore rule matches it exactly).
    A fresh copy is kept in data/meta; if the download fails the last saved copy is used."""
    try:
        r = requests.get(CAP_URL, timeout=30, headers={"User-Agent": "stage-lab"})
        j = r.json() if r.ok else None
        if j and isinstance(j.get("records"), list) and len(j["records"]) > 500:
            CAP_FILE.parent.mkdir(parents=True, exist_ok=True)
            CAP_FILE.write_text(json.dumps(j, separators=(",", ":")))
    except Exception as e:  # noqa: BLE001
        log.warning("market-cap snapshot download failed (%s); using the saved copy", e)
    try:
        return json.loads(CAP_FILE.read_text())
    except (FileNotFoundError, ValueError):
        return None


def _safe(sym: str) -> str:
    return "NSE_" + sym.replace("/", "-").replace(":", "_")


def _num(x, nd=None):
    if x is None or pd.isna(x):
        return None
    f = float(x)
    if nd is not None:
        f = round(f, nd)
    return int(f) if f.is_integer() and abs(f) < 2**53 else f


def build(dl: pd.DataFrame, prices: pd.DataFrame, snap: pd.DataFrame) -> dict:
    if not len(dl):
        log.warning("screener: no delivery data yet")
        return {}
    dl = dl.copy()
    dl["_p"] = dl["series"].map(PRIORITY).fillna(99)
    # one row per stock per day; if a stock traded in two series on one day keep the main one (EQ first)
    dl = dl.sort_values(["symbol", "date", "_p"]).drop_duplicates(["symbol", "date"], keep="first")
    last = dl["date"].max()   # every symbol is kept, even if it last traded long ago (Accumulation Lab does the same)

    # names and market caps: Stage Lab's own stock list first, then the raw NSE lines
    nse = prices[prices["exchange"] == "NSE"].sort_values("date").drop_duplicates("symbol", keep="last")
    isin_of = dict(zip(nse["symbol"], nse["isin"]))
    name_of = dict(zip(nse["symbol"], nse["name"]))
    try:
        caps = pd.read_csv(config.META / "market_cap.csv").drop_duplicates("isin").set_index("isin")["mcap_cr"]
    except FileNotFoundError:
        caps = pd.Series(dtype=float)
    snap_by_key = snap if "key" not in snap.columns else snap.set_index("key")

    if SERIES_DIR.exists():
        shutil.rmtree(SERIES_DIR)
    SERIES_DIR.mkdir(parents=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = []
    for sym, g in dl.groupby("symbol", sort=True):
        key = f"NSE:{sym}"
        row = snap_by_key.loc[key] if key in snap_by_key.index else None
        isin = isin_of.get(sym)
        cap = None
        if row is not None and pd.notna(row.get("mcap_cr")):
            cap = float(row["mcap_cr"])
        elif isin in caps.index and pd.notna(caps[isin]):
            cap = float(caps[isin])
        name = (row.get("name") if row is not None else None) or name_of.get(sym) or sym
        file = _safe(sym)
        master.append(dict(symbol=sym, name=str(name), stageLabCapCrore=None if cap is None else round(cap, 2),
                           page=(file if row is not None else None), file=file))
        doc = dict(symbol=sym,
                   d=[x.strftime("%Y-%m-%d") for x in g["date"]],
                   s=(g["series"].iloc[0] if g["series"].nunique() == 1 else list(g["series"])),
                   pc=[_num(x) for x in g["prevClose"]], o=[_num(x) for x in g["open"]],
                   h=[_num(x) for x in g["high"]], l=[_num(x) for x in g["low"]], c=[_num(x) for x in g["close"]],
                   v=[_num(x) for x in g["volume"]], dq=[_num(x) for x in g["delivery"]],
                   t=[_num(x) for x in g["trades"]], to=[_num(x, 2) for x in g["turnover"]])
        (SERIES_DIR / f"{file}.json").write_text(json.dumps(doc, separators=(",", ":")))
    snap_caps = market_cap_snapshot()
    info = dict(asof=last.strftime("%Y-%m-%d"), sessions=int(dl["date"].nunique()),
                first=dl["date"].min().strftime("%Y-%m-%d"), stocks=len(master),
                market_cap_asof=(snap_caps or {}).get("asof"), market_cap_count=(snap_caps or {}).get("count"),
                market_cap_basis=("Accumulation Lab's market-cap snapshot, scaled by each stock's NSE close on the "
                                  "as-of date (same rule as Accumulation Lab)") if snap_caps else
                                 "Stage Lab market cap (BSE), because Accumulation Lab's snapshot was unavailable")
    (OUT_DIR / "master.json").write_text(json.dumps(dict(info=info, stocks=master), separators=(",", ":")))
    if snap_caps:
        (OUT_DIR / "market-cap-snapshot.json").write_text(json.dumps(snap_caps, separators=(",", ":")))
    log.info("screener: %d stocks, %d sessions (%s to %s)", len(master), info["sessions"], info["first"], info["asof"])
    return info
