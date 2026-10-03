import { SandboxExecutionGate } from "../purchase-execution/gate"
import type { ExecutionGate, PurchaseOperation } from "../purchase-execution/types"
import { RiskPolicyEngine } from "./engine"
import { RiskRepository } from "./repository"
import type { SqlitePurchaseRepository } from "../purchase-execution/repository"
import type { RiskInput } from "./types"
export class LimitedExecutionGate implements ExecutionGate {
  readonly engine: RiskPolicyEngine
  constructor(repo: SqlitePurchaseRepository) { this.engine=new RiskPolicyEngine(new RiskRepository(repo)) }
  check(input:RiskInput) {
    // Initial plan checks are not permission to submit: persisted operations are checked again.
    if(!input.operationId)return new SandboxExecutionGate().check(input)
    return this.engine.evaluate(input)
  }
  settle(op:PurchaseOperation,now:number){this.engine.settle(op,now)}
}
