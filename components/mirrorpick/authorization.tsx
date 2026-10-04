"use client";
import { useState, type ComponentProps } from "react";
import { Info, PenLine } from "lucide-react";
import { Modal } from "./modal";
import { SandboxAuthorizationForm } from "./sandbox-authorization";

const categories = ["Cleanser", "Toner", "Serum", "Moisturizer", "Sunscreen"];
const merchants = [
  "Taobao Flagship Store",
  "Mannings",
  "Watsons",
  "Sasa Official",
];
const payments = [
  "WeChat Pay HK",
  "AlipayHK",
  "Apple Pay",
  "VISA",
  "Mastercard",
  "PayMe",
  "Octopus",
  "UnionPay",
  "Other",
];
// Preview preferences live only in this page's memory, never in payment terms.
let pageDraft: Record<string, string[]> = {};

export function AuthorizationForm(
  props: ComponentProps<typeof SandboxAuthorizationForm>,
) {
  const [sandbox, setSandbox] = useState(false);
  const [draft, setDraft] = useState(() => pageDraft);
  const [otherPayment, setOtherPayment] = useState(
    () => draft.payments?.includes("Other") ?? false,
  );
  const [step, setStep] = useState(1);
  const [validation, setValidation] = useState("");
  const [saved, setSaved] = useState(false);
  const [today] = useState(() =>
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" }),
  );
  const value = (name: string, fallback = "") => draft[name]?.[0] ?? fallback;

  function choices(name: string, values: string[], radio = false) {
    return (
      <div className="mp-auth-options">
        {values.map((option) => (
          <label className="mp-auth-choice" key={option}>
            <input
              type={radio ? "radio" : "checkbox"}
              name={name}
              value={option}
              defaultChecked={draft[name]?.includes(option) ?? false}
              required={radio}
              onChange={
                name === "payments" && option === "Other"
                  ? (e) => setOtherPayment(e.target.checked)
                  : undefined
              }
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    );
  }

  if (sandbox)
    return (
      <SandboxAuthorizationForm {...props} close={() => setSandbox(false)} />
    );

  return (
    <Modal
      title="Initial Authorization"
      close={props.close}
      className="mp-authorization"
      wide
    >
      <header className="mp-auth-heading">
        <div>
          <h2>Initial Authorization</h2>
          <p>AI shopping agent · Authorization agreement</p>
        </div>
        <ol className="mp-auth-steps" aria-label="Authorization progress">
          {[
            "Agent information",
            "Authorization details",
            "Confirm and sign",
          ].map((label, index) => (
            <li
              key={label}
              aria-current={step === index + 1 ? "step" : undefined}
            >
              <span>{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </header>
      <p className="mp-auth-help">
        Please fill in all required fields; for optional fields, enter
        &quot;None&quot; if not applicable.
      </p>
      <form
        onChange={() => {
          setSaved(false);
          setValidation("");
        }}
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const missing = ["merchants", "payments"].filter(
            (name) => !data.getAll(name).length,
          );
          if (missing.length) {
            setValidation(
              `Please select at least one ${missing.includes("merchants") ? "merchant source" : "payment method"}.`,
            );
            return;
          }
          if (
            Number(data.get("monthlySoft")) > Number(data.get("monthlyHard")) ||
            Number(data.get("singleSoft")) > Number(data.get("singleHard"))
          ) {
            setValidation(
              "Each soft limit must be less than or equal to its hard limit.",
            );
            return;
          }
          if (
            !String(data.get("authorizedBy")).trim() ||
            !String(data.get("ingredients")).trim() ||
            !String(data.get("signature")).trim() ||
            (otherPayment && !String(data.get("otherPayment")).trim())
          ) {
            setValidation("Please complete the required text fields.");
            return;
          }
          pageDraft = {};
          for (const name of new Set(data.keys()))
            pageDraft[name] = data.getAll(name).map(String);
          setValidation("");
          setSaved(true);
          setStep(3);
        }}
      >
        <section
          onFocusCapture={() => setStep(1)}
          aria-labelledby="mp-agent-information"
        >
          <h3 id="mp-agent-information" className="mp-section-title">
            (1)&nbsp; Agent Information
          </h3>
          <div className="mp-auth-agent-grid">
            <label>
              <span>
                Authorized by <em>*</em>
              </span>
              <input
                name="authorizedBy"
                placeholder="Please enter your name"
                defaultValue={value("authorizedBy")}
                required
                autoComplete="off"
              />
            </label>
            <label>
              Authorized agent
              <input readOnly value="MirrorPick shopping agent" />
            </label>
            <fieldset>
              <legend>
                Skin type <em>*</em>
              </legend>
              {choices(
                "skinType",
                ["Dry", "Oily", "Combination", "Sensitive", "Normal"],
                true,
              )}
            </fieldset>
            <label>
              Authorization date
              <input readOnly value={today} />
            </label>
            <label className="mp-auth-full">
              <span>
                Excluded ingredients <em>*</em>
              </span>
              <input
                name="ingredients"
                placeholder="e.g. alcohol; enter None if none"
                defaultValue={value("ingredients")}
                required
              />
            </label>
          </div>
        </section>
        <section
          onFocusCapture={() => setStep(2)}
          aria-labelledby="mp-authorization-details"
        >
          <h3 id="mp-authorization-details" className="mp-section-title">
            (2)&nbsp; Authorization Details
          </h3>
          <label>
            Purpose
            <input
              readOnly
              value="Delegate skincare purchasing within budget and approved channels; ask me before exceeding soft limits."
            />
          </label>
          <div className="mp-auth-scope-grid">
            <fieldset>
              <legend>Allowed categories</legend>
              {choices("categories", categories)}
            </fieldset>
            <fieldset>
              <legend>
                Merchant sources <em>*</em>
              </legend>
              {choices("merchants", merchants)}
            </fieldset>
          </div>
          <fieldset className="mp-auth-region">
            <legend>
              Delivery region <em>*</em>
            </legend>
            {choices("region", ["Hong Kong", "Mainland China", "Other"], true)}
          </fieldset>
          <div className="mp-auth-budget-title">Budget limits</div>
          <table className="mp-budget mp-auth-budget">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Soft limit (ask for confirmation)</th>
                <th scope="col">Hard limit (no exceptions)</th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  label: "Monthly budget",
                  name: "monthly",
                  soft: 800,
                  hard: 1500,
                },
                {
                  label: "Per-order amount",
                  name: "single",
                  soft: 400,
                  hard: 1000,
                },
              ].map((row) => (
                <tr key={row.name}>
                  <th scope="row">{row.label}</th>
                  {(["Soft", "Hard"] as const).map((limit) => (
                    <td key={limit}>
                      <div className="mp-auth-currency">
                        <span>HK$</span>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          name={`${row.name}${limit}`}
                          aria-label={`${row.label} ${limit.toLowerCase()} limit`}
                          required
                          defaultValue={value(
                            `${row.name}${limit}`,
                            String(limit === "Soft" ? row.soft : row.hard),
                          )}
                        />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <label className="mp-auth-expiry">
            <span>
              Authorization expiry date <em>*</em>
            </span>
            <input
              type="date"
              name="expiry"
              min={today}
              defaultValue={value("expiry", `${today.slice(0, 4)}-12-31`)}
              required
            />
          </label>
          <fieldset className="mp-auth-payment">
            <legend>
              Payment method <em>*</em>
            </legend>
            <div className="mp-auth-payment-row">
              {choices("payments", payments)}
              <input
                name="otherPayment"
                aria-label="Other payment method"
                placeholder="Please enter"
                disabled={!otherPayment}
                required={otherPayment}
                defaultValue={value("otherPayment")}
              />
            </div>
          </fieldset>
        </section>
        <section
          onFocusCapture={() => setStep(3)}
          aria-labelledby="mp-signature-confirmation"
        >
          <h3 className="mp-section-title">Risk statement</h3>
          <div className="mp-auth-risk">
            <Info size={20} aria-hidden="true" />
            <div>
              1. Purchases above soft limits require your separate confirmation.
              <br />
              2. Purchases above hard limits must not proceed.
              <br />
              This preview saves preferences for this page session only; it does
              not authorize payments.
            </div>
          </div>
          <h3 id="mp-signature-confirmation" className="mp-section-title">
            Signature confirmation
          </h3>
          <div className="mp-auth-signature-row">
            <label className="mp-auth-signature">
              <span>
                Signature / Confirm <em>*</em>
              </span>
              <span className="mp-auth-signature-box">
                <PenLine size={19} aria-hidden="true" />
                <input
                  name="signature"
                  aria-label="Signature / Confirm"
                  placeholder="Please sign here"
                  required
                  defaultValue={value("signature")}
                  autoComplete="off"
                />
              </span>
            </label>
            <label className="mp-auth-choice mp-auth-consent">
              <input type="checkbox" name="confirmed" required />
              <span>
                I have read and agree to the above authorization and risk
                statement.
              </span>
            </label>
          </div>
          {validation && (
            <div className="mp-error" role="alert">
              {validation}
            </div>
          )}
          {saved && (
            <div className="mp-auth-success" role="status">
              Preferences saved for this page session. No payment authorization
              was created.
            </div>
          )}
          <footer className="mp-auth-footer">
            <button
              type="button"
              className="mp-auth-sandbox-link"
              onClick={(event) => {
                const form = event.currentTarget.closest("form");
                if (form) {
                  const data = new FormData(form);
                  const current: Record<string, string[]> = {};
                  for (const name of new Set(data.keys()))
                    current[name] = data.getAll(name).map(String);
                  setDraft(current);
                }
                setSandbox(true);
              }}
            >
              Sandbox authorization settings
            </button>
            <div className="mp-actions">
              <button type="button" onClick={props.close}>
                Back
              </button>
              <button className="primary" type="submit">
                {saved ? "Saved" : "Sign & submit"}
              </button>
            </div>
          </footer>
        </section>
      </form>
    </Modal>
  );
}
