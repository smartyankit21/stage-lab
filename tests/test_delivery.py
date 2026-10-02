"""NSE full bhavcopy (with delivery) is read the same way Accumulation Lab reads it."""
from datetime import date

import pytest

from engine import delivery

SAMPLE = """SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER
RELIANCE, EQ, 01-Oct-2026, 1187.20, 1186.00, 1190.00, 1165.00, 1168.00, 1167.70, 1175.10, 10234567, 120265.43, 254321, 5123456, 50.06
SOMEBOND, N1, 01-Oct-2026, 1000.00, 1000.00, 1000.00, 1000.00, 1000.00, 1000.00, 1000.00, 10, 0.10, 1, -, -
TINYCO, BE, 01-Oct-2026, 10.00, 10.20, 10.40, 10.00, 10.30, 10.30, 10.25, 5000, 0.51, 12, -, -
"""


def test_parse_maps_columns_and_units():
    df = delivery.parse(SAMPLE, date(2026, 10, 1))
    assert list(df["symbol"]) == ["RELIANCE", "SOMEBOND", "TINYCO"]   # every series kept, as Accumulation Lab does
    r = df.iloc[0]
    assert r["close"] == 1167.70 and r["prevClose"] == 1187.20       # CLOSE_PRICE, not LAST_PRICE
    assert r["volume"] == 10234567 and r["trades"] == 254321 and r["delivery"] == 5123456
    assert r["turnover"] == pytest.approx(120265.43 * 100000)        # lakh -> rupees
    assert df.iloc[2]["delivery"] != df.iloc[2]["delivery"]          # "-" -> missing


def test_parse_rejects_wrong_date():
    with pytest.raises(ValueError):
        delivery.parse(SAMPLE, date(2026, 9, 30))
