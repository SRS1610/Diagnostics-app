// src/Tracker.tsx — the consumer trade-in tracker.
//
// Reached from the link/QR printed on the report. Everything the
// customer can do lives here: see the inspection outcome, see the offer
// and how it was arrived at, accept or decline it, choose how to be
// paid, and ask for a review if they disagree.
//
// Two rules run through the whole file:
//
//  1. NEVER SHOW A NUMBER THE BUSINESS CANNOT HONOUR. When the API
//     reports the offer as unavailable (it was computed from the
//     illustrative seed price table), the amount is absent, not zero
//     and not a guess. The customer is told it's pending, which is true.
//
//  2. STATE, NOT ASSUMPTION. Every panel renders from the API's view of
//     the world, re-fetched after each action. There is no optimistic
//     update anywhere: this screen decides whether someone believes
//     they have been paid.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, formatDate, formatMoney, trackerApi, type TrackerView } from "./api";

const PAYOUT_METHODS = [
  { value: "store_credit", name: "Store credit", note: "Often carries a bonus — check with the store." },
  { value: "ach", name: "Bank transfer (ACH)", note: "Paid to your bank account." },
  { value: "paypal", name: "PayPal", note: "Paid to your PayPal address." },
  { value: "gift_card", name: "Gift card", note: "Issued as a digital gift card." },
];

/** Which rail step the device is at. Derived from the API's state
 *  rather than stored, so it cannot drift out of step with reality. */
function currentStage(view: TrackerView): number {
  if (view.offer?.payout) return 4;
  if (view.offer?.accepted) return 3;
  if (view.offer) return 2;
  return 1;
}

const STAGES = ["Received", "Inspected", "Offer ready", "Accepted", "Paid"];

export function Tracker() {
  const { token = "" } = useParams<{ token: string }>();
  const [view, setView] = useState<TrackerView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<"none" | "payout" | "dispute">("none");

  const load = useCallback(async () => {
    try {
      setView(await trackerApi.get(token));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : "We couldn't load this page. Please try again.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every action returns the refreshed view, so the screen always shows
   *  server state rather than what we hoped would happen. */
  const run = async (action: () => Promise<TrackerView>) => {
    setBusy(true);
    setActionError(null);
    try {
      setView(await action());
      setPanel("none");
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "That didn't work. Please try again.");
      // A rejection usually means our view of the state was stale (the
      // offer expired, a dispute was opened elsewhere). Re-read rather
      // than leaving a screen that disagrees with the server.
      void load();
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="page">
        <Brand />
        <div className="card">
          <h2>We couldn't open this link</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {loadError} If you followed a link from your inspection report, check it was copied in full — and contact
            the store if it still doesn't work.
          </p>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="page">
        <Brand />
        <p className="muted small">Loading…</p>
      </div>
    );
  }

  const stage = currentStage(view);
  const offer = view.offer;

  return (
    <div className="page">
      <Brand />

      <h1>Your trade-in</h1>
      <div className="sub">Inspected {formatDate(view.inspection.inspectedAt)}</div>

      {/* Status */}
      <div className="card">
        <div className="device-row">
          <div className="device-thumb">📱</div>
          <div>
            <div className="device-name">
              {view.device.make} {view.device.model}
            </div>
            <div className="device-meta">
              {/* Masked by the API. Enough to confirm it's your device,
                  not enough to be worth anything to anyone else. */}
              Serial {view.device.serialNumberMasked ?? "—"} · IMEI {view.device.imeiMasked ?? "—"}
            </div>
          </div>
        </div>

        <div className="progress-track">
          <div className="progress-line" />
          <div className="progress-line-fill" style={{ width: `${(stage / (STAGES.length - 1)) * 100}%` }} />
          <div className="progress-steps">
            {STAGES.map((label, i) => (
              <div className="progress-step" key={label}>
                <div className={`step-dot ${i < stage ? "done" : i === stage ? "current" : ""}`}>
                  {i < stage ? "✓" : ""}
                </div>
                <div className={`step-label ${i === stage ? "active" : ""}`}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        <StatusMessage view={view} />
      </div>

      {/* Inspection summary — counts only. The full report, technician
          notes and photos are not part of the public view. */}
      <div className="card">
        <div className="card-title">Inspection</div>
        <div className="field-row">
          <span className="k">Tests run</span>
          <span className="v">{view.inspection.testsRun}</span>
        </div>
        <div className="field-row">
          <span className="k">Passed</span>
          <span className="v">{view.inspection.testsPassed}</span>
        </div>
        <div className="field-row">
          <span className="k">Flagged</span>
          <span className="v">{view.inspection.testsFlagged}</span>
        </div>
        {view.inspection.testsSkipped > 0 && (
          <div className="field-row">
            <span className="k">Not tested</span>
            <span className="v">{view.inspection.testsSkipped}</span>
          </div>
        )}
        {view.dataErasure && (
          <div className="field-row">
            <span className="k">Data erased</span>
            <span className="v">
              {formatDate(view.dataErasure.wipedAt)} · {view.dataErasure.standard.replace(/_/g, " ")}
            </span>
          </div>
        )}
      </div>

      {actionError && <div className="error-box">{actionError}</div>}

      {/* Offer */}
      {offer && (
        <div className="card">
          <div className="card-title">Your offer</div>

          {offer.amount === null ? (
            <>
              <div className="offer-amount muted">Pending</div>
              <div className="offer-sub">
                {offer.unavailableReason ??
                  "This offer isn't ready yet. The store will be in touch once it's confirmed."}
              </div>
            </>
          ) : (
            <>
              <div className="offer-amount">{formatMoney(offer.amount, offer.currency)}</div>
              <div className="offer-sub">
                Grade {offer.grade} ·{" "}
                {offer.expired ? "Expired " + formatDate(offer.expiresAt) : "Valid until " + formatDate(offer.expiresAt)}
              </div>

              {/* The breakdown behind the number. A total with no
                  explanation is what makes people dispute. */}
              {offer.basePrice !== null && (
                <div className="offer-breakdown">
                  <div className="offer-row">
                    <span>Base price (Grade {offer.grade})</span>
                    <span>{formatMoney(offer.basePrice, offer.currency)}</span>
                  </div>
                  {offer.deductions.map((d, i) => (
                    <div className="offer-row" key={`${d.reason}-${i}`}>
                      <span className="neg">{d.reason}</span>
                      <span className="neg">−{formatMoney(d.amount, offer.currency)}</span>
                    </div>
                  ))}
                  {/* An offer never goes below zero. When the deductions
                      come to more than the base price, the floor is shown
                      as its own line — otherwise these numbers visibly
                      don't add up, and a customer checking the maths on
                      the screen where they accept money finds it wrong. */}
                  {offer.deductionsCappedBy > 0 && (
                    <div className="offer-row">
                      <span>Offer floor (an offer is never below zero)</span>
                      <span>+{formatMoney(offer.deductionsCappedBy, offer.currency)}</span>
                    </div>
                  )}
                  <div className="offer-row total">
                    <span>Total offer</span>
                    <span>{formatMoney(offer.amount, offer.currency)}</span>
                  </div>
                </div>
              )}
            </>
          )}

          <OfferActions view={view} busy={busy} onRun={run} token={token} onOpenPanel={setPanel} />
        </div>
      )}

      {!offer && (
        <div className="card">
          <div className="card-title">Your offer</div>
          <p className="muted small" style={{ margin: 0 }}>
            Your device has been inspected. We'll show your offer here as soon as it's ready.
          </p>
        </div>
      )}

      {panel === "payout" && (
        <PayoutPanel busy={busy} onCancel={() => setPanel("none")} onChoose={(m) => run(() => trackerApi.choosePayout(token, m))} />
      )}

      {panel === "dispute" && (
        <DisputePanel
          busy={busy}
          onCancel={() => setPanel("none")}
          onSubmit={(item, note) => run(() => trackerApi.fileDispute(token, item, note))}
        />
      )}

      {/* Details */}
      <div className="card">
        <div className="card-title">Details</div>
        <div className="field-row">
          <span className="k">Payout method</span>
          <span className="v">
            {offer?.payout ? offer.payout.method.replace(/_/g, " ") : "Not yet selected"}
          </span>
        </div>
        {offer?.payout && (
          <div className="field-row">
            <span className="k">Payout status</span>
            <span className="v">{offer.payout.status}</span>
          </div>
        )}
        <div className="field-row">
          <span className="k">Review request</span>
          <span className="v">{view.dispute ? "Open — under review" : "None"}</span>
        </div>
      </div>

      {offer?.payout && (
        <p className="muted small center">
          {/* Said plainly rather than implied: no payment provider is
              connected, so a "pending" payout is a recorded choice, not
              money in flight. Letting someone believe otherwise is the
              worst failure this screen could have. */}
          {offer.payout.note}
        </p>
      )}

      <ContactPrompt
        token={token}
        notifications={view.notifications}
        onSaved={() => void load()}
      />
    </div>
  );
}

/** Self-service contact capture. Shown until at least one channel is on
 *  file, then replaced with a quiet confirmation — this is an offer, not
 *  a form the customer is required to fill in to use the tracker. */
function ContactPrompt({
  token,
  notifications,
  onSaved,
}: {
  token: string;
  notifications: TrackerView["notifications"];
  onSaved: () => void;
}) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (notifications.hasEmail || notifications.hasPhone) {
    return (
      <p className="muted small center">
        We'll send updates to {notifications.hasEmail && notifications.hasPhone ? "your email and phone" : notifications.hasEmail ? "your email" : "your phone"} as your trade-in progresses.
      </p>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() && !phone.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await trackerApi.setContact(token, {
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="card-title">Get updates</div>
      <p className="muted small" style={{ margin: "0 0 10px" }}>
        Add your email or phone number to get a text or email as your trade-in moves along — inspection complete,
        offer ready, payout sent. Entirely optional.
      </p>
      {error && <div className="error-box" style={{ marginBottom: 8 }}>{error}</div>}
      <input className="input" type="email" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 8 }} />
      <input className="input" type="tel" placeholder="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ marginBottom: 10 }} />
      <button className="btn btn-secondary" disabled={busy || (!email.trim() && !phone.trim())}>
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function Brand() {
  return (
    <div className="top-brand">
      <div className="brand-mark">✓</div>
      <div className="brand-name">Trade-In Tracker</div>
    </div>
  );
}

function StatusMessage({ view }: { view: TrackerView }) {
  if (view.onHold) {
    return (
      <div className="status-message hold">
        Your review request is open. Your offer is on hold until someone has looked at it — we'll be in touch.
      </div>
    );
  }
  if (view.offer?.payout) {
    return <div className="status-message done">Payout method chosen. The store will confirm once it's processed.</div>;
  }
  if (view.offer?.accepted) {
    return <div className="status-message done">Offer accepted. Choose how you'd like to be paid.</div>;
  }
  if (view.offer?.declinedAt) {
    return (
      <div className="status-message hold">
        You declined this offer. Contact the store if you'd like to reopen it.
      </div>
    );
  }
  if (view.offer?.expired) {
    return <div className="status-message hold">This offer has expired. Contact the store for an updated one.</div>;
  }
  if (view.offer?.amount === null) {
    return <div className="status-message">Your device has been inspected. Your offer is being finalised.</div>;
  }
  if (view.offer) {
    return <div className="status-message">Your offer is ready — review the breakdown below and accept when you're ready.</div>;
  }
  return <div className="status-message">Your device has been inspected. We'll have an offer for you shortly.</div>;
}

function OfferActions({
  view,
  busy,
  onRun,
  token,
  onOpenPanel,
}: {
  view: TrackerView;
  busy: boolean;
  onRun: (action: () => Promise<TrackerView>) => Promise<void>;
  token: string;
  onOpenPanel: (panel: "none" | "payout" | "dispute") => void;
}) {
  const offer = view.offer!;

  // Each of these is a condition the API also enforces. Mirrored here so
  // the customer isn't offered a button that can only fail — the API
  // stays the authority, this is just not wasting their time.
  const settled = offer.accepted || Boolean(offer.declinedAt);
  const canAct = offer.amount !== null && !offer.expired && !view.onHold && !settled;

  return (
    <>
      {!settled && (
        <div className="btn-row">
          <button className="btn btn-secondary" disabled={busy || !canAct} onClick={() => void onRun(() => trackerApi.declineOffer(token))}>
            Decline
          </button>
          <button className="btn btn-primary" disabled={busy || !canAct} onClick={() => void onRun(() => trackerApi.acceptOffer(token))}>
            Accept offer
          </button>
        </div>
      )}

      {offer.accepted && !offer.payout && !view.onHold && (
        <button className="btn btn-primary" disabled={busy} onClick={() => onOpenPanel("payout")}>
          Choose how to get paid
        </button>
      )}

      {!view.dispute && (
        <div className="link-row">
          <button className="link-btn" onClick={() => onOpenPanel("dispute")}>
            Don't agree with the grade? Request a review →
          </button>
        </div>
      )}
    </>
  );
}

function PayoutPanel({
  busy,
  onCancel,
  onChoose,
}: {
  busy: boolean;
  onCancel: () => void;
  onChoose: (method: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="card">
      <div className="card-title">How would you like to be paid?</div>
      <div className="method-list">
        {PAYOUT_METHODS.map((m) => (
          <button
            key={m.value}
            className={`method ${selected === m.value ? "selected" : ""}`}
            onClick={() => setSelected(m.value)}
          >
            <div>
              <div className="method-name">{m.name}</div>
              <div className="method-note">{m.note}</div>
            </div>
          </button>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        You can only choose once here — contact the store if you need to change it afterwards.
      </p>
      <div className="btn-row">
        <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !selected} onClick={() => selected && onChoose(selected)}>
          Confirm
        </button>
      </div>
    </div>
  );
}

const DISPUTE_SUBJECTS = ["The overall grade", "A specific test result", "The offer amount", "Something else"];

function DisputePanel({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (disputingItem: string, customerNote: string) => void;
}) {
  const [item, setItem] = useState(DISPUTE_SUBJECTS[0]);
  const [note, setNote] = useState("");

  return (
    <div className="card">
      <div className="card-title">Request a review</div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Tell us what doesn't look right. Someone will re-check the original inspection photos and come back to you.
        Your offer stays on hold in the meantime, so nothing is finalised while we look.
      </p>

      <div className="field">
        <label htmlFor="subject">What are you disputing?</label>
        <select id="subject" className="input" value={item} onChange={(e) => setItem(e.target.value)}>
          {DISPUTE_SUBJECTS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="note">What happened?</label>
        <textarea
          id="note"
          className="textarea"
          maxLength={2000}
          placeholder="Describe the problem in your own words."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="muted small" style={{ margin: "6px 0 0" }}>
          {note.length}/2000
        </p>
      </div>

      <div className="btn-row">
        <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !note.trim()} onClick={() => onSubmit(item, note.trim())}>
          Send review request
        </button>
      </div>
    </div>
  );
}
