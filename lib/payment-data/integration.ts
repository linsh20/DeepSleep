import { evaluateShoppingCandidates } from "../agent-b/contract.ts"
import type { ContractBPolicy, ContractBResult, ContractEvaluationInput, PaymentOrder } from "../../types/index.ts"
import { buildPaymentContext, type BuildPaymentContextInput } from "./context-builder.ts"
import { PaymentRepository } from "./repository.ts"

/** Two-stage integration for an already-reviewed candidate and trusted complete quote. */
export function evaluateWithStoredPaymentMethods(input: {
  evaluation: Omit<ContractEvaluationInput,"paymentContext">
  payment: BuildPaymentContextInput
  order: PaymentOrder
}, repository: PaymentRepository, policy: ContractBPolicy): Promise<ContractBResult> {
  const context = buildPaymentContext(repository,input.payment)
  if (input.order.taskId !== context.taskId || input.order.requirementVersion !== context.requirementVersion) {
    throw new TypeError("订单与支付上下文任务/版本不一致")
  }
  // evaluateShoppingCandidates constructs its own order from the selected candidate quote.
  if (JSON.stringify(input.order.quote) !== JSON.stringify(context.quote)) throw new TypeError("订单与支付上下文报价不一致")
  return evaluateShoppingCandidates({ ...input.evaluation, paymentContext:context },policy)
}
