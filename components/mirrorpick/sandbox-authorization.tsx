"use client";
import { useState } from "react";
import type {
  Authorization,
  AuthorizationTerms,
} from "@/services/risk-control/types";
import { hkdToMinor } from "@/services/main-agent/money";
import { Modal } from "./modal";
export function SandboxAuthorizationForm({
  authorization: a,
  scope,
  busy,
  error,
  close,
  save,
}: {
  authorization: Authorization | null;
  scope: {
    productIds: string[];
    merchantIds: string[];
    paymentMethods: string[];
  };
  busy: boolean;
  error: string;
  close: () => void;
  save: (terms: AuthorizationTerms) => Promise<void>;
}) {
  const [validation, setValidation] = useState("");
  const [defaultExpiry] = useState(() =>
    new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-CA", {
      timeZone: "Asia/Hong_Kong",
    }),
  );
  return (
    <Modal title="Sandbox Authorization" close={close} wide>
      <header className="mp-auth-header">
        <div>
          <h2>
            {a ? "Manage Sandbox Authorization" : "Sandbox Authorization"}
          </h2>
          <p>AI shopping agent · Limited sandbox authorization</p>
        </div>
        <ol className="mp-mini-steps">
          <li>Agent information</li>
          <li>Authorization details</li>
          <li>Confirm & save</li>
        </ol>
      </header>
      <p className="mp-muted">
        Choose the exact products and limits you authorize. Search remains
        available without authorization.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setValidation("");
          try {
            const f = new FormData(e.currentTarget);
            await save({
              startsAt: Date.now(),
              expiresAt: Date.parse(`${f.get("expiry")}T23:59:59+08:00`),
              singleSoftMinor: hkdToMinor(String(f.get("singleSoft"))),
              singleHardMinor: hkdToMinor(String(f.get("singleHard"))),
              monthlySoftMinor: hkdToMinor(String(f.get("monthlySoft"))),
              monthlyHardMinor: hkdToMinor(String(f.get("monthlyHard"))),
              productIds: f.getAll("productIds").map(String),
              merchantIds: f.getAll("merchantIds").map(String),
              paymentMethods: f.getAll("paymentMethods").map(String),
            });
          } catch (e) {
            setValidation(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        {(error || validation) && (
          <div className="mp-error" role="alert">
            {validation || error}
          </div>
        )}
        <h3 className="mp-section-title">(1) Agent Information</h3>
        <div className="mp-grid">
          <label>
            Authorized session
            <input readOnly value="Current server-issued demo session" />
          </label>
          <label>
            Authorized agent
            <input readOnly value="MirrorPick shopping agent" />
          </label>
        </div>
        <p className="mp-muted">
          Demo sessions are not formal identity verification. Skin concerns and
          excluded ingredients belong to your search requirements, not this
          authorization. No legal signature is collected.
        </p>
        <h3 className="mp-section-title">(2) Authorization Details</h3>
        <label>
          Purpose
          <input
            readOnly
            value="Sandbox purchases within approved products, merchants and budget limits"
          />
        </label>
        <fieldset>
          <legend>Allowed products · explicitly select each product</legend>
          {scope.productIds.map((id) => (
            <label className="mp-check" key={id}>
              <input
                type="checkbox"
                name="productIds"
                value={id}
                defaultChecked={a?.productIds.includes(id) ?? false}
              />
              {id === "demo-shopping-lotion"
                ? "Demo Shopping Lotion 200ml · new catalog"
                : "Sandbox Lotion 200ml · legacy case"}
            </label>
          ))}
        </fieldset>
        <div className="mp-grid">
          <fieldset>
            <legend>Merchant sources</legend>
            {scope.merchantIds.map((id) => (
              <label className="mp-check" key={id}>
                <input
                  type="checkbox"
                  name="merchantIds"
                  value={id}
                  defaultChecked={a?.merchantIds.includes(id) ?? false}
                />
                Demo Merchant · simulated
              </label>
            ))}
            <label className="mp-check disabled">
              <input type="checkbox" disabled />
              Watsons / Mannings · checkout unavailable
            </label>
          </fieldset>
          <fieldset>
            <legend>Payment method</legend>
            {scope.paymentMethods.map((id) => (
              <label className="mp-check" key={id}>
                <input
                  type="checkbox"
                  name="paymentMethods"
                  value={id}
                  defaultChecked={a?.paymentMethods.includes(id) ?? false}
                />
                Stripe sandbox test card
              </label>
            ))}
            <label className="mp-check disabled">
              <input type="checkbox" disabled />
              AlipayHK / wallets · unavailable
            </label>
          </fieldset>
        </div>
        <h4>Budget limits · HKD</h4>
        <table className="mp-budget">
          <thead>
            <tr>
              <th>Item</th>
              <th>Soft limit · ask for confirmation</th>
              <th>Hard limit · no exceptions</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Monthly budget</th>
              <td>
                <input
                  aria-label="Monthly soft limit"
                  name="monthlySoft"
                  defaultValue={(a?.monthlySoftMinor ?? 30000) / 100}
                  required
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]{1,2})?"
                />
              </td>
              <td>
                <input
                  aria-label="Monthly hard limit"
                  name="monthlyHard"
                  defaultValue={(a?.monthlyHardMinor ?? 40000) / 100}
                  required
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]{1,2})?"
                />
              </td>
            </tr>
            <tr>
              <th>Per-order amount</th>
              <td>
                <input
                  aria-label="Single soft limit"
                  name="singleSoft"
                  defaultValue={(a?.singleSoftMinor ?? 20000) / 100}
                  required
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]{1,2})?"
                />
              </td>
              <td>
                <input
                  aria-label="Single hard limit"
                  name="singleHard"
                  defaultValue={(a?.singleHardMinor ?? 20000) / 100}
                  required
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]{1,2})?"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <label className="mp-expiry">
          Authorization expiry · Hong Kong date
          <input
            type="date"
            name="expiry"
            required
            defaultValue={
              a
                ? new Date(a.expiresAt).toLocaleDateString("en-CA", {
                    timeZone: "Asia/Hong_Kong",
                  })
                : defaultExpiry
            }
          />
        </label>
        <h3 className="mp-section-title">Risk statement</h3>
        <div className="mp-note">
          Simulated merchant · Stripe sandbox · no real charges. Per-order hard
          limit is at most HK$200. Soft-limit exceptions require separate
          confirmation. Revocation stops future execution; submitted payments
          may still return a receipt. Refunds and legal liability determinations
          are not implemented.
        </div>
        <h3 className="mp-section-title">
          Explicit authorization confirmation
        </h3>
        <label className="mp-check">
          <input name="confirmed" type="checkbox" required />I explicitly
          authorize only the selected sandbox scope and limits. This does not
          grant permission for an individual test payment.
        </label>
        <footer className="mp-actions">
          <button type="button" onClick={close}>
            Back / skip
          </button>
          <button className="primary" disabled={busy}>
            Confirm & save authorization
          </button>
        </footer>
      </form>
    </Modal>
  );
}
