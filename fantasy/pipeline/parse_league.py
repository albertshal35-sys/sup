"""Parse last year's actual auction sheet: who this room bought and what they paid."""
import pdfplumber, pandas as pd, re, json

PDF = "/root/.claude/uploads/b6dbd986-fdbc-537a-8465-5370390179a6/4b2cd901-Morns_Fantasy_Football_Auction_Draft_Tracker__2025.pdf"
with pdfplumber.open(PDF) as pdf:
    tbl = pdf.pages[0].extract_tables()[0]

SLOTS = {"QB", "RB", "WR", "TE", "FLEX", "K", "DEF", "BENCH"}
rows = []
teams_hdr = None
for r in tbl:
    cells = [(c or "").strip() for c in r]
    if "Amount Spent" in cells:                      # a header row starts a block of 5 teams
        teams_hdr = [(cells[i], i, i + 1) for i in range(len(cells))
                     if cells[i] and cells[i] != "Amount Spent" and i + 1 < len(cells)
                     and cells[i + 1] == "Amount Spent"]
        continue
    if not teams_hdr:
        continue
    slot = cells[1] if len(cells) > 1 and cells[1] in SLOTS else (cells[0] if cells and cells[0] in SLOTS else None)
    if slot is None:
        continue
    for name, ci, pi in teams_hdr:
        player = cells[ci] if ci < len(cells) else ""
        price = cells[pi] if pi < len(cells) else ""
        player = player.strip()
        m = re.search(r"\$?\s*(\d+)", price or "")
        if not player or not m:
            continue
        rows.append(dict(team=name, slot=slot, player=player, price=int(m.group(1))))

df = pd.DataFrame(rows)
df.to_csv("out/league_2025.csv", index=False)
print(f"parsed {len(df)} buys across {df.team.nunique()} teams")
print()
sp = df.groupby("team").price.agg(["sum", "size"]).rename(columns={"sum": "spent", "size": "players"})
print(sp.to_string())
print(f"\ntotal spent ${df.price.sum()} of ${df.team.nunique()*200}")
print()
print("spend by roster slot:")
g = df.groupby("slot").price.agg(["sum", "size", "mean", "max"]).sort_values("sum", ascending=False)
g["pct"] = (g["sum"] / df.price.sum() * 100).round(1)
print(g.round(1).to_string())
print()
print("the 20 most expensive buys:")
print(df.nlargest(20, "price")[["player", "slot", "price", "team"]].to_string(index=False))
