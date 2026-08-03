// src/pages/Profiles.tsx — admin_portal_profiles.html
//
// Test Profiles: name, PIN, enabled tests, and the printable QR that the
// mobile app scans at intake. CLAUDE.md's profile QR encodes
// tenantId:pin together, which is what lets two tenants both use PIN
// 4726 without collision — so the QR payload comes from the API rather
// than being assembled here from the PIN alone.

import { useState } from "react";
import { api, type CustomerProfile } from "../api/client";
import { AsyncBoundary, formatDate, useApi } from "../components/common";

export function ProfilesPage() {
  const { data, loading, error, reload } = useApi(() => api.get<CustomerProfile[]>("/profiles"));
  const profiles = data ?? [];

  const [creating, setCreating] = useState(false);
  const [customerName, setName] = useState("");
  const [pin, setPin] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ name: string; payload: string } | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      await api.post("/profiles", { customerName: customerName.trim(), pin: pin.trim(), enabledTestIds: [] });
      setName("");
      setPin("");
      setCreating(false);
      await reload();
    } catch (err) {
      // The API rejects a duplicate PIN within this tenant with a 409 —
      // surfaced verbatim, since "PIN already in use" is exactly what
      // the admin needs to know.
      setFormError(err instanceof Error ? err.message : "Could not create profile");
    }
  };

  const showQr = async (profile: CustomerProfile) => {
    const res = await api.get<{ payload: string }>(`/profiles/${profile.profileId}/qr`);
    setQr({ name: profile.customerName, payload: res.payload });
  };

  const remove = async (profile: CustomerProfile) => {
    if (!confirm(`Delete profile "${profile.customerName}"? Sessions using its PIN will stop resolving.`)) return;
    await api.delete(`/profiles/${profile.profileId}`);
    await reload();
  };

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Test Profiles</h1>
          <p className="page-sub">Named test sets a technician loads by scanning a QR or entering a PIN</p>
        </div>
        <button className="btn" onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "New Profile"}</button>
      </div>

      {creating && (
        <form className="card" style={{ marginBottom: 20 }} onSubmit={create}>
          {formError && <div className="error-box">{formError}</div>}
          <div className="field">
            <label htmlFor="pname">Profile name</label>
            <input id="pname" className="input" value={customerName} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="ppin">PIN (4–6 digits)</label>
            <input id="ppin" className="input" value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" required />
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Only needs to be unique within this tenant — another company can use the same PIN safely, because the
              QR encodes the tenant alongside it.
            </p>
          </div>
          <button className="btn" disabled={!customerName.trim() || !pin.trim()}>Create profile</button>
        </form>
      )}

      {qr && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="row-between">
            <strong>{qr.name} — QR payload</strong>
            <button className="btn btn-secondary btn-sm" onClick={() => setQr(null)}>Close</button>
          </div>
          <code style={{ display: "block", marginTop: 10, padding: 12, background: "var(--panel-soft)", borderRadius: 8, fontSize: 13 }}>
            {qr.payload}
          </code>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Encode this string as a QR code and post it at the intake station. Rendering the image itself isn't wired
            up yet — the payload is the part that has to be exact.
          </p>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={profiles.length === 0} emptyMessage="No profiles configured.">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>PIN</th>
                <th>Tests</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.profileId}>
                  <td style={{ fontWeight: 600 }}>{p.customerName}</td>
                  <td className="muted">{p.pin}</td>
                  <td>{p.enabledTestIds.length}</td>
                  <td className="muted">{formatDate(p.updatedAt)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => void showQr(p)}>QR</button>{" "}
                    <button className="btn btn-secondary btn-sm" onClick={() => void remove(p)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>
    </>
  );
}
