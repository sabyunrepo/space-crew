/** The self-hosted platform's router verifies the incoming JWT (HS256, exp,
 * role=authenticated, sub is a UUID) before this function ever runs, so the
 * function only needs to decode the payload - no signature re-verification,
 * no network round trip to GoTrue. See claudedocs/SUPABASE-BPRIME-PROBE.ko.md. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64UrlDecode(input: string): string {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeJwtSub(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { sub?: unknown };
    return typeof payload.sub === "string" && UUID_RE.test(payload.sub) ? payload.sub : null;
  } catch {
    return null;
  }
}
