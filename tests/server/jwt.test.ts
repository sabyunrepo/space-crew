import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyJwt } from "../../server/jwt.ts";

const SECRET = "test-secret-value";

function b64url(input: unknown): string {
  const json = typeof input === "string" ? input : JSON.stringify(input);
  return Buffer.from(json, "utf8").toString("base64url");
}

function sign(header: object, payload: object, secret = SECRET): string {
  const headerPart = b64url(header);
  const payloadPart = b64url(payload);
  const signature = createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");
  return `${headerPart}.${payloadPart}.${signature}`;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: randomUUID(),
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe("verifyJwt", () => {
  it("accepts a valid HS256 token and returns sub", () => {
    const payload = validPayload();
    const token = sign({ alg: "HS256", typ: "JWT" }, payload);
    expect(verifyJwt(token, SECRET)).toBe(payload.sub);
  });

  it("rejects a forged signature", () => {
    const token = sign({ alg: "HS256" }, validPayload(), "wrong-secret");
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = sign(
      { alg: "HS256" },
      validPayload({ exp: Math.floor(Date.now() / 1000) - 10 }),
    );
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects a token with no exp claim", () => {
    const payload: Record<string, unknown> = validPayload();
    delete payload.exp;
    const token = sign({ alg: "HS256" }, payload);
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects a non-authenticated role", () => {
    const token = sign({ alg: "HS256" }, validPayload({ role: "anon" }));
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects a sub that is not a UUID", () => {
    const token = sign({ alg: "HS256" }, validPayload({ sub: "not-a-uuid" }));
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it('rejects alg "none"', () => {
    const headerPart = b64url({ alg: "none" });
    const payloadPart = b64url(validPayload());
    expect(verifyJwt(`${headerPart}.${payloadPart}.`, SECRET)).toBeNull();
  });

  it("rejects an RS256 header even with a matching HS256-computed signature body", () => {
    const token = sign({ alg: "RS256" }, validPayload());
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyJwt("not-a-jwt", SECRET)).toBeNull();
    expect(verifyJwt("a.b", SECRET)).toBeNull();
    expect(verifyJwt("", SECRET)).toBeNull();
  });

  it("returns null (never throws) when the header segment decodes to JSON null", () => {
    const headerPart = b64url(null);
    const payloadPart = b64url(validPayload());
    const signature = createHmac("sha256", SECRET)
      .update(`${headerPart}.${payloadPart}`)
      .digest("base64url");
    expect(() =>
      verifyJwt(`${headerPart}.${payloadPart}.${signature}`, SECRET),
    ).not.toThrow();
    expect(verifyJwt(`${headerPart}.${payloadPart}.${signature}`, SECRET)).toBeNull();
  });

  it("returns null (never throws) when the payload segment decodes to JSON null", () => {
    const headerPart = b64url({ alg: "HS256" });
    const payloadPart = b64url(null);
    const signature = createHmac("sha256", SECRET)
      .update(`${headerPart}.${payloadPart}`)
      .digest("base64url");
    expect(() =>
      verifyJwt(`${headerPart}.${payloadPart}.${signature}`, SECRET),
    ).not.toThrow();
    expect(verifyJwt(`${headerPart}.${payloadPart}.${signature}`, SECRET)).toBeNull();
  });

  it("returns null (never throws) when the payload segment decodes to a JSON number", () => {
    const headerPart = b64url({ alg: "HS256" });
    const payloadPart = b64url(123);
    const signature = createHmac("sha256", SECRET)
      .update(`${headerPart}.${payloadPart}`)
      .digest("base64url");
    expect(() =>
      verifyJwt(`${headerPart}.${payloadPart}.${signature}`, SECRET),
    ).not.toThrow();
    expect(verifyJwt(`${headerPart}.${payloadPart}.${signature}`, SECRET)).toBeNull();
  });
});
