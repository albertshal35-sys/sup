# Gridiron Moneyball

An auction board and live bidding assistant for one specific league:

| | |
|---|---|
| Scoring | Full PPR |
| Starters | 2 QB · 2 RB · 3 WR · 1 TE · 1 FLEX (RB/WR/TE) · 1 D/ST · 1 K |
| Bench | 6 |
| Roster | 17 |
| Teams | 10 (configurable) |
| Format | **Auction**, $200 budget (configurable) |

The lineup is the whole point. Almost every ranking you can find online is built for a
one-quarterback league, and in a two-quarterback league those rankings are wrong in a way
that costs games. Everything here is computed against *these* rules.

## What it is

`index.html` is a single self-contained file — no build step, no network calls. Open it in
any browser, including on a phone at the draft table.

**Rankings** — every draftable player priced in dollars, with projections, tiers, VORP,
bye weeks, and risk flags. The prices sum to the money in the room: 10 teams × $200 =
$2,000 on the board, so a player's price is his share of the league's budget.

**Auction Room** — log every sale as it happens, yours and everyone else's. It tracks your
budget, your maximum legal bid, the live inflation rate, and what your room has actually
been paying for each position against list — then tells you what a player is worth *right
now*, the most you should pay, and which position your money is stretching furthest in.

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
   real weekly scores, with lineups set up front rather than with hindsight
   (`auction_sim_real.py`).
6. **Control every claim** — before believing any edge, re-run it against a different room.
   A real edge survives; a crowding trade flips sign (`field_test.py`, `qb_density.py`).

### The findings that shaped the board

**The two-quarterback rule is the league.** Starting two QBs drags replacement level from
QB11 down to QB21, which adds about **74 points** of value to the top quarterback compared
to a standard league. Twenty QBs start every week and roughly thirty-two exist, which is
why about a quarter of your budget belongs at the position. Note what this does *not*
license: see the quarterback premium below, which failed its own test.

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
spot must reserve) is exactly accounted for. The board sums to $1,995 against $2,000 in
the room.

That lands at roughly **24% of your money on quarterbacks, 28% on backs, 36% on receivers,
10% on tight ends, and 2% on kicker and defense combined.**

Ten teams matters more than it sounds. Every replacement level rises, because a shallower
league starts fewer players at each position: against a twelve-team room, quarterback
replacement climbs from QB25 to QB21 and receiver from WR43 to WR37. The players you can
stream in-season are better, which makes the expensive ones worth relatively less. The
board is rebuilt for ten; change the team count in the Auction Room and your bid ceilings
follow, but the printed prices assume a ten-team room.

### Custom statistics

Four statistics built here that you will not find on a ranking site. All four count a
missed week as a zero, because that is what your lineup scored.

| | |
|---|---|
| **WAA** | *Wins Above Available.* Converts each week into the probability it wins you that week, then sums the season, measured against the best player available for a dollar. |
| **Floor** | Share of weeks he outscored a typical starter at his position — how often he actually won you the slot. |
| **Spike** | Share of weeks in the top decile of outcomes at his position. |
| **Blank** | Share of weeks he gave you nothing at all. |

WAA forecasts realised wins **better than projected points do** — 0.719 versus 0.670 rank
correlation, winning all ten test seasons. And pricing an auction off it still **lost 7.2
points of win rate.**

That contradiction is the most useful thing in this repo. Your weekly score is a *sum*, and
sums are linear, so a player's contribution to the team is simply his points. The win curve
— the S-shaped map from score to victory — applies exactly once, when your total meets an
opponent's. WAA applies it a second time to each player individually, which double-counts
it and misprices everyone. So the board prices on points and carries WAA, Floor, Spike and
Blank as descriptive columns for breaking ties and knowing what you are buying.

### What the auction study found, and what it got wrong

Twelve bidding strategies competed in replayed auctions across 2014–2025 — random
nomination order, English bidding settled at second price plus a dollar, every team forced
to finish with a legal roster, lineups set up front rather than with hindsight. Re-run for
a ten-team room; the orderings held.

Two results survive every robustness check:

**Track inflation (+4.1).** The largest durable edge. Bidders who re-priced the board as
money left the room beat bidders who stuck to preseason values. When early lots go cheap
the leftover cash has to land on somebody. This is why the app asks you to log the players
you *lose* — those sales tell you more than your own do.

**Do not play stars and scrubs (−9.5).** The worst strategy tested by a wide margin. This
lineup starts nine and flexes a tenth; three stars and six holes loses more in the holes
than it gains at the top. The best-performing honest strategy spent about $156 of $200 and
finished around 3 QB, 4 RB, 6 WR, 2 TE.

**And one result that did not survive.** An earlier version of this tool told you to pay
25% over list for quarterbacks, on the strength of a +4.6 point win rate in that
tournament. It was wrong. That arm was competing against eleven *other* gimmick strategies.
Re-run against ordinary value bidders, the edge decays to nothing as the room catches on:

| How many pay up for QBs | Their edge |
|---|---|
| 2 | +0.9 pp |
| 4 | +0.0 pp |
| 6 | −0.5 pp |
| 8 | −0.7 pp |

Worth a little while you are one of two doing it; worth less than nothing once several
are. That is a description of a crowding trade, not a strategy.

Testing every other tilt the same way produced the same lesson. Paying up for boom-bust
players at equal projected points gained **+5.4** points when only two teams did it and
lost **−8.7** when ten did. Preferring safe, high-floor players showed the same shape
reversed. These are not strategies; they are trades against the room, and their sign flips
with the room.

So the tool ships **no fixed positional lean.** What replaces it is a live read: the
Auction Room tracks what your actual room has paid for each position against list, and
points you at whatever it is neglecting. That is the only version of "buy low" that cannot
be arbitraged away by the other eleven managers, because it is defined by them.

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

And nothing here guarantees a win. The measured edges are worth roughly half a win to a
win a season against managers bidding off a generic sheet, which is a real advantage and
not a certainty. Anyone selling you more than that is selling you a story.
