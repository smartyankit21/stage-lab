import io, zipfile, numpy as np, pandas as pd, time
from datetime import date
from engine import sources, store, indicators as ind
from engine.compute import compute

rng=np.random.default_rng(0)
days=pd.bdate_range("2025-03-03","2026-10-01")
N=300
def make_panel():
    rows=[]
    drift=rng.normal(0.0004,0.0012,N)
    for j in range(N):
        px=100*np.exp(np.cumsum(rng.normal(drift[j],0.02,len(days))))
        prev=np.r_[np.nan,px[:-1]]
        if j==0:   # 1:2 split on day 300: raw prices halve, exchange publishes adjusted prev close
            px=px.copy(); px[300:]/=2; prev=np.r_[np.nan,px[:-1]]; prev[300]=px[299]/2
        for i,d in enumerate(days):
            rows.append(dict(date=d,key=f"NSE:S{j}",symbol=f"S{j}",isin=f"IN{j:010d}",series="EQ",name=f"Co {j}",
                             exchange="NSE",open=px[i],high=px[i]*1.01,low=px[i]*0.99,close=px[i],prev_close=prev[i],
                             volume=1e5,turnover=px[i]*1e5*50))
    return pd.DataFrame(rows)

def test_split_adjustment():
    p=make_panel(); a=store.adjusted(p)
    s=a[a.key=="NSE:S0"].set_index("date").close
    jump=abs(s.iloc[300]/s.iloc[299]-1)
    assert jump<0.15, jump    # no artificial -50% gap after adjustment
    raw=p[p.key=="NSE:S0"].set_index("date").close
    assert abs(raw.iloc[300]/raw.iloc[299]-0.5)<0.15

def test_weekly_ma_matches_manual():
    p=store.adjusted(make_panel()); c=store.wide(p)
    m=ind.weekly_mas(c,partial=True,slope_weeks=4,mode="weekly")
    t=c.index[-1]  # Thursday 2026-10-01
    k="NSE:S5"
    wk=c[k].resample("W-FRI").last()
    manual=(wk.iloc[-31:-1].sum()+c[k].iloc[-1])/31  # placeholder check replaced below
    # 10w: previous 9 completed weekly closes + today's close
    exp10=(wk.iloc[-10:-1].sum()+c[k].iloc[-1])/10
    assert abs(m["wma10"].loc[t,k]-exp10)<1e-9
    m2=ind.weekly_mas(c,partial=False,mode="weekly")
    assert abs(m2["wma10"].loc[t,k]-wk.iloc[-11:-1].mean())<1e-9

def test_rs_percentile_bounds_and_order():
    p=store.adjusted(make_panel()); c=store.wide(p)
    rs=ind.rs_table(c)
    last=rs["rs12"].iloc[-1]
    assert last.min()>=1 and last.max()==100 and last.notna().sum()==N
    sc=ind.rs_score(c,(63,126,189,252)).iloc[-1]
    assert last[sc.idxmax()]==100 and last[sc.idxmin()]==1

def test_compute_runs_and_stage_consistency():
    p=store.adjusted(make_panel())
    t=time.time(); r=compute(p); el=time.time()-t
    s=r.snapshot
    assert set(s.stage.dropna().unique())<= {1,2,3,4}
    assert (s.loc[s.stage==2,"rules_met"]==8).all()
    assert (s.loc[s.stage==2,"days_in_s2"]>=0).all()
    print("compute secs",round(el,2),"stage counts",s.stage.value_counts().to_dict())

def test_udiff_parsing():
    nse_csv=("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4\n"
     "2026-10-01,2026-10-01,CM,NSE,STK,2885,INE002A01018,RELIANCE,EQ,,,,,RELIANCE INDUSTRIES LTD,1400,1410,1390,1405,1405,1398,,,,,1000000,1405000000,5000,F1,1,,,,,\n"
     "2026-10-01,2026-10-01,CM,NSE,STK,1,INE000000001,JUNKBOND,N1,,,,,SOME BOND,100,100,100,100,100,100,,,,,10,1000,1,F1,1,,,,,\n")
    bse_csv=nse_csv.replace(",NSE,",",BSE,").replace("RELIANCE,EQ","RELIANCE,A").replace("INE000000001,JUNKBOND,N1","INE999999999,SHREEREF,B")
    n=sources._normalise(pd.read_csv(io.StringIO(nse_csv)),"NSE")
    b=sources._normalise(pd.read_csv(io.StringIO(bse_csv)),"BSE")
    day=sources.filter_day(n,b)
    assert set(day.key)=={"NSE:RELIANCE","BSE:SHREEREF"}, set(day.key)
    assert day.set_index("key").loc["NSE:RELIANCE","prev_close"]==1398

def test_bad_downloads_are_rejected(tmp_path, monkeypatch):
    from engine import config
    monkeypatch.setattr(config, "RAW", tmp_path)
    f = sources.Fetcher(pause=0)
    html = b"<html><head><title>BSE</title></head><body>" + b"x" * 2000 + b"</body></html>"
    class R:
        def __init__(s, code, content): s.status_code, s.content = code, content
    # 1) a bad cached file from an earlier run is discarded, and an HTML reply is not accepted
    (tmp_path / "bse").mkdir()
    bad = tmp_path / "bse" / "2026-09-30.csv"; bad.write_bytes(html)
    monkeypatch.setattr(f.s, "get", lambda *a, **k: R(200, html))
    assert f.bse(date(2026, 9, 30)) is None and not bad.exists()
    # 2) after 5 straight failures BSE is skipped without network calls
    for d in range(1, 5):
        f.bse(date(2026, 9, d))
    calls = []
    monkeypatch.setattr(f.s, "get", lambda *a, **k: calls.append(1) or R(200, html))
    assert f.bse(date(2026, 8, 3)) is None and calls == []
    # 3) a genuine UDiFF CSV is accepted
    g = sources.Fetcher(pause=0)
    good = ("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4\n"
            + "2026-10-01,2026-10-01,CM,BSE,STK,1,INE999999999,SHREEREF,B,,,,,SHREE REF,100,101,99,100,100,99,,,,,1000,100000,10,F1,1,,,,,\n" * 40).encode()
    monkeypatch.setattr(g.s, "get", lambda *a, **k: R(200, good))
    df = g.bse(date(2026, 10, 1))
    assert df is not None and len(df) == 40
    # 4) an NSE reply that is not a zip is rejected
    monkeypatch.setattr(g.s, "get", lambda *a, **k: R(200, html))
    assert g.nse(date(2026, 10, 1)) is None


def test_daily_mas_are_50_150_200_day_smas():
    p=store.adjusted(make_panel()); c=store.wide(p); k="NSE:S7"
    m=ind.weekly_mas(c,mode="daily",slope_weeks=4)
    assert abs(m["wma10"][k].iloc[-1]-c[k].iloc[-50:].mean())<1e-9
    assert abs(m["wma30"][k].iloc[-1]-c[k].iloc[-150:].mean())<1e-9
    assert abs(m["wma40"][k].iloc[-1]-c[k].iloc[-200:].mean())<1e-9
    assert abs(m["wma40_prev"][k].iloc[-1]-c[k].iloc[-220:-20].mean())<1e-9

def test_new_isin_split_without_adjusted_prev_close():
    # NUVAMA-style 1:5 split: new ISIN, prev_close NOT adjusted by the exchange
    d=pd.bdate_range("2026-01-01",periods=6)
    px=[7400,7500,7615,1493.5,1461,1480]; isin=["OLD"]*3+["NEW"]*3
    prev=[np.nan,7400,7500,7615,1493.5,1461]
    p=pd.DataFrame(dict(date=d,key="NSE:NUV",symbol="NUV",isin=isin,series="EQ",name="N",exchange="NSE",
        open=px,high=px,low=px,close=px,close_official=px,prev_close=prev,volume=1,turnover=1))
    a=store.adjusted(p).set_index("date").close
    assert abs(a.iloc[2]-1523)<1 and abs(a.iloc[3]-1493.5)<1e-6, a.tolist()

def test_genuine_crash_is_not_treated_as_split():
    d=pd.bdate_range("2026-01-01",periods=4)
    px=[100,100,58,57]; prev=[np.nan,100,100,58]
    p=pd.DataFrame(dict(date=d,key="NSE:X",symbol="X",isin="I",series="EQ",name="X",exchange="NSE",
        open=px,high=px,low=px,close=px,close_official=px,prev_close=prev,volume=1,turnover=1))
    a=store.adjusted(p).set_index("date").close
    assert a.iloc[0]==100


def test_block_deal_row_is_not_used():
    hdr=("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4\n")
    bl="2026-10-01,2026-10-01,CM,NSE,STK,1,INE531F01023,NUVAMA,BL,,,,,N,1652.5,1652.5,1652.5,1652.5,1652.5,7227,,,,,1,1,1,F1,1,,,,,\n"
    eq="2026-10-01,2026-10-01,CM,NSE,STK,2,INE531F01023,NUVAMA,EQ,,,,,N,1665,1738.6,1652.9,1701.4,1686.3,1652.5,,,,,1,1,1,F1,1,,,,,\n"
    n=sources._normalise(pd.read_csv(io.StringIO(hdr+bl+eq)),"NSE")
    day=sources.filter_day(n,None)
    assert len(day)==1 and day.iloc[0]["series"]=="EQ" and day.iloc[0]["close"]==1686.3

def test_classification_flow(tmp_path, monkeypatch):
    from engine import universe
    monkeypatch.setattr(universe, "CACHE", tmp_path / "c.csv")
    monkeypatch.setattr(universe, "MCAP", tmp_path / "m.csv")
    monkeypatch.setattr(universe, "from_bse", lambda: pd.DataFrame([
        dict(isin="I1", scrip_cd="500002", key="BSE:ABB", name="ABB", mcap_cr=145250.0),
        dict(isin="I2", scrip_cd="500325", key="BSE:REL", name="Rel", mcap_cr=1900000.0)]))
    asked = {}
    def headers(codes, **k):
        asked["codes"] = dict(codes)
        return pd.DataFrame([dict(isin="I1", macro="Industrials", sector="Capital Goods", industry="Electrical Equipment",
                                  basic_industry="Heavy Electrical Equipment", pe=38.0, source="bse")])
    monkeypatch.setattr(universe, "from_bse_headers", headers)
    monkeypatch.setattr(universe, "from_nse_indices", lambda: pd.DataFrame([dict(isin="I3", key="NSE:SME", name="Sme",
        macro="Textiles", sector="Textiles", industry="Textiles", basic_industry="Textiles", mcap_cr=None, source="nse_index")]))
    snap = pd.DataFrame({"isin": ["I1", "I2", "I3"], "close": [1, 2, 3]}, index=pd.Index(["NSE:ABB", "NSE:REL", "NSE:SME"], name="key"))
    universe.refresh(snap)
    assert asked["codes"] == {"I1": "500002", "I2": "500325"}
    out = universe.attach(snap)
    assert out.loc["NSE:ABB", "industry"] == "Electrical Equipment" and out.loc["NSE:ABB", "pe"] == 38.0
    assert out.loc["NSE:SME", "industry"] == "Textiles"
    assert out.loc["NSE:REL", "industry"] == "Unclassified" and out.loc["NSE:REL", "mcap_cat"] == "Large Cap"
    # second run only asks for what is still missing
    universe.refresh(snap)
    assert asked["codes"] == {"I2": "500325"}

def test_breadth_counts_and_score():
    from engine import breadth
    d = pd.bdate_range("2025-01-01", periods=300)
    # 3 stocks: A rises every day, B falls every day, C flat
    c = pd.DataFrame({"A": np.linspace(100, 200, 300), "B": np.linspace(200, 100, 300), "C": 100.0}, index=d)
    st = pd.DataFrame({"A": 2, "B": 4, "C": 1}, index=d, dtype=float)
    out = breadth.compute(c, st, ["A", "B", "C"])
    L = out["latest"]
    assert (L["adv"], L["dec"], L["nh"], L["nl"]) == (1, 1, 1, 1)
    assert L["participation"]["200"]["now"] == round(100 / 3, 1)
    assert L["stage2_pct"] == round(100 / 3, 1)
    # score = mean(50 A/D, 50 highs, 33.3 averages) = 44
    assert L["score"] == 44 and L["label"] == "Neutral"
    assert len(out["series"]["d"]) <= breadth.DAYS and out["series"]["ad_line"][0] == 0

def test_rotation_signal():
    from engine import breadth
    d = pd.bdate_range("2025-01-01", periods=320)
    big = np.full(320, 100.0)
    mid = np.r_[np.full(250, 100.0), np.linspace(100, 120, 70)]   # mid caps break out at the end
    rows = [dict(date=x, index="Nifty 100", close=b) for x, b in zip(d, big)] + \
           [dict(date=x, index="Nifty MidSmallcap 400", close=m) for x, m in zip(d, mid)]
    out = breadth.rotation(pd.DataFrame(rows))
    assert out["above"] and out["leading"] == "Mid and small caps" and out["gap_pct"] > 0

def test_rrg_quadrants():
    from engine.groups import rrg
    d = pd.bdate_range(end="2025-12-26", periods=260)   # ends on a Friday
    bench = pd.Series(100.0, index=d)
    t = np.arange(260)
    gi = pd.DataFrame({
        "Leader": 100 * np.exp(0.00002 * t ** 2),     # outperforming, and accelerating
        "Laggard": 100 * np.exp(-0.00002 * t ** 2),   # underperforming, getting worse
    }, index=d)
    pts = {p["name"]: p for p in rrg(gi, bench)}
    assert pts["Leader"]["quadrant"] == "Leading" and pts["Laggard"]["quadrant"] == "Lagging"
    assert len(pts["Leader"]["trail"]) == 6

def test_holidays_remembered_and_bse_not_disabled(tmp_path, monkeypatch):
    from engine import config, store
    monkeypatch.setattr(config, "PRICES", tmp_path / "p.parquet")
    monkeypatch.setattr(store, "CLOSED", tmp_path / "closed.json")
    monkeypatch.setattr(config, "BACKFILL_DAYS", 20)
    holidays = {date(2026, 9, 14), date(2026, 9, 15), date(2026, 9, 16), date(2026, 9, 17), date(2026, 9, 18), date(2026, 9, 21)}
    bse_calls = []
    def fake_day(ex, d):
        return pd.DataFrame(dict(date=[pd.Timestamp(d)], symbol=["X"], isin=["IN1" if ex == "NSE" else "IN2"], series=["EQ" if ex == "NSE" else "B"],
            name=["X"], open=[1.0], high=[1.0], low=[1.0], close=[10.0], close_official=[10.0], last=[10.0], prev_close=[10.0],
            volume=[1.0], turnover=[1.0], exchange=[ex]))
    class F:
        bse_failures = 0
        def nse(self, d): return None if d in holidays else fake_day("NSE", d)
        def bse(self, d, count_failure=True):
            bse_calls.append(d)
            if d in holidays:
                self.bse_failures += int(count_failure); return None
            return None if self.bse_failures >= 5 else fake_day("BSE", d)
    monkeypatch.setattr(store, "Fetcher", F)
    p = store.update(end=date(2026, 10, 1))
    assert date(2026, 10, 1) in set(p["date"].dt.date)
    assert set(p[p["date"] == "2026-10-01"]["exchange"]) == {"NSE", "BSE"}      # BSE still used after 6 holidays
    assert holidays <= store.closed_days()
    bse_calls.clear(); store.update(end=date(2026, 10, 1))
    assert not (set(bse_calls) & holidays)                                     # holidays not asked again
