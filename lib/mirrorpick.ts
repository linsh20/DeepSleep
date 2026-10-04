import type { ShoppingCandidate } from "../types/index";
import type { PaymentState } from "../services/purchase-execution/types";

export const identity = (
  c: Pick<ShoppingCandidate, "productId" | "skuId" | "offerId">,
) => JSON.stringify([c.productId, c.skuId, c.offerId]);
export const money = (minor: number | null | undefined) =>
  minor == null ? "Unknown" : `HK$${(minor / 100).toFixed(2)}`;
export function candidateTotal(c: ShoppingCandidate): number | null {
  if (c.quote) return c.quote.totalMinor.value;
  const o = c.offer;
  if (
    !o ||
    o.itemPriceMinor.value == null ||
    o.shippingMinor.value == null ||
    o.discountMinor.value == null
  )
    return null;
  return o.itemPriceMinor.value + o.shippingMinor.value - o.discountMinor.value;
}
export const paymentLabels: Record<PaymentState, string> = {
  not_started: "Not started",
  creating: "Creating payment · unconfirmed",
  requires_confirmation: "Awaiting payment confirmation",
  confirming: "Confirming · unconfirmed",
  requires_action: "Action required · unconfirmed",
  processing: "Processing · unconfirmed",
  failed: "Payment failed",
  unknown: "Unknown · reconcile original payment",
  succeeded: "Payment succeeded",
  canceled: "Payment canceled",
};
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public uncertain = false,
  ) {
    super(`${code}: ${message}`);
  }
}
// Keep an identical uncertain mutation's ID. Never automatically replay a payment.
export class AgentClient {
  private pending = new Map<string, string>();
  async request<T>(
    path: string,
    body?: Record<string, unknown>,
    idempotent = false,
  ): Promise<T> {
    const key = `${path}:${JSON.stringify(body)}`;
    let payload = body;
    if (body && idempotent) {
      const requestId = this.pending.get(key) ?? crypto.randomUUID();
      this.pending.set(key, requestId);
      payload = { ...body, requestId };
    }
    let response: Response;
    try {
      response = await fetch(
        `/api/agent/${path}`,
        body === undefined
          ? { cache: "no-store" }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
      );
    } catch {
      throw new ApiError(
        "OUTCOME_UNKNOWN",
        "Request interrupted. Query the original task and purchase before retrying.",
        true,
      );
    }
    let data: T & { error?: { code: string; message?: string } };
    try {
      data = await response.json();
    } catch {
      throw new ApiError(
        "OUTCOME_UNKNOWN",
        "Unreadable response. Query original state.",
        true,
      );
    }
    if (response.ok || response.status < 500) this.pending.delete(key);
    if (!response.ok)
      throw new ApiError(
        data.error?.code ?? "REQUEST_FAILED",
        data.error?.message ?? "Request failed",
        response.status >= 500,
      );
    return data;
  }
}
