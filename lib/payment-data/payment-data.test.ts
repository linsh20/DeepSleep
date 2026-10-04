import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { optimizePaymentMethods } from "../agent-b/payment.ts"
import type { ContractBPolicy, ContractEvaluationInput, Fact, PaymentOrder } from "../../types/index.ts"
import { buildPaymentContext } from "./context-builder.ts"
import { evaluateWithStoredPaymentMethods } from "./integration.ts"
import { PaymentRepository } from "./repository.ts"
import { seedMockPaymentData } from "./seed.ts"

const now = new Date("2026-10-04T02:00:00.000Z")
function setup() {
  const db = new DatabaseSync(":memory:")
  seedMockPaymentData(db,{ userId:"user-1", now })
  const repository = new PaymentRepository(db)
  const quote = { productId:"product",skuId:"sku",offerId:"offer",quantity:1,destination:"HK",currency:"HKD",totalMinor:20000 }
  const context = buildPaymentContext(repository,{ userId:"user-1",taskId:"task",requirementVersion:1,quote,
    category:"skincare",merchantId:"watsons",acceptedPaymentChannels:["credit_card"],acceptedNetworks:["visa","mastercard"],now })
  const order:PaymentOrder = { taskId:"task",requirementVersion:1,quote,total:{value:20000,source:"mock-dataset",fetchedAt:now.toISOString(),status:"mock"},maxUpfrontMinor:null }
  const optimize = () => optimizePaymentMethods(order,buildPaymentContext(repository,{ userId:"user-1",taskId:"task",requirementVersion:1,quote,
    category:"skincare",merchantId:"watsons",acceptedPaymentChannels:["credit_card"],acceptedNetworks:["visa","mastercard"],now }),
    { policyVersion:"test-v1",dataEnvironment:"development_mock",now:()=>now })
  return { db,repository,context,optimize }
}

test("seed is repeatable and repository is user-scoped", () => {
  const { db,repository } = setup()
  seedMockPaymentData(db,{ userId:"user-1",now })
  assert.deepEqual(repository.cards("user-1").map(row=>row.card_id),["card-a","card-b"])
  assert.equal(repository.cards("other").length,0)
})

test("scenario A: database context recommends Card B with expected costs", () => {
  const { context,optimize } = setup()
  assert.equal(context.methods.length,2)
  const result = optimize()
  assert.equal(result.recommended?.cardId,"card-b")
  assert.deepEqual(result.recommended?.costs,{instantDiscountMinor:1500,orderPayableMinor:18500,
    convertedPrincipalMinor:17020,feeMinor:271,chargeMinor:17291,comparisonChargeMinor:18675,futureCashbackMinor:600})
})

test("scenario B: database usage update switches recommendation to Card A", () => {
  const { db,optimize } = setup()
  db.prepare("UPDATE payment_benefit_usage SET used_minor=3000 WHERE benefit_id='instant-card-b'").run()
  const result = optimize()
  assert.equal(result.recommended?.cardId,"card-a")
  const cardB = result.evaluations.find(row=>row.cardId==="card-b")
  assert.equal(cardB?.costs?.instantDiscountMinor,0)
  assert.equal(cardB?.costs?.comparisonChargeMinor,20179)
})

test("scenario C/D: unknown fee and expired FX remain verification requests", () => {
  const { db,optimize } = setup()
  db.prepare("UPDATE payment_fee_rules SET fee_bps=NULL,evidence_status='unverified' WHERE card_id='card-b'").run()
  let result = optimize()
  assert.equal(result.recommended?.cardId,"card-a")
  assert.equal(result.comparisonComplete,false)
  assert.equal(result.evaluations.find(row=>row.cardId==="card-b")?.status,"needs_verification")
  db.prepare("UPDATE payment_fee_rules SET fee_bps=100,evidence_status='mock' WHERE card_id='card-b'").run()
  db.prepare("UPDATE payment_fx_quotes SET fetched_at='2026-10-04T01:00:00.000Z',valid_until='2026-10-04T01:30:00.000Z' WHERE fx_id='fx-card-b-hkd-cny'").run()
  result = optimize()
  assert.match(result.verificationRequests.flatMap(row=>row.fields).join(" "),/settlementRate/)
})

test("eligibility, environment isolation, cashback ordering and idempotent settlement", () => {
  const { db,repository,context,optimize } = setup()
  const cardB = context.methods.find(row=>row.cardId==="card-b")!
  assert.equal(cardB.futureCashbackMinor?.value,600)
  cardB.futureCashbackMinor!.value=0
  assert.equal(optimize().recommended?.cardId,"card-b")
  const production = optimizePaymentMethods({taskId:"task",requirementVersion:1,quote:context.quote,
    total:{value:20000,source:"mock-dataset",fetchedAt:now.toISOString(),status:"mock"},maxUpfrontMinor:null},context,
    {policyVersion:"prod",dataEnvironment:"verified_sources",now:()=>now})
  assert.equal(production.status,"needs_verification")
  const event={eventId:"event-1",userId:"user-1",benefitId:"instant-card-b",period:"2026-10",amountMinor:1500,settledAt:now.toISOString()}
  assert.equal(repository.recordBenefitSettlement(event),true)
  assert.equal(repository.recordBenefitSettlement(event),false)
  assert.equal(repository.usage("user-1","instant-card-b","2026-10"),1500)
  db.prepare("UPDATE payment_cards SET status='inactive' WHERE card_id='card-b'").run()
  assert.equal(optimize().recommended?.cardId,"card-a")
})

test("database context is consumed by the existing evaluateShoppingCandidates entry", async () => {
  const { repository } = setup()
  const f=<T>(value:T):Fact<T>=>({value,source:"mock-dataset",fetchedAt:now.toISOString(),status:"mock"})
  const evaluation:Omit<ContractEvaluationInput,"paymentContext">={
    requirement:{taskId:"task",requirementVersion:1,category:"skincare",query:"cream",currency:"HKD",
      budget:{maxMinor:22000,scope:"delivered"},destination:"HK",hardConstraints:[],preferences:[],excludedProductIds:[]},
    quantity:1,sourceTaskId:"task",sourceRequirementVersion:1,searchStatus:"complete",
    candidates:[{productId:"product",skuId:"sku",offerId:"offer",title:"Cream",url:"https://example.com/product",
      attributes:{category:f("skincare")},merchant:{id:"watsons",name:f("Watsons"),platformId:f("watsons")},
      offer:{currency:"HKD",itemPriceMinor:f(20000),shippingMinor:f(0),discountMinor:f(0),stock:f("available"),deliverable:f(true)},
      quote:{quantity:1,destination:"HK",totalMinor:f(20000),otherFeesMinor:f(0),estimatedDeliveryAtMs:{...f(0),value:null}},missingFields:[]}],
  }
  const quote={productId:"product",skuId:"sku",offerId:"offer",quantity:1,destination:"HK",currency:"HKD",totalMinor:20000}
  const order:PaymentOrder={taskId:"task",requirementVersion:1,quote,total:f(20000),maxUpfrontMinor:22000}
  const policy:ContractBPolicy={policyVersion:"test-v1",dataEnvironment:"development_mock",merchantAllowlist:[{id:"watsons",platformId:"watsons"}],priceBenchmarks:[],now:()=>now}
  const result=await evaluateWithStoredPaymentMethods({evaluation,payment:{userId:"user-1",taskId:"task",requirementVersion:1,quote,
    category:"skincare",merchantId:"watsons",acceptedPaymentChannels:["credit_card"],acceptedNetworks:["visa","mastercard"],now},order},repository,policy)
  assert.equal(result.paymentOptimization?.recommended?.cardId,"card-b")
  assert.equal(result.decisionRecord.paymentContextSnapshot?.methods.length,2)
})
