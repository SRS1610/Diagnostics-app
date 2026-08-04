// src/components/Shell.tsx
//
// The portal chrome, in two variants.
//
// The tenant shell shows the tenant-indicator badge on every page.
// CLAUDE.md requires it on Dashboard, Report Detail, Devices, Device
// History, Test Profiles, Compliance, Disputes, Billing & Licenses, Team
// and Settings — putting it in the shell rather than on each page is what
// makes "every page" true by construction instead of by diligence.
//
// The master shell is deliberately a different, darker palette. Quoting
// CLAUDE.md: "a superuser context should never be visually confusable
// with a normal tenant view, to reduce the risk of an admin losing track
// of which context they're acting in." That is a safety property, not
// decoration — a master_admin who thinks they are in their own console
// while actually inside a customer's tenant is how someone edits the
// wrong company's data.

import { NavLink, useNavigate } from "react-router-dom";
import { useSession } from "../auth/SessionContext";

const TENANT_NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/reports", label: "Reports" },
  { to: "/devices", label: "Devices" },
  { to: "/batches", label: "Batch Intake" },
  { to: "/profiles", label: "Test Profiles" },
  { to: "/trade-in", label: "Trade-in" },
  { to: "/disputes", label: "Disputes" },
  { to: "/warranty", label: "Warranty" },
  { to: "/compliance", label: "Compliance" },
  { to: "/billing", label: "Billing & Licenses" },
  { to: "/invoices", label: "Invoices" },
  { to: "/team", label: "Team" },
  { to: "/activity", label: "Activity Log" },
  { to: "/settings", label: "Settings" },
];

export function TenantShell({ children }: { children: React.ReactNode }) {
  const { email, role, viewingTenantId, viewingTenantName, exitTenantView, logout } = useSession();
  const navigate = useNavigate();
  const isMasterVisiting = role === "master_admin";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Device Diagnostics</div>
        <nav>
          {TENANT_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          {/* The tenant indicator. Shows which tenant's data is on
              screen — and when a master_admin is visiting, says so
              explicitly rather than looking like an ordinary session. */}
          <span className="tenant-badge">
            <span className="dot" />
            {viewingTenantName ?? viewingTenantId ?? "No tenant in scope"}
            {isMasterVisiting && " · viewing as master admin"}
          </span>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="muted" style={{ fontSize: 13 }}>{email}</span>
            {isMasterVisiting && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  await exitTenantView();
                  navigate("/master");
                }}
              >
                Exit tenant view
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

export function MasterShell({ children }: { children: React.ReactNode }) {
  const { email, logout } = useSession();

  return (
    <div className="shell">
      <aside className="sidebar master">
        <div className="brand">Master Console</div>
        <nav>
          <NavLink to="/master" end className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
            Tenants
          </NavLink>
        </nav>
      </aside>

      <div className="main master">
        <header className="topbar">
          <span className="master-badge">⚡ PLATFORM — ALL TENANTS</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, color: "#9aa3b2" }}>{email}</span>
            <button className="btn btn-secondary btn-sm" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
