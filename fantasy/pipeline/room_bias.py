"""What this room over- and under-pays for, measured against 2025 fair value.

Names on the sheet are nicknames and abbreviations, so match them loosely against
the 2025 player pool, then price each buy the way the board would have priced him
going into 2025 and compare with what the room actually paid.
"""
import pandas as pd, numpy as np, json, re, difflib

buys = pd.read_csv("out/league_2025.csv")
sp = pd.read_parquet("out/player_seasons.parquet")

# the 2025 player universe, with what they actually scored that season
u = sp[(sp.season == 2025) & sp.position.isin(["QB", "RB", "WR", "TE"])].copy()
u = u[["player_id", "player_display_name", "position", "fpts", "games"]]
u["key"] = u.player_display_name.str.lower().str.replace(r"[^a-z ]", "", regex=True)

ALIAS = {
    "amon ra": "amon-ra st. brown", "cmc": "christian mccaffrey", "puka": "puka nacua",
    "jt": "jonathan taylor", "tae": "davante adams", "reek": "tyreek hill",
    "marv": "marvin harrison", "ceedee": "ceedee lamb", "jamarr chase": "ja'marr chase",
    "jsn": "jaxon smith-njigba", "btj": "brian thomas", "tet": "tetairoa mcmillan",
    "bijan": "bijan robinson", "saquon": "saquon barkley", "lamar": "lamar jackson",
    "hurts": "jalen hurts", "jallen": "josh allen", "caleb": "caleb williams",
    "purdy": "brock purdy", "kyler": "kyler murray", "love": "jordan love",
    "daniels": "jayden daniels", "stroud": "c.j. stroud", "fields": "justin fields",
    "herbert": "justin herbert", "dak": "dak prescott", "goff": "jared goff",
    "maye": "drake maye", "baker": "baker mayfield", "darnold": "sam darnold",
    "bo nix": "bo nix", "jj mccarthy": "j.j. mccarthy", "penix": "michael penix",
    "tlaw": "trevor lawrence", "rodgers": "aaron rodgers", "stafford": "matthew stafford",
    "kittle": "george kittle", "mandrews": "mark andrews", "hock": "t.j. hockenson",
    "njoku": "david njoku", "pitts": "kyle pitts", "kelce": "travis kelce",
    "laporta": "sam laporta", "engram": "evan engram", "evan engram": "evan engram",
    "higgins": "tee higgins", "aj brown": "a.j. brown", "london": "drake london",
    "ladd": "ladd mcconkey", "waddle": "jaylen waddle", "dk": "dk metcalf",
    "terry": "terry mclaurin", "pittman": "michael pittman", "zay": "zay flowers",
    "olave": "chris olave", "shakir": "khalil shakir", "deebo": "deebo samuel",
    "rice": "rashee rice", "jeudy": "jerry jeudy", "pickens": "george pickens",
    "egbuka": "emeka egbuka", "burden": "luther burden", "nabers": "malik nabers",
    "nico collins": "nico collins", "kenny w": "kenneth walker", "jacobs": "josh jacobs",
    "pollard": "tony pollard", "kyren": "kyren williams", "james cook": "james cook",
    "henderson": "treveyon henderson", "kamara": "alvin kamara", "harvey": "jaydon blue",
    "breece": "breece hall", "hampton": "omarion hampton", "jeanty": "ashton jeanty",
    "bucky irving": "bucky irving", "chase brown": "chase brown", "monty": "david montgomery",
    "najee": "najee harris", "javonte": "javonte williams", "dobbins": "j.k. dobbins",
    "judkins": "quinshon judkins", "skattebo": "cam skattebo", "connor": "james conner",
    "aaron jones": "aaron jones", "devonta s": "devonta smith", "addison": "jordan addison",
    "godwin": "chris godwin", "chris godwin": "chris godwin", "doubs": "romeo doubs",
    "mooney": "darnell mooney", "ridley": "calvin ridley", "aiyuk": "brandon aiyuk",
    "odunze": "rome odunze", "legette": "xavier legette", "bateman": "rashod bateman",
    "kirk": "christian kirk", "palmer": "josh palmer", "meyers": "jakobi meyers",
    "worthy": "xavier worthy", "diggs": "stefon diggs", "dj moore": "d.j. moore",
    "marvin mims": "marvin mims", "shahheed": "rashid shaheed", "courtsut": "courtland sutton",
    "travis hunter": "travis hunter", "tyler warren": "tyler warren",
    "kaleb johnson": "kaleb johnson", "guerrendo": "isaac guerendo", "white": "rachaad white",
    "mitchell": "keaton mitchell", "reed": "jayden reed", "bigsby": "tank bigsby",
    "brock bowers": "brock bowers", "mahome": "patrick mahomes",
    "patrick mahome": "patrick mahomes", "derrick henry": "derrick henry",
    "mike evans": "mike evans", "garrett": "garrett wilson", "amon ra ": "amon-ra st. brown",
}

names = u.key.tolist()


def match(raw):
    s = re.sub(r"[^a-z ]", "", str(raw).lower()).strip()
    if s in ALIAS:
        s = ALIAS[s]
    if s in names:
        return s
    hit = [n for n in names if n == s or n.endswith(" " + s) or n.startswith(s + " ")]
    if len(hit) == 1:
        return hit[0]
    close = difflib.get_close_matches(s, names, n=1, cutoff=0.86)
    return close[0] if close else None


buys["key"] = buys.player.apply(match)
m = buys.merge(u, on="key", how="left", suffixes=("", "_u"))
hit = m[m.position.notna()]
print(f"matched {len(hit)} of {len(buys)} buys to a 2025 player "
      f"({hit.price.sum()} of {buys.price.sum()} dollars)")
miss = m[m.position.isna() & (m.price >= 5)]
if len(miss):
    print("unmatched buys over $4:", list(zip(miss.player, miss.price)))

# ---- the room's real positional split, once flex and bench are classified
print("\n" + "=" * 70)
print("WHERE THIS ROOM'S MONEY WENT, 2025")
print("=" * 70)
tot = hit.price.sum()
# Read the board's own split rather than hardcoding it, so a change to the pricing
# cannot silently leave this comparison measuring the previous curve.
_bd = pd.read_parquet("out/board2026.parquet")
_bd = _bd[(_bd.auction >= 1) & _bd.position.isin(["QB", "RB", "WR", "TE"])]
_tot = _bd.auction.sum()
mine = {p: round(_bd.loc[_bd.position == p, "auction"].sum() / _tot * 100, 1)
        for p in ("QB", "RB", "WR", "TE")}
print("board split (skill only):", mine)
print(f"  {'pos':<5}{'paid':>8}{'share':>9}{'board says':>12}{'gap':>8}")
bias = {}
for p in ("QB", "RB", "WR", "TE"):
    s = hit[hit.position == p].price.sum()
    share = s / tot * 100
    bias[p] = dict(paid=int(s), share=round(share, 1), target=mine[p],
                   gap=round(share - mine[p], 1))
    print(f"  {p:<5}{s:>8.0f}{share:>8.1f}%{mine[p]:>11.1f}%{share-mine[p]:>+8.1f}")
k = buys[buys.slot.isin(["K", "DEF"])].price.sum()
print(f"  {'K+DEF':<5}{k:>8.0f}{k/buys.price.sum()*100:>8.1f}%{2.1:>11.1f}%{k/buys.price.sum()*100-2.1:>+8.1f}")

json.dump(bias, open("out/room_bias.json", "w"), indent=1)
hit.to_csv("out/league_2025_matched.csv", index=False)
