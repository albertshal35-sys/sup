"""Stage 13: is any of this a strategy, or just a reaction to the room?

Two sweeps of the same volatility premium disagreed completely. In the first the
field was mostly tilted and the neutral arm lost; in the second the field was
mostly neutral and the tilted arms lost. That pattern has an obvious reading: in
an auction you are not solving a decision problem, you are playing a game. What
pays is being different from the room, and the sign flips with the room.

This tests it directly. Each candidate runs balanced six against six versus
neutral pricing, and then again in a lopsided field. If an edge is a property of
the strategy it survives both. If it is a property of the field it flips.
"""
import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings("ignore")
exec(open("consistency_real.py").read().split('print("=" * 78)')[0])


def board_for_season(season):
    pts_board, rep = BOARDS[season]
    sb = sd_board(season)
    if sb is None:
        return None
    b = pts_board.merge(sb, on=["player_id", "position"], how="inner").reset_index(drop=True)
    if len(b) < 150:
        return None
    for pos in ("QB", "RB", "WR", "TE"):
        m = b.position == pos
        if m.sum() < 10:
            continue
        x = b.loc[m, "proj_blend"].values
        y = b.loc[m, "proj_sd"].values
        A = np.vstack([x, np.ones_like(x)]).T
        coef = np.linalg.lstsq(A, y, rcond=None)[0]
        b.loc[m, "sd_resid"] = y - (A @ coef)
    b["sd_resid"] = b["sd_resid"].fillna(0.0)
    return b, rep


def make_prices(b, kind):
    if kind == "neutral":
        b["_v"] = b.proj_blend
    elif kind == "volatile":
        b["_v"] = b.proj_blend + 12.0 * b["sd_resid"]
    elif kind == "safe":
        b["_v"] = b.proj_blend - 12.0 * b["sd_resid"]
    elif kind == "qbprem":
        b["_v"] = b.proj_blend * np.where(b.position == "QB", 1.25, 1.0)
    elif kind == "qbdisc":
        b["_v"] = b.proj_blend * np.where(b.position == "QB", 0.80, 1.0)
    return price_from(b, "_v")


def duel(kind, n_treat):
    """n_treat teams use `kind`, the rest price neutrally."""
    out = {kind: [], "neutral": []}
    for season in ALL:
        got = board_for_season(season)
        if got is None:
            continue
        b, rep = got
        p_t = make_prices(b, kind)
        p_n = make_prices(b, "neutral")
        mat = WKP[season].reindex(b.player_id.values).fillna(0.0).values
        pos_arr = b.position.values
        projv = b.proj_blend.values
        for ns in range(10):
            rng = np.random.default_rng((season * 1471 + ns * 83) % (2**31))
            for rot in range(12):
                tags = [(kind if ((t + rot) % TEAMS) < n_treat else "neutral") for t in range(TEAMS)]
                psets = [p_t if tags[t] == kind else p_n for t in range(TEAMS)]
                teams = run(pos_arr, psets, tags, rng)
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
                    out[tags[t]].append(wins[t])
    a, n = np.array(out[kind]), np.array(out["neutral"])
    se = np.sqrt(a.std(ddof=1) ** 2 / len(a) + n.std(ddof=1) ** 2 / len(n)) * 100
    return a.mean() * 100, n.mean() * 100, (a.mean() - n.mean()) * 100, se


print("=" * 78)
print("U. STRATEGY OR REACTION?  —  the same tilt against different rooms")
print("=" * 78)
print(f"  {'candidate':<12}{'field':<22}{'tilted':>9}{'neutral':>9}{'edge':>9}{'SE':>7}")
res = {}
for kind in ("volatile", "safe", "qbprem", "qbdisc"):
    # Levels are expressed against TEAMS, not hardcoded: at n_treat == TEAMS there is
    # no neutral arm left to measure against, which silently produced NaN.
    for n_treat, label in ((TEAMS // 2, "half the room"),
                           (2, f"only 2 of {TEAMS}"),
                           (TEAMS - 2, f"{TEAMS - 2} of {TEAMS}")):
        t, n, d, se = duel(kind, n_treat)
        res[f"{kind}|{n_treat}"] = dict(tilted=round(t, 2), neutral=round(n, 2),
                                        edge=round(d, 2), se=round(se, 2))
        print(f"  {kind:<12}{label:<22}{t:9.2f}{n:9.2f}{d:+9.2f}{se:7.2f}", flush=True)

json.dump(res, open("out/research_field.json", "w"), indent=1)
print("\nwrote out/research_field.json")
