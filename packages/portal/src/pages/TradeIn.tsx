// src/pages/TradeIn.tsx — quotes, payouts and marketplace listings.
//
// The API for all of this existed and had no screen, which meant the
// only way to see what a tenant had offered anyone was to query the
// database. This is the operations view: what was offered, what was
// accepted, and what has been paid.
//
// The page is blunt about two things, because money is involved:
//
//  1. A quote priced from the illustrative seed table is labelled as
//     such and cannot be accepted. CLAUDE.md is explicit that the seed
//     prices are "rough/illustrative" and that web-sourced trade-in
//     pricing varied by 2x+ between sources. A number that looks like an
//     offer is treated as one by whoever reads it.
//
//  2. A payout row is a RECORD of an intended disbursement, not a
//     payment. No processor is integrated. The page says so where the
//     status is shown, not in a footnote.

import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useSession } from "../auth/SessionContext";
import { AsyncBoundary, StatCard, StatusBadge, formatDate, useApi } from "../components/common";

interface Payout {
  payoutId: string;
  method: string;
  status: string;
  amount: number;
  initiatedAt: string;
  completedAt: string | null;
  reference: string | null;
  failureReason: string | null;
}

interface Quote {
  quoteId: string;
  reportId: string;
  deviceModel: string;
  grade: string;
  basePrice: number;
  finalOffer: number;
  currency: string;
  quotedAt: string;
  expiresAt: string;
  priceSource: string;
  accepted: boolean;
  acceptedAt: string | null;
  payout?: Payout | null;
}

interface Listing {
  listingId: string;
  reportId: string;
  title: string;
  askingPrice: number;
  currency: string;
  createdAt: string;
}

const SEED_SOURCE = "unverified_seed_data";

function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function TradeInPage() {
  const { role } = useSession();
  const canAct = role !== "tenant_staff";

  const quotesQuery = useApi(() => api.get<Quote[]>("/quotes"));
  const listingsQuery = useApi(() => api.get<Listing[]>("/listings"));

  const quotes = quotesQuery.data ?? [];
  const listings = listingsQuery.data ?? [];

  const [actionError, setActionError] = useState<string | null>(null);

  const accepted = quotes.filter((q) => q.accepted);
  const awaiting = quotes.filter((q) => !q.accepted);
  const paidOut = quotes.filter((q) => q.payout);
  const owed = accepted
    .filter((q) => !q.payout || q.payout.status !== "completed")
    .reduce((sum, q) => sum + q.finalOffer, 0);

  const currency = quotes[0]?.currency ?? "USD";

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await quotesQuery.reload();
    } catch (e) {
      // The API refuses acceptance on an expired quote, a seed-priced
      // one, or one with an open dispute — each with a specific reason.
      setActionError(e instanceof Error ? e.message : "That didn't work");
    }
  };

  return (
    <>
      <h1 className="page-title">Trade-in</h1>
      <p className="page-sub">Offers made to customers, what they accepted, and what is owed</p>

      <div className="stat-grid">
        <StatCard
          value={awaiting.length}
          label="Awaiting a decision"
          loading={quotesQuery.loading}
          error={quotesQuery.error}
        />
        <StatCard
          value={accepted.length}
          label="Accepted"
          loading={quotesQuery.loading}
          error={quotesQuery.error}
          color="var(--success)"
        />
        <StatCard
          value={money(owed, currency)}
          label="Accepted, not yet paid"
          loading={quotesQuery.loading}
          error={quotesQuery.error}
          color={owed > 0 ? "var(--warn)" : undefined}
        />
        <StatCard
          value={listings.length}
          label="Marketplace listings"
          loading={listingsQuery.loading}
          error={listingsQuery.error}
        />
      </div>

      {actionError && <div className="error-box">{actionError}</div>}

      <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Quotes</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary
          loading={quotesQuery.loading}
          error={quotesQuery.error}
          isEmpty={quotes.length === 0}
          emptyMessage="No quotes yet. A quote is computed from a completed inspection and a price list."
        >
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Grade</th>
                <th>Offer</th>
                <th>Status</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => {
                const seedPriced = quote.priceSource === SEED_SOURCE;
                const expired = new Date(quote.expiresAt).getTime() < Date.now();
                return (
                  <tr key={quote.quoteId}>
                    <td>
                      <Link to={`/reports/${quote.reportId}`} style={{ color: "var(--accent)", fontWeight: 600 }}>
                        {quote.deviceModel}
                      </Link>
                    </td>
                    <td>{quote.grade}</td>
                    <td>
                      <strong>{money(quote.finalOffer, quote.currency)}</strong>
                      {seedPriced && (
                        <div>
                          {/* Not a footnote: a figure from the seed table
                              is not an offer anyone can honour. */}
                          <span className="badge badge-warn" style={{ marginTop: 4 }}>
                            illustrative pricing
                          </span>
                        </div>
                      )}
                    </td>
                    <td>
                      {quote.accepted ? (
                        <StatusBadge status="accepted" />
                      ) : expired ? (
                        <StatusBadge status="expired" />
                      ) : (
                        <StatusBadge status="awaiting_review" />
                      )}
                    </td>
                    <td className="muted">{formatDate(quote.expiresAt)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {canAct && !quote.accepted && !expired && !seedPriced && (
                        <button
                          className="btn btn-sm"
                          onClick={() => void run(() => api.post(`/quotes/${quote.quoteId}/accept`))}
                        >
                          Accept
                        </button>
                      )}
                      {canAct && quote.accepted && !quote.payout && (
                        <PayoutForm quoteId={quote.quoteId} onDone={() => void quotesQuery.reload()} />
                      )}
                      {quote.payout && <PayoutCell payout={quote.payout} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 12 }}>
        {paidOut.length > 0
          ? "A payout row records the method a customer chose and the amount owed. Nothing here moves money — no payment processor is integrated."
          : "Recording a payout captures the method and amount. It does not transfer funds: no payment processor is integrated."}
      </p>

      <h2 style={{ fontSize: 15, margin: "24px 0 10px" }}>Marketplace listings</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary
          loading={listingsQuery.loading}
          error={listingsQuery.error}
          isEmpty={listings.length === 0}
          emptyMessage="No listings. A device routed to resale can be listed from its report."
        >
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Asking price</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {listings.map((listing) => (
                <tr key={listing.listingId}>
                  <td>
                    <Link to={`/reports/${listing.reportId}`} style={{ color: "var(--accent)" }}>
                      {listing.title}
                    </Link>
                  </td>
                  <td>{money(listing.askingPrice, listing.currency)}</td>
                  <td className="muted">{formatDate(listing.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 12 }}>
        Listing prices come from a placeholder markup formula, not a pricing strategy — see marketplaceListing.ts.
      </p>

      {canAct && <PricingSection />}
    </>
  );
}

// ============================================================
// Pricing — market_price_entries admin UI.
//
// Every quote is computed from these rows: model + storage → per-grade
// base price. The page shows the current table read-only and lets an
// admin edit prices inline. Uploading is a PUT of the whole edited set,
// upserting per (model, storage). While no real price feed is connected,
// this is the primary way a tenant moves off the seed data (which blocks
// quote acceptance server-side) — same visibility rule as everything
// else in this page: the block is stated, not hidden.
// ============================================================

interface PriceRow {
  entryId?: string;
  model: string;
  storageGb: number;
  gradeBasePrices: { A: number; B: number; C: number; D: number };
  currency: string;
  priceSource?: string;
}

function PricingSection() {
  const query = useApi(() => api.get<PriceRow[]>("/quotes/prices"));
  const rows = query.data ?? [];
  const [edited, setEdited] = useState<Record<string, PriceRow>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [newRow, setNewRow] = useState<PriceRow>({
    model: "",
    storageGb: 128,
    gradeBasePrices: { A: 0, B: 0, C: 0, D: 0 },
    currency: "USD",
  });

  const keyOf = (r: PriceRow) => `${r.model}::${r.storageGb}`;
  const merge = (r: PriceRow) => ({ ...r, ...edited[keyOf(r)] });

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const draft = rows.map((r) => merge(r));
    if (newRow.model.trim() && newRow.storageGb > 0) draft.push(newRow);
    try {
      await api.put("/quotes/prices", { prices: draft.map((r) => ({
        model: r.model,
        storageGb: r.storageGb,
        gradeBasePrices: r.gradeBasePrices,
        currency: r.currency,
      })) });
      setMsg({ kind: "ok", text: `Saved ${draft.length} price row(s).` });
      setEdited({});
      setNewRow({ model: "", storageGb: 128, gradeBasePrices: { A: 0, B: 0, C: 0, D: 0 }, currency: "USD" });
      await query.reload();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Could not save prices" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 style={{ fontSize: 15, margin: "24px 0 10px" }}>Pricing</h2>
      <p className="page-sub" style={{ marginBottom: 10 }}>
        Base price per (model, storage, grade). A quote priced from seed data is blocked from acceptance server-side — replace those rows here to unblock offers.
      </p>
      {msg && <div className={msg.kind === "ok" ? "info-box" : "error-box"}>{msg.text}</div>}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary
          loading={query.loading}
          error={query.error}
          isEmpty={rows.length === 0}
          emptyMessage="No prices uploaded yet. Add the first row below."
        >
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Storage (GB)</th>
                <th>A</th>
                <th>B</th>
                <th>C</th>
                <th>D</th>
                <th>Currency</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const k = keyOf(r);
                const merged = merge(r);
                const setField = (patch: Partial<PriceRow>) =>
                  setEdited((prev) => ({ ...prev, [k]: { ...merged, ...patch } }));
                const setGrade = (g: "A" | "B" | "C" | "D", v: number) =>
                  setField({ gradeBasePrices: { ...merged.gradeBasePrices, [g]: v } });
                return (
                  <tr key={k}>
                    <td>{r.model}</td>
                    <td className="muted">{r.storageGb}</td>
                    {(["A", "B", "C", "D"] as const).map((g) => (
                      <td key={g}>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          value={merged.gradeBasePrices[g]}
                          onChange={(e) => setGrade(g, Number(e.target.value) || 0)}
                          style={{ width: 90 }}
                        />
                      </td>
                    ))}
                    <td className="muted">{r.currency}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{r.priceSource ?? "—"}</td>
                  </tr>
                );
              })}
              <tr>
                <td>
                  <input
                    className="input"
                    placeholder="e.g. iPhone 13"
                    value={newRow.model}
                    onChange={(e) => setNewRow({ ...newRow, model: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={newRow.storageGb}
                    onChange={(e) => setNewRow({ ...newRow, storageGb: Number(e.target.value) || 0 })}
                    style={{ width: 90 }}
                  />
                </td>
                {(["A", "B", "C", "D"] as const).map((g) => (
                  <td key={g}>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      value={newRow.gradeBasePrices[g]}
                      onChange={(e) => setNewRow({
                        ...newRow,
                        gradeBasePrices: { ...newRow.gradeBasePrices, [g]: Number(e.target.value) || 0 },
                      })}
                      style={{ width: 90 }}
                    />
                  </td>
                ))}
                <td>
                  <input
                    className="input"
                    value={newRow.currency}
                    onChange={(e) => setNewRow({ ...newRow, currency: e.target.value.toUpperCase() })}
                    style={{ width: 70 }}
                  />
                </td>
                <td className="muted">new</td>
              </tr>
            </tbody>
          </table>
        </AsyncBoundary>
      </div>
      <div style={{ marginTop: 10 }}>
        <button className="btn btn-sm" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save prices"}
        </button>
      </div>
    </>
  );
}

function PayoutForm({ quoteId, onDone }: { quoteId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = async (method: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/quotes/${quoteId}/payout`, { method });
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record that payout");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Record payout
      </button>
    );
  }

  return (
    <div style={{ textAlign: "left" }}>
      {error && <div className="error-box">{error}</div>}
      <select
        className="input"
        defaultValue=""
        disabled={busy}
        onChange={(e) => e.target.value && void record(e.target.value)}
      >
        <option value="" disabled>
          Choose a method…
        </option>
        <option value="store_credit">Store credit</option>
        <option value="ach">Bank transfer (ACH)</option>
        <option value="paypal">PayPal</option>
        <option value="gift_card">Gift card</option>
      </select>
    </div>
  );
}

function PayoutCell({ payout }: { payout: Payout }) {
  return (
    <div style={{ textAlign: "right" }}>
      <StatusBadge status={payout.status} />
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {payout.method.replace(/_/g, " ")}
      </div>
      {payout.failureReason && (
        <div className="muted" style={{ fontSize: 12 }}>
          {payout.failureReason}
        </div>
      )}
    </div>
  );
}
