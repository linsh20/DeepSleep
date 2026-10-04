"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Moon,
  Plus,
  MessageCircle,
  Settings,
  Send,
  Search,
  ShieldCheck,
  ShoppingBag,
  Check,
  UserRound,
  Menu,
  Info,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import type { MainTask, RequirementDraft } from "@/services/main-agent/types";
import type { PurchaseBridge } from "@/services/purchase-bridge/service";
import type {
  Authorization,
  AuthorizationTerms,
  Confirmation,
  RiskDecision,
} from "@/services/risk-control/types";
import { normalizeHKD } from "@/services/main-agent/money";
import {
  AgentClient,
  identity,
  candidateTotal,
  money,
  paymentLabels,
} from "@/lib/mirrorpick";
import { AuthorizationForm } from "./authorization";
import { Modal } from "./modal";
import { Welcome } from "./welcome";
import { SoftConfirmation } from "./soft-confirmation";
import "./mirrorpick.css";

type Purchases = ReturnType<PurchaseBridge["state"]> & {
  checkoutPreparation?: {
    status: string;
    reason?: string;
    missingFacts?: string[];
    review?: unknown;
  };
};
type Risk = {
  authorization: Authorization | null;
  scope: {
    productIds: string[];
    merchantIds: string[];
    paymentMethods: string[];
  };
  decisions: RiskDecision[];
  confirmations: Confirmation[];
};
type History = { taskId: string; title: string }[];
const time = (v: string | number) =>
  new Date(v).toLocaleString("en-GB", {
    timeZone: "Asia/Hong_Kong",
    dateStyle: "medium",
    timeStyle: "short",
  });
const historyKey = "mirrorpick-known-tasks";
export function MirrorPick() {
  const [api] = useState(() => new AgentClient());
  const [task, setTask] = useState<MainTask | null>(null),
    [risk, setRisk] = useState<Risk | null>(null),
    [purchases, setPurchases] = useState<Purchases | null>(null);
  const [history, setHistory] = useState<History>([]),
    [model, setModel] = useState("Checking connection"),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [modal, setModal] = useState<
      "welcome" | "authorization" | "requirements" | null
    >(null),
    [sidebar, setSidebar] = useState(false),
    [message, setMessage] = useState(""),
    [permission, setPermission] = useState<string | null>(null),
    [now, setNow] = useState(0),
    [dismissed, setDismissed] = useState<string | null>(null);
  const active = useRef<string | null>(null),
    generation = useRef(0),
    locked = useRef(true),
    readSequence = useRef(0);
  const current = purchases?.purchases.find(
    (p) => p.plan.requirementVersion === task?.requirementVersion,
  );
  const decision = current?.operation
    ? risk?.decisions.find(
        (d) => d.operationId === current.operation!.operationId,
      )
    : undefined;
  const confirmation =
    decision?.decision === "hold" && decision.confirmationId
      ? risk?.confirmations.find(
          (c) =>
            c.confirmationId === decision.confirmationId &&
            c.status === "pending" &&
            c.taskId === task?.taskId &&
            c.planId === current?.plan.planId &&
            c.authorizationVersion === risk?.authorization?.version &&
            c.requirementVersion === task?.requirementVersion,
        )
      : undefined;
  const authorization = risk?.authorization;
  const authorized =
    authorization?.status === "active" &&
    authorization.startsAt <= now &&
    authorization.expiresAt > now;
  const shopping =
    task?.shoppingResult && "kind" in task.shoppingResult
      ? task.shoppingResult
      : null;
  const permissionBinding = current
    ? `${current.plan.planId}:${task?.requirementVersion}:${authorization?.version}`
    : null;
  const hasPermission =
    permissionBinding !== null && permission === permissionBinding;
  const canExecute =
    !!current &&
    authorized &&
    !current.stale &&
    !current.quoteExpired &&
    current.quote.expiresAt > now &&
    task?.intent === "purchase" &&
    (decision?.decision !== "block" ||
      decision.authorizationVersion !== authorization?.version) &&
    (!current.operation ||
      ["not_started", "requires_confirmation"].includes(
        current.operation.paymentStatus,
      )) &&
    !current.operation?.busy &&
    (!confirmation || confirmation.status !== "pending");
  function remember(t: MainTask) {
    const title = t.requirementDraft.query || "New skincare conversation";
    setHistory((old) => {
      const next = [
        { taskId: t.taskId, title },
        ...old.filter((h) => h.taskId !== t.taskId),
      ].slice(0, 30);
      localStorage.setItem(
        historyKey,
        JSON.stringify(next.map((h) => ({ taskId: h.taskId }))),
      );
      return next;
    });
    localStorage.setItem("mirrorpick-active-task", t.taskId);
  }
  async function refresh(id = active.current, epoch = generation.current) {
    const sequence = ++readSequence.current;
    const [r, t, p, m] = await Promise.all([
      api.request<Risk>("risk/state"),
      id
        ? api.request<{ task: MainTask }>(`tasks/${encodeURIComponent(id)}`)
        : null,
      id
        ? api.request<Purchases>(
            `purchases/state?taskId=${encodeURIComponent(id)}`,
          )
        : null,
      api.request<{ model: { state: string } }>("model"),
    ]);
    if (
      sequence !== readSequence.current ||
      epoch !== generation.current ||
      id !== active.current
    )
      return;
    setRisk(r);
    setModel(m.model.state);
    if (t) {
      setTask(t.task);
      remember(t.task);
    }
    if (p) setPurchases(p);
  }
  async function run(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    readSequence.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        await refresh();
      } catch {
        /* Preserve primary error and known transaction state. */
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    let alive = true;
    async function boot() {
      try {
        await api.request("session", {});
        const raw = JSON.parse(
          localStorage.getItem(historyKey) || "[]",
        ) as History;
        const ids = Array.isArray(raw)
          ? raw.filter((h) => h && typeof h.taskId === "string").slice(0, 30)
          : [];
        const checked = await Promise.all(
          ids.map(async (h) => {
            try {
              const { task: t } = await api.request<{ task: MainTask }>(
                `tasks/${encodeURIComponent(h.taskId)}`,
              );
              return {
                taskId: t.taskId,
                title: t.requirementDraft.query || "New skincare conversation",
              };
            } catch {
              return null;
            }
          }),
        );
        if (!alive) return;
        setHistory(checked.filter((h): h is History[number] => h !== null));
        const saved = localStorage.getItem("mirrorpick-active-task");
        active.current =
          saved && checked.some((h) => h?.taskId === saved) ? saved : null;
        await refresh();
        if (!active.current && alive) setModal("welcome");
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) {
          locked.current = false;
          setBusy(false);
        }
      }
    }
    void boot();
    return () => {
      alive = false;
    };
    // The server session is established once; all later reads share its cookie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setNow(Date.now()));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const pending =
      task?.status === "shopping" ||
      (!!current?.operation &&
        [
          "creating",
          "confirming",
          "processing",
          "unknown",
          "requires_action",
          "requires_confirmation",
        ].includes(current.operation.paymentStatus));
    if (!pending && (!confirmation || confirmation.expiresAt <= Date.now()))
      return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !locked.current)
        void refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    task?.taskId,
    task?.status,
    current?.operation?.paymentStatus,
    confirmation?.confirmationId,
  ]);
  const confirmationExpired = !!confirmation && confirmation.expiresAt <= now;
  useEffect(() => {
    if (confirmationExpired) void refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmationExpired]);
  async function create() {
    const { task: t } = await api.request<{ task: MainTask }>(
      "tasks",
      {},
      true,
    );
    generation.current++;
    active.current = t.taskId;
    setTask(t);
    setPurchases(null);
    setPermission(null);
    setDismissed(null);
    remember(t);
    setSidebar(false);
    return t;
  }
  async function switchTask(id: string) {
    generation.current++;
    active.current = id;
    setTask(null);
    setPurchases(null);
    setPermission(null);
    setDismissed(null);
    setSidebar(false);
    await refresh(id);
  }
  async function send() {
    const text = message.trim();
    if (!text) return;
    await run(async () => {
      const t = task ?? (await create());
      const { task: next } = await api.request<{ task: MainTask }>(
        "messages",
        {
          taskId: t.taskId,
          expectedVersion: t.requirementVersion,
          message: text,
        },
        true,
      );
      setTask(next);
      remember(next);
      setMessage("");
      setPermission(null);
      await refresh();
    });
  }
  async function saveRequirements(f: FormData) {
    await run(async () => {
      const t = task ?? (await create());
      const draft: RequirementDraft = {
        ...t.requirementDraft,
        category: String(f.get("category")),
        query: String(f.get("query")),
        quantity: Number(f.get("quantity")),
        currency: "HKD",
        destination: String(f.get("destination")),
        budget: {
          maxHKD: normalizeHKD(String(f.get("budget"))),
          scope: "delivered",
        },
        hardConstraints: [
          ...JSON.parse(String(f.get("constraints"))).filter(
            (c: { id?: string }) => c.id !== "mirrorpick_exclusions",
          ),
          ...(String(f.get("exclusions") || "").trim()
            ? [
                {
                  id: "mirrorpick_exclusions",
                  field: "text.searchable",
                  op: "notContainsAny",
                  value: String(f.get("exclusions"))
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                },
              ]
            : []),
        ],
        preferences: JSON.parse(String(f.get("preferences"))),
      };
      const { task: next } = await api.request<{ task: MainTask }>(
        `tasks/${t.taskId}/requirements`,
        {
          expectedVersion: t.requirementVersion,
          intent: f.get("intent"),
          requirementDraft: draft,
        },
        true,
      );
      setTask(next);
      remember(next);
      setPermission(null);
      setModal(null);
      await refresh();
    });
  }
  async function demo(legacy = false) {
    await run(async () => {
      const t = await create();
      const { task: next } = await api.request<{ task: MainTask }>(
        `tasks/${t.taskId}/requirements`,
        {
          expectedVersion: t.requirementVersion,
          intent: "purchase",
          requirementDraft: {
            category: legacy ? "沙盒测试乳液" : "沙盒目录乳液",
            query: legacy ? "测试乳液 200ml" : "DEEPSLEEP DEMO LOTION 200ML",
            quantity: 1,
            currency: "HKD",
            destination: "香港",
            budget: { maxHKD: 200, scope: "delivered" },
            hardConstraints: [],
            preferences: [],
            excludedProductIds: [],
          },
        },
        true,
      );
      setTask(next);
      remember(next);
      setModal(null);
      setNotice(
        "A separate sandbox task was created. Your other search requirements remain in their original task.",
      );
      await refresh();
    });
  }
  async function purchase(
    action: "prepare" | "execute" | "recover",
    planId?: string,
    candidateId?: string,
  ) {
    if (!task) return;
    await run(async () => {
      const payload = {
        taskId: task.taskId,
        ...(action !== "recover"
          ? { expectedVersion: task.requirementVersion }
          : {}),
        ...(planId ? { planId } : {}),
        ...(candidateId ? { candidateId } : {}),
        ...(action === "execute" ? { testPermission: true } : {}),
      };
      if (action === "execute") {
        if (!hasPermission || !canExecute) return;
        setPermission(null);
      }
      const state = await api.request<Purchases>(
        `purchases/${action}`,
        payload,
        true,
      );
      if (active.current !== state.taskId) return;
      setPurchases(state);
      await refresh();
      if (action === "prepare" && state.checkoutPreparation)
        setNotice(
          `${state.checkoutPreparation.status}: ${state.checkoutPreparation.reason ?? "Quote prepared. No order or payment was created."}`,
        );
    });
  }
  async function saveAuthorization(terms: AuthorizationTerms) {
    await run(async () => {
      await api.request(
        "risk/authorization",
        {
          terms,
          expectedVersion: authorization?.version ?? 0,
          explicitlyConfirmed: true,
        },
        true,
      );
      await refresh();
      setPermission(null);
      setModal(null);
    });
  }
  async function confirm(accept: boolean) {
    if (!confirmation) return;
    await run(async () => {
      const result = await api.request<{ accepted?: boolean }>(
        "risk/confirmation",
        { confirmationId: confirmation.confirmationId, accept },
      );
      setDismissed(confirmation.confirmationId);
      setPermission(null);
      await refresh();
      setNotice(
        accept && result.accepted
          ? "Exception accepted for this operation only. Select a new one-time sandbox permission and explicitly execute the original plan."
          : "Confirmation was not accepted. No payment was triggered.",
      );
    });
  }
  const stage =
    current?.operation && current.operation.paymentStatus !== "not_started"
      ? 3
      : current
        ? 2
        : shopping
          ? 1
          : 0;
  return (
    <div className="mp-app">
      <aside className={`mp-sidebar ${sidebar ? "open" : ""}`}>
        <Link href="/" className="mp-brand">
          <Moon size={43} fill="currentColor" />
          <div>
            MirrorPick<small>Better skin, a brighter tomorrow</small>
          </div>
        </Link>
        <button
          className="primary mp-new"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await create();
            })
          }
        >
          <Plus />
          New chat
        </button>
        <h3>Chat history</h3>
        <p className="mp-muted">Verified tasks · this browser</p>
        <nav>
          {history.map((h) => (
            <button
              key={h.taskId}
              className={task?.taskId === h.taskId ? "selected" : ""}
              disabled={busy}
              onClick={() => void run(() => switchTask(h.taskId))}
            >
              <MessageCircle size={20} />
              <span>{h.title}</span>
            </button>
          ))}
        </nav>
        {history.length === 0 && (
          <div className="mp-empty-history">
            <MessageCircle size={32} />
            <p>No past chats yet</p>
            <small>Start your skincare journey now</small>
          </div>
        )}
        <footer>
          <button
            onClick={() => setModal("authorization")}
            disabled={!risk || busy}
          >
            <Settings />
            Settings & authorization
          </button>
          <div className="mp-profile">
            <UserRound />
            <div>
              Demo session<small>Hong Kong · no verified identity</small>
            </div>
          </div>
          <button onClick={() => setModal("welcome")}>About MirrorPick</button>
          <details>
            <summary>Developer tools</summary>
            <a href="/agent">Agent debug</a>
            <a href="/agent-risk">Risk debug</a>
            <a href="/product-search">Product search</a>
          </details>
        </footer>
      </aside>
      <main className={`mp-main ${!task ? "mp-home" : ""}`}>
        <header className="mp-top">
          <button
            className="mp-menu"
            aria-label="Toggle sidebar"
            onClick={() => setSidebar(!sidebar)}
          >
            <Menu />
          </button>
          <div>
            <h1>{task?.requirementDraft.query || "Welcome to MirrorPick"}</h1>
            <span className={`mp-badge ${authorized ? "green" : "yellow"}`}>
              {authorized
                ? "Authorization active"
                : "Search available · purchase authorization required"}
            </span>
          </div>
          <small className="mp-date">
            {now
              ? new Date(now).toLocaleDateString("en-CA", {
                  timeZone: "Asia/Hong_Kong",
                })
              : ""}
          </small>
        </header>
        <div className="mp-content">
          {error && (
            <div className="mp-error" role="alert">
              {error}
              <button onClick={() => void run(() => refresh())}>
                <RefreshCw size={16} />
                Query original state
              </button>
            </div>
          )}
          {notice && (
            <div className="mp-note" role="status">
              {notice}
            </div>
          )}
          {!task && (
            <section className="mp-landing">
              <h2>Leave skincare shopping to MirrorPick.</h2>
              <p>
                Your preferences. Clear evidence. Purchases within your limits.
              </p>
              <Image
                width={349}
                height={255}
                loading="eager"
                src="/mirrorpick/welcome-scene.png"
                alt="Decorative skincare bottles with a lavender crescent moon"
              />
              <button
                onClick={() => setModal("requirements")}
                className="primary"
              >
                Set search requirements <ArrowRight size={18} />
              </button>
              <button disabled={busy} onClick={() => void demo()}>
                Start a separate sandbox demo
              </button>
            </section>
          )}
          {task && (
            <>
              <div className="mp-messages">
                {task.messages?.map((m, i) => (
                  <div
                    className={`mp-message ${m.role}`}
                    key={`${m.requestId}-${m.role}-${i}`}
                  >
                    <span className="mp-avatar">
                      {m.role === "assistant" ? (
                        <Moon size={23} />
                      ) : (
                        <UserRound size={23} />
                      )}
                    </span>
                    <div>
                      {m.role === "assistant" && <strong>MirrorPick</strong>}
                      <p>{m.content}</p>
                      <small>{time(m.at)}</small>
                    </div>
                  </div>
                ))}
                {!task.messages?.length && (
                  <div className="mp-message assistant">
                    <span className="mp-avatar">
                      <Moon />
                    </span>
                    <div>
                      <strong>MirrorPick</strong>
                      <p>
                        {current
                          ? "Your sandbox quote is ready. Review limits and grant a separate test permission before execution."
                          : shopping
                            ? `I found ${shopping.candidates.length} candidate(s). Compare their evidence and review what remains unknown.`
                            : task.requirement
                              ? "Your requirements are saved. Start a search to compare products and evidence."
                              : "Tell me what you need, or set structured requirements to start your search."}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <ol className="mp-progress">
                {[
                  "Search products",
                  "Compare options",
                  "Risk checks",
                  "Auto purchase",
                ].map((label, i) => (
                  <li
                    className={i < stage ? "done" : i === stage ? "active" : ""}
                    key={label}
                  >
                    <span>{i < stage ? <Check size={17} /> : i + 1}</span>
                    <strong>{label}</strong>
                    <small>
                      {i < stage
                        ? "Completed"
                        : i === stage
                          ? busy
                            ? "In progress"
                            : "Current stage"
                          : "Not started"}
                    </small>
                  </li>
                ))}
              </ol>
              <details
                className="mp-stage-details"
                open={!shopping && !current}
              >
                <summary>
                  Search requirements · view saved request and authorization
                </summary>
                <section className="mp-card">
                  <div className="mp-card-heading">
                    <h2>
                      <Search />
                      Search requirements
                    </h2>
                    <span className="mp-badge">
                      {task.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <div className="mp-grid mp-divided">
                    <div>
                      <h3>This request</h3>
                      <dl>
                        <dt>Product</dt>
                        <dd>
                          {task.requirementDraft.query || "Not specified"}
                        </dd>
                        <dt>Category</dt>
                        <dd>
                          {task.requirementDraft.category || "Not specified"}
                        </dd>
                        <dt>Quantity</dt>
                        <dd>{task.requirementDraft.quantity ?? "Unknown"}</dd>
                        <dt>Delivered budget</dt>
                        <dd>
                          {task.requirementDraft.budget?.maxHKD == null
                            ? "Unknown"
                            : `HK$${task.requirementDraft.budget.maxHKD.toFixed(2)}`}
                        </dd>
                        <dt>Delivery</dt>
                        <dd>
                          {task.requirementDraft.destination || "Not specified"}
                        </dd>
                        <dt>Hard conditions</dt>
                        <dd>
                          {task.requirementDraft.hardConstraints?.length ?? 0}{" "}
                          retained
                        </dd>
                      </dl>
                      {task.clarificationQuestions.map((q) => (
                        <p className="mp-note" key={q}>
                          {q}
                        </p>
                      ))}
                    </div>
                    <div>
                      <h3>From current authorization</h3>
                      {authorization ? (
                        <dl>
                          <dt>Status / version</dt>
                          <dd>
                            {authorization.status} · v{authorization.version}
                          </dd>
                          <dt>Allowed products</dt>
                          <dd>{authorization.productIds.join(", ")}</dd>
                          <dt>Merchant / payment</dt>
                          <dd>
                            {authorization.merchantIds.join(", ")} /{" "}
                            {authorization.paymentMethods.join(", ")}
                          </dd>
                          <dt>Per-order limits</dt>
                          <dd>
                            {money(authorization.singleSoftMinor)} soft /{" "}
                            {money(authorization.singleHardMinor)} hard
                          </dd>
                          <dt>Monthly limits</dt>
                          <dd>
                            {money(authorization.monthlySoftMinor)} soft /{" "}
                            {money(authorization.monthlyHardMinor)} hard
                          </dd>
                          <dt>Expires</dt>
                          <dd>{time(authorization.expiresAt)}</dd>
                        </dl>
                      ) : (
                        <p>
                          No purchase authorization. You can still search and
                          compare products.
                        </p>
                      )}
                    </div>
                  </div>
                  <footer className="mp-card-footer">
                    <span>
                      Model: {model.replaceAll("_", " ")} · facts remain
                      source-backed
                    </span>
                    <div>
                      <button
                        onClick={() => setModal("requirements")}
                        disabled={busy}
                      >
                        Edit requirements
                      </button>
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          !task.requirement ||
                          task.status === "shopping"
                        }
                        onClick={() =>
                          void run(async () => {
                            const { task: t } = await api.request<{
                              task: MainTask;
                            }>(
                              `tasks/${task.taskId}/search`,
                              { expectedVersion: task.requirementVersion },
                              true,
                            );
                            setTask(t);
                            await refresh();
                          })
                        }
                      >
                        Search products
                      </button>
                    </div>
                  </footer>
                  <details>
                    <summary>
                      View requirement sources & retained conditions
                    </summary>
                    <pre>
                      {JSON.stringify(
                        {
                          draft: task.requirementDraft,
                          requirement: task.requirement,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </section>
              </details>
              {shopping && (
                <details className="mp-stage-details" open={!current}>
                  <summary>
                    Candidate comparison · view original search evidence
                  </summary>
                  <section className="mp-card">
                    <div className="mp-card-heading">
                      <h2>
                        Compare {shopping.candidates.length} candidate products
                      </h2>
                      <small>
                        {shopping.dataEnvironment.replaceAll("_", " ")}
                      </small>
                    </div>
                    <p className="mp-muted">
                      {shopping.status} · Search evidence does not grant
                      purchase permission.
                    </p>
                    <div className="mp-table-scroll">
                      <table className="mp-candidates">
                        <thead>
                          <tr>
                            <th>Product</th>
                            <th>Merchant / Delivery</th>
                            <th>Item + Shipping = Total</th>
                            <th>Evidence / action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shopping.candidates.map((c) => {
                            const rec = shopping.recommendations.find(
                              (r) => identity(r) === identity(c),
                            );
                            return (
                              <tr key={identity(c)}>
                                <td>
                                  <strong>{c.title}</strong>
                                  <small>
                                    {c.productId} · {c.skuId}
                                  </small>
                                </td>
                                <td>
                                  {c.merchant?.name.value ??
                                    "Merchant not verified"}
                                  <small>
                                    {c.quote?.destination ??
                                      "Delivery unverified"}
                                  </small>
                                  <small>
                                    {c.quote?.estimatedDeliveryAtMs.value
                                      ? time(
                                          c.quote.estimatedDeliveryAtMs.value,
                                        )
                                      : "Delivery date unknown"}
                                  </small>
                                </td>
                                <td>
                                  {money(c.offer?.itemPriceMinor.value)} +{" "}
                                  {money(c.offer?.shippingMinor.value)}
                                  <strong>= {money(candidateTotal(c))}</strong>
                                </td>
                                <td>
                                  <span
                                    className={`mp-badge ${rec ? "green" : "yellow"}`}
                                  >
                                    {rec
                                      ? `Rank ${rec.rank} · ${rec.evidenceStatus}`
                                      : "Needs review"}
                                  </span>
                                  <button
                                    disabled={
                                      busy || task.intent !== "purchase"
                                    }
                                    onClick={() =>
                                      void purchase(
                                        "prepare",
                                        undefined,
                                        identity(c),
                                      )
                                    }
                                  >
                                    Check checkout eligibility
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {!shopping.candidates.length && (
                      <p className="mp-note">
                        No candidates returned. Adjust your requirements;
                        unknown hard conditions remain unverified.
                      </p>
                    )}
                    <div className="mp-grid mp-divided">
                      <div>
                        <h3>Requirement match & evidence</h3>
                        {shopping.diagnostics.candidateChecks.map((a) => (
                          <details key={identity(a)}>
                            <summary>
                              {shopping.candidates.find(
                                (c) => identity(c) === identity(a),
                              )?.title ?? a.productId}{" "}
                              · {a.disposition}
                            </summary>
                            {a.checks.map((c, i) => (
                              <p key={i}>
                                <span
                                  className={`mp-badge ${c.outcome === "match" ? "green" : c.outcome === "mismatch" ? "red" : "yellow"}`}
                                >
                                  {c.outcome}
                                </span>{" "}
                                {c.reason} · {c.evidenceFields.join(", ")}
                              </p>
                            ))}
                          </details>
                        ))}
                      </div>
                      <div>
                        <h3>Uncertainties to note</h3>
                        <p>
                          Delivery, final price, merchant eligibility and
                          unverified product properties must be checked before
                          checkout.
                        </p>
                        <p>
                          Snapshot or mock data is not live merchant evidence.
                        </p>
                        <details>
                          <summary>
                            View all missing facts and source warnings (
                            {(shopping.missingFacts?.length ?? 0) +
                              shopping.diagnostics.warnings.length}
                            )
                          </summary>
                          {shopping.missingFacts?.map((f) => (
                            <p key={f}>{f}</p>
                          ))}
                          {shopping.diagnostics.warnings.map((w, i) => (
                            <p key={i}>{w}</p>
                          ))}
                        </details>
                      </div>
                    </div>
                    {shopping.candidates.map((c) => (
                      <details key={identity(c)}>
                        <summary>
                          View sources & fact snapshots · {c.title}
                        </summary>
                        <p>
                          Reference URL:{" "}
                          {/^https:\/\//.test(c.url) ? (
                            <a href={c.url} target="_blank" rel="noreferrer">
                              {c.url}
                            </a>
                          ) : (
                            "Unavailable"
                          )}
                          . Mock URLs are illustrative, not merchant evidence.
                        </p>
                        <pre>{JSON.stringify(c, null, 2)}</pre>
                      </details>
                    ))}
                    <div className="mp-note">
                      Candidate references are preserved. The final checkout
                      offer is separately quoted and reviewed. Payment not
                      started by comparison.
                    </div>
                  </section>
                </details>
              )}
              {task.requirementDraft.category === "沙盒测试乳液" && (
                <button
                  disabled={busy}
                  onClick={() => void purchase("prepare")}
                >
                  Prepare legacy sandbox quote · no payment
                </button>
              )}
              {current && (
                <section className="mp-card">
                  <div className="mp-card-heading">
                    <h2>
                      <ShieldCheck />
                      Pre-payment risk checks
                    </h2>
                    <span
                      className={`mp-badge ${decision?.decision === "approve" ? "green" : decision?.decision === "block" ? "red" : "yellow"}`}
                    >
                      {decision?.decision ??
                        "Checked during explicit execution"}
                    </span>
                  </div>
                  <div className="mp-product">
                    <Image
                      width={139}
                      height={133}
                      src="/mirrorpick/decorative-lotion.png"
                      alt="Decorative lotion illustration; not a photo of this demo product"
                    />
                    <div>
                      <h3>
                        {current.plan.title} × {current.plan.quantity}
                      </h3>
                      <p>Demo Merchant · Hong Kong · Stripe sandbox</p>
                      <p>
                        {money(current.quote.itemSubtotalMinor)} item +{" "}
                        {money(current.quote.shippingMinor)} shipping
                      </p>
                      <strong>Total {money(current.quote.totalMinor)}</strong>
                    </div>
                  </div>
                  <p className="mp-note">
                    模拟商户 · Stripe 沙盒 · 无真实扣款 / Simulated merchant ·
                    no real charges.
                  </p>
                  <div className="mp-risk-row">
                    <ShieldCheck />
                    <div>
                      <h3>
                        Authorization status{" "}
                        <span
                          className={`mp-badge ${authorized ? "green" : "red"}`}
                        >
                          {authorized ? "Active" : "Not valid"}
                        </span>
                      </h3>
                      <p>
                        {authorized
                          ? `Valid until ${time(authorization!.expiresAt)}`
                          : "Save a valid authorization before execution."}
                      </p>
                    </div>
                    <button onClick={() => setModal("authorization")}>
                      View / edit authorization
                    </button>
                  </div>
                  <div className="mp-risk-row">
                    <ShieldCheck />
                    <div>
                      <h3>Transaction safety</h3>
                      <p>
                        {decision
                          ? `${decision.decision} · ${time(decision.at)}`
                          : "Final risk checks have not run. A saved quote is not payment approval."}
                      </p>
                      {decision?.hits.map((h) => (
                        <p
                          className={
                            h.severity === "block" ? "mp-error" : "mp-note"
                          }
                          key={h.rule}
                        >
                          {h.rule}: {h.reason}
                          <br />
                          {h.exit}
                        </p>
                      ))}
                    </div>
                  </div>
                  <div className="mp-risk-row">
                    <ShoppingBag />
                    <div>
                      <h3>Monthly budget</h3>
                      <div className="mp-grid mp-totals">
                        <div>
                          Spent<strong>{money(decision?.spentMinor)}</strong>
                        </div>
                        <div>
                          Reserved
                          <strong>{money(decision?.reservedMinor)}</strong>
                        </div>
                        <div>
                          Projected
                          <strong>{money(decision?.projectedMinor)}</strong>
                        </div>
                      </div>
                      <p>
                        Soft {money(authorization?.monthlySoftMinor)} · Hard{" "}
                        {money(authorization?.monthlyHardMinor)}
                      </p>
                    </div>
                  </div>
                  <div className="mp-risk-row">
                    <Info />
                    <div>
                      <h3>Per-order budget</h3>
                      <p>
                        {money(current.quote.totalMinor)} · Soft{" "}
                        {money(authorization?.singleSoftMinor)} / Hard{" "}
                        {money(authorization?.singleHardMinor)}
                      </p>
                    </div>
                  </div>
                  <div className="mp-note">
                    Soft-limit breaches need a separate confirmation. Hard-limit
                    breaches stop the transaction.
                  </div>
                  <p
                    className={
                      current.stale || current.quote.expiresAt <= now
                        ? "mp-error"
                        : "mp-muted"
                    }
                  >
                    {!now
                      ? "Checking quote validity…"
                      : current.stale
                      ? "Requirements changed. This plan is stale."
                      : current.quote.expiresAt <= now
                        ? "Quote expired. This saved plan cannot execute; create a new explicit task or requirement version."
                        : `Quote expires ${time(current.quote.expiresAt)} · ${Math.max(0, Math.ceil((current.quote.expiresAt - now) / 1000))}s remaining`}
                  </p>
                  <label className="mp-check">
                    <input
                      type="checkbox"
                      checked={hasPermission}
                      onChange={(e) =>
                        setPermission(
                          e.target.checked ? permissionBinding : null,
                        )
                      }
                      disabled={busy || !canExecute}
                    />
                    I permit this one Stripe sandbox test for this plan. This is
                    separate from my ongoing authorization.
                  </label>
                  <div className="mp-actions">
                    {confirmation &&
                      dismissed === confirmation.confirmationId && (
                        <button onClick={() => setDismissed(null)}>
                          Open soft-limit confirmation
                        </button>
                      )}
                    <button
                      className="primary"
                      disabled={busy || !hasPermission || !canExecute}
                      onClick={() =>
                        void purchase("execute", current.plan.planId)
                      }
                    >
                      Execute this sandbox purchase
                    </button>
                  </div>
                  <details>
                    <summary>
                      Checkout quote, original / final Offer and B review
                    </summary>
                    <pre>
                      {JSON.stringify(
                        {
                          quote: current.quote,
                          checkout: current.plan.checkout,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </section>
              )}
              {purchases?.purchases
                .filter((p) => p.operation)
                .map((p) => (
                  <section className="mp-card" key={p.plan.planId}>
                    <div className="mp-card-heading">
                      <h2>
                        <ShoppingBag />
                        Auto purchase · order & payment
                      </h2>
                      <span
                        className={`mp-badge ${p.operation?.paymentStatus === "succeeded" ? "green" : "yellow"}`}
                      >
                        {
                          paymentLabels[
                            p.operation?.paymentStatus ?? "not_started"
                          ]
                        }
                      </span>
                    </div>
                    <p>Demo Merchant · Stripe sandbox · no real charges</p>
                    {!p.stripeConfigured && (
                      <div className="mp-note">
                        Stripe sandbox is not configured. No Stripe payment can
                        be sent until the server key is configured.
                      </div>
                    )}
                    {p.operation?.errorCode && (
                      <p className="mp-error" role="alert">
                        {p.operation.errorCode} · Check the original transaction
                        state before proceeding.
                      </p>
                    )}
                    <p>
                      {p.plan.title} · {money(p.quote.totalMinor)} · requirement
                      v{p.plan.requirementVersion}
                      {p.stale ? " · historical plan" : ""}
                    </p>
                    <ol className="mp-timeline">
                      <li>
                        Submit merchant order{" "}
                        <strong>{p.order?.status ?? "Not submitted"}</strong>
                      </li>
                      <li>
                        Send payment request{" "}
                        <strong>
                          {
                            paymentLabels[
                              p.operation?.paymentStatus ?? "not_started"
                            ]
                          }
                        </strong>
                      </li>
                      <li>
                        Receive order receipt{" "}
                        <strong>
                          {p.order?.status === "confirmed"
                            ? "Merchant confirmed"
                            : p.order?.status === "confirmation_failed"
                              ? "Merchant confirmation failed"
                              : "Not confirmed"}
                        </strong>
                      </li>
                    </ol>
                    <div className="mp-note">
                      {p.operation?.paymentStatus === "succeeded"
                        ? "Payment succeeded. Merchant order status is reported independently; do not pay again."
                        : "Payment success has not been confirmed unless the server reports succeeded."}
                    </div>
                    <dl>
                      <dt>Plan</dt>
                      <dd>{p.plan.planId}</dd>
                      <dt>Operation</dt>
                      <dd>{p.operation?.operationId ?? "Not created"}</dd>
                      <dt>Order receipt</dt>
                      <dd>{p.order?.orderId ?? "Not received"}</dd>
                      <dt>Payment reference</dt>
                      <dd>{p.operation?.paymentId ?? "Not created"}</dd>
                    </dl>
                    {p.operation && (
                      <button
                        disabled={busy}
                        onClick={() => void purchase("recover", p.plan.planId)}
                      >
                        Reconcile original transaction
                      </button>
                    )}
                    <small className="mp-muted">
                      Refunds, disputes and logistics tracking are not
                      implemented.
                    </small>
                  </section>
                ))}
            </>
          )}
          <div className="mp-demo">
            <Info size={18} />
            <span>
              Explicit sandbox demos · separate tasks, no real products or
              charges
            </span>
            <button disabled={busy} onClick={() => void demo()}>
              Shopping catalog demo
            </button>
            <button disabled={busy} onClick={() => void demo(true)}>
              Legacy demo
            </button>
          </div>
        </div>
        <footer className="mp-composer">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              aria-label="Tell me your skincare needs"
              placeholder="Tell me your skincare needs…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              className="primary"
              aria-label="Send message"
              disabled={busy || !message.trim()}
            >
              <Send />
            </button>
          </form>
          <div>
            <button
              className="mp-revoke"
              disabled={
                busy || !authorization || authorization.status === "revoked"
              }
              onClick={() =>
                void run(async () => {
                  await api.request(
                    "risk/revoke",
                    { expectedVersion: authorization!.version },
                    true,
                  );
                  setPermission(null);
                  await refresh();
                  setNotice(
                    "Authorization revoked. Future execution is blocked; submitted payments may still settle. This is not a refund.",
                  );
                })
              }
            >
              Revoke
            </button>
            <small>
              Stops future purchases; submitted payments may still settle.
            </small>
          </div>
          <button
            aria-label="Refresh task, order and payment status"
            disabled={busy}
            onClick={() => void run(() => refresh())}
          >
            <RefreshCw size={20} />
          </button>
        </footer>
      </main>
      {modal === "welcome" && (
        <Welcome
          ready={!!risk}
          close={() => setModal(null)}
          continueToAuthorization={() => setModal("authorization")}
        />
      )}
      {modal === "authorization" && risk && (
        <AuthorizationForm
          authorization={authorization ?? null}
          scope={risk.scope}
          busy={busy}
          error={error}
          close={() => setModal(null)}
          save={saveAuthorization}
        />
      )}
      {modal === "requirements" && (
        <Modal title="Search requirements" close={() => setModal(null)} wide>
          <h2>Search requirements</h2>
          {error && (
            <div className="mp-error" role="alert">
              {error}
            </div>
          )}
          <p>
            Conditions and preferences are retained when editing. Prices include
            shipping. No authorization is required to search.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveRequirements(new FormData(e.currentTarget));
            }}
          >
            <div className="mp-grid">
              <label>
                Intent
                <select name="intent" defaultValue={task?.intent ?? "compare"}>
                  <option value="compare">Compare products</option>
                  <option value="purchase">
                    Purchase after explicit permission
                  </option>
                </select>
              </label>
              <label>
                Category
                <input
                  name="category"
                  required
                  defaultValue={task?.requirementDraft.category ?? ""}
                />
              </label>
              <label>
                Product / query
                <input
                  name="query"
                  required
                  defaultValue={task?.requirementDraft.query ?? ""}
                />
              </label>
              <label>
                Quantity
                <input
                  name="quantity"
                  type="number"
                  min="1"
                  required
                  defaultValue={task?.requirementDraft.quantity ?? 1}
                />
              </label>
              <label>
                Delivered budget · HKD
                <input
                  name="budget"
                  required
                  defaultValue={task?.requirementDraft.budget?.maxHKD ?? 200}
                />
              </label>
              <label>
                Delivery region
                <input
                  name="destination"
                  required
                  defaultValue={task?.requirementDraft.destination ?? "香港"}
                />
              </label>
            </div>
            <label>
              Excluded ingredient keywords · comma separated
              <input
                name="exclusions"
                defaultValue={
                  (
                    task?.requirementDraft.hardConstraints?.find(
                      (c) => c.id === "mirrorpick_exclusions",
                    )?.value as string[] | undefined
                  )?.join(", ") ?? ""
                }
              />
            </label>
            <details>
              <summary>Advanced matching rules</summary>
              <label>
                Hard conditions · shared contract JSON
                <textarea
                  name="constraints"
                  rows={4}
                  defaultValue={JSON.stringify(
                    task?.requirementDraft.hardConstraints ?? [],
                    null,
                    2,
                  )}
                />
              </label>
              <label>
                Preferences · shared contract JSON
                <textarea
                  name="preferences"
                  rows={4}
                  defaultValue={JSON.stringify(
                    task?.requirementDraft.preferences ?? [],
                    null,
                    2,
                  )}
                />
              </label>
            </details>
            <p className="mp-muted">
              Unknown ingredient, efficacy or delivery facts remain unverified.
              Existing excluded product IDs are preserved. Natural-language
              editing requires the configured server model.
            </p>
            <div className="mp-actions">
              <button type="button" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                Save requirements
              </button>
            </div>
          </form>
        </Modal>
      )}
      {now > 0 && confirmation && dismissed !== confirmation.confirmationId && (
        <SoftConfirmation
          c={confirmation}
          decision={decision!}
          authorization={authorization!}
          busy={busy}
          error={error}
          now={now}
          close={() => setDismissed(confirmation.confirmationId)}
          respond={confirm}
        />
      )}
    </div>
  );
}
