"""Stage 6: build the 2026 draft board.

Applies the trained models to 2025 usage, adds rookies via draft-capital priors,
converts to VORP under this exact lineup, then tiers and prices the board.
"""
import pandas as pd, numpy as np, json, warnings
from sklearn.ensemble import HistGradientBoostingRegressor

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")
TEAMS = 10
LINEUP = dict(QB=2, RB=2, WR=3, TE=1)
FLEX_N, FLEX_POS = 1, ("RB", "WR", "TE")
BENCH, ROSTER = 6, 17

# ---------------------------------------------------------------- panel
LAGS = ["ppg", "xfp_pg", "games", "car_pg", "tgt_pg", "touch_pg", "td_pg", "target_share", "fpts"]
lag = sp[["player_id", "season"] + LAGS].copy(); lag["season"] += 1
lag.columns = ["player_id", "season"] + [c + "_l1" for c in LAGS]
lag2 = sp[["player_id", "season"] + LAGS].copy(); lag2["season"] += 2
lag2.columns = ["player_id", "season"] + [c + "_l2" for c in LAGS]
P = sp.merge(lag, on=["player_id", "season"], how="left").merge(lag2, on=["player_id", "season"], how="left")
nn = sp[["player_id", "season", "ppg", "games", "fpts"]].copy(); nn["season"] -= 1
nn.columns = ["player_id", "season", "y_ppg", "y_games", "y_fpts"]
P = P.merge(nn, on=["player_id", "season"], how="left")
P = P[(P.games >= 3) & (P.season >= 2009)]

COMMON = ["ppg", "xfp_pg", "td_luck_pg", "games", "age", "exp", "fpts",
          "ppg_l1", "xfp_pg_l1", "games_l1", "fpts_l1", "td_pg_l1", "ppg_l2", "xfp_pg_l2", "games_l2"]
POSF = {
    "QB": ["pass_att_pg", "pass_yd_pg", "epa_pass", "cpoe", "car_pg", "rushyd_pg", "td_pg", "car_pg_l1"],
    "RB": ["car_pg", "touch_pg", "tgt_pg", "rec_pg", "rushyd_pg", "ryd_pg", "fd_pg", "expl_pg",
           "td_rate", "ypc", "target_share", "epa_rush", "yac_pg", "car_pg_l1", "touch_pg_l1", "tgt_pg_l1"],
    "WR": ["tgt_pg", "rec_pg", "ryd_pg", "ayd_pg", "target_share", "air_yards_share", "wopr", "adot",
           "catch_rate", "ypt", "td_rate", "fd_pg", "expl_pg", "yac_pg", "epa_rec", "racr",
           "tgt_pg_l1", "target_share_l1", "ryd_pg_l1"],
    "TE": ["tgt_pg", "rec_pg", "ryd_pg", "ayd_pg", "target_share", "air_yards_share", "wopr", "adot",
           "catch_rate", "td_rate", "fd_pg", "expl_pg", "yac_pg", "epa_rec", "tgt_pg_l1", "target_share_l1"],
}


def hgb(depth=4, it=400):
    return HistGradientBoostingRegressor(max_depth=depth, learning_rate=0.05, max_iter=it,
                                         min_samples_leaf=20, l2_regularization=1.0, random_state=0)


# ---------------------------------------------------------------- games played
# Projected points are points-per-game times EXPECTED GAMES, so the games estimate is
# half of every number on this board. It was also the half nobody validated.
#
# On the loss that actually matters — error in projected season points across the 150
# players who get priced — a gradient-boosted games model, a linear shrinkage and an
# empirical curve are indistinguishable: 63.4 / 63.1 / 63.4 points over ten holdout
# seasons. Availability is close to unforecastable, and no estimator rescues that.
#
# So the choice is not made on accuracy, because accuracy does not move. It is made on
# COHERENCE, and the other two fail it:
#
#   the model     projected 16.0 games for a QB who played 8, and 8.7 for one who
#                 played 7 — same evidence, opposite answers, because a tree given a
#                 dozen correlated features invents structure in the noise
#   linear shrink projected 15.8 games for a back who had played three full seasons,
#                 against an empirical 14.2 — fitting MAE on the crowded middle blows
#                 out the tail, which is exactly where the money is
#
# What ships is the empirical curve itself: an isotonic fit of next-season games on a
# 2-1-1 weighted average of the last three seasons, per position. Monotone by
# construction, so more games played can never mean fewer games projected, and it
# reproduces the real tail (a three-year durable back gets 14.2, not 15.8).
from sklearn.isotonic import IsotonicRegression

GW = (3.0, 2.0, 1.0)


def games_blend(df):
    num = np.zeros(len(df))
    den = np.zeros(len(df))
    for c, w in zip(("games", "games_l1", "games_l2"), GW):
        if c not in df.columns:
            continue
        v = df[c].values.astype(float)
        m = np.isfinite(v)
        num[m] += w * v[m]
        den[m] += w
    return np.where(den > 0, num / np.maximum(den, 1e-9), np.nan)


P["g_blend"] = games_blend(P)

# The curve above conditions on games played alone, which cannot tell a franchise
# starter who got hurt from a backup who lost his job. It buried Lamar Jackson,
# Jayden Daniels and Joe Burrow — all of whom missed most of 2025 — at a few dollars
# each, against an industry consensus that has them near the top of the position.
#
# The depth chart separates them, and the effect is large:
#
#   QB who played 1-9 games, and is the preseason QB1   -> 10.8 games (n=29)
#   QB who played 1-9 games, and is the QB2             ->  4.7 games (n=84)
#
# So blend the games-only curve with the mean for the player's (depth, games) cell,
# weighted by how much evidence that cell actually has: n / (n + 20). Holdout MAE
# over 2021-2024 improves from 3.619 to 3.516 games, better or equal in every season.
# Depth charts only exist from 2021, which is why this is a correction on top of the
# curve rather than the curve itself.
DEPTH_K = 20.0


def _depth_chart(year):
    """Preseason snapshot; nflverse changed format mid-decade, so read either."""
    try:
        d = pd.read_csv(f"data/depth_{year}.csv", low_memory=False)
    except Exception:
        return None
    if "gsis_id" not in d.columns:
        return None
    if "pos_abb" in d.columns:
        d = d[d.pos_abb.isin(["QB", "RB", "WR", "TE"])].copy()
        d["dt"] = pd.to_datetime(d.get("dt"), errors="coerce")
        d = d.sort_values("dt").groupby("gsis_id", as_index=False).head(1)
        d = d.rename(columns={"pos_rank": "depth"})
    else:
        d = d[d.position.isin(["QB", "RB", "WR", "TE"])].copy()
        if "week" in d.columns:
            d = d[d.week <= 1] if (d.week <= 1).any() else d
            d = d.sort_values("week").groupby("gsis_id", as_index=False).head(1)
        d = d.rename(columns={"depth_team": "depth"})
    d["depth"] = pd.to_numeric(d["depth"], errors="coerce")
    d = d.dropna(subset=["gsis_id", "depth"]).sort_values("depth")
    d = d.groupby("gsis_id", as_index=False).head(1)
    return d[["gsis_id", "depth"]].rename(columns={"gsis_id": "player_id"}).assign(season=year)


_dep = [x for x in (_depth_chart(y) for y in range(2021, 2027)) if x is not None]
DEPTHC = pd.concat(_dep, ignore_index=True) if _dep else pd.DataFrame(
    columns=["player_id", "depth", "season"])
# a chart for season S describes the season being projected, so it attaches to row S-1
DEPTHC["season"] = DEPTHC.season - 1
DEPTHC["db"] = np.clip(DEPTHC.depth, 1, 3)


def _gbucket(g):
    return np.select([np.asarray(g) >= 15, np.asarray(g) >= 10], [2, 1], 0)


_dtrain = P.merge(DEPTHC[["player_id", "season", "db"]], on=["player_id", "season"], how="left")
_dtrain = _dtrain[_dtrain.db.notna() & _dtrain.y_games.notna()]
_dtrain["gbk"] = _gbucket(_dtrain.games)
DEPTH_CELL = _dtrain.groupby(["position", "db", "gbk"]).y_games.agg(["mean", "size"])
print("depth-conditioned games (position, depth, games-band): "
      f"{len(DEPTH_CELL)} cells from {len(_dtrain)} player-seasons")


def apply_depth(te, pos, base):
    """Pull the games-only estimate toward the player's (depth, games) cell mean."""
    d = te[["player_id", "season"]].merge(
        DEPTHC[["player_id", "season", "db"]], on=["player_id", "season"], how="left")
    db = d.db.values
    gbk = _gbucket(te.games.values)
    out = base.copy()
    for i in range(len(te)):
        if not np.isfinite(db[i]):
            continue
        key = (pos, float(db[i]), int(gbk[i]))
        if key not in DEPTH_CELL.index:
            continue
        m, n = DEPTH_CELL.loc[key, "mean"], DEPTH_CELL.loc[key, "size"]
        w = n / (n + DEPTH_K)
        out[i] = w * m + (1 - w) * base[i]
    return out

GAMES_CURVE = {}
for _p in ("QB", "RB", "WR", "TE"):
    _t = P[(P.position == _p) & P.y_games.notna() & P.g_blend.notna()]
    GAMES_CURVE[_p] = IsotonicRegression(increasing=True, out_of_bounds="clip").fit(
        _t.g_blend, _t.y_games)
print("expected games by durability (3-season 2-1-1 average -> next season):")
for _p in ("QB", "RB", "WR", "TE"):
    print(f"  {_p}: " + "  ".join(
        f"{x}g->{GAMES_CURVE[_p].predict([x])[0]:.1f}" for x in (17, 15, 12, 9, 6)))

proj_rows = []
for pos in ["QB", "RB", "WR", "TE"]:
    f = [c for c in COMMON + POSF[pos] if c in P.columns]
    tr = P[(P.position == pos) & P.y_fpts.notna()]
    mp = hgb().fit(tr[f], tr.y_ppg)
    for src_season, decay in [(2025, 1.0), (2024, 0.88)]:
        te = P[(P.position == pos) & (P.season == src_season)].copy()
        if len(te) == 0:
            continue
        te["proj_ppg"] = mp.predict(te[f]) * decay
        te["proj_g"] = np.clip(apply_depth(
            te, pos, GAMES_CURVE[pos].predict(games_blend(te))), 0, 17)
        te["src"] = src_season
        proj_rows.append(te[["player_id", "position", "proj_ppg", "proj_g", "src", "age",
                             "ppg", "games", "fpts", "tgt_pg", "car_pg", "target_share",
                             "td_luck_pg", "xfp_pg", "rec_pg", "ryd_pg", "rushyd_pg",
                             "pass_att_pg", "exp"]])
pr = pd.concat(proj_rows, ignore_index=True)
pr = pr.sort_values("src", ascending=False).drop_duplicates("player_id", keep="first")
print("projected from prior play:", len(pr), "| from 2025:", (pr.src == 2025).sum())

# ---------------------------------------------------------------- rookies
dp = pd.read_csv("data/draft_picks.csv", low_memory=False)
hist_rook = sp[(sp.exp == 0) & sp.draft_pick.notna() & (sp.season >= 2006)].copy()
# Empirical means by draft-capital bucket, interpolated on log(pick). A log-linear
# fit extrapolates nonsense at the very top of the draft, so the top bucket's own
# historical average is the ceiling — no rookie is projected above what rookies
# taken in that range have actually averaged.
BUCKETS = [(1, 12), (13, 32), (33, 64), (65, 105), (106, 262)]
rook_fit = {}
for pos in ["QB", "RB", "WR", "TE"]:
    d = hist_rook[hist_rook.position == pos]
    xs, ppgs, gs = [], [], []
    for lo, hi in BUCKETS:
        s = d[(d.draft_pick >= lo) & (d.draft_pick <= hi)]
        if len(s) < 5:
            continue
        xs.append(np.log(np.sqrt(lo * hi)))
        ppgs.append(float(s.ppg.mean()))
        gs.append(float(s.games.mean()))
    if len(xs) < 2:
        continue
    rook_fit[pos] = (np.array(xs), np.array(ppgs), np.array(gs))
    print(f"  rookie curve {pos}: " + " ".join(
        f"{lo}-{hi}:{p:.1f}ppg" for (lo, hi), p in zip(
            [b for b in BUCKETS if len(d[(d.draft_pick >= b[0]) & (d.draft_pick <= b[1])]) >= 5], ppgs)))

r26 = dp[dp.season == 2026].copy()
r26 = r26[r26.position.isin(["QB", "RB", "WR", "TE"])]
rook_rows = []
for _, r in r26.iterrows():
    pos = r["position"]
    if pos not in rook_fit:
        continue
    xs, ppgs, gs = rook_fit[pos]
    lp = np.clip(np.log(max(float(r["pick"]), 1)), xs.min(), xs.max())
    rook_rows.append(dict(player_id=r.get("gsis_id"), name=r.get("pfr_player_name"),
                          position=pos, team=r.get("team"),
                          proj_ppg=float(np.interp(lp, xs, ppgs)),
                          proj_g=float(np.clip(np.interp(lp, xs, gs), 6, 17)),
                          rookie=True, draft_pick=int(r["pick"]), age=22.0, src=None))
rook = pd.DataFrame(rook_rows)
print("2026 rookies projected:", len(rook))

# ---------------------------------------------------------------- 2026 pool
ros = pd.read_csv("data/rost_2026.csv", low_memory=False)
ros = ros[ros.status.isin(["ACT", "RES", "E14"])]
ros = ros[ros.position.isin(["QB", "RB", "WR", "TE", "K"])]
ros = ros.drop_duplicates(subset=["gsis_id"], keep="first")
ros = ros.rename(columns={"gsis_id": "player_id", "full_name": "name"})
pool = ros[["player_id", "name", "position", "team", "birth_date", "years_exp", "headshot_url"]].copy()
pool["age26"] = (pd.Timestamp("2026-09-01") - pd.to_datetime(pool.birth_date, errors="coerce")).dt.days / 365.25

board = pool.merge(pr.drop(columns=["position", "age"]), on="player_id", how="left")
board = board.merge(rook[["player_id", "proj_ppg", "proj_g", "rookie", "draft_pick"]],
                    on="player_id", how="left", suffixes=("", "_rk"))
board["rookie"] = board.rookie.fillna(False)
board["proj_ppg"] = board.proj_ppg.fillna(board.proj_ppg_rk)
board["proj_g"] = board.proj_g.fillna(board.proj_g_rk)

# rookies drafted in 2026 who are not yet on the roster file still belong on the board
missing_rk = rook[~rook.player_id.isin(board.player_id) & rook.player_id.notna()]
if len(missing_rk):
    add = missing_rk.rename(columns={"name": "name"})[
        ["player_id", "name", "position", "team", "proj_ppg", "proj_g", "rookie", "draft_pick"]].copy()
    add["age26"] = 22.0
    board = pd.concat([board, add], ignore_index=True)

# players with no signal at all: replacement-level filler
FLOOR = dict(QB=6.0, RB=4.0, WR=4.0, TE=3.0, K=8.0)
board["proj_ppg"] = board.apply(
    lambda r: r.proj_ppg if pd.notna(r.proj_ppg) else FLOOR.get(r.position, 3.0), axis=1)
board["proj_g"] = board.proj_g.fillna(13.0)

# ---------------------------------------------------------------- kickers
kk = sp[(sp.position == "K") & (sp.season.isin([2024, 2025]))]
kagg = kk.groupby("player_id").agg(k_ppg=("ppg", "mean"), k_g=("games", "mean")).reset_index()
kmean = kk.ppg.mean()
board = board.merge(kagg, on="player_id", how="left")
is_k = board.position == "K"
# kicker year-over-year rho is 0.26, so regress hard toward the league mean
board.loc[is_k, "proj_ppg"] = 0.30 * board.loc[is_k, "k_ppg"].fillna(kmean) + 0.70 * kmean
board.loc[is_k, "proj_g"] = board.loc[is_k, "k_g"].fillna(16.0).clip(10, 17)

board["proj_total"] = (board.proj_ppg * board.proj_g).round(1)

# ---------------------------------------------------------------- DST
dstx = pd.read_parquet("out/dst_seasons.parquet")
d25 = dstx[dstx.season.isin([2024, 2025])].groupby("team").agg(d_fpts=("fpts", "mean")).reset_index()
dmean = d25.d_fpts.mean()
d25["proj_total"] = (0.35 * d25.d_fpts + 0.65 * dmean).round(1)
TEAM_NAMES = {"ARI": "Cardinals", "ATL": "Falcons", "BAL": "Ravens", "BUF": "Bills", "CAR": "Panthers",
              "CHI": "Bears", "CIN": "Bengals", "CLE": "Browns", "DAL": "Cowboys", "DEN": "Broncos",
              "DET": "Lions", "GB": "Packers", "HOU": "Texans", "IND": "Colts", "JAX": "Jaguars",
              "KC": "Chiefs", "LA": "Rams", "LAC": "Chargers", "LV": "Raiders", "MIA": "Dolphins",
              "MIN": "Vikings", "NE": "Patriots", "NO": "Saints", "NYG": "Giants", "NYJ": "Jets",
              "PHI": "Eagles", "PIT": "Steelers", "SEA": "Seahawks", "SF": "49ers", "TB": "Buccaneers",
              "TEN": "Titans", "WAS": "Commanders"}
dst_rows = [dict(player_id=f"DST_{r.team}", name=f"{TEAM_NAMES.get(r.team, r.team)} D/ST",
                 position="DST", team=r.team, proj_total=float(r.proj_total),
                 proj_ppg=float(r.proj_total) / 17, proj_g=17.0, age26=np.nan, rookie=False)
            for _, r in d25.iterrows()]
board = pd.concat([board, pd.DataFrame(dst_rows)], ignore_index=True)

# ---------------------------------------------------------------- bye weeks
g = pd.read_csv("data/games.csv", low_memory=False)
g26 = g[(g.season == 2026) & (g.game_type == "REG")]
played = pd.concat([g26[["week", "home_team"]].rename(columns={"home_team": "team"}),
                    g26[["week", "away_team"]].rename(columns={"away_team": "team"})])
byes = {}
for t, d in played.groupby("team"):
    missing = sorted(set(range(1, 19)) - set(d.week.astype(int)))
    byes[t] = missing[0] if missing else None
board["bye"] = board.team.map(byes)

# ---------------------------------------------------------------- VORP + pricing
def replacement_levels(b):
    taken = {p: n * TEAMS for p, n in LINEUP.items()}
    pools = {p: np.sort(b[b.position == p]["proj_total"].values)[::-1] for p in FLEX_POS}
    for _ in range(FLEX_N * TEAMS):
        best, bv = None, -1e9
        for p in FLEX_POS:
            i = taken[p]
            if i < len(pools[p]) and pools[p][i] > bv:
                best, bv = p, pools[p][i]
        if best:
            taken[best] += 1
    rep = {}
    for p in ["QB", "RB", "WR", "TE"]:
        v = np.sort(b[b.position == p]["proj_total"].values)[::-1]
        rep[p] = float(v[taken[p]])
    for p, n in [("K", TEAMS), ("DST", TEAMS)]:
        v = np.sort(b[b.position == p]["proj_total"].values)[::-1]
        rep[p] = float(v[min(n, len(v) - 1)])
    return rep, taken


rep, taken = replacement_levels(board)

# ---------------------------------------------------------------- undo shrinkage
# A gradient-boosted model predicts a conditional MEAN, which is the right target
# for one player and the wrong one for a market: conditional means are shrunk toward
# the population mean, so the predicted distribution comes out narrower than the real
# one. Over twelve seasons the projected QB1-minus-QB12 gap is 96 points where the
# realised gap is 121, and the visible symptom is a curve with no cliff — the board
# priced QB6 at $39 in a room whose QB6 goes for $20.
#
# Rescale each position's spread around its replacement level, which holds the bottom
# of the pool still and stretches the top. The multipliers are measured in
# decompress.py as realised spread over projected spread, and validated
# leave-one-season-out: they cut the error in points-by-rank at every position
# (QB +4.3, RB +4.1, WR +1.8, TE +0.8 points a rank).
#
# Calibrated to what players actually SCORE, not to what this room pays. Matching the
# room's quarterback prices would erase the very gap the tool exists to find.
try:
    LAMBDA = json.load(open("out/research_lambda.json"))
except FileNotFoundError:
    LAMBDA = dict(QB=1.166, RB=1.293, WR=1.113, TE=1.104)
    print("research_lambda.json not found — using the last fitted multipliers")
lam = board.position.map(LAMBDA).astype(float)
anchor = board.position.map(rep).astype(float)
board["proj_raw"] = board.proj_total
board.loc[lam.notna(), "proj_total"] = (
    anchor + (board.proj_total - anchor) * lam).round(1)[lam.notna()]
print("\nspread correction applied:", {k: round(v, 3) for k, v in LAMBDA.items()})

# replacement is unchanged by construction (it is the anchor), but recompute so the
# flex allocation sees the rescaled pool
rep, taken = replacement_levels(board)
print("replacement levels (2026 projections):", {k: round(v, 1) for k, v in rep.items()})
print("starting slots consumed league-wide:", taken)
board["vorp"] = (board.proj_total - board.position.map(rep)).round(1)
board["pos_rank"] = board.groupby("position").proj_total.rank(ascending=False, method="first").astype(int)

# Auction dollars. A player is worth what he scores above REPLACEMENT — the last
# man who actually starts somewhere, flex included — and the money is split in
# proportion to that surplus.
#
# This used to draw the line at the last man BOUGHT rather than the last man
# started, on the reasoning that everyone below that line costs a dollar. That had
# it exactly backwards: everyone below the line costing a dollar is precisely why
# replacement belongs there. Drawing it at rank ~150 of the skill pool instead of
# rank ~60 left almost every rostered player holding a large surplus, so the money
# spread evenly instead of concentrating, and the curve came out far too flat:
#
#   rank          1     10     50    110
#   this room   $60    $44    $12     $1     (2025 draft sheet, 10 teams, $200)
#   old map     $32    $26    $14     $8
#   fixed       $55    $41    $15     $1
#
# Mean error against the room's own curve falls from $6.61 a rank to $0.88, and the
# number of players priced at a dollar goes from 0 to 60 against the room's 63. No
# exponent or fudge factor is involved — sweeping one only bought another $0.08 a
# rank, which is not worth a parameter fitted to a single draft. The replacement
# levels are the ones `rep` already computes above, with every starting slot
# including the flex allocated; the old block recomputed a different, wrong cut and
# ignored them.
AUCTION_BUDGET = 200
discretionary = AUCTION_BUDGET * TEAMS - ROSTER * TEAMS

# Roster construction first: every team rosters exactly one kicker and one defense,
# so the board carries exactly TEAMS of each and the other spots go to skill players.
# Both are priced at a dollar, which is not a simplification — it is what this room
# actually pays. On the 2025 sheet all ten defenses went for $1 and eight of nine
# kickers went for $1 ($22 of $1,991 between them). Letting them bid against skill
# players for a share of surplus put six extra kickers on the board and $72 into a
# position whose year-over-year correlation is 0.33.
skill = board.position.isin(["QB", "RB", "WR", "TE"])
k_ids = board[board.position == "K"].nlargest(TEAMS, "proj_total").player_id
d_ids = board[board.position == "DST"].nlargest(TEAMS, "proj_total").player_id
skill_spots = ROSTER * TEAMS - 2 * TEAMS

board["surplus"] = np.where(skill, np.maximum(0.0, board.vorp), 0.0)
pool = board.loc[skill, "surplus"].sum()
board["auction"] = np.where(board.surplus > 0, 1 + board.surplus / pool * discretionary, 1.0)
board.loc[~skill, "auction"] = 1.0

# take exactly the players a real draft consumes; everyone else is off-board
bought = set(board[skill].nlargest(skill_spots, "auction").player_id) | set(k_ids) | set(d_ids)
board.loc[~board.player_id.isin(bought), "auction"] = 0.0
board["auction"] = board.auction.round(0)
print(f"auction pricing: ${AUCTION_BUDGET}/team, {ROSTER} spots, "
      f"${discretionary} discretionary; board totals ${board.auction.sum():.0f} "
      f"vs ${AUCTION_BUDGET * TEAMS} in the room")
print(f"  priced above $1: {(board.auction > 1).sum()}   at $1: {(board.auction == 1).sum()}"
      f"   top of board: ${board.auction.max():.0f}")

# tiers: break where the drop to the next player is unusually large
def tier_up(d):
    d = d.sort_values("proj_total", ascending=False).copy()
    gaps = -d.proj_total.diff().fillna(0)
    thresh = max(gaps[1:].quantile(0.80), 1e-6)
    t, cur = [], 1
    for i, gp in enumerate(gaps):
        if i > 0 and gp >= thresh:
            cur += 1
        t.append(cur)
    d["tier"] = t
    return d


board = pd.concat([tier_up(d) for _, d in board.groupby("position")], ignore_index=True)
board["overall_rank"] = board.vorp.rank(ascending=False, method="first").astype(int)
board = board.sort_values("vorp", ascending=False).reset_index(drop=True)

# ---------------------------------------------------------------- flags
def flags(r):
    f = []
    if r.position in ("QB", "RB", "WR", "TE"):
        if pd.notna(r.get("td_luck_pg")) and r.get("td_luck_pg", 0) > 1.5:
            f.append("TD regression risk")
        if pd.notna(r.get("td_luck_pg")) and r.get("td_luck_pg", 0) < -1.2:
            f.append("Positive TD regression")
        if r.position == "RB" and pd.notna(r.age26) and r.age26 >= 27:
            f.append("RB age cliff")
        if r.position in ("WR", "TE") and pd.notna(r.age26) and r.age26 >= 30:
            f.append("Age decline")
        if pd.notna(r.get("games")) and r.get("games", 17) <= 12 and r.get("src") == 2025:
            f.append("Injury history")
        if r.get("src") == 2024:
            f.append("No 2025 usage")
        if r.get("rookie"):
            f.append("Rookie")
    return f


board["flags"] = board.apply(flags, axis=1)

# Carry last season's week-shape stats onto the board. These are descriptive columns
# (the board prices on points — see the WAA finding), but the app and the breakout
# stages read them from here, so attach them where the board is built rather than
# bolting them on afterwards: rebuilding the board used to drop them silently.
try:
    _W = pd.read_parquet("out/win_metrics.parquet")
    _W = _W[_W.season == 2025][["player_id", "waa", "flr", "spk", "ghst"]]
    _W.columns = ["player_id", "waa25", "flr25", "spk25", "ghst25"]
    board = board.merge(_W, on="player_id", how="left")
    print(f"week-shape columns attached for {int(board.flr25.notna().sum())} players")
except FileNotFoundError:
    print("win_metrics.parquet not found — run wins.py first for the WAA columns")

board.to_parquet("out/board2026.parquet")

print("\n" + "=" * 78)
print("2026 BOARD  —  top 40 by VORP")
print("=" * 78)
show = board.head(40)[["overall_rank", "name", "position", "team", "pos_rank", "proj_ppg",
                       "proj_g", "proj_total", "vorp", "tier", "auction"]]
show = show.assign(proj_ppg=show.proj_ppg.round(1), proj_g=show.proj_g.round(1))
print(show.to_string(index=False))
for p in ["QB", "RB", "WR", "TE", "K", "DST"]:
    d = board[board.position == p].head(5)
    print(f"\n  {p}: " + " | ".join(f"{r['name']} {r.proj_total:.0f}" for _, r in d.iterrows()))
