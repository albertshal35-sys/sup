/**
 * Alerts & daily digest — after every pipeline run, email the critical
 * picture: new high-urgency triggers, notes crossing D-60, fresh liens.
 * Sends through Resend (RESEND_API_KEY secret); recipient + on/off are
 * managed in Settings.
 */

import type { Env } from "./index";

interface AlertConfig {
  enabled: boolean;
  email: string;
}

export async function getAlertConfig(env: Env): Promise<AlertConfig> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM app_settings WHERE key IN ('alerts_enabled','alert_email')"
  ).all<{ key: string; value: string }>();
  const map = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  return { enabled: map.alerts_enabled === "true", email: map.alert_email ?? "" };
}

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error("resend_not_configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.ALERT_FROM || "LienWolf <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const money = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;

/** Build the digest HTML from the last 26h of signals. Returns null if quiet. */
async function buildDigest(env: Env): Promise<{ subject: string; html: string } | null> {
  const [fresh, d60] = await Promise.all([
    env.DB.prepare(
      `SELECT t.kind, t.urgency, t.headline, t.score, e.name AS entity_name,
              p.address, p.city
       FROM triggers t
       JOIN entities e ON e.id = t.entity_id
       LEFT JOIN properties p ON p.id = t.property_id
       WHERE t.detected_at >= datetime('now','-26 hours')
         AND t.status NOT IN ('dismissed','converted')
       ORDER BY t.score DESC LIMIT 20`
    ).all<{ kind: string; urgency: string; headline: string; score: number; entity_name: string; address: string | null; city: string | null }>(),
    env.DB.prepare(
      `SELECT e.name AS entity_name, l.principal, l.rate_pct,
              CAST(julianday(COALESCE(l.maturity_date, date(l.originated_at,'+12 months'))) - julianday('now') AS INTEGER) AS days
       FROM loans l JOIN entities e ON e.id = l.entity_id
       WHERE l.status='active' AND l.lender_type IN ('private','hard_money')
         AND julianday(COALESCE(l.maturity_date, date(l.originated_at,'+12 months'))) - julianday('now') BETWEEN 55 AND 60
       ORDER BY days ASC LIMIT 10`
    ).all<{ entity_name: string; principal: number; rate_pct: number | null; days: number }>(),
  ]);

  if (fresh.results.length === 0 && d60.results.length === 0) return null;

  const critical = fresh.results.filter((t) => t.urgency === "critical");
  const row = (label: string, body: string) =>
    `<tr><td style="padding:6px 10px;font-size:11px;color:#8a919b;white-space:nowrap;vertical-align:top">${label}</td>
     <td style="padding:6px 0;font-size:13px;color:#17191d">${body}</td></tr>`;

  const items = fresh.results
    .map((t) =>
      row(
        `${t.urgency.toUpperCase()} · ${t.score}`,
        `<strong>${t.entity_name}</strong> — ${t.headline}${t.address ? `<br/><span style="color:#5a616a;font-size:12px">${t.address}, ${t.city}</span>` : ""}`
      )
    )
    .join("");
  const balloons = d60.results
    .map((l) =>
      row(
        `D-${l.days}`,
        `<strong>${l.entity_name}</strong> — ${money(l.principal)}${l.rate_pct ? ` @ ${l.rate_pct}%` : ""} crosses the 60-day window`
      )
    )
    .join("");

  const html = `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <h2 style="font-size:16px;color:#17191d;margin:0 0 4px">LienWolf morning digest</h2>
    <p style="font-size:12px;color:#5a616a;margin:0 0 16px">
      ${fresh.results.length} new signal${fresh.results.length === 1 ? "" : "s"} · ${critical.length} critical · ${d60.results.length} note${d60.results.length === 1 ? "" : "s"} entering D-60
    </p>
    ${items ? `<table style="border-collapse:collapse;width:100%">${items}</table>` : ""}
    ${balloons ? `<h3 style="font-size:13px;color:#17191d;margin:18px 0 6px">Crossing D-60</h3><table style="border-collapse:collapse;width:100%">${balloons}</table>` : ""}
    <p style="font-size:11px;color:#8a919b;margin-top:20px">Sent by your LienWolf pipeline · manage in Settings → Alerts</p>
  </div>`;

  const subject = critical.length
    ? `🔴 ${critical.length} critical signal${critical.length === 1 ? "" : "s"} — LienWolf digest`
    : `LienWolf digest — ${fresh.results.length} new signal${fresh.results.length === 1 ? "" : "s"}`;
  return { subject, html };
}

/** Called at the end of every pipeline run. Quiet days send nothing. */
export async function maybeSendDigest(env: Env): Promise<void> {
  const cfg = await getAlertConfig(env);
  if (!cfg.enabled || !cfg.email || !env.RESEND_API_KEY) return;
  const digest = await buildDigest(env);
  if (!digest) return;
  try {
    await sendEmail(env, cfg.email, digest.subject, digest.html);
  } catch (err) {
    console.warn("digest send failed", err);
  }
}

/** Settings "Send test" — always sends, even on a quiet day. */
export async function sendTestDigest(env: Env): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getAlertConfig(env);
  if (!cfg.email) return { ok: false, error: "no_recipient" };
  const digest = (await buildDigest(env)) ?? {
    subject: "LienWolf digest — test",
    html: `<p style="font-family:sans-serif;font-size:13px">Alerts are wired up. Quiet day — no new signals in the last 26 hours.</p>`,
  };
  try {
    await sendEmail(env, cfg.email, digest.subject, digest.html);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}
