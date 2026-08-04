// src/lib/oidc.ts
//
// The OIDC-protocol pieces of SSO: building an authorization URL,
// exchanging a code for tokens, and verifying an id_token's signature
// against the IdP's published keys.
//
// Signature verification specifically is NOT hand-rolled the way
// totp.ts's HMAC-SHA1 was. An id_token is normally RS256 (RSA), and
// verifying that correctly means parsing a JWKS key, converting it to a
// usable key object, and checking the signature per RFC 7518 — getting
// any step of that wrong is a full authentication bypass, not a minor
// bug. `jose` (zero runtime dependencies, the library `openid-client`
// itself is built on) does this well-audited rather than freshly, which
// is the right tradeoff here even though this project otherwise prefers
// hand-rolled crypto for things simple enough to get right on one read.

import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OidcConnectionConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// createRemoteJWKSet keeps its own internal cache of fetched keys, so
// reusing the same instance per jwksUri (rather than constructing one
// per verification) is what actually avoids re-fetching the IdP's keys
// on every single login.
function getJwks(jwksUri: string) {
  let set = jwksCache.get(jwksUri);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, set);
  }
  return set;
}

export function buildAuthorizationUrl(
  connection: OidcConnectionConfig,
  opts: { redirectUri: string; state: string; nonce: string },
): string {
  const url = new URL(connection.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", connection.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("nonce", opts.nonce);
  return url.toString();
}

/** Exchanges an authorization code for tokens at the IdP's token
 *  endpoint. Standard authorization_code grant, client credentials sent
 *  in the body (not Basic auth) — universally accepted, and this stays
 *  interoperable with the widest range of IdPs without per-provider
 *  branching. */
export async function exchangeCodeForTokens(
  connection: OidcConnectionConfig,
  code: string,
  redirectUri: string,
): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: connection.clientId,
    client_secret: connection.clientSecret,
  });

  const response = await fetch(connection.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { id_token?: string };
  if (!data.id_token) {
    throw new Error("Token endpoint response had no id_token");
  }
  return { idToken: data.id_token };
}

export interface VerifiedIdentity {
  subject: string;
  email: string;
}

/** Verifies the id_token's signature (via the IdP's published JWKS),
 *  issuer, audience and nonce — every one of these is a distinct thing
 *  an attacker-controlled or misdirected token could get wrong, and
 *  skipping any single check turns this into an authentication bypass
 *  rather than a login. */
export async function verifyIdToken(
  connection: OidcConnectionConfig,
  idToken: string,
  expectedNonce: string,
): Promise<VerifiedIdentity> {
  const jwks = getJwks(connection.jwksUri);
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: connection.issuer,
    audience: connection.clientId,
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error("Nonce mismatch — possible replay of an old authorization response");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("id_token had no subject claim");
  }
  if (typeof payload.email !== "string" || !payload.email) {
    throw new Error("id_token had no email claim");
  }

  return { subject: payload.sub, email: payload.email.toLowerCase() };
}

/** Test-only escape hatch: lets tests point a fresh jwksUri's cache
 *  entry so re-registering a connection against a freshly-started fake
 *  IdP in the same process doesn't serve a stale key set from an
 *  earlier test's server on the same URL. Not used by production code. */
export function _resetJwksCacheForTests(): void {
  jwksCache.clear();
}
