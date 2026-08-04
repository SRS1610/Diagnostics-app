// src/pages/ChangePassword.tsx
//
// Serves two jobs from one screen: the forced change after an admin has
// provisioned or reset an account, and the ordinary voluntary change.
//
// The forced case is not a formality. A temporary password has been
// spoken aloud, written on a note, or pasted into a chat — an admin has
// definitely seen it. Until it is replaced the account is effectively
// shared, so the portal will not let a user go anywhere else first.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useSession } from "../auth/SessionContext";

const MIN_LENGTH = 12;

export function ChangePasswordPage() {
  const { mustChangePassword, clearMustChangePassword, logout } = useSession();
  const navigate = useNavigate();

  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Checked here as well as server-side so the mismatch is caught before
  // a round trip; the API remains the authority on everything else.
  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const submittable = !busy && currentPassword && newPassword.length >= MIN_LENGTH && newPassword === confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/change-password", { currentPassword, newPassword });
      clearMustChangePassword();
      setDone(true);
      setCurrent("");
      setNew("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change your password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 460 }}>
      <h1 className="page-title">{mustChangePassword ? "Choose a password" : "Change your password"}</h1>

      {mustChangePassword ? (
        <p className="page-sub">
          Your account was set up with a temporary password that an administrator has seen. Choose your own before
          continuing.
        </p>
      ) : (
        <p className="page-sub">You'll need your current password to set a new one.</p>
      )}

      {done ? (
        <div className="card">
          <p style={{ margin: 0 }}>Password changed.</p>
          <p className="muted" style={{ fontSize: 13 }}>
            Sessions on other devices are unaffected — sign out everywhere by changing it again from each, or ask an
            admin to reset the account.
          </p>
          <button className="btn" onClick={() => navigate("/dashboard")}>
            Continue
          </button>
        </div>
      ) : (
        <form className="card" onSubmit={submit}>
          {error && <div className="error-box">{error}</div>}

          <div className="field">
            <label htmlFor="current">Current password</label>
            <input
              id="current"
              className="input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="next">New password</label>
            <input
              id="next"
              className="input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
              required
            />
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {/* Length, not a composition rule — mandatory symbols and
                  digits push people towards Password1! */}
              At least {MIN_LENGTH} characters. A phrase you can remember beats a short complicated string.
            </p>
            {tooShort && <div className="error-box">Too short — {MIN_LENGTH} characters minimum.</div>}
          </div>

          <div className="field">
            <label htmlFor="confirm">Confirm new password</label>
            <input
              id="confirm"
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
            {mismatch && <div className="error-box">Those don't match.</div>}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" disabled={!submittable}>
              Set password
            </button>
            {/* No "skip" on the forced path — that would leave the
                account on a password someone else knows. Signing out is
                the only other way forward. */}
            {mustChangePassword && (
              <button type="button" className="btn btn-secondary" onClick={logout}>
                Sign out
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
