"""Stage 8: auction strategy tournament.

Same replayed seasons and real weekly scores as the snake-draft study, but the
draft is now an open auction: 12 teams, a fixed budget, nominations in random
order, English bidding settled at second price plus a dollar.

Strategies differ only in how they value a player and how hard they chase him.
Every team must still finish with a legal roster, and nobody may bid money they
would need to fill their remaining slots.
"""
import pandas as pd, numpy as np, json, warnings, sys
warnings.filterwarnings("ignore")
import sim_env
sim_env.load(globals())

LINEUP_A = dict(QB=2, RB=2, WR=3, TE=1)
FLEXP = ("RB", "WR", "TE")

def realistic_weekly(pos_arr, wk_mat, proj):
    """Fixed starters chosen by projection; a blank week promotes the backup."""
    n, W = wk_mat.shape
    order = np.argsort(-proj)
    starters, used = {}, set()
    for p, cnt in LINEUP_A.items():
        picks = [i for i in order if pos_arr[i] == p and i not in used][:cnt]
        starters[p] = picks
        used.update(picks)
    flex = [i for i in order if pos_arr[i] in FLEXP and i not in used][:1]
    used.update(flex)
    bench = [i for i in order if i not in used]

    total = np.zeros(W)
    for w in range(W):
        active = []
        for p, cnt in LINEUP_A.items():
            for i in starters[p]:
                if wk_mat[i, w] > 0:
                    active.append(i)
                else:
                    # he is out this week; the best bench body at the spot plays
                    sub = next((j for j in bench if pos_arr[j] == p
                                and j not in active and wk_mat[j, w] > 0), None)
                    active.append(sub if sub is not None else i)
        for i in flex:
            if wk_mat[i, w] > 0:
                active.append(i)
            else:
                sub = next((j for j in bench if pos_arr[j] in FLEXP
                            and j not in active and wk_mat[j, w] > 0), None)
                active.append(sub if sub is not None else i)
        total[w] = sum(wk_mat[i, w] for i in active)
    return total




ALL = list(range(2014, 2026))
BUDGET = 200
SPOTS = 15                      # 9 starters + 6 bench; K and D/ST cost $1 each and are excluded
LINEUP_A = dict(QB=2, RB=2, WR=3, TE=1)
FLEXP = ("RB", "WR", "TE")


def price_board(board, rep):
    """Standard auction pricing: surplus over the last player who gets drafted,
    scaled so the league's whole discretionary budget is spent."""
    b = board.copy()
    b["vorp"] = b.proj_blend - b.position.map(rep)
    drafted = b.nlargest(TEAMS * SPOTS, "vorp")
    cut = {}
    for p in ("QB", "RB", "WR", "TE"):
        d = drafted[drafted.position == p]
        cut[p] = float(d.proj_blend.min()) if len(d) else float(b[b.position == p].proj_blend.min())
    b["surplus"] = np.maximum(0.0, b.proj_blend - b.position.map(cut))
    pool = b.nlargest(TEAMS * SPOTS, "vorp")
    tot = pool.surplus.sum()
    disc = TEAMS * BUDGET - TEAMS * SPOTS
    b["price"] = 1.0 + (b.surplus / tot) * disc if tot > 0 else 1.0
    b.loc[~b.index.isin(pool.index), "price"] = 1.0
    return b


class Team:
    __slots__ = ("budget", "roster", "counts", "strat")

    def __init__(self, strat):
        self.budget = BUDGET
        self.roster = []
        self.counts = dict(QB=0, RB=0, WR=0, TE=0)
        self.strat = strat

    def spots_left(self):
        return SPOTS - len(self.roster)

    def max_bid(self):
        return self.budget - (self.spots_left() - 1)

    def needs(self):
        n = {p: max(0, LINEUP_A[p] - self.counts[p]) for p in LINEUP_A}
        surplus = sum(max(0, self.counts[p] - LINEUP_A[p]) for p in FLEXP)
        n["FLEX"] = max(0, 1 - surplus)
        return n


def willingness(team, row, infl, forced, pressure):
    """What this team will pay for this player, in dollars.

    `pressure` is the team's own money-to-value ratio over the seats it still has
    to fill. Every real bidder has it: unspent budget is worthless, so a team
    holding cash with slots open bids above list. Strategies differ in how they
    value players, not in whether they obey that."""
    s = team.strat
    if team.spots_left() <= 0:
        return 0
    cap = CAPS_A.get(row.position, 99)
    if team.counts[row.position] >= cap:
        return 0
    base = row.price * (infl if s.get("inflation") else 1.0)
    base *= max(1.0, pressure)
    n = team.needs()
    starters_open = sum(v for k, v in n.items() if k != "FLEX") + n["FLEX"]
    if forced and starters_open >= team.spots_left():
        # must fill a starting slot with this pick or run out of room
        if not (n.get(row.position, 0) > 0 or (n["FLEX"] > 0 and row.position in FLEXP)):
            return 0
    base *= s.get("mult", {}).get(row.position, 1.0)
    if n.get(row.position, 0) > 0:
        base *= s.get("need", 1.0)
    elif row.position in FLEXP and n["FLEX"] > 0:
        base *= 1.0 + (s.get("need", 1.0) - 1.0) * 0.5
    else:
        base *= s.get("surplus", 1.0)
    # stars-and-scrubs: overpay at the top, refuse to pay for the middle
    if s.get("stars") and row.vorp > 0:
        rank = row.vrank
        base *= 1.18 if rank <= s["stars"] else 0.80
    base *= s.get("aggr", 1.0)
    return int(max(0, min(base, team.max_bid())))


CAPS_A = dict(QB=3, RB=6, WR=7, TE=3)


def build_pool(b):
    """The lots that go up for bid. Ranking purely by VORP starves the deep
    positions — every team needs two quarterbacks and one tight end, so the pool
    must hold enough of them for the room to fill legal rosters."""
    floor = dict(QB=3 * TEAMS, TE=2 * TEAMS, RB=5 * TEAMS, WR=6 * TEAMS)
    keep = set()
    for pos, n in floor.items():
        keep |= set(b[b.position == pos].nlargest(n, "vorp").index)
    keep |= set(b.nlargest(TEAMS * SPOTS + 40, "vorp").index)
    return b.loc[sorted(keep, key=lambda i: -b.vorp.loc[i])].copy()


def run_auction(b, strats, rng):
    teams = [Team(s) for s in strats]
    pool = build_pool(b)
    pool["vrank"] = np.arange(1, len(pool) + 1)
    order = rng.permutation(len(pool))
    total_value = pool.price.sum()
    spent = 0.0
    bought_value = 0.0
    prices = pool.price.values
    remaining_value = prices.copy()
    for oi in order:
        live = [t for t in teams if t.spots_left() > 0]
        if not live:
            break
        row = pool.iloc[oi]
        spots_open = sum(t.spots_left() for t in live)
        money_disc = sum(max(0, t.budget - t.spots_left()) for t in live)
        top_left = np.sort(remaining_value)[::-1][:spots_open]
        value_disc = max(float(np.maximum(top_left - 1.0, 0).sum()), 1.0)
        infl = float(np.clip(money_disc / value_disc, 0.6, 2.5))

        bids = []
        for i, t in enumerate(teams):
            if t.spots_left() <= 0:
                bids.append((0, rng.random(), i))
                continue
            # this team's own pressure: spare cash over the value it still needs
            disc = max(0.0, t.budget - t.spots_left())
            rival = money_disc / max(len(live), 1)
            pressure = disc / rival if rival > 0 else 1.0
            bids.append((willingness(t, row, infl, True, pressure), rng.random(), i))
        bids.sort(reverse=True)
        top = bids[0]
        second = bids[1] if len(bids) > 1 else (0, 0, -1)

        if top[0] < 1:
            # nobody wants him at a real price; in a live room someone still
            # takes him for a dollar rather than leave a roster spot empty
            def can_take(t):
                if t.spots_left() <= 0 or t.budget < 1:
                    return False
                if t.counts[row.position] >= CAPS_A.get(row.position, 99):
                    return False
                n = t.needs()
                fills = n.get(row.position, 0) > 0 or (n["FLEX"] > 0 and row.position in FLEXP)
                open_st = sum(v for k, v in n.items() if k != "FLEX") + n["FLEX"]
                # never burn a slot you still need for a starter
                return fills or open_st < t.spots_left()
            ok = [i for i, t in enumerate(teams) if can_take(t)]
            # prefer a team that still needs this position, so nobody gets a
            # sixth receiver while the slot they must fill goes empty
            fits = [i for i in ok
                    if teams[i].needs().get(row.position, 0) > 0
                    or (teams[i].needs()["FLEX"] > 0 and row.position in FLEXP)]
            cands = fits or ok
            if not cands:
                continue
            wi = int(rng.choice(cands))
            price = 1
        else:
            wi = top[2]
            price = max(1, min(top[0], second[0] + 1))
        t = teams[wi]
        t.budget -= price
        t.roster.append(oi)
        t.counts[row.position] += 1
        spent += price
        bought_value += row.price
        remaining_value[oi] = 0.0
    return teams, pool


STRATS = [
    ("Value, flat", dict()),
    ("Value + inflation", dict(inflation=True)),
    ("Value + inflation + need", dict(inflation=True, need=1.15, surplus=0.85)),
    ("Stars and scrubs", dict(inflation=True, stars=5)),
    ("Balanced, no stars", dict(inflation=True, stars=0, aggr=0.95, need=1.2, surplus=0.7)),
    ("Bargain hunter (pay 85%)", dict(inflation=True, aggr=0.85)),
    ("Aggressive (pay 115%)", dict(inflation=True, aggr=1.15)),
    ("QB premium", dict(inflation=True, mult={"QB": 1.25})),
    ("QB discount", dict(inflation=True, mult={"QB": 0.75})),
    ("RB premium", dict(inflation=True, mult={"RB": 1.25})),
    ("WR premium", dict(inflation=True, mult={"WR": 1.25})),
    ("TE premium", dict(inflation=True, mult={"TE": 1.25})),
]

obs = {n: [] for n, _ in STRATS}
spend = {n: [] for n, _ in STRATS}
shape = {n: [] for n, _ in STRATS}
for season in ALL:
    board, rep = BOARDS[season]
    b = price_board(board, rep)
    mat = WKP[season].reindex(b.player_id.values).fillna(0.0).values
    pool_static = build_pool(b)
    posv = pool_static.position.values
    poolmat = mat[[b.index.get_loc(i) for i in pool_static.index]]
    poolproj = pool_static.proj_blend.values
    for ns in range(14):
        rng = np.random.default_rng((season * 8419 + ns * 37) % (2**31))
        for rot in range(12):
            order = [(t + rot) % len(STRATS) for t in range(TEAMS)]
            teams, pool = run_auction(b, [STRATS[i][1] for i in order], rng)
            sc = np.zeros((TEAMS, 17))
            for t in range(TEAMS):
                ix = np.array(teams[t].roster)
                sc[t] = realistic_weekly(posv[ix], poolmat[ix], poolproj[ix])
            wins = np.zeros(TEAMS)
            for w in range(17):
                c = sc[:, w]
                wins += (c[:, None] > c[None, :]).sum(axis=1)
            wins /= 17 * (TEAMS - 1)
            for t in range(TEAMS):
                nm = STRATS[order[t]][0]
                obs[nm].append(wins[t])
                spend[nm].append(BUDGET - teams[t].budget)
                cc = pd.Series([posv[i] for i in teams[t].roster]).value_counts()
                shape[nm].append([cc.get(p, 0) for p in ("QB", "RB", "WR", "TE")])
    print("  ", season, "done", flush=True)

rows = []
for nm, _ in STRATS:
    v = np.array(obs[nm])
    sh = np.mean(np.array(shape[nm]), axis=0)
    rows.append(dict(strategy=nm, win=v.mean() * 100,
                     se=v.std(ddof=1) / np.sqrt(len(v)) * 100,
                     spend=np.mean(spend[nm]),
                     shape=f"{sh[0]:.1f}QB/{sh[1]:.1f}RB/{sh[2]:.1f}WR/{sh[3]:.1f}TE"))
r = pd.DataFrame(rows).sort_values("win", ascending=False)
print("\n", r.round(2).to_string(index=False))
json.dump(r.to_dict("records"), open("out/research_auction_real.json", "w"), indent=1, default=str)
print("wrote out/research_auction_real.json")
