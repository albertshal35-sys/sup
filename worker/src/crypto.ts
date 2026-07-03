/**
 * Secret storage helpers — vendor API keys live in D1 encrypted with
 * AES-256-GCM. The KEK is derived (SHA-256) from the ADMIN_TOKEN Worker
 * secret, so ciphertext in the database is useless without the secret.
 */

function b64encode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  kekSource: string,
  plaintext: string
): Promise<{ ct: string; iv: string }> {
  const key = await deriveKey(kekSource);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ct: b64encode(ct), iv: b64encode(iv.buffer) };
}

export async function decryptSecret(
  kekSource: string,
  ct: string,
  iv: string
): Promise<string | null> {
  try {
    const key = await deriveKey(kekSource);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(iv) },
      key,
      b64decode(ct)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null; // rotated ADMIN_TOKEN → key must be re-entered
  }
}

/** Constant-time-ish bearer comparison (length + XOR fold). */
export function tokenMatches(header: string | null, expected: string | undefined): boolean {
  if (!header || !expected) return false;
  const provided = header.replace(/^Bearer\s+/i, "");
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
