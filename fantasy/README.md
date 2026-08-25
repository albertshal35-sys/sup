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
bye weeks, and risk flags. Two price columns, because they are two different questions:
**Value $** is what a player is worth, and **Expect $** is what this room actually paid at
his positional rank last year. The gap between them is the edge.

**The Leap** — situational calls the price sheet cannot make: who moved up a depth chart,
whose team lost half its targets, who changed coaches, who was being fed by December, and
what each 2026 schedule actually serves up. Scored against the board rather than in place
of it, with its own accuracy printed at the top.

**Auction Room** — log every sale as it happens, yours and everyone else's. It tracks your
budget, your maximum legal bid, the live inflation rate, and what your room has actually
been paying for each position against list — then tells you what a player is worth *right
now*, the most you should pay, and which position your money is stretching furthest in.

**The Matrix** — all 40 metrics correlated against each other and clustered into a heatmap,
so the duplicates fall into blocks; which stats are already inside the price and which know
something it does not; a chart of price against the size of a player's job, with the two
corners that survived a proper control marked on it; and a sortable player-by-metric grid
where every cell is shaded by how far that player sits from the average at his own position.

## How the numbers were built

Everything is derived from [nflverse](https://github.com/nflverse/nflverse-data) play-by-play
aggregates covering **1999–2025** — 15,873 scored player-seasons, plus team defense and
kicking — re-scored under the league's exact rules.

1. **Score every season** under these rules (`build_base.py`).
2. **Measure what carries over** — year-over-year correlation of every usage and efficiency
   metric against next-season output (`analyze.py`).
3. **Strip touchdown luck** — build expected fantasy points from volume alone, then test
   whether the residual repeats (`model2.py`). It mostly does not.
4. **Project** — one gradient-boosted model per position for points per game, blended 75/25
   with last season's actual points; expected games from an empirical durability curve
   conditioned on the depth chart, because the model for it lost to arithmetic
   (`project2026.py`, `games_test.py`).
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
season averages **12.7 games** the next one; one with three full seasons behind him averages
14.2, and one who missed most of last year but still holds the job averages far more than
his games played suggest. Every projection here is points per game times *expected* games,
and that second term comes from the empirical durability curve described under Pricing —
not from a model, which lost to arithmetic.

**Kicker and defense are coin flips.** Year-over-year rank correlation of 0.33 and 0.26.
The board holds exactly ten of each at $1 — which is what this room pays: all ten defenses
went for $1 in 2025 and eight of nine kickers did. The Auction Room caps your bid at $2.

### Pricing

A player's price is what he scores above **replacement** — the last man who actually starts
somewhere, flex included. Those surpluses are scaled so the league's whole discretionary
budget (total money minus the $1 each roster spot must reserve) is exactly accounted for.
The board sums to $2,000 against $2,000 in the room, prices exactly 170 players, and holds
exactly ten kickers and ten defenses at $1 each.

That lands at roughly **28% of your money on quarterbacks, 28% on backs, 36% on receivers,
7% on tight ends, and 1% on kicker and defense combined.**

#### Corrected: the games-played model lost to two lines of arithmetic

Projected points are points-per-game times **expected games**, so the games estimate is
half of every number on this board. It was also the half nobody validated, and it did not
survive being asked to. Two of its 2026 outputs made the case on their own:

    Joe Burrow      played  8 games in 2025  ->  projected 16.0
    Jayden Daniels  played  7 games in 2025  ->  projected  8.7

Same evidence, opposite conclusions. A tree handed a dozen correlated features will invent
structure in noise, and availability is mostly noise.

On the loss that actually matters — error in projected **season points** across the 150
players who get priced — the gradient-boosted model, a linear shrinkage and an empirical
curve are indistinguishable: **63.4 / 63.1 / 63.4** points over ten holdout seasons. So the
choice is not made on accuracy, because accuracy does not move. It is made on **coherence**,
and the other two fail it: the model is non-monotone (above), and linear shrinkage fitted to
MAE on the crowded middle blows out the tail, projecting 15.8 games for a back with three
full seasons behind him against an empirical 14.2.

What ships is the empirical curve itself — an isotonic fit of next-season games on a 2-1-1
weighted average of the last three seasons, per position. Monotone by construction.

**Then the depth chart, which fixed the real damage.** A curve conditioned on games played
alone cannot tell a franchise starter who got hurt from a backup who lost his job, and it
buried Lamar Jackson, Jayden Daniels and Joe Burrow at a few dollars each. The split is
large:

| QB who played 1–9 games | next season |
|---|---|
| …and is the preseason QB1 | **10.8** games (n=29) |
| …and is the QB2 | 4.7 games (n=84) |

Blending the games-only curve with the mean for the player's (depth, games) cell, weighted
`n / (n + 20)`, improves holdout MAE from **3.619 to 3.516** games and is better or equal in
every test season. Depth charts only exist from 2021, which is why this is a correction on
top of the curve rather than the curve itself.

#### Corrected: the projections were too timid at the top

A gradient-boosted model predicts a conditional **mean**. That is the right target for one
player and the wrong one for a market: conditional means shrink toward the population
average, so the predicted *distribution* comes out narrower than the real one. Over twelve
seasons the projected QB1-minus-QB12 gap was **96 points where the realised gap is 121**.

The symptom at an auction is a curve with no cliff. The board priced QB6 within a dollar or
two of QB3, in a room whose quarterback prices fall off a shelf after QB5 ($31 → $20 → $16).

Each position's spread is now rescaled around its own replacement level by a multiplier
measured from history — QB ×1.17, RB ×1.29, WR ×1.11, TE ×1.10 — and validated
leave-one-season-out. It cuts the error in points-per-rank at **every** position: QB +4.3,
RB +4.1, WR +1.8, TE +0.8 points a rank.

This is calibrated to what players actually **score**, not to what this room **pays**.
Matching the room's quarterback prices would erase the very gap the tool exists to find.

#### Value is not price

Even with correct projections, the board says the top quarterback is worth $54 and this room
has never paid near that. Both things are true, and printing only one of them makes the board
useless as a bid guide. So there are two columns:

| | |
|---|---|
| **Value $** | Surplus over replacement, scaled to the league's money. What he is worth. |
| **Expect $** | What this room actually paid at that positional rank in 2025, smoothed monotone. |

The room's own curves, which is where Expect $ comes from:

```
QB: 42 38 36 35 31 | 20 16 16 13 12 12 12 …   (27 bought)
RB: 60 60 58 45 43 | 41 40 39 37 36 36 33 …   (40 bought)
WR: 60 49 49 47 47 | 44 41 37 36 36 30 27 …   (59 bought)
TE: 27 16 11  8  5 |  4  3  2  1  1  1  1 …   (13 bought)
```

A first attempt used a single multiplier per position (quarterbacks cost 63¢ on the dollar,
and so on). It put QB1 correctly at $32 but inflated the top running back to $75 in a room
whose most expensive back went for $60 — each position has its own *shape*, not just its own
level, so the rank map replaced it.

One caveat, stated plainly: **this is one season of one league.** It is a forecast of a
ten-person habit, not a law. 2025's QB1 went for $42, at the top of the $30–35 range the
league's own members describe as typical, so treat the Expect column's top row as a ceiling
rather than a centre.

#### Corrected: the price curve used to be far too flat

An earlier version measured surplus against the last man **bought** at each position
(~rank 150 of the skill pool) rather than the last man who **starts** (~rank 60), on the
reasoning that everyone below that line costs a dollar anyway. That had it exactly
backwards — everyone below the line costing a dollar is precisely *why* replacement belongs
there. Drawing it at rank 150 left almost every rostered player holding a large surplus, so
the money spread evenly instead of concentrating.

Checked against this room's own 2025 draft sheet:

| rank | this room paid | old board | corrected |
|---|---|---|---|
| 1 | $60 | $37 | **$56** |
| 10 | $44 | $30 | **$42** |
| 30 | $27 | $23 | **$30** |
| 50 | $12 | $15 | $15 |
| 110 | $1 | $7 | **$1** |

Mean error against the room's curve falls from **$4.53 a rank to $1.04**, the top-ten share
of the budget goes from 16.6% to 24.0% against the room's 26.1%, and the number of players
priced at a dollar goes from 15 to 82 against the room's 63. No exponent or fudge factor is
involved: sweeping one bought another $0.08 a rank, which is not worth a parameter fitted to
a single draft. The replacement levels were already computed correctly further up the file —
the pricing block simply recomputed a different, wrong cut and ignored them.

The same bug was in `auction_sim_real.py` and `room_bias2.py`, so every strategy finding and
every room ratio below was recomputed after the fix. Two secondary fixes came with it:
kickers and defenses were bidding against skill players for a share of surplus, which put
six extra kickers on the board and $72 into positions this room pays $22 for, and several
downstream filters used `auction >= 2` as a proxy for "draftable" — fine under a flat curve,
wrong once 82 of the 170 rostered players sit at exactly $1.

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
| **LOAD** | Touches a week his 2026 role pays, **plus** what he actually got — see below. Replaces LIFT, which had the sign backwards. |

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

**Track inflation (+6.9).** The largest durable edge. Bidders who re-priced the board as
money left the room beat bidders who stuck to preseason values. When early lots go cheap
the leftover cash has to land on somebody. This is why the app asks you to log the players
you *lose* — those sales tell you more than your own do.

**Do not play stars and scrubs (−6.9).** The worst strategy tested. This lineup starts nine
and flexes a tenth; three stars and six holes loses more in the holes than it gains at the
top. The best-performing honest strategy spent about $163 of $200 and finished around
3 QB, 4 RB, 6 WR, 2 TE.

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
be arbitraged away by the other managers, because it is defined by them.

### LOAD — a stat built for finding breakouts

    LOAD = touches a week his 2026 job normally pays
         + touches a week he actually got in 2025

Each half is standardised inside position and the two are added, because a quarterback
drops back thirty-five times and a third receiver sees five. What each rung of the depth
chart pays is measured, not assumed:

| | 1st | 2nd | 3rd |
|---|---|---|---|
| QB | 35.1 | 15.0 | 25.0 |
| RB | 16.8 | 8.0 | 4.0 |
| WR | 6.5 | 5.6 | 4.1 |
| TE | 4.5 | 1.9 | 1.3 |

One number for the size of a player's job, counting both the part he has already proven and
the part the depth chart just handed him. The board sees neither cleanly: it projects
fantasy *points*, and two players with identical projections can arrive there on volume or
on touchdowns. The volume one repeats.

**Between the top and bottom third, at the same price: +35.9 points** of season-long
residual, ±7.8, **t = 4.6**, over 560 player-seasons in 2022–2025. The pay curve is refit
with each test season removed, so it never scores a year it has already seen.

"At the same price" is doing real work in that sentence — see the retraction below.

#### Retracted: LIFT had the wrong sign

This repo previously shipped **LIFT** = role *minus* last year's usage — the "room to grow"
— at **+29 points**, 5.8 standard errors. That number was reproducible and it was not the
stat. High-LIFT players are cheap players (LIFT correlates **−0.43** with what the board
charges), and cheap players beat their projections for a reason that has nothing to do with
role: projections overshoot at the top and undershoot at the bottom. Ranking on **price
alone** collects +17 points of the same effect.

Comparing only players who cost about the same, LIFT collapses:

| held at a fixed price | spread | t |
|---|---|---|
| LOAD (role **+** usage) | **+35.9** | **4.6** |
| role alone | +23.6 | 2.8 |
| last year's usage alone | +3.0 | 0.4 |
| LIFT (role **−** usage) | +8.2 | 1.0 |
| price alone — the null | −3.4 | −0.4 |

The cause is arithmetic, not calibration. *Both* halves predict the miss positively, so
subtracting one from the other cancels the signal. A regression allowed to choose its own
weights wants **(+13.5, +9.1)**; LIFT forced **(+1, −1)**. LOAD adds them instead.

Three independent checks agree — the sum beats the difference, the fitted weights are both
positive, and the partial correlation after projecting out price is +0.196 (t 4.9) for the
sum against +0.038 (t 0.9) for LIFT. The 8-signal Leap model never used LIFT, so its +29
result is unaffected.

#### The version that failed first

The first attempt, RUNWAY, multiplied a player's efficiency over his own teammates by the
opportunity going spare. It returned **+1.1 points**, well inside the noise. The post-mortem
is the useful half: efficiency over one's own teammates graded out **negative** (−0.050).
Coaches do not hand work to the efficient backup, and a high rate on few touches is mostly
small sample. Both failures point the same way: measure the *job*, not the running.

### The correlation matrix, and the trap it caught

Every stat here was tested on its own. That is not the same as testing whether it adds
anything the others do not already say. `corrmatrix.py` correlates all 40 metrics against
each other over 12,073 player-seasons and clusters them, then asks two questions.

**Which stats are the same stat.** 39 pairs correlate at |rho| ≥ 0.85 — target share and
WOPR at 0.990, points/gm and expected points/gm at 0.985, season points and board VORP at
0.947. Anything inside a block can be dropped without losing information, which is why the
rankings table carries five columns and not forty.

**What is independent of price.** A stat correlated with what a player costs is already in
the price; you are paying for it. This screen is what promoted LIFT, and it is also what
nearly buried its replacement:

| | in the price | knows the board's miss |
|---|---|---|
| Depth chart climb | +0.187 | **+0.153** |
| LIFT (retracted) | −0.427 | +0.171 |
| Role (touches) | +0.485 | +0.121 |
| Season points | +0.904 | −0.083 |
| Floor rate | +0.867 | −0.077 |
| **LOAD** | **+0.852** | **+0.079** |

Read the bottom rows together: everything the board prices heavily predicts its own miss
*negatively*. That is regression to the mean — expensive players disappoint, as a class.
LOAD is the single exception, and that is the whole reason it survives a control that LIFT
does not.

The lesson generalises. "Uncorrelated with price" and "adds something at a given price" are
different claims, and only the second one is worth money. Screening on the first promotes
stats whose entire edge is that they point at cheap players.

#### The player grid

`playergrid.py` drops the same idea one level down: 150 priced players as rows, twelve
metrics as columns, every cell a z-score inside the player's own position, shaded teal for
favourable and rust for unfavourable. Three columns (TD luck, blank weeks, age) have their
colour flipped because the good direction is down.

The columns are held to the tab's own standard — no two may correlate above the 0.85 that
defines a duplicate. That is an assertion in the build, and it **fired twice**: `touches`
turned out to be literally the same column as `prior use` for every non-quarterback
(targets + carries either way), and `role` ran 0.888 against prior use. Both were cut. The
closest surviving pair is points/gm against floor rate at 0.657. Price is exempt from the
check — it is the benchmark the other columns are read against, not a rival signal, so its
0.87 against projected points is the design rather than a fault.

Only the LOAD column carries a validated edge. The rest are descriptive: they show what you
are buying and where a profile disagrees with itself, not that disagreement is profitable.
Sorting a twelve-column grid will always surface somebody — that is what sorting does.

### The Leap: situational signals

The board prices a player on what he did. A breakout list can only add value if it predicts
what the board *missed*, so the target is the residual — points above or below projection —
and every signal is computed for past seasons too and scored leave-one-season-out.

| Signal | What it is |
|---|---|
| **Climb** | Depth chart position today against last preseason |
| **Vacated** | Targets and carries that left his team |
| **Coach** | New head coach (7 teams for 2026) |
| **Trend** | Back-half usage minus front-half usage last season |
| **TD luck** | Scored under what his volume deserved |
| **Leap** | Year two and three, where the age curve is steepest |
| **SOS** | 2026 opponents graded on what they allowed to his position in 2025 |

Between the top fifth and the bottom fifth: **+29 points** of season-long residual, ±5.4,
across 1,609 player-seasons. Rank correlation 0.176 — modest, and stated as such on the tab.

Depth chart position and movement carry nearly all of it. Schedule finished near the bottom.
Changing teams is a **negative** on average, which is the opposite of how a draft room
usually treats it.

One correction worth recording: the first version of this measured +54 points, because it
used end-of-season depth charts to "predict" seasons that had already happened. Using the
preseason snapshot — the only thing you actually have in August — halved the effect. The
+29 is the honest number.

### Your room, measured

The 2025 draft sheet (`pipeline/data/league_2025.csv`, parsed from the league tracker) says
this is not a hypothetical. Comparing what the ten teams paid against what those players
were worth going into 2025:

| | Paid | Board said | On the dollar |
|---|---|---|---|
| QB | 17.9% | 27.6% | **65¢** |
| TE | 4.2% | 11.2% | **37¢** |
| WR | 41.6% | 38.9% | 107¢ |
| RB | 36.3% | 22.4% | **162¢** |

The biggest bargains in the room were quarterbacks — Goff at $9 against $41 of value,
Mayfield at $12 against $42. **All eight of the biggest overpays were running backs**:
McCaffrey $43 against $1, Gibbs $60 against $20, Bijan $60 against $30, Saquon $58 against
$29, Chase Brown $40 against $17.

**This league bids a two-quarterback format as though it were a normal one**, and pays for
it at running back. That is a large, specific, repeatable edge, and it is the one place a
positional lean is justified — because it is a measurement of the nine people you are
bidding against rather than a rule imported from somewhere else.

Note what the pricing fix did to this table. Under the old flat curve the room read as
overpaying receivers by 11% as well; with replacement drawn correctly, receivers come out
at **107¢ — near fair** — and the whole distortion resolves to two positions. The
conclusion got sharper, not softer, which is the useful kind of correction.

The Auction Room starts from these ratios and shrinks toward tonight's sales as they
accumulate; after about eight sales at a position the live read dominates. One caveat worth
holding: part of the running-back gap is the projections being conservative about elite
players, since they multiply points per game by *expected* games. The quarterback and tight
end gaps cannot be explained that way.

### Sanity check against the wider market

Every number above is fitted to this league's own rules and this room's own sheet, which is
the point — but it also means nothing external ever contradicts it. So: how does the board
compare with published 2QB/superflex auction guidance?

| | consensus (12-team superflex) | this board (10-team, 2QB, full PPR) |
|---|---|---|
| QB1 price | $42–65 | **$48** |
| QB tier 2 | $36–48 | Herbert $32, Mahomes $23 |
| QB tier 3 | $20–34 | Goff $30, Mayfield $40 |
| Share of budget at QB | 35–45% | **24%** |

The top of the quarterback market lands inside the published range. The **share** does not,
and that gap is expected rather than reassuring: consensus figures are for 12-team rooms,
where replacement at every position is thinner and quarterbacks are correspondingly scarcer.
Ten teams means better streamers and a lower ceiling on what any one starter is worth.

Where the board disagrees hardest is on **players coming off injury**. Consensus has Lamar
Jackson, Jayden Daniels and Joe Burrow near the top of the position; this board has them at
$9, $8 and $0. That is not a bug and it is not shrinkage — it is the durability curve doing
what the data says, and the data says a quarterback who missed most of a season plays 10.8
games the next one even when he keeps the job. Consensus projects those players healthy.

**Treat that as a live disagreement, not a verdict.** If you believe Jackson is a 16-game
quarterback, the board is wrong about him and you should bid accordingly — it is one input,
and this is the input it is least sure of.

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
python wins.py                  # WAA / Floor / Spike / Blank
python breakout.py              # The Leap panel + 8-signal model
python load.py                  # LOAD, and the price-held-fixed control
python corrmatrix.py            # the 40-metric correlation matrix
python standouts.py             # the corners of the price-vs-LOAD chart
python playergrid.py            # the player-by-metric grid
python games_test.py            # does the games model beat arithmetic? (it does not)
python decompress.py            # fit the per-position spread correction (run before the board)
python price_shape2.py          # check the price curve against the room's own sheet
python expected_price.py        # value vs what this room actually pays
python build_app.py             # emit the app
```

Two scripts are kept only because they document failures: `runway.py` (the breakout stat
that returned nothing) and `lift.py` (the retracted stat). `standouts_null.py` and
`lift_decomp.py` are the controls that caught the retraction and are worth reading before
trusting any "cheap X" screen.

`build_app.py` writes `out/standalone.html`, which is what ships as `index.html`.

## What this does not know

No beat reporting, camp buzz, press conferences, or contract talk. Depth charts, rosters and
coaching changes **are** in there and are current as of the build date, but a hamstring
reported this morning is invisible. Where the model and your ears disagree about a job
battle, trust your ears. A player who changed teams is still projected from his old team's
usage. Rookies get the historical
average for their draft-capital bucket and nothing else — no scouting.

Treat it as a price sheet built from what actually happened, not a substitute for knowing
your league. When you know something the box score does not, override it.

And nothing here guarantees a win. The measured edges are worth roughly half a win to a
win a season against managers bidding off a generic sheet, which is a real advantage and
not a certainty. Anyone selling you more than that is selling you a story.
