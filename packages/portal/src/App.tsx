// src/App.tsx
//
// Routing, and the two access rules that mirror the API's own:
//
//  - Unauthenticated users see only the login page.
//  - Tenant-scoped pages are unreachable without a tenant in scope. A
//    master_admin who hasn't entered a tenant view has none, and the API
//    would reject those calls with a 400 (requireTenantScope). Rather
//    than let a page render and then fail, routing sends them to the
//    Master Console to pick a tenant first.
//
// This is UI convenience, not enforcement — the API is the enforcement.
// Duplicating the rule here just stops the user meeting an error they
// cannot act on.

import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./auth/SessionContext";
import { MasterShell, TenantShell } from "./components/Shell";
import { LoginPage } from "./pages/Login";
import { MasterConsolePage } from "./pages/MasterConsole";
import { DashboardPage } from "./pages/Dashboard";
import { ReportDetailPage, ReportsPage } from "./pages/Reports";
import { DeviceHistoryPage, DevicesPage } from "./pages/Devices";
import { ProfilesPage } from "./pages/Profiles";
import { DisputesPage } from "./pages/Disputes";
import { ActivityLogPage, BillingPage, SettingsPage, TeamPage } from "./pages/Misc";
import { ChangePasswordPage } from "./pages/ChangePassword";
import { CompliancePage } from "./pages/Compliance";
import { TradeInPage } from "./pages/TradeIn";
import { BatchesPage, InvoicesPage, WarrantyPage } from "./pages/Operations";

function TenantRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, viewingTenantId, mustChangePassword } = useSession();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  // A temporary password is one an administrator has seen, so the
  // account is effectively shared until it is replaced. Nothing else in
  // the portal is reachable first.
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  // No tenant in scope — a master_admin who has not entered one. Every
  // tenant-scoped API call would 400, so send them to choose first.
  if (!viewingTenantId) return <Navigate to="/master" replace />;
  return <TenantShell>{children}</TenantShell>;
}

function MasterRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, role, mustChangePassword } = useSession();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  if (role !== "master_admin") return <Navigate to="/dashboard" replace />;
  return <MasterShell>{children}</MasterShell>;
}

export default function App() {
  const { isAuthenticated, role, viewingTenantId, mustChangePassword } = useSession();

  const home = !isAuthenticated
    ? "/login"
    : mustChangePassword
      ? "/change-password"
      : role === "master_admin" && !viewingTenantId
        ? "/master"
        : "/dashboard";

  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to={home} replace /> : <LoginPage />} />

      {/* Reachable while mustChangePassword is set, unlike every other
          page — it is the way out of that state. Rendered in whichever
          shell suits the role so the user is not dropped somewhere
          visually unrecognisable. */}
      <Route
        path="/change-password"
        element={
          !isAuthenticated ? (
            <Navigate to="/login" replace />
          ) : role === "master_admin" && !viewingTenantId ? (
            <MasterShell><ChangePasswordPage /></MasterShell>
          ) : (
            <TenantShell><ChangePasswordPage /></TenantShell>
          )
        }
      />

      <Route path="/master" element={<MasterRoute><MasterConsolePage /></MasterRoute>} />

      <Route path="/dashboard" element={<TenantRoute><DashboardPage /></TenantRoute>} />
      <Route path="/reports" element={<TenantRoute><ReportsPage /></TenantRoute>} />
      <Route path="/reports/:reportId" element={<TenantRoute><ReportDetailPage /></TenantRoute>} />
      <Route path="/devices" element={<TenantRoute><DevicesPage /></TenantRoute>} />
      <Route path="/devices/:deviceKey" element={<TenantRoute><DeviceHistoryPage /></TenantRoute>} />
      <Route path="/profiles" element={<TenantRoute><ProfilesPage /></TenantRoute>} />
      <Route path="/disputes" element={<TenantRoute><DisputesPage /></TenantRoute>} />
      <Route path="/trade-in" element={<TenantRoute><TradeInPage /></TenantRoute>} />
      <Route path="/batches" element={<TenantRoute><BatchesPage /></TenantRoute>} />
      <Route path="/warranty" element={<TenantRoute><WarrantyPage /></TenantRoute>} />
      <Route path="/invoices" element={<TenantRoute><InvoicesPage /></TenantRoute>} />
      <Route path="/compliance" element={<TenantRoute><CompliancePage /></TenantRoute>} />
      <Route path="/billing" element={<TenantRoute><BillingPage /></TenantRoute>} />
      <Route path="/team" element={<TenantRoute><TeamPage /></TenantRoute>} />
      <Route path="/activity" element={<TenantRoute><ActivityLogPage /></TenantRoute>} />
      <Route path="/settings" element={<TenantRoute><SettingsPage /></TenantRoute>} />

      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
