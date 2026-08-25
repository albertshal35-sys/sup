"""Stage 14: is the quarterback premium a strategy or a crowding trade?

Two earlier runs disagreed because they tilted in different ways. Re-pricing the
board is zero-sum — marking quarterbacks up 25% silently marks every other
position down, so that arm was really "spend your budget on quarterbacks instead
of skill players". The advice actually shipped is narrower: keep the same board,
but stretch above list when a quarterback is on the block.

This tests the shipped version at three field densities. A real edge holds
whether two teams or ten are doing it. A crowding trade decays as the room fills
up with people doing the same thing.
"""
import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings("ignore")
exec(open("consistency_real.py").read().split('print("=" * 78)')[0])

MULT = 1.25


def run_mult(pool_pos, prices, mults, rng, projv=None):
    """One shared price board; teams differ only in how far above list they will
    stretch for a given position."""
    n = len(pool_pos)
    teams = [Team(prices, str(i)) for i in range(TEAMS)]
    order = rng.permutation(n)
    remaining = prices.copy()
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
            v = prices[oi] * infl * max(1.0, pressure)
            v *= mults[i].get(pos, 1.0)
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


print("=" * 78)
print("V. QUARTERBACK PREMIUM BY FIELD DENSITY  —  stretch above list, same board")
print("=" * 78)
print(f"  {'how many do it':<20}{'them':>9}{'others':>9}{'edge':>9}{'SE':>7}")
out = {}
for n_treat in (2, 4, 6, 8):          # TEAMS is 10; at 10 there is no control arm left
    a, b_ = [], []
    for season in ALL:
        bb, rep = BOARDS[season]
        bb = bb.reset_index(drop=True).copy()
        bb["_v"] = bb.proj_blend
        prices = price_from(bb, "_v")
        mat = WKP[season].reindex(bb.player_id.values).fillna(0.0).values
        pos_arr = bb.position.values
        projv = bb.proj_blend.values
        for ns in range(10):
            rng = np.random.default_rng((season * 6689 + ns * 29) % (2**31))
            for rot in range(12):
                treat = [((t + rot) % TEAMS) < n_treat for t in range(TEAMS)]
                mults = [({"QB": MULT} if treat[t] else {}) for t in range(TEAMS)]
                teams = run_mult(pos_arr, prices, mults, rng)
                sc = np.zeros((TEAMS, 17))
                for t in range(TEAMS):
                    ix = np.array(teams[t].roster)
                    sc[t] = realistic_weekly(pos_arr[ix], mat[ix], projv[ix])
                wins = np.zeros(TEAMS)
                for w in range(17):
                    c = sc[:, w]
                    wins += (c[:, None] > c[None, :]).sum(axis=1)
                wins /= 17 * (TEAMS - 1)
                for t in range(TEAMS):
                    (a if treat[t] else b_).append(wins[t])
    A, B = np.array(a), np.array(b_)
    se = np.sqrt(A.std(ddof=1) ** 2 / len(A) + B.std(ddof=1) ** 2 / len(B)) * 100
    d = (A.mean() - B.mean()) * 100
    out[n_treat] = dict(them=round(A.mean() * 100, 2), others=round(B.mean() * 100, 2),
                        edge=round(d, 2), se=round(se, 2))
    print(f"  {str(n_treat) + f' of {TEAMS}':<20}{A.mean()*100:9.2f}{B.mean()*100:9.2f}{d:+9.2f}{se:7.2f}", flush=True)

json.dump(out, open("out/research_qb_density.json", "w"), indent=1)
print("\nwrote out/research_qb_density.json")
