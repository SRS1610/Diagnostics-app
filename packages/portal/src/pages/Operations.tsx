// src/pages/Operations.tsx — invoices, batch intake, warranty claims.
//
// Three views over APIs that already worked and had no screen. Grouped
// in one file because each is a single table over a single endpoint; the
// pages that carry real interaction live on their own.

import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { api, type License } from "../api/client";
import { useSession } from "../auth/SessionContext";
import { AsyncBoundary, StatCard, StatusBadge, formatDate, useApi } from "../components/common";

function money(amount: number, currency = "USD") {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

// ============================================================
// Invoices
// ============================================================

interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

interface Invoice {
  invoiceId: string;
  licenseId: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  total: number;
  status: string;
  issuedAt: string;
  dueAt: string;
}

const INVOICE_STATUSES = ["draft", "sent", "paid", "overdue", "void"];

export function InvoicesPage() {
  const { role } = useSession();
  const canManage = role !== "tenant_staff";

  const { data, loading, error, reload } = useApi(() => api.get<Invoice[]>("/invoices"));
  const invoices = data ?? [];
  const licences = useApi(() => api.get<License[]>("/licenses"));

  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const outstanding = invoices
    .filter((i) => i.status !== "paid" && i.status !== "void")
    .reduce((sum, i) => sum + i.total, 0);

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "That didn't work");
    }
  };

  const activeLicence = (licences.data ?? []).find((l) => l.status === "active");

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Invoices</h1>
          <p className="page-sub">Generated from licence usage — what to bill, not a charge</p>
        </div>
        {canManage && activeLicence && (
          <button
            className="btn"
            onClick={() => void run(() => api.post("/invoices", { licenseId: activeLicence.licenseId }))}
          >
            Generate from current licence
          </button>
        )}
      </div>

      <div className="stat-grid">
        <StatCard value={invoices.length} label="Invoices" loading={loading} error={error} />
        <StatCard
          value={money(outstanding)}
          label="Outstanding"
          loading={loading}
          error={error}
          color={outstanding > 0 ? "var(--warn)" : undefined}
        />
      </div>

      {actionError && <div className="error-box">{actionError}</div>}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary
          loading={loading}
          error={error}
          isEmpty={invoices.length === 0}
          emptyMessage="No invoices generated yet."
        >
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Total</th>
                <th>Status</th>
                <th>Due</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                // Fragment with an explicit key: a list item that renders
                // TWO rows (the invoice and its expanded line items)
                // needs the key on the wrapper, not the children. React
                // strips this warning from production builds, so the e2e
                // suite would never have caught it.
                <Fragment key={invoice.invoiceId}>
                  <tr>
                    <td>
                      <button
                        className="link-btn"
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--accent)", fontWeight: 600 }}
                        onClick={() => setExpanded(expanded === invoice.invoiceId ? null : invoice.invoiceId)}
                      >
                        {new Date(invoice.billingPeriodStart).toLocaleDateString()} –{" "}
                        {new Date(invoice.billingPeriodEnd).toLocaleDateString()}
                      </button>
                    </td>
                    <td>
                      <strong>{money(invoice.total)}</strong>
                    </td>
                    <td>
                      <StatusBadge status={invoice.status} />
                    </td>
                    <td className="muted">{formatDate(invoice.dueAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      {canManage && (
                        <select
                          className="input"
                          style={{ width: "auto", display: "inline-block" }}
                          value={invoice.status}
                          onChange={(e) =>
                            void run(() => api.patch(`/invoices/${invoice.invoiceId}`, { status: e.target.value }))
                          }
                        >
                          {INVOICE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  </tr>
                  {expanded === invoice.invoiceId && (
                    <tr>
                      <td colSpan={5} style={{ background: "var(--panel-soft)" }}>
                        <table>
                          <thead>
                            <tr>
                              <th>Line item</th>
                              <th>Qty</th>
                              <th>Unit</th>
                              <th>Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(invoice.lineItems ?? []).map((line, i) => (
                              <tr key={i}>
                                <td>{line.description}</td>
                                <td>{line.quantity}</td>
                                <td>{money(line.unitPrice)}</td>
                                <td>{money(line.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 14 }}>
        {/* invoicing.ts is explicit that it produces what to bill and
            charges nobody. Marking an invoice "paid" here records that
            you were paid some other way; it does not collect anything. */}
        Nothing on this page charges a customer. Amounts use placeholder plan pricing and are not billable as-is —
        collecting payment needs a processor, which is not integrated. Changing a status records what happened
        elsewhere.
      </p>
    </>
  );
}

// ============================================================
// Batch intake
// ============================================================

interface Batch {
  batchId: string;
  sourceName: string;
  profileId: string | null;
  technicianId: string | null;
  deviceSerials: string[];
  status: string;
  createdAt: string;
  closedAt: string | null;
}

export function BatchesPage() {
  const { data, loading, error } = useApi(() => api.get<Batch[]>("/batches"));
  const batches = data ?? [];

  const open = batches.filter((b) => b.status === "open");
  const devices = batches.reduce((sum, b) => sum + b.deviceSerials.length, 0);

  return (
    <>
      <h1 className="page-title">Batch intake</h1>
      <p className="page-sub">Lots scanned in on the tablet — a carrier buyback, a corporate refresh</p>

      <div className="stat-grid">
        <StatCard value={batches.length} label="Batches" loading={loading} error={error} />
        <StatCard value={open.length} label="Still open" loading={loading} error={error} color={open.length ? "var(--warn)" : undefined} />
        <StatCard value={devices} label="Devices scanned" loading={loading} error={error} />
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary
          loading={loading}
          error={error}
          isEmpty={batches.length === 0}
          emptyMessage="No batches. A technician starts one on the tablet."
        >
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Devices</th>
                <th>Status</th>
                <th>Started</th>
                <th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.batchId}>
                  <td style={{ fontWeight: 600 }}>{batch.sourceName}</td>
                  <td>{batch.deviceSerials.length}</td>
                  <td>
                    <StatusBadge status={batch.status === "open" ? "awaiting_review" : "completed"} />
                    <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>{batch.status}</span>
                  </td>
                  <td className="muted">{formatDate(batch.createdAt)}</td>
                  <td className="muted">{batch.closedAt ? formatDate(batch.closedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 14 }}>
        {/* Read-only on purpose: a batch is built by scanning devices,
            which happens on the tablet. A "create batch" button here
            would produce an empty lot nobody is standing next to. */}
        Batches are started and closed on the tablet, where the scanning happens. This is the view of them.
        Re-scanning a serial already in a lot is a no-op rather than a duplicate.
      </p>
    </>
  );
}

// ============================================================
// Warranty claims
// ============================================================

interface WarrantyClaim {
  claimId: string;
  reportId: string;
  deviceSerial: string;
  claimedIssue: string;
  submittedAt: string;
  warrantyExpiresAt: string;
  status: string;
  resolutionNotes: string | null;
}

const CLAIM_STATUSES = ["open", "investigating", "approved", "denied", "resolved"];

export function WarrantyPage() {
  const { role } = useSession();
  const canManage = role !== "tenant_staff";

  const { data, loading, error, reload } = useApi(() => api.get<WarrantyClaim[]>("/warranty-claims"));
  const claims = data ?? [];
  const [actionError, setActionError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const open = claims.filter((c) => c.status === "open" || c.status === "investigating");

  const update = async (claim: WarrantyClaim, status: string) => {
    setActionError(null);
    try {
      await api.patch(`/warranty-claims/${claim.claimId}`, {
        status,
        resolutionNotes: notes[claim.claimId]?.trim() || undefined,
      });
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not update that claim");
    }
  };

  return (
    <>
      <h1 className="page-title">Warranty claims</h1>
      <p className="page-sub">Post-sale claims traced back to the inspection that cleared the device</p>

      <div className="stat-grid">
        <StatCard value={claims.length} label="Claims" loading={loading} error={error} />
        <StatCard
          value={open.length}
          label="Needing attention"
          loading={loading}
          error={error}
          color={open.length ? "var(--warn)" : undefined}
        />
      </div>

      {actionError && <div className="error-box">{actionError}</div>}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={claims.length === 0} emptyMessage="No warranty claims.">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Reported issue</th>
                <th>Status</th>
                <th>Warranty ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => {
                const expired = new Date(claim.warrantyExpiresAt).getTime() < Date.now();
                return (
                  <tr key={claim.claimId}>
                    <td>
                      <Link to={`/reports/${claim.reportId}`} style={{ color: "var(--accent)", fontWeight: 600 }}>
                        {claim.deviceSerial}
                      </Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        filed {formatDate(claim.submittedAt)}
                      </div>
                    </td>
                    <td>
                      {claim.claimedIssue}
                      {claim.resolutionNotes && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          {claim.resolutionNotes}
                        </div>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={claim.status} />
                      {expired && (
                        <div>
                          <span className="badge badge-neutral" style={{ marginTop: 4 }}>
                            out of warranty
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="muted">{formatDate(claim.warrantyExpiresAt)}</td>
                    <td style={{ textAlign: "right", minWidth: 220 }}>
                      {canManage && (
                        <>
                          <input
                            className="input"
                            placeholder="Resolution note"
                            value={notes[claim.claimId] ?? ""}
                            onChange={(e) => setNotes((n) => ({ ...n, [claim.claimId]: e.target.value }))}
                          />
                          <select
                            className="input"
                            style={{ marginTop: 6 }}
                            value={claim.status}
                            onChange={(e) => void update(claim, e.target.value)}
                          >
                            {CLAIM_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 14 }}>
        {/* warrantyTracking.ts's claimRateByTechnician() is the reason
            claims link back to a report: a cluster of claims against one
            technician's inspections is a signal worth watching. */}
        Each claim links to the inspection that passed the device, so a pattern against one technician's work is
        visible rather than buried.
      </p>
    </>
  );
}
