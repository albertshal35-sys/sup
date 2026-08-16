"""Stage 12: the variance question, without hindsight.

The previous run said volatile players were worth a large premium at equal
projected points. That result is not trustworthy, because every simulation so far
sets each week's lineup with perfect hindsight — it always starts whoever ended
up scoring most. Hindsight lineups harvest a boom-bust player's spike weeks and
bench his zeros, which is exactly the advantage a real manager cannot get.

For most comparisons the bias cancels: both arms enjoy it equally. For a
comparison specifically about variance it does not cancel at all — it IS the
treatment.

So this rerun sets lineups the way a manager actually can: the same starters
every week, chosen up front by projection, with one concession to reality —
if a starter is inactive that week (scores nothing), his backup comes in.
"""
import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings("ignore")
exec(open("consistency_resid.py").read().split("print(\"=\" * 78)")[0])

KS = [-12.0, -6.0, 0.0, 6.0, 12.0, 24.0]


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


print("=" * 78)
print("T. VARIANCE, WITHOUT HINDSIGHT  —  lineups set up front, not after the fact")
print("=" * 78)
obs = {k: [] for k in KS}
obs_hind = {k: [] for k in KS}
for season in ALL:
    pts_board, rep = BOARDS[season]
    sb = sd_board(season)
    if sb is None:
        continue
    b = pts_board.merge(sb, on=["player_id", "position"], how="inner").reset_index(drop=True)
    if len(b) < 150:
        continue
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

    price_sets_by_k = {}
    for k in KS:
        b["_v"] = b.proj_blend - k * b["sd_resid"]
        price_sets_by_k[k] = price_from(b, "_v")
    mat = WKP[season].reindex(b.player_id.values).fillna(0.0).values
    pos_arr = b.position.values
    projv = b.proj_blend.values

    for ns in range(12):
        rng = np.random.default_rng((season * 2789 + ns * 67) % (2**31))
        for rot in range(12):
            arms = [KS[(t + rot) % len(KS)] for t in range(TEAMS)]
            psets = [price_sets_by_k[a] for a in arms]
            teams = run(pos_arr, psets, [str(a) for a in arms], rng)
            sc = np.zeros((TEAMS, 17)); sh = np.zeros((TEAMS, 17))
            for t in range(TEAMS):
                ix = np.array(teams[t].roster)
                sc[t] = realistic_weekly(pos_arr[ix], mat[ix], projv[ix])
                sh[t] = optimal_weekly(pos_arr[ix], mat[ix])
            for tag, arr in (("real", sc), ("hind", sh)):
                wins = np.zeros(TEAMS)
                for w in range(17):
                    c = arr[:, w]
                    wins += (c[:, None] > c[None, :]).sum(axis=1)
                wins /= 17 * (TEAMS - 1)
                for t in range(TEAMS):
                    (obs if tag == "real" else obs_hind)[arms[t]].append(wins[t])
    print("  ", season, "done", flush=True)

rows = []
for k in KS:
    v, h = np.array(obs[k]), np.array(obs_hind[k])
    rows.append(dict(k=k, real=v.mean() * 100, real_se=v.std(ddof=1) / np.sqrt(len(v)) * 100,
                     hindsight=h.mean() * 100, n=len(v)))
r = pd.DataFrame(rows)
b0 = float(r[r.k == 0].real.iloc[0]); h0 = float(r[r.k == 0].hindsight.iloc[0])
r["real_vs_pts"] = (r.real - b0).round(2)
r["hind_vs_pts"] = (r.hindsight - h0).round(2)
print("\n", r.round(2)[["k", "real", "real_se", "real_vs_pts", "hind_vs_pts", "n"]].to_string(index=False))
print("\n  'real' sets the lineup up front; 'hindsight' is the old, optimistic method.")
print("  Negative k pays a premium for boom-bust at equal projected points.\n")
for _, x in r.iterrows():
    if x.k == 0:
        continue
    se = np.sqrt(x.real_se ** 2 + float(r[r.k == 0].real_se.iloc[0]) ** 2)
    print(f"    k={x.k:+6.1f}:  realistic {x.real_vs_pts:+5.2f} pp ({abs(x.real_vs_pts)/se:4.1f} SE)"
          f"   |  hindsight said {x.hind_vs_pts:+5.2f} pp")
json.dump(r.to_dict("records"), open("out/research_variance_real.json", "w"), indent=1, default=str)
print("\nwrote out/research_variance_real.json")
