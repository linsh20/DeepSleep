import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const req = createRequire(import.meta.url);
req.extensions[".ts"] = (m, f) =>
  m._compile(
    ts.transpileModule(readFileSync(f, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    f,
  );
const { AgentClient, identity, candidateTotal, paymentLabels, money } = req(
  "../lib/mirrorpick.ts",
);
const fact = (value) => ({
  value,
  source: "mock-dataset",
  status: "mock",
  fetchedAt: "2026-10-04T00:00:00Z",
});
test("MirrorPick: unknown shipping/discount cannot be displayed as a free or complete total", () => {
  const c = {
    offer: {
      itemPriceMinor: fact(16000),
      shippingMinor: fact(null),
      discountMinor: fact(0),
    },
  };
  assert.equal(candidateTotal(c), null);
  assert.equal(money(candidateTotal(c)), "Unknown");
  c.offer.shippingMinor = fact(1000);
  assert.equal(candidateTotal(c), 17000);
  c.offer.discountMinor = fact(null);
  assert.equal(candidateTotal(c), null);
  c.quote = { totalMinor: fact(16900) };
  assert.equal(candidateTotal(c), 16900);
  c.quote.totalMinor = fact(null);
  assert.equal(candidateTotal(c), null);
});
test("MirrorPick: candidate identity distinguishes same product with other SKU and Offer", () => {
  const a = { productId: "p", skuId: "s1", offerId: "o1" };
  assert.notEqual(identity(a), identity({ ...a, skuId: "s2" }));
  assert.notEqual(identity(a), identity({ ...a, offerId: "o2" }));
  assert.equal(identity(a), '["p","s1","o1"]');
});
test("MirrorPick: every server payment enum has an independent truthful label", () => {
  const enums = [
    "not_started",
    "creating",
    "requires_confirmation",
    "confirming",
    "requires_action",
    "processing",
    "failed",
    "unknown",
    "succeeded",
    "canceled",
  ];
  assert.deepEqual(Object.keys(paymentLabels).sort(), enums.sort());
  for (const state of enums.filter((x) => x !== "succeeded"))
    assert.ok(!paymentLabels[state].includes("succeeded"));
  assert.match(paymentLabels.unknown, /reconcile original/);
});
test("MirrorPick: interrupted execute has no automatic replay; explicit identical retry retains requestId", async (t) => {
  const calls = [];
  let interrupted = true;
  t.mock.method(globalThis, "fetch", async (path, init) => {
    calls.push({ path, init });
    if (interrupted) {
      interrupted = false;
      throw new TypeError("connection lost");
    }
    return Response.json({ ok: true });
  });
  const client = new AgentClient(),
    body = {
      taskId: "task",
      planId: "plan",
      expectedVersion: 1,
      testPermission: true,
    };
  await assert.rejects(client.request("purchases/execute", body, true), {
    code: "OUTCOME_UNKNOWN",
  });
  assert.equal(calls.length, 1);
  await client.request("purchases/execute", body, true);
  assert.equal(
    JSON.parse(calls[0].init.body).requestId,
    JSON.parse(calls[1].init.body).requestId,
  );
  assert.equal(calls[1].path, "/api/agent/purchases/execute");
  assert.deepEqual(
    Object.keys(JSON.parse(calls[1].init.body)).sort(),
    [
      "taskId",
      "planId",
      "expectedVersion",
      "testPermission",
      "requestId",
    ].sort(),
  );
});
test("MirrorPick: state reads never send a mutation or a test permission", async (t) => {
  let seen;
  t.mock.method(globalThis, "fetch", async (path, init) => {
    seen = { path, init };
    return Response.json({ purchases: [] });
  });
  await new AgentClient().request("purchases/state?taskId=original");
  assert.equal(seen.init.method, undefined);
  assert.equal(seen.init.body, undefined);
  assert.equal(seen.init.cache, "no-store");
});
test("MirrorPick: server errors and unreadable outcomes retain retry identity; changed intent gets a new ID", async (t) => {
  const calls = [];
  let status = 503;
  t.mock.method(globalThis, "fetch", async (path, init) => {
    calls.push(JSON.parse(init.body));
    return status === 503
      ? Response.json(
          { error: { code: "BRIDGE_UNAVAILABLE", message: "query state" } },
          { status },
        )
      : Response.json({ ok: true });
  });
  const client = new AgentClient();
  await assert.rejects(
    client.request("purchases/execute", { planId: "original" }, true),
    { uncertain: true },
  );
  status = 200;
  await client.request("purchases/execute", { planId: "original" }, true);
  assert.equal(calls[0].requestId, calls[1].requestId);
  await client.request("purchases/execute", { planId: "different" }, true);
  assert.notEqual(calls[1].requestId, calls[2].requestId);
});
