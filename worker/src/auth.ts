/**
 * Access-code authentication. One code (the ACCESS_CODE Worker secret)
 * unlocks the whole product: POST /api/auth/login exchanges the code for
 * a signed session token (HMAC-SHA256 over an expiry timestamp), and every
 * other /api route requires a valid session. The same secret is the KEK
 * for vendor API keys stored in D1.
 */

import type { Env } from "./index";

const SESSION_DAYS = 30;

function secret(env: Env): string | undefined {
  return env.ACCESS_CODE || env.ADMIN_TOKEN; // ADMIN_TOKEN kept as legacy alias
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authConfigured(env: Env): boolean {
  return Boolean(secret(env));
}

export async function loginWithCode(env: Env, code: string): Promise<string | null> {
  const s = secret(env);
  if (!s || !code || !constantTimeEqual(code, s)) return null;
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const sig = await hmacHex(s, `session:${exp}`);
  return `${exp}.${sig}`;
}

export async function verifySession(env: Env, header: string | null): Promise<boolean> {
  const s = secret(env);
  if (!s) return false;
  const token = header?.replace(/^Bearer\s+/i, "") ?? "";
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await hmacHex(s, `session:${exp}`);
  return constantTimeEqual(token.slice(dot + 1), expected);
}
