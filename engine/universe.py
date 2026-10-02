"""Company names, industry classification and market cap.

Tries free sources in order and keeps whatever works (cached for 30 days):
  1. BSE list of listed companies     - market cap and BSE code for every company (each run)
  2. BSE company header (per stock)   - sector / industry / group / sub-group and P/E;
                                         only for stocks not yet classified (cached 90 days)
  3. NSE index membership files       - ~750 stocks, broad industry only (fills gaps)

    python -m engine.universe --diagnose   # test which sources work from this connection
    python -m engine.universe --refresh    # rebuild the classification cache
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import time
from datetime import datetime, timedelta

import pandas as pd
import requests

from . import config
from .sources import UA

log = logging.getLogger(__name__)
CACHE = config.META / "classification.csv"
FIELDS = ["isin", "name", "macro", "sector", "industry", "basic_industry", "pe", "source", "updated"]
MCAP = config.META / "market_cap.csv"

BSE_LIST = ("https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w"
            "?Group=&Scripcode=&industry=&segment=Equity&status=Active")
BSE_HEADER = "https://api.bseindia.com/BseIndiaAPI/api/ComHeader/w"
NSE_INDEX_FILES = [
    "https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv",
    "https://nsearchives.nseindia.com/content/indices/ind_niftymicrocap250_list.csv",
]


def _session(referer: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*",
                      "Accept-Language": "en-IN,en;q=0.9", "Referer": referer,
                      "Origin": referer.rstrip("/")})
    return s


def _pick(rec: dict, *needles):
    """Find a field by (case-insensitive) name fragments, tolerant of API renames."""
    low = {k.lower(): k for k in rec}
    for n in needles:
        for lk, k in low.items():
            if n in lk:
                return rec[k]
    return None


# ------------------------------------------------------------------ sources --
def from_bse() -> pd.DataFrame:
    """BSE's list of listed companies: ISIN, BSE scrip code, name and market cap (Rs crore)."""
    s = _session("https://www.bseindia.com/")
    r = s.get(BSE_LIST, timeout=60)
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict):
        data = next((v for v in data.values() if isinstance(v, list)), [])
    rows = [dict(isin=str(_pick(rec, "isin")).strip(), scrip_cd=str(_pick(rec, "scrip_cd") or "").strip(),
                 key="BSE:" + str(_pick(rec, "scrip_id") or "").strip(),
                 name=_pick(rec, "issuer_name", "scrip_name"),
                 mcap_cr=pd.to_numeric(_pick(rec, "mktcap"), errors="coerce"))
            for rec in data if _pick(rec, "isin")]
    return pd.DataFrame(rows)


def from_bse_headers(scrip_codes: dict[str, str], save_every: int = 200, on_save=None) -> pd.DataFrame:
    """Per-company classification from BSE: {isin: scrip_code} -> sector / industry / group / sub-group, P/E."""
    s = _session("https://www.bseindia.com/")
    rows, fails = [], 0
    for i, (isin, code) in enumerate(scrip_codes.items()):
        try:
            r = s.get(BSE_HEADER, params={"quotetype": "EQ", "scripcode": code, "seriesid": ""}, timeout=20)
            j = r.json()
            rows.append(dict(isin=isin, macro=j.get("Sector"), sector=j.get("IndustryNew"),
                             industry=j.get("IGroup"), basic_industry=j.get("ISubGroup") or j.get("Industry"),
                             pe=pd.to_numeric(j.get("PE"), errors="coerce"), source="bse"))
        except Exception:  # noqa: BLE001
            fails += 1
            if fails >= 15 and not rows:
                raise RuntimeError("BSE company header service is refusing requests")
        if on_save and rows and i % save_every == save_every - 1:
            on_save(pd.DataFrame(rows))
            log.info("classification: %d/%d companies", i + 1, len(scrip_codes))
        time.sleep(0.3)
    return pd.DataFrame(rows)


def from_nse_indices() -> pd.DataFrame:
    s = _session("https://www.nseindia.com/")
    parts = []
    for url in NSE_INDEX_FILES:
        r = s.get(url, timeout=30)
        r.raise_for_status()
        parts.append(pd.read_csv(io.StringIO(r.text)))
    df = pd.concat(parts).drop_duplicates("ISIN Code")
    return pd.DataFrame(dict(isin=df["ISIN Code"], key="NSE:" + df["Symbol"], name=df["Company Name"],
                             macro=None, sector=df["Industry"], industry="Unclassified",
                             basic_industry="Unclassified", mcap_cr=float("nan"), source="nse_index"))


def from_nse_quotes(symbols: list[str], limit: int | None = None) -> pd.DataFrame:
    s = _session("https://www.nseindia.com/")
    s.get("https://www.nseindia.com/", timeout=20)          # cookies the API expects
    rows, fails = [], 0
    for i, sym in enumerate(symbols[:limit] if limit else symbols):
        try:
            r = s.get("https://www.nseindia.com/api/quote-equity", params={"symbol": sym}, timeout=20)
            j = r.json()
            ind = j.get("industryInfo", {}) or {}
            shares = (j.get("securityInfo", {}) or {}).get("issuedSize")
            px = (j.get("priceInfo", {}) or {}).get("lastPrice")
            rows.append(dict(isin=j.get("info", {}).get("isin"), key="NSE:" + sym,
                             name=j.get("info", {}).get("companyName"), macro=ind.get("macro"),
                             sector=ind.get("sector"), industry=ind.get("industry"),
                             basic_industry=ind.get("basicIndustry"),
                             mcap_cr=(shares * px / 1e7) if shares and px else float("nan"), source="nse_quote"))
        except Exception:  # noqa: BLE001
            fails += 1
            if fails >= 10 and not rows:
                raise RuntimeError("NSE quote API is refusing requests from this connection")
        time.sleep(0.35)
    return pd.DataFrame(rows)


# ------------------------------------------------------------------- cache --
def load() -> pd.DataFrame:
    return pd.read_csv(CACHE) if CACHE.exists() else pd.DataFrame(columns=FIELDS)


def _merge_save(cur: pd.DataFrame, new: pd.DataFrame) -> pd.DataFrame:
    new = new.copy()
    new["updated"] = datetime.now().isoformat(timespec="seconds")
    out = pd.concat([cur, new], ignore_index=True).drop_duplicates("isin", keep="last")
    for c in FIELDS:
        if c not in out.columns:
            out[c] = None
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    out[FIELDS].to_csv(CACHE, index=False)
    return out[FIELDS]


def refresh(snapshot: pd.DataFrame | None = None, max_age_days: int = 90, force: bool = False) -> pd.DataFrame:
    """Update market caps (every run) and classify any stock not yet classified (or stale).

    snapshot: latest engine snapshot (index=key, column isin) - limits work to stocks we track.
    """
    cur = load()
    try:                                   # market cap + BSE scrip codes: one request
        lst = from_bse()
        MCAP.parent.mkdir(parents=True, exist_ok=True)
        lst[["isin", "scrip_cd", "mcap_cr"]].to_csv(MCAP, index=False)
        log.info("market caps updated for %d companies", len(lst))
    except Exception as e:  # noqa: BLE001
        log.warning("BSE company list unavailable (%s); keeping cached market caps", e)
        lst = pd.read_csv(MCAP, dtype={"scrip_cd": str}) if MCAP.exists() else pd.DataFrame(columns=["isin", "scrip_cd", "mcap_cr"])
    if snapshot is None:
        return cur
    fresh = cur[pd.to_datetime(cur["updated"], errors="coerce") > datetime.now() - timedelta(days=max_age_days)]
    done = set() if force else set(fresh["isin"].dropna())
    todo = [i for i in snapshot["isin"].dropna().unique() if i not in done]
    codes = dict(zip(lst["isin"], lst["scrip_cd"].astype(str)))
    via_bse = {i: codes[i] for i in todo if i in codes and codes[i] not in ("", "nan")}
    if via_bse:
        log.info("classification: fetching %d companies from BSE (first run takes ~%d min)", len(via_bse), len(via_bse) * 0.35 / 60 + 1)
        state = {"cur": cur}
        def save(df):
            state["cur"] = _merge_save(cur, df)
        try:
            df = from_bse_headers(via_bse, on_save=save)
            cur = _merge_save(cur, df)
        except Exception as e:  # noqa: BLE001
            log.warning("classification: BSE headers unavailable (%s)", e)
            cur = state["cur"]
    left = [i for i in todo if i not in set(cur["isin"])]
    if left:
        try:
            idx = from_nse_indices()
            idx = idx[idx["isin"].isin(left)].assign(pe=float("nan"))
            if len(idx):
                cur = _merge_save(cur, idx[["isin", "name", "macro", "sector", "industry", "basic_industry", "pe", "source"]])
                log.info("classification: %d more from NSE index files", len(idx))
        except Exception as e:  # noqa: BLE001
            log.warning("classification: NSE index files unavailable (%s)", e)
    n = snapshot["isin"].isin(set(cur["isin"])).sum()
    log.info("classification: %d of %d tracked stocks classified", n, len(snapshot))
    return cur


def attach(latest: pd.DataFrame) -> pd.DataFrame:
    """Add classification, P/E, market cap and size bucket to the latest snapshot (matched by ISIN)."""
    meta = load().drop_duplicates("isin").set_index("isin")
    out = latest.join(meta[["macro", "sector", "industry", "basic_industry", "pe"]], on="isin", how="left")
    if MCAP.exists():
        mc = pd.read_csv(MCAP).drop_duplicates("isin").set_index("isin")["mcap_cr"]
        out["mcap_cr"] = out["isin"].map(mc)
    else:
        out["mcap_cr"] = float("nan")
    for c in ["macro", "sector", "industry", "basic_industry"]:
        out[c] = out[c].fillna("Unclassified")
    rank = out["mcap_cr"].rank(ascending=False, method="first")
    out["mcap_cat"] = pd.cut(rank, [0, 100, 250, 1e9], labels=["Large Cap", "Mid Cap", "Small Cap"]).astype(str)
    out.loc[out["mcap_cr"].isna(), "mcap_cat"] = "Unknown"
    return out


def diagnose():
    """Print which sources respond from this connection and what their fields look like."""
    print("1) BSE company list ...")
    try:
        r = _session("https://www.bseindia.com/").get(BSE_LIST, timeout=60)
        print("   HTTP", r.status_code, "| bytes", len(r.content))
        j = r.json()
        rec = j[0] if isinstance(j, list) and j else j
        print("   records:", len(j) if isinstance(j, list) else "n/a")
        print("   sample:", json.dumps(rec, default=str)[:700])
    except Exception as e:  # noqa: BLE001
        print("   FAILED:", e)
    print("1b) BSE company header (classification) ...")
    try:
        print("  ", from_bse_headers({"INE117A01022": "500002", "INE002A01018": "500325"}).to_dict("records"))
    except Exception as e:  # noqa: BLE001
        print("   FAILED:", e)
    print("2) NSE quote API ...")
    try:
        df = from_nse_quotes(["RELIANCE", "TCS"])
        print("  ", df.to_dict("records"))
    except Exception as e:  # noqa: BLE001
        print("   FAILED:", e)
    print("3) NSE index files ...")
    try:
        df = from_nse_indices()
        print("   companies:", len(df), "| industries:", df["industry"].nunique())
    except Exception as e:  # noqa: BLE001
        print("   FAILED:", e)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--diagnose", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if a.diagnose:
        diagnose()
    elif a.refresh:
        refresh(force=True)
