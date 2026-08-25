"""Stage 25: the price curve was linear, and auctions are not.

project2026.py priced every player as

    price = 1 + surplus / total_surplus * discretionary_budget

which spreads the money in direct proportion to value over the last man bought.
That is the wrong shape. Against what this room actually paid in 2025:

    rank        1      10      50     110
    room      $60     $44     $12      $1
    board     $37     $30     $15      $7

The totals agree ($1995 vs $1991) — the money is all there, it is just in the
wrong place. Every one of the ~100 marginal players is soaking up $5-10 that in
a real room lands on the top twenty.

This measures the true shape against the room's own draft sheet and fits a single
parameter to it: an exponent on surplus.

    price = 1 + k * surplus^gamma

gamma = 1 is the current linear map. gamma > 1 concentrates money at the top and
collapses the tail toward a dollar, which is what an auction does. One parameter,
fit to 169 real purchases, and it has a structural meaning rather than being a
free curve through the data.
"""
import pandas as pd, numpy as np, pickle, re, difflib, json, warnings

warnings.filterwarnings("ignore")
sp = pd.read_parquet("out/player_seasons.parquet")
BOARDS = pickle.load(open("out/boards_cache.pkl", "rb"))["BOARDS"]
L = pd.read_csv("out/league_2025.csv")
TEAMS, ROSTER, BUDGET = 10, 17, 200
LINEUP = dict(QB=2, RB=2, WR=3, TE=1, DST=1, K=1)
FLEX = 1

# ---------------------------------------------------------------- 2025 board
b25, rep25 = BOARDS[2025]
b25 = b25.copy()
nm = sp[sp.season == 2024][["player_id", "player_display_name", "position"]].drop_duplicates("player_id")
b25 = b25.merge(nm, on="player_id", how="left", suffixes=("", "_n"))
b25["name"] = b25.player_display_name.fillna("")
b25 = b25[b25.name != ""]
b25["pos"] = b25.position.fillna(b25.get("position_n"))

# same replacement construction the board uses: the last man actually bought
skill_spots = ROSTER * TEAMS - 2 * TEAMS
drafted = pd.concat([
    b25[b25.pos.isin(["QB", "RB", "WR", "TE"])].nlargest(skill_spots, "proj_blend"),
    b25[b25.pos == "K"].nlargest(TEAMS, "proj_blend"),
    b25[b25.pos == "DST"].nlargest(TEAMS, "proj_blend")])
cut = drafted.groupby("pos").proj_blend.min()
b25["surplus"] = np.maximum(0.0, b25.proj_blend - b25.pos.map(cut))
b25["drafted"] = b25.player_id.isin(drafted.player_id)

# ---------------------------------------------------------------- match names
ALIAS = {"cmc": "christian mccaffrey", "bijan": "bijan robinson", "puka": "puka nacua",
         "amon ra": "amon-ra st brown", "ceedee": "ceedee lamb", "saquon": "saquon barkley",
         "lamar": "lamar jackson", "jamarr chase": "ja'marr chase", "nabers": "malik nabers",
         "jeanty": "ashton jeanty", "josh allen qb": "josh allen"}
b25["key"] = b25.name.str.lower().str.replace(r"[^a-z ]", "", regex=True).str.strip()
names = b25.key.tolist()


def match(raw):
    s = re.sub(r"[^a-z ]", "", str(raw).lower()).strip()
    s = ALIAS.get(s, s)
    if s in names:
        return s
    hit = [n for n in names if n == s or n.endswith(" " + s) or n.startswith(s + " ")]
    if len(hit) == 1:
        return hit[0]
    close = difflib.get_close_matches(s, names, n=1, cutoff=0.84)
    return close[0] if close else None


L["key"] = L.player.apply(match)
m = L.merge(b25[["key", "name", "pos", "surplus", "proj_blend", "drafted"]],
            on="key", how="left")
hit = m[m.surplus.notna()].copy()
print(f"matched {len(hit)}/{len(L)} buys "
      f"(${hit.price.sum():.0f} of ${L.price.sum():.0f})")
miss = m[m.surplus.isna() & (m.price >= 8)]
if len(miss):
    print("unmatched over $7:", list(zip(miss.player, miss.price))[:12])

# ---------------------------------------------------------------- the shape
print("\n" + "=" * 72)
print("A. HOW CONCENTRATED IS THE MONEY, REALLY")
print("=" * 72)
real = np.sort(L.price.values)[::-1]
cur = np.sort(pd.read_parquet("out/board2026.parquet").auction.values)[::-1]
cur = cur[cur >= 1]
print(f"  {'':<16}{'room 2025':>12}{'board (linear)':>16}")
for n in (10, 20, 30, 50, 80):
    print(f"  top {n:<12}{real[:n].sum() / real.sum():>11.1%}{cur[:n].sum() / cur.sum():>16.1%}")
print(f"  {'players at $1':<16}{(real <= 1).sum():>12}{(cur <= 1).sum():>16}")
print(f"  {'players at <=$2':<14}{(real <= 2).sum():>14}{(cur <= 2).sum():>16}")

# ---------------------------------------------------------------- fit gamma
print("\n" + "=" * 72)
print("B. FIT price = 1 + k * surplus^gamma  ON WHAT THE ROOM PAID")
print("=" * 72)
d = hit[hit.surplus > 0].copy()
disc = BUDGET * TEAMS - ROSTER * TEAMS


def fit(gamma, frame, budget=disc):
    s = frame.surplus.values ** gamma
    return 1 + s / s.sum() * budget


best, rows = None, []
for g in np.arange(0.8, 3.01, 0.05):
    pred = fit(g, d)
    err = np.abs(pred - d.price.values).mean()
    sq = np.sqrt(((pred - d.price.values) ** 2).mean())
    rows.append((g, err, sq))
    if best is None or err < best[1]:
        best = (g, err, sq)
print(f"  {'gamma':>7}{'mean abs err':>15}{'rms':>9}")
for g, e, s in rows[::4]:
    star = "   <-- best" if abs(g - best[0]) < 1e-9 else ""
    print(f"  {g:>7.2f}{e:>15.2f}{s:>9.2f}{star}")
print(f"\n  best gamma = {best[0]:.2f}  (mean abs error ${best[1]:.2f}/player, "
      f"vs ${np.abs(fit(1.0, d) - d.price.values).mean():.2f} for the linear map)")

G = best[0]
d["pred_lin"] = fit(1.0, d)
d["pred_new"] = fit(G, d)
print("\n  the top of the board under each map:")
print(f"  {'player':<22}{'paid':>7}{'linear':>9}{'gamma':>8}")
for _, r in d.nlargest(14, "price").iterrows():
    print(f"  {r['name'][:21]:<22}{r.price:>7.0f}{r.pred_lin:>9.0f}{r.pred_new:>8.0f}")

json.dump(dict(gamma=round(float(G), 2), mae=round(float(best[1]), 2),
               mae_linear=round(float(np.abs(fit(1.0, d) - d.price.values).mean()), 2),
               n=int(len(d)),
               curve=[dict(g=round(float(g), 2), mae=round(float(e), 2)) for g, e, s in rows]),
          open("out/research_priceshape.json", "w"), indent=1)
print("\nwrote out/research_priceshape.json")
