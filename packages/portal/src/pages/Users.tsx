// src/pages/Users.tsx — portal user management, shown on the Team page.
//
// Two things here are unusual enough to be worth stating.
//
// A newly created account's password is displayed ON SCREEN, once. That
// is not a shortcut around emailing it — no email provider is
// integrated, so an emailed password would go nowhere. Showing it to the
// admin who created the account, with an explicit "this will not be
// shown again", is the honest version of the same handover.
//
// Deactivation is offered before deletion, and is the default framing.
// A deleted user takes their name off nothing — activity-log entries
// record actorUserId, so deleting an account leaves an audit trail
// pointing at an id nobody can resolve.

import { useState } from "react";
import { api, type PortalUser } from "../api/client";
import { useSession } from "../auth/SessionContext";
import { AsyncBoundary, StatusBadge, formatDate, useApi } from "../components/common";

export function UsersSection() {
  const { role, email: myEmail } = useSession();
  const canManage = role !== "tenant_staff";

  const { data, loading, error, reload } = useApi(() => api.get<PortalUser[]>("/users"));
  const users = data ?? [];

  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("tenant_staff");
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Shown once, then gone. Held in memory only — writing it anywhere
  // more durable would undo the point of not storing it.
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      const res = await api.post<{ user: PortalUser; temporaryPassword: string }>("/users", {
        email: newEmail.trim(),
        displayName: newName.trim() || undefined,
        role: newRole,
      });
      setIssued({ email: res.user.email, password: res.temporaryPassword });
      setNewEmail("");
      setNewName("");
      setCreating(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create this user");
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      // The API refuses the lockout cases (last admin, yourself) with an
      // explanation; surfaced verbatim because it says what to do.
      setActionError(err instanceof Error ? err.message : "That didn't work");
    }
  };

  const resetPassword = async (user: PortalUser) => {
    setActionError(null);
    try {
      const res = await api.post<{ temporaryPassword: string }>(`/users/${user.userId}/reset-password`);
      setIssued({ email: user.email, password: res.temporaryPassword });
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not reset that password");
    }
  };

  const remove = (user: PortalUser) => {
    if (
      !confirm(
        `Delete ${user.email}?\n\nDeactivating is usually better: it ends their access immediately and keeps the ` +
          `activity log readable. Deleting leaves past log entries pointing at an account that no longer exists.`,
      )
    ) {
      return;
    }
    void run(() => api.delete(`/users/${user.userId}`));
  };

  return (
    <>
      <div className="row-between" style={{ marginTop: 30 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>Portal users</h2>
          <p className="page-sub" style={{ margin: "4px 0 0" }}>
            People who can sign in to this portal — separate from technicians, who sign in on the tablet
          </p>
        </div>
        {canManage && (
          <button className="btn" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "Add user"}
          </button>
        )}
      </div>

      {issued && (
        <div className="card" style={{ marginTop: 14, borderColor: "var(--accent)" }}>
          <div className="row-between">
            <strong>Temporary password for {issued.email}</strong>
            <button className="btn btn-secondary btn-sm" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
          <code
            style={{
              display: "block",
              marginTop: 10,
              padding: 12,
              background: "var(--panel-soft)",
              borderRadius: 8,
              fontSize: 15,
              letterSpacing: "0.04em",
            }}
          >
            {issued.password}
          </code>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
            Give this to them directly — it is not stored in readable form and will not be shown again. They must
            change it when they first sign in. No email was sent: no email provider is connected.
          </p>
        </div>
      )}

      {creating && (
        <form className="card" style={{ marginTop: 14 }} onSubmit={create}>
          {formError && <div className="error-box">{formError}</div>}
          <div className="field">
            <label htmlFor="uemail">Email</label>
            <input
              id="uemail"
              className="input"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="uname">Name (optional)</label>
            <input id="uname" className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="urole">Role</label>
            <select id="urole" className="input" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
              <option value="tenant_staff">Staff — read-only plus day-to-day work</option>
              <option value="tenant_admin">Admin — can manage users, licences and disputes</option>
            </select>
          </div>
          <button className="btn" disabled={!newEmail.trim()}>
            Create user
          </button>
        </form>
      )}

      {actionError && (
        <div className="error-box" style={{ marginTop: 14 }}>
          {actionError}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 14 }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={users.length === 0} emptyMessage="No portal users yet.">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Access</th>
                <th>Last sign-in</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{user.displayName ?? user.email}</div>
                    {user.displayName && <div className="muted" style={{ fontSize: 12 }}>{user.email}</div>}
                    {user.email === myEmail && (
                      <span className="badge badge-neutral" style={{ marginTop: 4 }}>
                        you
                      </span>
                    )}
                  </td>
                  <td className="muted">{user.role.replace(/_/g, " ")}</td>
                  <td>
                    <StatusBadge status={user.active ? "active" : "deactivated"} />
                    {user.mustChangePassword && (
                      <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                        password not set
                      </span>
                    )}
                  </td>
                  <td className="muted">{user.lastLoginAt ? formatDate(user.lastLoginAt) : "never"}</td>
                  {canManage && (
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => void run(() => api.patch(`/users/${user.userId}`, { active: !user.active }))}
                      >
                        {user.active ? "Deactivate" : "Reactivate"}
                      </button>{" "}
                      <button className="btn btn-secondary btn-sm" onClick={() => void resetPassword(user)}>
                        Reset password
                      </button>{" "}
                      <button className="btn btn-secondary btn-sm" onClick={() => remove(user)}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 12 }}>
        Deactivating ends access on the user's very next request — an open browser tab stops working immediately
        rather than lasting until its session expires. A tenant can never be left with no active admin, and nobody can
        remove their own access.
      </p>
    </>
  );
}
