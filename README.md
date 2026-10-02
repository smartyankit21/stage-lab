# Stage Lab

A personal market-analytics site for Indian stocks (NSE + BSE): relative strength,
Weinstein-style stages, industry rotation, market breadth and chart setups.
It updates itself every weekday evening and costs nothing to run.

**Live site:** https://stage-lab-tkku.netlify.app

## How it works

```
GitHub Actions, weekdays 7:15 pm IST (and 9:45 pm as a catch-up)
  1. restore saved data from the `data` branch
  2. download the day's exchange files      engine/sources.py, engine/indices.py
  3. compute RS, stages, breadth, setups   engine/compute.py and friends
  4. save data back to the `data` branch
  5. push the finished site to the `site` branch, which Netlify publishes
```

- **Prices:** NSE daily bhavcopy, with BSE's for BSE-only stocks. Yahoo Finance is the fallback.
  Missing days are filled in automatically on the next run. Known market holidays are
  remembered so they aren't requested again.
- **Industries and market cap:** BSE company data, cached for 90 days.
- **Index values** (Nifty 100, Nifty MidSmallcap 400, Nifty 500 and others): NSE's daily index file.
- **Storage:** the `data` branch holds one commit with the latest price history, so the repo
  doesn't grow over time.

## Pages

Overview, Market breadth, Industries (with a rotation chart), Stage 2 stocks and candidates,
RS screen, Chart setups (Cup & handle / VCP and High tight flag), Stage 2 history, Watchlist,
Journal, and a page for every stock, sector and industry. Press ⌘K (or /) anywhere to search.

## Watchlist and Journal (Supabase)

Your watchlists and trades live in a free Supabase database, so they sync across devices.
You sign in with an emailed link (no password). Row-level security means each signed-in
person can only ever see their own rows, even though the site is public.

One-time setup:
1. Create a free project at supabase.com.
2. SQL Editor: run `supabase/schema.sql`.
3. Authentication → URL Configuration: set Site URL to the live site and add `<site>/**` to Redirect URLs.
4. Put the Project URL and the public (anon / publishable) key in `site/config.js`. Never the service_role key.
5. After your first sign-in, you can turn off "Allow new users to sign up" under Authentication → Sign In / Providers,
   so nobody else can create an account on your database.

## Method

| Piece | Method |
|---|---|
| Price | Last traded price |
| Averages | 50, 150 and 200-day simple averages |
| RS 12M / 3M | 40% weight on the latest quarter and 20% on each of the three before it (63-day slices for 12M, 15-day slices for 3M), ranked 1–100 across all stocks |
| Stage 2 | All 8 rules: price above the 50/150/200-day averages, 150-day above 200-day, 200-day higher than a month ago, 15%+ above the 52-week low, within 25% of the 52-week high, RS floor |
| Stage 1/3/4 | Moving-average structure |
| Stage 2 candidate | 6+ of the 8 rules met, missing only pullback rules |
| Health score | Equal-weight average of the rising/falling split, new highs vs lows, and % of stocks above their averages |
| Rotation chart | Each group's equal-weight index vs the Nifty 500: 13-week relative strength (x) and its 4-week change (y) |

All tunable settings are in `engine/config.py`. Not investment advice.

## Running it yourself

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m engine.run_daily              # first run downloads ~20 months of history
python3 -m http.server 8000 -d site     # then open http://localhost:8000
python -m pytest -q tests               # tests
```

## Branches

- `main`: code
- `data`: latest price history, industry data and the holiday list (one commit, replaced each run)
- `site`: the finished website, replaced each run; Netlify deploys it automatically

To run the job by hand: Actions tab → **daily-update** → **Run workflow**.
If a run fails, GitHub emails you; the next run fills in anything missed.

Charts use [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) (Apache 2.0);
the database client is [supabase-js](https://github.com/supabase/supabase-js) (MIT).
