"""Stage 10: does pricing by wins beat pricing by points?

Two boards, same auction. One prices players by projected fantasy points, the way
every ranking site does it. The other prices them by projected Wins Above
Available. Six teams bid off each board, seats rotate so neither gets a soft
draw, and the rosters are scored on real weekly results.

Both projections are leak-free: for season S, models see nothing after S-1.
"""
import pandas as pd, numpy as np, json, warnings, pickle
from sklearn.ensemble import HistGradientBoostingRegressor
from scipy.stats import spearmanr

warnings.filterwarnings("ignore")
import sim_env
sim_env.load(globals())          # BOARDS, WKP, optimal_weekly, TEAMS, LINEUP, ...

BUDGET = 200
SPOTS = 15
LINEUP_A = dict(QB=2, RB=2, WR=3, TE=1)
FLEXP = ("RB", "WR", "TE")
CAPS_A = dict(QB=3, RB=6, WR=7, TE=3)
ALL = list(range(2016, 2026))   # win metrics start in 2012; leave 3+ seasons to train on

sp = pd.read_parquet("out/player_seasons.parquet")
W = pd.read_parquet("out/win_metrics.parquet")

# ---------------------------------------------------------------- panel
base = sp.merge(W.drop(columns=["position"]), on=["player_id", "season"], how="inner")
LAGS = ["ppg", "xfp_pg", "games", "car_pg", "tgt_pg", "touch_pg", "td_pg", "target_share",
        "fpts", "waa", "flr", "spk", "ghst", "wk_sd"]
lag = base[["player_id", "season"] + LAGS].copy(); lag["season"] += 1
lag.columns = ["player_id", "season"] + [c + "_l1" for c in LAGS]
P2 = base.merge(lag, on=["player_id", "season"], how="left")
nxt = base[["player_id", "season", "waa", "fpts"]].copy(); nxt["season"] -= 1
nxt.columns = ["player_id", "season", "y_waa", "y_fpts"]
P2 = P2.merge(nxt, on=["player_id", "season"], how="left")
P2 = P2[(P2.games >= 3)]

FEAT = ["ppg", "xfp_pg", "td_luck_pg", "games", "age", "exp", "fpts",
        "waa", "flr", "spk", "ghst", "wk_sd",
        "ppg_l1", "fpts_l1", "games_l1", "waa_l1", "flr_l1", "ghst_l1",
        "car_pg", "tgt_pg", "touch_pg", "target_share", "rec_pg", "ryd_pg",
        "rushyd_pg", "pass_att_pg", "epa_pass", "epa_rec", "epa_rush"]
FEAT = [c for c in FEAT if c in P2.columns]


def hgb(depth=4, it=400):
    return HistGradientBoostingRegressor(max_depth=depth, learning_rate=0.05, max_iter=it,
                                         min_samples_leaf=20, l2_regularization=1.0, random_state=0)


def waa_board(season):
    """Projected WAA for `season`, trained only on data that predates it."""
    out = []
    for pos in ("QB", "RB", "WR", "TE"):
        tr = P2[(P2.position == pos) & (P2.season < season - 1) & P2.y_waa.notna()]
        te = P2[(P2.position == pos) & (P2.season == season - 1)]
        if len(tr) < 150 or len(te) == 0:
            continue
        m = hgb().fit(tr[FEAT], tr.y_waa)
        out.append(pd.DataFrame(dict(player_id=te.player_id.values, position=pos,
                                     proj_waa=m.predict(te[FEAT]))))
    return pd.concat(out, ignore_index=True)


def price_from(b, col, floor_col=None):
    """Auction dollars from any value column: surplus over the last man bought at
    the position, scaled so the room's discretionary budget is fully accounted."""
    b = b.copy()
    order = b.sort_values(col, ascending=False)
    keep = []
    counts = {p: 0 for p in ("QB", "RB", "WR", "TE")}
    cap = dict(QB=3 * TEAMS, RB=5 * TEAMS, WR=6 * TEAMS, TE=2 * TEAMS)
    for i, r in order.iterrows():
        if len(keep) >= TEAMS * SPOTS:
            break
        if counts[r.position] >= cap[r.position]:
            continue
        keep.append(i); counts[r.position] += 1
    drafted = b.loc[keep]
    cut = {p: float(drafted[drafted.position == p][col].min()) for p in ("QB", "RB", "WR", "TE")}
    b["surplus"] = np.maximum(0.0, b[col] - b.position.map(cut))
    tot = b.loc[keep, "surplus"].sum()
    disc = TEAMS * BUDGET - TEAMS * SPOTS
    b["price"] = 1.0 + (b.surplus / tot) * disc if tot > 0 else 1.0
    b.loc[~b.index.isin(keep), "price"] = 1.0
    return b["price"].values


# ---------------------------------------------------------------- auction engine
class Team:
    __slots__ = ("budget", "roster", "counts", "prices", "tag")

    def __init__(self, prices, tag):
        self.budget = BUDGET; self.roster = []; self.prices = prices; self.tag = tag
        self.counts = dict(QB=0, RB=0, WR=0, TE=0)

    def spots_left(self): return SPOTS - len(self.roster)
    def max_bid(self): return self.budget - (self.spots_left() - 1)

    def needs(self):
        n = {p: max(0, LINEUP_A[p] - self.counts[p]) for p in LINEUP_A}
        s = sum(max(0, self.counts[p] - LINEUP_A[p]) for p in FLEXP)
        n["FLEX"] = max(0, 1 - s)
        return n


def run(pool_pos, price_sets, tags, rng):
    n = len(pool_pos)
    teams = [Team(price_sets[t], tags[t]) for t in range(TEAMS)]
    order = rng.permutation(n)
    neutral = np.mean(price_sets, axis=0)
    remaining = neutral.copy()
    for oi in order:
        live = [t for t in teams if t.spots_left() > 0]
        if not live:
            break
        pos = pool_pos[oi]
        spots_open = sum(t.spots_left() for t in live)
        money_disc = sum(max(0, t.budget - t.spots_left()) for t in live)
        top_left = np.sort(remaining)[::-1][:spots_open]
        value_disc = max(float(np.maximum(top_left - 1.0, 0).sum()), 1.0)
        infl = float(np.clip(money_disc / value_disc, 0.6, 2.5))

        bids = []
        for i, t in enumerate(teams):
            if t.spots_left() <= 0 or t.counts[pos] >= CAPS_A[pos]:
                bids.append((0, rng.random(), i)); continue
            nd = t.needs()
            fills = nd.get(pos, 0) > 0 or (nd["FLEX"] > 0 and pos in FLEXP)
            open_st = sum(v for k, v in nd.items() if k != "FLEX") + nd["FLEX"]
            if open_st >= t.spots_left() and not fills:
                bids.append((0, rng.random(), i)); continue
            disc = max(0.0, t.budget - t.spots_left())
            pressure = disc / (money_disc / max(len(live), 1)) if money_disc > 0 else 1.0
            v = t.prices[oi] * infl * max(1.0, pressure)
            v *= 1.10 if fills else 0.92
            bids.append((int(max(0, min(v, t.max_bid()))), rng.random(), i))
        bids.sort(reverse=True)
        top = bids[0]
        second = bids[1] if len(bids) > 1 else (0, 0, -1)
        if top[0] < 1:
            ok = []
            for i, t in enumerate(teams):
                if t.spots_left() <= 0 or t.budget < 1 or t.counts[pos] >= CAPS_A[pos]:
                    continue
                nd = t.needs()
                fills = nd.get(pos, 0) > 0 or (nd["FLEX"] > 0 and pos in FLEXP)
                open_st = sum(v for k, v in nd.items() if k != "FLEX") + nd["FLEX"]
                if fills or open_st < t.spots_left():
                    ok.append(i)
            if not ok:
                continue
            fits = [i for i in ok if teams[i].needs().get(pos, 0) > 0
                    or (teams[i].needs()["FLEX"] > 0 and pos in FLEXP)]
            wi = int(rng.choice(fits or ok)); price = 1
        else:
            wi = top[2]; price = max(1, min(top[0], second[0] + 1))
        t = teams[wi]
        t.budget -= price; t.roster.append(oi); t.counts[pos] += 1
        remaining[oi] = 0.0
    return teams


# ---------------------------------------------------------------- the bake-off
print("=" * 78)
print("Q. WINS VS POINTS  —  same auction, two price sheets")
print("=" * 78)
res = {"points": [], "wins": []}
champ = {"points": [], "wins": []}
acc = []
for season in ALL:
    pts_board, rep = BOARDS[season]
    wb = waa_board(season)
    b = pts_board.merge(wb, on=["player_id", "position"], how="inner").reset_index(drop=True)
    if len(b) < 150:
        continue
    b["vorp"] = b.proj_blend - b.position.map(rep)

    # how well did each projection call the season that followed?
    truth = W[W.season == season][["player_id", "waa"]]
    chk = b.merge(truth, on="player_id", how="inner")
    acc.append((season,
                spearmanr(chk.proj_waa, chk.waa)[0],
                spearmanr(chk.proj_blend, chk.waa)[0]))

    p_pts = price_from(b, "proj_blend")
    p_waa = price_from(b, "proj_waa")
    mat = WKP[season].reindex(b.player_id.values).fillna(0.0).values
    pos_arr = b.position.values

    for ns in range(14):
        rng = np.random.default_rng((season * 5077 + ns * 61) % (2**31))
        for rot in range(12):
            tags = [("wins" if ((t + rot) % 2 == 0) else "points") for t in range(TEAMS)]
            psets = [p_waa if tags[t] == "wins" else p_pts for t in range(TEAMS)]
            teams = run(pos_arr, psets, tags, rng)
            sc = np.zeros((TEAMS, 17))
            for t in range(TEAMS):
                ix = np.array(teams[t].roster)
                sc[t] = optimal_weekly(pos_arr[ix], mat[ix])
            wins = np.zeros(TEAMS)
            for w in range(17):
                c = sc[:, w]
                wins += (c[:, None] > c[None, :]).sum(axis=1)
            wins /= 17 * (TEAMS - 1)
            rank = (-sc.sum(axis=1)).argsort().argsort()
            for t in range(TEAMS):
                res[teams[t].tag].append(wins[t])
                champ[teams[t].tag].append(1.0 if rank[t] == 0 else 0.0)
    a = np.mean([x for x in res["wins"][-14 * 12 * 6:]]) * 100
    p = np.mean([x for x in res["points"][-14 * 12 * 6:]]) * 100
    print(f"   {season}: wins-priced {a:5.2f}%   points-priced {p:5.2f}%   diff {a-p:+5.2f}", flush=True)

print("\n  projection accuracy (rho vs that season's actual WAA):")
for s, rw, rp in acc:
    print(f"    {s}: projected-WAA {rw:+.3f}   projected-points {rp:+.3f}")
print(f"    mean: projected-WAA {np.mean([a[1] for a in acc]):+.3f}   "
      f"projected-points {np.mean([a[2] for a in acc]):+.3f}")

vw, vp = np.array(res["wins"]), np.array(res["points"])
sew = vw.std(ddof=1) / np.sqrt(len(vw)) * 100
sep = vp.std(ddof=1) / np.sqrt(len(vp)) * 100
diff = vw.mean() * 100 - vp.mean() * 100
se = np.sqrt(sew ** 2 + sep ** 2)
print("\n" + "-" * 78)
print(f"  wins-priced   {vw.mean()*100:.2f}% ± {sew:.2f}   most points in league {np.mean(champ['wins'])*100:.1f}%")
print(f"  points-priced {vp.mean()*100:.2f}% ± {sep:.2f}   most points in league {np.mean(champ['points'])*100:.1f}%")
print(f"  difference    {diff:+.2f} pp  ({abs(diff)/se:.1f} SE)  over {len(vw)} team-seasons each")
print(f"  on a 14-game schedule that is {diff/100*14:+.2f} wins a year")

json.dump(dict(wins=round(float(vw.mean() * 100), 3), points=round(float(vp.mean() * 100), 3),
               diff=round(float(diff), 3), se=round(float(se), 3),
               champ_wins=round(float(np.mean(champ["wins"]) * 100), 2),
               champ_points=round(float(np.mean(champ["points"]) * 100), 2),
               acc_waa=round(float(np.mean([a[1] for a in acc])), 3),
               acc_pts=round(float(np.mean([a[2] for a in acc])), 3),
               n=len(vw)), open("out/research_waa.json", "w"), indent=1)
print("\nwrote out/research_waa.json")
