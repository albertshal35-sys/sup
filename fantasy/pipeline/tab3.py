"""Add the third tab: situational calls, with its own accuracy on the label."""
p = "app_template.html"
s = open(p).read()

# ---- tab button
s = s.replace(
    '<button role="tab" id="tab-draft" aria-selected="false" aria-controls="panel-draft">Auction Room</button>',
    '<button role="tab" id="tab-draft" aria-selected="false" aria-controls="panel-draft">Auction Room</button>\n'
    '      <button role="tab" id="tab-leap" aria-selected="false" aria-controls="panel-leap">The Leap</button>')
s = s.replace(
    '  <section id="panel-draft" role="tabpanel" aria-labelledby="tab-draft" hidden></section>',
    '  <section id="panel-draft" role="tabpanel" aria-labelledby="tab-draft" hidden></section>\n'
    '  <section id="panel-leap" role="tabpanel" aria-labelledby="tab-leap" hidden></section>')

# ---- renderer
RENDER = r'''
/* ==================================================================
   RENDER — THE LEAP
   ================================================================== */
function renderLeap() {
  const el = $("#panel-leap");
  const B = RESEARCH.breakout;
  const t = soldIds();
  const sosBy = {};
  B.sos.forEach(r => { (sosBy[r.pos] = sosBy[r.pos] || []).push(r); });
  const posName = { QB: "quarterbacks", RB: "running backs", WR: "receivers", TE: "tight ends" };

  el.innerHTML = `
  <div class="grid" style="padding-top:1.1rem">
    <div>
      <p class="eyebrow">The leap</p>
      <h1>Who the price sheet is about to be wrong about</h1>
      <p class="hint" style="max-width:72ch;margin-top:.4rem">
        The board prices a player on what he did. This asks what changed around him — the depth chart he is on
        today, the targets and carries that left his team, a new head coach, how he was being used by December,
        and the defences his 2026 schedule actually serves up. Everything here is measured, and measured against
        the board rather than in place of it.</p>
    </div>

    <div class="card pad">
      <div class="section-head">
        <h2>How much this is worth, honestly</h2>
        <span class="hint">tested on ${B.seasons[0]}–${B.seasons[B.seasons.length - 1]}, one season held out at a time</span>
      </div>
      <div class="findings">
        <div class="finding">
          <p class="eyebrow">The spread it buys</p>
          <div class="bignum good">+${fmt(B.spread)} pts</div>
          <p>Between the players these signals liked most and least, in season-long points above what the
          projection said. Roughly ${fmt(B.spread / 17, 1)} points a week — the difference between a startable
          flex and a bench body. Rank correlation with the miss is ${fmt(B.rho, 3)}, which is modest and honest:
          this sharpens the board, it does not replace it.</p>
          <p class="hint">±${fmt(B.se, 1)} points. Across ${B.n} player-seasons.</p>
        </div>
        <div class="finding">
          <p class="eyebrow">What actually carries it</p>
          <p>Where a player sits on the depth chart, and how far he has moved on it since last preseason, do most
          of the work. Everything else is a tiebreak. Note the sign on a new team: changing uniforms is a
          <em>negative</em> on average, which is the opposite of how the room usually treats it.</p>
          <dl class="kv">
            ${B.signals.slice(0, 7).map(([k, v]) => `<dt>${({
              climb: "moved up the depth chart", depth: "depth chart position",
              new_team: "changed teams", age: "age", games: "games played last year",
              td_luck_pg: "scored under his volume", coach_change: "new head coach",
              trend: "finishing usage vs starting", ppg: "last year's points per game",
              exp: "years in the league", vac_tgt_share: "vacated target share",
              sos: "schedule", sos_playoff: "playoff schedule", car_pg: "carries per game",
              tgt_pg: "targets per game", target_share: "target share",
              vac_car_share: "vacated carry share", vac_tgt: "vacated targets",
              vac_car: "vacated carries"
            })[k] || k}</dt><dd class="num">${v >= 0 ? "+" : ""}${fmt(v, 3)}</dd>`).join("")}
          </dl>
        </div>
        <div class="finding">
          <p class="eyebrow">Where the caution goes</p>
          <p>The model's favourite players are backup quarterbacks, because a third-stringer who wins a job gains
          two hundred points and there is endless room above a projection of nothing. True, and useless — you
          cannot spend an auction on lottery tickets. So this list only contains players the board already prices
          at $2 or more. Treat the dollar figures as a nudge to your ceiling, not a new price.</p>
        </div>
      </div>
    </div>

    <div class="card pad">
      <div class="section-head">
        <h2>Buy</h2>
        <span class="hint">points above the board's projection, and what that is worth in dollars at the margin</span>
      </div>
      <div>
        ${B.picks.map((p, i) => `
          <div class="rec ${i < 3 ? "top" : ""} ${t.has(p.id) ? "gone" : ""}">
            <div class="n mono">${i + 1}</div>
            <div class="body">
              <div><span class="pos-pill pos-${p.pos}">${p.pos}</span>
                <strong>${p.name}</strong>
                <span class="psub">${p.team || ""}${p.bye ? " · bye " + p.bye : ""} · board says
                  $${p.auc} · ${fmt(p.pts)} pts</span>
                <span class="flag good" style="margin-left:.3rem">+${fmt(p.edge)} pts · worth ~$${fmt(p.edged)} more</span></div>
              <div class="why">${p.why.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(". ")}.</div>
              ${p.risk.length ? `<div class="why" style="color:var(--danger)">But: ${p.risk.join("; ")}.</div>` : ""}
            </div>
          </div>`).join("")}
      </div>
    </div>

    <div class="card pad">
      <div class="section-head">
        <h2>Let someone else pay</h2>
        <span class="hint">priced at $8 or more, situation pointing the other way</span>
      </div>
      <div>
        ${B.fades.map(p => `
          <div class="rec ${t.has(p.id) ? "gone" : ""}">
            <div class="body">
              <div><span class="pos-pill pos-${p.pos}">${p.pos}</span> <strong>${p.name}</strong>
                <span class="psub">${p.team || ""} · board says $${p.auc}</span>
                <span class="flag warn" style="margin-left:.3rem">${fmt(p.edge)} pts</span></div>
              ${p.risk.length ? `<div class="why">${p.risk.join("; ")}.</div>` : ""}
            </div>
          </div>`).join("")}
      </div>
    </div>

    <div class="card pad">
      <div class="section-head">
        <h2>Strength of schedule</h2>
        <span class="hint">2026 opponents, graded on what they allowed to each position in 2025</span>
      </div>
      <p class="hint" style="margin-bottom:.7rem">Positive is easier. The playoff column covers weeks 15 to 17,
        which is the only stretch that decides anything. A full season of schedule is worth far less than a depth
        chart — it is a tiebreak between two players you already like, not a reason to buy.</p>
      <div class="tablewrap">
        <table>
          <thead><tr><th class="l">Position</th><th class="l">Softest draws</th><th class="l">Hardest draws</th></tr></thead>
          <tbody>
            ${["QB", "RB", "WR", "TE"].map(pos => {
              const rows = (sosBy[pos] || []).slice().sort((a, b) => b.sos - a.sos);
              const easy = rows.slice(0, 5), hard = rows.slice(-5).reverse();
              return `<tr>
                <td class="l"><span class="pos-pill pos-${pos}">${pos}</span> <span class="psub">${posName[pos]}</span></td>
                <td class="l">${easy.map(r => `<span class="flag good">${r.team} ${r.sos >= 0 ? "+" : ""}${fmt(r.sos, 2)}</span>`).join(" ")}</td>
                <td class="l">${hard.map(r => `<span class="flag warn">${r.team} ${fmt(r.sos, 2)}</span>`).join(" ")}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <details class="method">
        <summary>What this tab cannot see</summary>
        <div class="pad" style="padding-left:0">
          <p>No beat reporting, no camp buzz, no press conferences, no contract talk. The depth charts are
          today's, the rosters are today's, and the coaching changes are real — but a hamstring reported this
          morning is invisible here. Where the model and your ears disagree about a job battle, trust your ears.</p>
          <p>Strength of schedule grades 2026 opponents on what they allowed in <em>2025</em>, and defences move
          around a lot year to year. It belongs at the bottom of the reasoning, which is where the model put it
          on its own — schedule finished near the bottom of the signal list.</p>
        </div>
      </details>
    </div>
  </div>`;
}
'''
s = s.replace("/* ==================================================================\n   BOOT", RENDER +
              "/* ==================================================================\n   BOOT")

# ---- routing
s = s.replace('''  $("#tab-board").setAttribute("aria-selected", S.tab === "board");
  $("#tab-draft").setAttribute("aria-selected", S.tab === "draft");
  $("#panel-board").hidden = S.tab !== "board";
  $("#panel-draft").hidden = S.tab !== "draft";
  if (S.tab === "board") renderBoard(); else renderDraft();''',
'''  $("#tab-board").setAttribute("aria-selected", S.tab === "board");
  $("#tab-draft").setAttribute("aria-selected", S.tab === "draft");
  $("#tab-leap").setAttribute("aria-selected", S.tab === "leap");
  $("#panel-board").hidden = S.tab !== "board";
  $("#panel-draft").hidden = S.tab !== "draft";
  $("#panel-leap").hidden = S.tab !== "leap";
  if (S.tab === "board") renderBoard();
  else if (S.tab === "draft") renderDraft();
  else renderLeap();''')
s = s.replace('$("#tab-draft").onclick = () => { S.tab = "draft"; S.focusSearch = true; render(); };',
              '$("#tab-draft").onclick = () => { S.tab = "draft"; S.focusSearch = true; render(); };\n'
              '$("#tab-leap").onclick = () => { S.tab = "leap"; S.focusSearch = false; render(); };')
open(p, "w").write(s)
print("tab 3 installed")
