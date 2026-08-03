// src/pages/Login.tsx — portal_login.html
//
// CLAUDE.md: the portal previously had no login of its own ("every
// mockup just showed 'J. Alvarez' as if permanently signed in"). This is
// that login, and it routes by role: tenant users land in their own
// portal, a master_admin lands in the Master Console with no tenant in
// scope until they explicitly enter one.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../auth/SessionContext";
import { ApiError } from "../api/client";

export function LoginPage() {
  const { login } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const role = await login(email.trim(), password);
      navigate(role === "master_admin" ? "/master" : "/dashboard", { replace: true });
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

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
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
      </form>
    </div>
  );
}
