"""Central settings for the Stage Lab engine.

Everything that was reconstructed (not published by the reference screen) lives here so
validate.py can tune it against the reference snapshot.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"            # cached exchange files, one per day
PRICES = DATA / "prices.parquet"   # adjusted daily OHLCV panel
META = DATA / "meta"          # classification, names, market-cap category
OUT = ROOT / "site" / "data"  # files the website reads
HISTORY = DATA / "history"    # daily snapshots (Time Machine)

# How much history to keep / backfill (trading days). 12M RS needs 252,
# 40-week MA + slope needs ~45 weeks, RS deltas and RRG trails need a bit more.
BACKFILL_DAYS = 420

# ---- Universe -----------------------------------------------------------
NSE_SERIES = ["EQ", "BE", "BZ", "SM", "ST", "IV"]   # priority order; SM/ST = SME boards. Never BL (block-deal window)
BSE_GROUPS = {"A", "B", "X", "XT", "T", "MT", "M", "MS"}   # equity groups (as used by the reference screen)
MIN_PRICE = 0.5
MIN_MEDIAN_TURNOVER_CR = 0.25   # 20-day median traded value, Rs crore
INCLUDE_BSE_ONLY = True

# ---- Relative Strength (published method) ---------------------------
# Verified against a reference snapshot: classic IBD weighting, 40% on the latest slice and 20% on each
# of the three before it. 12M uses 63-trading-day slices, 3M uses 15-day slices.
RS_12M_WINDOWS = (63, 126, 189, 252)
RS_3M_WINDOWS = (15, 30, 45, 60)
RS_WEIGHTS = (0.4, 0.2, 0.2, 0.2)
# "cumulative": each window is the return over the last N days (the published wording).
# "quarterly": each window is the return of that quarter only (classic IBD style).
RS_MODE = "quarterly"
RS_SCALE = "round"   # percentile x 100, rounded, clipped to 1..100 (best match)

# ---- Stage classification (reconstructed) ----------------------------------
STAGE = dict(
    min_close_vs_low52=1.15,    # close at least 15% above 52-week low
    min_close_vs_high52=0.75,   # close within 25% of 52-week high
    min_rs=0,                   # RS floor (snapshot shows ~50 minimum; not binding)
    slope_weeks=4,              # 200-day MA must be higher than 4 weeks (20 trading days) ago
    ma_mode="daily",            # "daily" = 50/150/200-day SMAs (matches the reference); "weekly" = true weekly
    use_partial_week=True,      # weekly mode only: include the current unfinished week
    high_low_from="close",      # "close" or "high_low" for 52-week range
)
CANDIDATE_MIN_RULES = 6        # of 8 rules met -> Stage 2 Candidate (93% agreement)

# ---- Groups ---------------------------------------------------------------
GROUP_LEVELS = ("sector", "industry", "basic_industry")   # broad -> narrow
