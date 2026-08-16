# Gridiron Moneyball

A draft board and live draft assistant for one specific league:

| | |
|---|---|
| Scoring | Full PPR |
| Starters | 2 QB · 2 RB · 3 WR · 1 TE · 1 FLEX (RB/WR/TE) · 1 D/ST · 1 K |
| Bench | 6 |
| Roster | 17 |
| Teams | 12 (configurable) |

The lineup is the whole point. Almost every ranking you can find online is built for a
one-quarterback league, and in a two-quarterback league those rankings are wrong in a way
that costs games. Everything here is computed against *these* rules.

## What it is

`index.html` is a single self-contained file — no build step, no network calls. Open it in
any browser, including on a phone at the draft table.

**Rankings** — every draftable player priced by value over replacement, with projections,
tiers, auction values, bye weeks, and risk flags.

**Draft Room** — log picks as they happen (yours and everyone else's) and it tells you who
to take next and why, accounting for what will still be on the board when your turn comes
back around.

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
5. **Replay history** — twelve draft strategies drafted against each other across replayed
   seasons using real weekly scores and optimal weekly lineups (`simulate.py`).
6. **Tune and validate** the winning formula on 2014–2020, then check it on 2021–2025, which
   were never used for tuning (`optimize.py`, `validate.py`).

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
Take them with your last two picks.

### The formula

For every available player:

```
score = VORP
      + 70            if he fills a starting slot you have not filled
      + 0.5 × (best VORP at his position now
               − best VORP at his position when your turn comes back)
```

VORP is projected points minus the last player at that position who would start in a
12-team league of this shape, flex included. The second term is the part most drafters get
wrong: it is not enough to know a player is good, you need to know whether the position
will still offer something comparable in two rounds. Quarterback usually will not; wide
receiver usually will.

The weights were tuned on 2014–2020 and validated on 2021–2025.

## Reproducing it

```bash
cd pipeline
./fetch_data.sh                 # ~120 MB from nflverse
pip install pandas numpy scikit-learn scipy pyarrow
python build_base.py            # score every season
python analyze.py               # stickiness, age curves, replacement levels
python model2.py                # touchdown-luck study + model bake-off
python simulate.py              # strategy tournament
python optimize.py              # formula search
python validate.py              # out-of-sample check
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
