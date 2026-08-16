# Gridiron Moneyball

An auction board and live bidding assistant for one specific league:

| | |
|---|---|
| Scoring | Full PPR |
| Starters | 2 QB · 2 RB · 3 WR · 1 TE · 1 FLEX (RB/WR/TE) · 1 D/ST · 1 K |
| Bench | 6 |
| Roster | 17 |
| Teams | 12 (configurable) |
| Format | **Auction**, $200 budget (configurable) |

The lineup is the whole point. Almost every ranking you can find online is built for a
one-quarterback league, and in a two-quarterback league those rankings are wrong in a way
that costs games. Everything here is computed against *these* rules.

## What it is

`index.html` is a single self-contained file — no build step, no network calls. Open it in
any browser, including on a phone at the draft table.

**Rankings** — every draftable player priced in dollars, with projections, tiers, VORP,
bye weeks, and risk flags. The prices sum to the money in the room: 12 teams × $200 =
$2,400 on the board, so a player's price is his share of the league's budget.

**Auction Room** — log every sale as it happens, yours and everyone else's. It tracks your
budget, your maximum legal bid, and the live inflation rate, then tells you what each
player is worth *right now* and the most you should pay.

## How the numbers were built

Everything is derived from [nflverse](https://github.com/nflverse/nflverse-data) play-by-play
aggregates covering **1999–2025** — 15,873 scored player-seasons, plus team defense and
kicking — re-scored under the league's exact rules.

1. **Score every season** under these rules (`build_base.py`).
2. **Measure what carries over** — year-over-year correlation of every usage and efficiency
   metric against next-season output (`analyze.py`).
3. **Strip touchdown luck** — build expected fantasy points from volume alone, then test
   whether the residual repeats (`model2.py`). It mostly does not.
4. **Project** — one gradient-boosted model per position for points per game, a second for
   games played, blended 75/25 with last season's actual points (`project2026.py`).
5. **Replay history** — strategies compete against each other across replayed seasons using
   real weekly scores and optimal weekly lineups (`simulate.py` for snake, `auction_sim.py`
   for auction).
6. **Control every positional claim** — before believing a premium, run the same premium on
   a different position and check that its mirror moves the other way
   (`tilt_test.py`, `tilt_confirm.py`, `weight_sweep.py`).

### The findings that shaped the board

**The two-quarterback rule is the league.** Starting two QBs drags replacement level from
QB13 down to QB25, which adds about **85 points** of value to the top quarterback compared
to a standard league. Twenty-four QBs start every week and roughly thirty-two exist. In the
simulations, waiting on quarterback was the single most damaging thing a team could do.

**Buy volume, never touchdowns.** Carries and targets are the stickiest things a player
owns (year-over-year rank correlation ≈ 0.72–0.74). Yards per carry (0.24) and touchdowns
per touch (0.23) are close to noise. Players who most outscored their own usage lost
2–3 points per game the following season, every position, every era.

**Availability is a projection input, not a footnote.** A running back who plays a full
season averages **12.7 games** the next one. Receivers 13.1, quarterbacks 13.6. Every
projection here is points per game times *expected* games.

**Kicker and defense are coin flips.** Year-over-year rank correlation of 0.33 and 0.26.
They are priced at a dollar or two and the Auction Room caps your bid on them at $2.

### Pricing

A player's price is what he scores above the last man bought at his position — not above
the last *starter*, because everyone below that line costs a dollar. Those surpluses are
scaled so the league's whole discretionary budget (total money minus the $1 each roster
spot must reserve) is exactly accounted for. The board sums to $2,399 against $2,400 in
the room.

That lands at roughly **20% of your money on quarterbacks, 27% on backs, 39% on receivers,
11% on tight ends, and 2% on kicker and defense combined.**

### What the auction study found

Twelve bidding strategies competed in replayed auctions across 2014–2025 — random
nomination order, English bidding settled at second price plus a dollar, every team forced
to finish with a legal roster and forbidden from bidding money it needs to fill its slots.
Rosters were then scored on real weekly results with optimal weekly lineups.

| Strategy | Win rate |
|---|---|
| Pay 25% over list for quarterbacks | **55.4%** |
| Pay 25% over list for receivers | 53.5% |
| Bid only 85% of list | 52.4% |
| Re-price as the money moves | 50.8% |
| Discount quarterbacks | 49.1% |
| Pay 115% of list across the board | 48.1% |
| Ignore inflation, use preseason values | 45.0% |
| Stars and scrubs | **39.1%** |

Three things came out of it, each ±0.4 points:

**Pay up for quarterbacks (+4.5).** In a two-QB league, 24 starters come out of a pool of
roughly 32. Paying a quarter over list beat neutral bidding; discounting them lost 6.3
points relative to that. The mirror moving the other way is what makes it credible — and
the same premium on running backs was worth +0.6, near enough to nothing, so this is the
format talking rather than an artifact of multiplying a number. Your bid ceilings in the
Auction Room already include it.

**Track inflation (+5.8).** The largest single edge. Bidders who re-priced the board as
money left the room beat bidders who stuck to preseason values by 5.8 points. When early
lots go cheap the leftover cash has to land on somebody. This is why the app asks you to
log the players you *lose* — those sales tell you more than your own do.

**Do not play stars and scrubs (−11.8).** It was the worst strategy tested by a wide
margin. This lineup starts nine and flexes a tenth; three stars and six holes loses more in
the holes than it gains at the top. Winning teams spent about $171 of $200 and finished
around 3 QB, 4 RB, 6 WR, 2 TE.

## Reproducing it

```bash
cd pipeline
./fetch_data.sh                 # ~120 MB from nflverse
pip install pandas numpy scikit-learn scipy pyarrow
python build_base.py            # score every season
python analyze.py               # stickiness, age curves, replacement levels
python model2.py                # touchdown-luck study + model bake-off
python simulate.py              # snake strategy tournament
python optimize.py              # formula search
python validate.py              # out-of-sample check
python cache_boards.py          # cache projections for the experiments below
python tilt_test.py WR          # positional premium sweep
python tilt_test.py RB          # the control
python tilt_confirm.py WR 1.3   # two-arm, season by season
python weight_sweep.py          # retune need + scarcity weights
python auction_sim.py           # auction strategy tournament
python project2026.py           # build the board
python build_app.py             # emit the app
```

`build_app.py` writes `out/standalone.html`, which is what ships as `index.html`.

## What this does not know

No injury reports, depth charts, holdouts, suspensions, coaching changes, or camp news. A
player who changed teams is projected from his old team's usage. Rookies get the historical
average for their draft-capital bucket and nothing else — no scouting.

Treat it as a price sheet built from what actually happened, not a substitute for knowing
your league. When you know something the box score does not, override it.
