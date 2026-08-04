// tests/fakeIdp.ts
//
// A real, minimal OIDC identity provider running in-process on an
// ephemeral port — the same "prove it with a real HTTP round trip"
// reasoning as webhooks.test.ts's receiver. sso.ts's callback route
// makes a REAL outbound HTTP call to the configured tokenEndpoint and a
// REAL fetch of jwksUri (via jose's createRemoteJWKSet); a mock of the
// fetch function would only prove the mock was wired up correctly, not
// that the actual HTTP + signature-verification path works.
//
// Deliberately NOT simulating the browser-facing authorization_endpoint
// — that's a redirect a human's browser follows, has no meaningful
// server-side behavior to test, and the "code" it hands back is opaque
// to everything except the IdP that issued it. Tests instead mint the
// code and its matching id_token directly, the same shortcut a real
// integration test against a sandbox IdP could not take but an
// in-process fake legitimately can.

import http from "node:http";
import { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface FakeIdp {
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string;
  /** Mints a real, correctly-signed id_token for this IdP's key and
   *  registers it to be returned for the given authorization `code`. */
  registerToken(code: string, claims: { sub: string; email: string; nonce: string; audience: string }): Promise<void>;
  /** Registers an already-built token string (e.g. one signed with a
   *  DIFFERENT key by signWithWrongKey) to be returned verbatim for the
   *  given code — for tests proving the callback rejects a token this
   *  IdP itself never actually signed. */
  registerRawToken(code: string, idToken: string): void;
  close(): Promise<void>;
}

const KID = "test-key-1";

export async function startFakeIdp(): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";

  const codes = new Map<string, string>(); // code -> id_token

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const code = params.get("code") ?? "";
        const idToken = codes.get(code);
        if (!idToken) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id_token: idToken, access_token: "unused", token_type: "Bearer" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const issuer = base;

  return {
    issuer,
    jwksUri: `${base}/jwks`,
    tokenEndpoint: `${base}/token`,
    async registerToken(code, claims) {
      const idToken = await new SignJWT({ email: claims.email, nonce: claims.nonce })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setSubject(claims.sub)
        .setIssuer(issuer)
        .setAudience(claims.audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      codes.set(code, idToken);
    },
    registerRawToken(code, idToken) {
      codes.set(code, idToken);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A second, unrelated keypair — for proving a token signed by the
 *  WRONG key is rejected even though every claim in it is otherwise
 *  valid. Not tied to any running server; jwtVerify never gets far
 *  enough to fetch a JWKS for a signature check that already failed. */
export async function signWithWrongKey(claims: {
  sub: string;
  email: string;
  nonce: string;
  issuer: string;
  audience: string;
}): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256");
  return new SignJWT({ email: claims.email, nonce: claims.nonce })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(claims.sub)
    .setIssuer(claims.issuer)
    .setAudience(claims.audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}
