// src/pages/Login.tsx — portal_login.html
//
// CLAUDE.md: the portal previously had no login of its own ("every
// mockup just showed 'J. Alvarez' as if permanently signed in"). This is
// that login, and it routes by role: tenant users land in their own
// portal, a master_admin lands in the Master Console with no tenant in
// scope until they explicitly enter one.
//
// Two steps when MFA is enabled: password first, then a code screen.
// The API never issues a real session token for an MFA account until
// the second factor checks out (see auth.ts's portal_mfa_pending
// token), so the "logged in" state genuinely cannot be reached by
// password alone here either — this isn't just hiding a screen.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../auth/SessionContext";
import { api, ApiError, type SsoStartResponse } from "../api/client";

export function LoginPage() {
  const { login, verifyMfa } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Set once /auth/login says a second factor is required. Its presence
  // is what switches the form to the code screen.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");

  // Scan-first, password-fallback is the pattern the rest of this app
  // uses (profile QR, technician badge); SSO is the same idea for portal
  // sign-in — offered as an alternative path, not a replacement, since
  // most tenants have no SSO connection configured at all.
  const [ssoMode, setSsoMode] = useState(false);
  const [ssoEmail, setSsoEmail] = useState("");
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [ssoBusy, setSsoBusy] = useState(false);

  const submitSso = async (e: React.FormEvent) => {
    e.preventDefault();
    setSsoBusy(true);
    setSsoError(null);
    try {
      const res = await api.post<SsoStartResponse>("/auth/sso/start", { email: ssoEmail.trim() });
      // A real cross-origin navigation to the IdP, not a react-router
      // route — the browser is leaving this app entirely until the IdP
      // redirects it back to /sso/complete.
      window.location.href = res.authorizationUrl;
    } catch (err) {
      setSsoError(
        err instanceof ApiError && err.status === 404
          ? "No SSO connection is configured for that email's organization."
          : err instanceof ApiError
            ? err.message
            : "Could not start SSO sign-in. Check your connection and try again.",
      );
      setSsoBusy(false);
    }
  };

  const goHome = (role: string) => navigate(role === "master_admin" ? "/master" : "/dashboard", { replace: true });

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email.trim(), password);
      if ("mfaRequired" in result) {
        setMfaToken(result.mfaToken);
      } else {
        goHome(result.role);
      }
    } catch (err) {
      // Deliberately not distinguishing "no such user" from "wrong
      // password" — the API returns one message for both, and echoing a
      // narrower one here would reintroduce the account-enumeration the
      // API avoids.
      setError(err instanceof ApiError ? err.message : "Could not sign in. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const role = await verifyMfa(mfaToken!, code.trim());
      goHome(role);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify that code.");
    } finally {
      setBusy(false);
    }
  };

  if (mfaToken) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={submitCode}>
          <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Two-factor verification</h1>
          <p className="page-sub">Enter the 6-digit code from your authenticator app, or one of your backup codes</p>

          {error && <div className="error-box">{error}</div>}

          <div className="field">
            <label htmlFor="mfacode">Code</label>
            <input
              id="mfacode"
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </div>

          <button className="btn" style={{ width: "100%" }} disabled={busy || !code.trim()}>
            {busy ? "Verifying…" : "Verify"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ width: "100%", marginTop: 8 }}
            onClick={() => {
              // This pending token expires on its own in 5 minutes and
              // grants nothing by itself — abandoning it here is safe,
              // not just a UI reset.
              setMfaToken(null);
              setCode("");
              setError(null);
            }}
          >
            Back
          </button>
        </form>
      </div>
    );
  }

  if (ssoMode) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={submitSso}>
          <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Sign in with SSO</h1>
          <p className="page-sub">Enter your work email — we'll redirect you to your organization's identity provider</p>

          {ssoError && <div className="error-box">{ssoError}</div>}

          <div className="field">
            <label htmlFor="ssoemail">Work email</label>
            <input
              id="ssoemail"
              className="input"
              type="email"
              value={ssoEmail}
              onChange={(e) => setSsoEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>

          <button className="btn" style={{ width: "100%" }} disabled={ssoBusy || !ssoEmail.trim()}>
            {ssoBusy ? "Redirecting…" : "Continue"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ width: "100%", marginTop: 8 }}
            onClick={() => {
              setSsoMode(false);
              setSsoError(null);
            }}
          >
            Back to password sign-in
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submitPassword}>
        <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Device Diagnostics</h1>
        <p className="page-sub">Sign in to the admin portal</p>

        {error && <div className="error-box">{error}</div>}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        <button className="btn" style={{ width: "100%" }} disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          style={{ width: "100%", marginTop: 8 }}
          onClick={() => {
            setSsoMode(true);
            setSsoError(null);
          }}
        >
          Sign in with SSO
        </button>
      </form>
    </div>
  );
}
