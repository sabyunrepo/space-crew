import { createHmac, timingSafeEqual } from "node:crypto";

/** In the sbp Edge Function deployment the platform gateway verifies the
 * incoming JWT (HS256, exp, role=authenticated, sub is a UUID) before the
 * function ever runs - see supabase/functions/_shared/jwt.ts. Nothing plays
 * that role for the Node server, so this re-implements the full check:
 * without it, an unverified token would let anyone act as any player. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64UrlDecode(input: string): Buffer | null {
  try {
    return Buffer.from(input, "base64url");
  } catch {
    return null;
  }
}

/** JSON.parse can legally return null or a primitive (e.g. the segment
 * decodes to "null" or "123") - guard before dereferencing a property. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Verifies signature, expiry, role and sub shape of an HS256 Supabase auth
 * JWT. Returns the sub (player id) on success, null on any failure. */
export function verifyJwt(token: string, secret: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: unknown;
  let payload: unknown;
  try {
    const headerJson = base64UrlDecode(headerPart);
    const payloadJson = base64UrlDecode(payloadPart);
    if (!headerJson || !payloadJson) return null;
    header = JSON.parse(headerJson.toString("utf8"));
    payload = JSON.parse(payloadJson.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(header) || !isRecord(payload)) return null;
  if (header.alg !== "HS256") return null; // rejects "none" and any asymmetric alg

  const signature = base64UrlDecode(signaturePart);
  if (!signature) return null;
  const expected = createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
    return null;

  if (typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000) return null;
  if (payload.role !== "authenticated") return null;
  if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) return null;
  return payload.sub;
}
