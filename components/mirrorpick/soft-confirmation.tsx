"use client";
import { useState } from "react";
import { TriangleAlert, Clock } from "lucide-react";
import type {
  Authorization,
  Confirmation,
  RiskDecision,
} from "@/services/risk-control/types";
import { money } from "@/lib/mirrorpick";
import { Modal } from "./modal";
const time = (v: number) =>
  new Date(v).toLocaleString("en-GB", {
    timeZone: "Asia/Hong_Kong",
    dateStyle: "medium",
    timeStyle: "short",
  });
export function SoftConfirmation({
  c,
  decision,
  authorization: a,
  busy,
  error,
  now,
  close,
  respond,
}: {
  c: Confirmation;
  decision: RiskDecision;
  authorization: Authorization;
  busy: boolean;
  error: string;
  now: number;
  close: () => void;
  respond: (accept: boolean) => Promise<void>;
}) {
  const [consent, setConsent] = useState(false),
    seconds = Math.max(0, Math.ceil((c.expiresAt - now) / 1000));
  return (
    <Modal title="Single-purchase soft-limit confirmation" close={close}>
      {error && (
        <div className="mp-error" role="alert">
          {error}
        </div>
      )}
      <div className="mp-confirm-title">
        <TriangleAlert size={42} />
        <div>
          <h2>Single-purchase soft-limit confirmation</h2>
          <p>Payment is paused. Approval applies only to this transaction.</p>
        </div>
        <span>
          <Clock size={20} />
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
      </div>
      <dl className="mp-confirm-totals">
        <dt>Monthly spent</dt>
        <dd>{money(decision.spentMinor)}</dd>
        <dt>Other reservations</dt>
        <dd>{money(decision.reservedMinor)}</dd>
        <dt>Proposed purchase</dt>
        <dd>+ {money(c.amountMinor)}</dd>
        <dt>Total after purchase</dt>
        <dd>
          <strong>{money(decision.projectedMinor)}</strong>
        </dd>
      </dl>
      <div className="mp-grid mp-totals">
        <div>
          Monthly soft<strong>{money(a.monthlySoftMinor)}</strong>
        </div>
        <div>
          Projected total<strong>{money(decision.projectedMinor)}</strong>
        </div>
        <div>
          Monthly hard<strong>{money(a.monthlyHardMinor)}</strong>
        </div>
      </div>
      <meter
        min={0}
        max={a.monthlyHardMinor}
        value={Math.min(decision.projectedMinor, a.monthlyHardMinor)}
        low={a.monthlySoftMinor}
        high={a.monthlyHardMinor}
        optimum={0}
        aria-label="Projected monthly budget"
      />
      <h3>Transaction details · sandbox</h3>
      <p>Demo Merchant · Stripe sandbox · {money(c.amountMinor)}</p>
      <p>
        Per-order soft {money(a.singleSoftMinor)} / hard{" "}
        {money(a.singleHardMinor)}
      </p>
      {decision.hits.map((h) => (
        <p key={h.rule}>{h.reason}</p>
      ))}
      <div className="mp-note">
        Approval does not change your ongoing limits or execute a payment. After
        approval, explicitly permit and execute the original plan.
      </div>
      <label className="mp-check">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        I explicitly accept this single soft-limit exception.
      </label>
      <p>
        {seconds > 0
          ? `Server deadline: ${time(c.expiresAt)}`
          : "Confirmation expired. Approval is disabled; refresh the original transaction state."}
      </p>
      <div className="mp-actions">
        <button disabled={busy} onClick={() => void respond(false)}>
          Reject transaction
        </button>
        <button
          className="primary"
          disabled={busy || !consent || seconds <= 0}
          onClick={() => void respond(true)}
        >
          Approve this exception
        </button>
      </div>
    </Modal>
  );
}
