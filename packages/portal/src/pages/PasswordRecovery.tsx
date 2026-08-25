// src/pages/PasswordRecovery.tsx — /forgot-password and /reset-password
//
// Two pages that share styling with Login. The API returns identical
// responses for known vs. unknown emails (see auth.ts's /forgot-password
// header) so this UI has no branching for "user found" either — the same
// success screen renders regardless.
//
// With no email provider integrated, the API's response includes a
// deliveryNote saying so and (when DEV_RETURN_RESET_TOKEN=1) the raw
// reset token, which we surface as a copyable link in development only.
// In production the technician is told an admin must reset from the Team
// page — matching Users.tsx's admin-visible-once password handover
// pattern.

import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";

interface ForgotResponse {
  message: string;
  deliveryNote?: string;
  devResetToken?: string;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ForgotResponse | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ForgotResponse>("/auth/forgot-password", { email: email.trim() });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit the request. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const devLink = result.devResetToken
      ? `${window.location.origin}/reset-password?token=${encodeURIComponent(result.devResetToken)}`
      : null;
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Check your email</h1>
          <p className="page-sub">{result.message}</p>
          {result.deliveryNote && (
            <div className="error-box" style={{ background: "#fff8e1", color: "#5b4300", borderColor: "#f0c95c" }}>
              {result.deliveryNote}
            </div>
          )}
          {devLink && (
            <>
              <p className="page-sub" style={{ marginTop: 12 }}>
                <strong>Development mode:</strong> the API returned the reset token directly. Use this link to complete the reset:
              </p>
              <a className="input" style={{ display: "block", wordBreak: "break-all", padding: 8 }} href={devLink}>
                {devLink}
              </a>
            </>
          )}
          <Link className="btn btn-secondary" to="/login" style={{ display: "block", textAlign: "center", marginTop: 12 }}>
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Reset your password</h1>
        <p className="page-sub">Enter the email you sign in with — we'll prepare a reset link.</p>

        {error && <div className="error-box">{error}</div>}

        <div className="field">
          <label htmlFor="fpemail">Email</label>
          <input
            id="fpemail"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </div>

        <button className="btn" style={{ width: "100%" }} disabled={busy || !email.trim()}>
          {busy ? "Submitting…" : "Send reset link"}
        </button>

        <Link className="btn btn-secondary" to="/login" style={{ display: "block", textAlign: "center", marginTop: 8 }}>
          Back to sign in
        </Link>
      </form>
    </div>
  );
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialToken = params.get("token") ?? "";
  const [token, setToken] = useState(initialToken);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/reset-password", { token: token.trim(), newPassword: pw });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset the password.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Password updated</h1>
          <p className="page-sub">You can now sign in with your new password.</p>
          <button className="btn" style={{ width: "100%", marginTop: 12 }} onClick={() => navigate("/login", { replace: true })}>
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Choose a new password</h1>
        <p className="page-sub">Paste the reset token from your email (or the /forgot-password screen in dev).</p>

        {error && <div className="error-box">{error}</div>}

        <div className="field">
          <label htmlFor="rptoken">Reset token</label>
          <input
            id="rptoken"
            className="input"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus={!initialToken}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="rppw">New password</label>
          <input
            id="rppw"
            className="input"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="rppw2">Confirm password</label>
          <input
            id="rppw2"
            className="input"
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        <button className="btn" style={{ width: "100%" }} disabled={busy || !token.trim() || !pw || !pw2}>
          {busy ? "Updating…" : "Update password"}
        </button>

        <Link className="btn btn-secondary" to="/login" style={{ display: "block", textAlign: "center", marginTop: 8 }}>
          Back to sign in
        </Link>
      </form>
    </div>
  );
}
