import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync,mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import ts from 'typescript'
const req=createRequire(import.meta.url)
req.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f)
const {SqlitePurchaseRepository}=req('../services/purchase-execution/repository.ts')
const {SqliteTaskRepository}=req('../services/main-agent/sqlite-repository.ts')
const {MainTaskOrchestrator}=req('../services/main-agent/orchestrator.ts')
const {DevelopmentRequirementInterpreter}=req('../services/main-agent/requirement-interpreter.ts')
const {configuredShoppingPort}=req('../services/main-agent/shopping-adapter.ts')
const {PurchaseBridge,currentTaskResolver}=req('../services/purchase-bridge/service.ts')
const {DemoMerchantAdapter}=req('../services/purchase-execution/demo-merchant.ts')
const {RiskRepository}=req('../services/risk-control/repository.ts')
const {AuthorizationService}=req('../services/risk-control/authorization.ts')
const {ConfirmationService}=req('../services/risk-control/confirmation.ts')
const {CHECKOUT_PRODUCT:c}=req('../services/checkout/catalog.ts')
const {candidateId}=req('../services/checkout/coordinator.ts')
const {bridgeHttp}=req('../services/purchase-bridge/http.ts')
class Payment{
 creates=0;confirms=0;objects=new Map()
 configured(){return true}configurationId(){return 'checkout-controlled'}
 async create(op){this.creates++;const id='pi_'+op.operationId.replaceAll('-','');if(!this.objects.has(id))this.objects.set(id,{id,livemode:false,amount:op.quote.totalMinor,currency:'hkd',status:'requires_confirmation',operationId:op.operationId,orderId:op.orderId,planId:op.planId});await this.onCreate?.();return structuredClone(this.objects.get(id))}
 async confirm(op){this.confirms++;this.objects.get(op.paymentId).status='succeeded';return structuredClone(this.objects.get(op.paymentId))}
 async retrieve(id){return structuredClone(this.objects.get(id))}verifyWebhook(raw){return JSON.parse(raw)}
}
const draft=()=>({category:c.category,query:c.title,currency:'HKD',quantity:1,destination:'香港',budget:{maxMinor:20000,scope:'delivered'},hardConstraints:[{field:'attributes.volumeMl',op:'eq',value:200}],preferences:[],excludedProductIds:[]})
async function setup(t,patch={}){
 const dir=mkdtempSync(join(tmpdir(),'checkout-')),path=join(dir,'test.sqlite'),repo=new SqlitePurchaseRepository(path),main=new SqliteTaskRepository(repo.db),payment=new Payment(),merchant=new DemoMerchantAdapter(repo),bridge=new PurchaseBridge(main,repo,merchant,payment),agent=new MainTaskOrchestrator(main,new DevelopmentRequirementInterpreter(),configuredShoppingPort()),risk=new RiskRepository(repo),auth=new AuthorizationService(risk)
 main.sessions.add('abc-def');const owner=main.owner('abc-def');const created=await agent.create(owner,randomUUID());const task=await agent.save(created.taskId,owner,{requestId:randomUUID(),expectedVersion:0,intent:'purchase',requirementDraft:{...draft(),...patch}});const searched=await agent.search(task.taskId,owner,randomUUID(),task.requirementVersion)
 const prepare=(requestId=randomUUID(),id=candidateId(searched.shoppingResult.candidates[0]))=>bridge.prepare(task.taskId,owner,{expectedVersion:task.requirementVersion,requestId,candidateId:id})
 const execute=view=>bridge.execute(task.taskId,owner,{planId:view.purchases[0].plan.planId,expectedVersion:task.requirementVersion,requestId:randomUUID(),testPermission:true})
 const authorize=(patch={})=>auth.save(owner,{startsAt:Date.now()-1000,expiresAt:Date.now()+3600000,singleSoftMinor:20000,singleHardMinor:20000,monthlySoftMinor:100000,monthlyHardMinor:100000,productIds:[c.productId],merchantIds:['demo-merchant'],paymentMethods:['stripe_test_card'],...patch},risk.current(owner)?.version??0,randomUUID(),true)
 const extraRepos=[];t.after(()=>{for(const extra of extraRepos)extra.close();try{repo.close()}catch{}rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})});return {dir,path,repo,main,payment,merchant,bridge,agent,risk,auth,owner,task,searched,prepare,execute,authorize,trackRepo:extra=>{extraRepos.push(extra);return extra}}
}
test('checkout: saved Shopping candidate without recommendation -> distinct Demo offer/quote -> B and fixed card -> plan, no payment',async t=>{
 const s=await setup(t);assert.equal(s.searched.shoppingResult.status,'needs_verification');assert.equal(s.searched.shoppingResult.recommendations.length,0)
 const v=await s.prepare();assert.equal(v.checkoutPreparation.status,'result_ready');assert.equal(s.payment.creates,0);const {plan,quote}=v.purchases[0],e=plan.checkout
 assert.equal(plan.taskId,s.task.taskId);assert.equal(e.sourceDecisionId,s.searched.shoppingResult.decisionRecord.decisionId);assert.equal(e.sourceCandidate.offerId,c.referenceOfferId);assert.notEqual(e.offerId,c.referenceOfferId);assert.equal(quote.totalMinor,17000);assert.equal(quote.source,'mock-dataset');assert.equal(e.review.status,'result_ready');assert.equal(e.review.paymentOptimization.recommended.optionId,'stripe_test_card');assert.equal(e.review.paymentOptimization.recommended.costs.chargeMinor,17000);assert.equal(e.reviewedCandidate.offer.stock.status,'mock');assert.equal(e.reviewedCandidate.searchableText.ingredients.value,null)
})
test('checkout: approve/hold/block with actual Shopping and new bound plan, budget spent exactly once',async t=>{
 const records=[]
 for(const [expected,limits] of [['approve',{}],['hold',{singleSoftMinor:10000}],['block',{singleSoftMinor:10000,singleHardMinor:16000}]]){
  const s=await setup(t);s.authorize(limits);const prepared=await s.prepare();let v=await s.execute(prepared),decision=s.risk.view(s.owner).decisions[0];assert.equal(decision.decision,expected)
  if(expected==='hold'){assert.equal(s.payment.confirms,0);const confirmation=s.risk.view(s.owner).confirmations[0];assert.equal(new ConfirmationService(s.risk,currentTaskResolver(s.main)).respond(s.owner,confirmation.confirmationId,true).accepted,true);v=await s.execute(prepared)}
  if(expected==='block')assert.equal(s.payment.creates,0)
  else{assert.equal(v.purchases[0].operation.paymentStatus,'succeeded');assert.equal(v.purchases[0].order.status,'confirmed');await Promise.all([s.execute(prepared),s.execute(prepared)]);const op=v.purchases[0].operation;const event=JSON.stringify({id:'evt_'+expected,paymentId:op.paymentId,operationId:op.operationId});await s.bridge.execution.webhook(event,'');await s.bridge.execution.webhook(event,'');assert.equal(s.payment.confirms,1);assert.equal(s.risk.view(s.owner).reservations.length,1);assert.equal(s.risk.view(s.owner).reservations[0].state,'spent');assert.equal(s.risk.view(s.owner).reservations[0].amount,17000)}
  records.push({provider:'controlled_payment_double_not_stripe',expected,input:{requirement:s.searched.requirement,candidateId:candidateId(s.searched.shoppingResult.candidates[0])},preparation:prepared.checkoutPreparation,plan:prepared.purchases[0].plan,decision,purchase:v.purchases[0],risk:s.risk.view(s.owner)})
 }
 mkdirSync('.data',{recursive:true});writeFileSync('.data/checkout-acceptance.json',JSON.stringify(records,null,2)+'\n')
})
test('checkout: old lotion authorization cannot authorize newly supported product; explicit new version required',async t=>{
 const s=await setup(t);s.authorize({productIds:['sandbox-lotion']});const v=await s.prepare();await s.execute(v);assert.ok(s.risk.view(s.owner).decisions[0].hits.some(h=>h.rule==='AUTH_SCOPE'));assert.equal(s.payment.confirms,0);assert.deepEqual(s.risk.current(s.owner).productIds,['sandbox-lotion']);s.authorize();assert.equal((await s.execute(v)).purchases[0].operation.paymentStatus,'succeeded')
})
test('checkout: unknown user hard facts remain verification; supported quote does not invent shade or ingredients',async t=>{
 const s=await setup(t,{hardConstraints:[{field:'attributes.shade',op:'eq',value:'02'}]});const v=await s.prepare();assert.equal(v.checkoutPreparation.status,'needs_verification');assert.ok(v.checkoutPreparation.review.missingFacts.includes('attributes.shade'));assert.equal(v.purchases.length,0);assert.equal(s.payment.creates,0)
})
test('checkout: non-deliverable, over-budget and excluded/hard mismatches stop with no payable plan',async t=>{
 const a=await setup(t,{destination:'澳门'});assert.equal((await a.prepare()).checkoutPreparation.status,'no_match')
 const b=await setup(t,{budget:{maxMinor:16500,scope:'delivered'}});assert.equal((await b.prepare()).checkoutPreparation.status,'no_match');assert.equal(b.bridge.state(b.task.taskId,b.owner).purchases.length,0)
 const d=await setup(t,{excludedProductIds:[c.productId]});assert.equal((await d.prepare()).checkoutPreparation.status,'no_match');assert.equal(d.payment.creates,0)
})
test('checkout: real Watsons candidate remains unsupported, its identity and timestamps stay intact',async t=>{
 const s=await setup(t,{category:'乳液',query:'乳液',hardConstraints:[]});assert.ok(s.searched.shoppingResult.candidates.length);const id=candidateId(s.searched.shoppingResult.candidates.find(c=>!s.searched.shoppingResult.diagnostics.candidateChecks.find(a=>candidateId(a)===candidateId(c))?.checks.some(k=>k.outcome==='mismatch')));const before=structuredClone(s.searched.shoppingResult);const v=await s.prepare(randomUUID(),id);assert.equal(v.checkoutPreparation.status,'unsupported_product');assert.equal(v.purchases.length,0);assert.deepEqual(s.main.get(s.task.taskId,s.owner).shoppingResult,before)
})
test('checkout: request and concurrent prepare dedupe, identity conflicts and cross-user rejected',async t=>{
 const s=await setup(t),id=randomUUID();const [a,b]=await Promise.all([s.prepare(id),s.prepare(id)]);assert.equal(a.purchases[0].plan.planId,b.purchases[0].plan.planId);assert.equal(s.repo.db.prepare('SELECT count(*) n FROM sandbox_plans').get().n,1)
 await assert.rejects(s.bridge.prepare(s.task.taskId,'foreign',{requestId:randomUUID(),expectedVersion:1,candidateId:candidateId(s.searched.shoppingResult.candidates[0])}),{code:'NOT_FOUND'})
 await assert.rejects(s.prepare(id,'different'),{code:'REQUEST_CONFLICT'});await assert.rejects(s.bridge.prepare(s.task.taskId,s.owner,{requestId:id,expectedVersion:1}),{code:'REQUEST_CONFLICT'})
})
test('checkout: prepare races requirement change; existing quote expiry and version cannot pay',async t=>{
 const s=await setup(t);const original=s.merchant.quote.bind(s.merchant);s.merchant.quote=async p=>{const q=await original(p);await s.agent.save(s.task.taskId,s.owner,{expectedVersion:1,requestId:randomUUID(),intent:'purchase',requirementDraft:{...draft(),budget:{maxMinor:19000,scope:'delivered'}}});return q};await assert.rejects(s.prepare(),{code:'STALE_VERSION'});assert.equal(s.repo.db.prepare('SELECT count(*) n FROM sandbox_plans').get().n,0)
 const b=await setup(t);b.authorize();const v=await b.prepare();const q=v.purchases[0].quote;signedExpiry(b,q,v.purchases[0].plan.planId);await assert.rejects(b.execute(v),{code:'QUOTE_EXPIRED'});assert.equal(b.payment.confirms,0)
})
function signedExpiry(s,q,id){s.repo.db.prepare('UPDATE sandbox_plans SET quote=? WHERE id=?').run(JSON.stringify({...q,expiresAt:Date.now()-1}),id)}
test('checkout: confirmed hold cannot survive changed quote/authorization; unknown old transaction blocks replacement',async t=>{
 const s=await setup(t);s.authorize({singleSoftMinor:10000});const v=await s.prepare();await s.execute(v);const confirmation=s.risk.view(s.owner).confirmations[0];new ConfirmationService(s.risk,currentTaskResolver(s.main)).respond(s.owner,confirmation.confirmationId,true);s.auth.revoke(s.owner,1,randomUUID());assert.equal((await s.execute(v)).purchases[0].operation.paymentStatus,'not_started');assert.equal(s.payment.confirms,0)
 const b=await setup(t);b.authorize();const first=await b.prepare();b.payment.onCreate=async()=>{throw Error('unknown transport')};assert.equal((await b.execute(first)).purchases[0].operation.paymentStatus,'unknown');await b.agent.save(b.task.taskId,b.owner,{requestId:randomUUID(),expectedVersion:1,intent:'purchase',requirementDraft:{...draft(),budget:{maxMinor:19000,scope:'delivered'}}});await assert.rejects(b.bridge.prepare(b.task.taskId,b.owner,{expectedVersion:2,requestId:randomUUID(),candidateId:candidateId(b.searched.shoppingResult.candidates[0])}),{code:'PRIOR_PAYMENT_UNRESOLVED'})
})
test('checkout: database restart recovers Shopping evidence, authorization, quote, operation and payment',async t=>{
 const s=await setup(t);s.authorize();const v=await s.prepare(),done=await s.execute(v);const repo=s.trackRepo(new SqlitePurchaseRepository(s.path));const main=new SqliteTaskRepository(repo.db),bridge=new PurchaseBridge(main,repo,new DemoMerchantAdapter(repo),s.payment),risk=new RiskRepository(repo);const restored=bridge.state(s.task.taskId,s.owner);assert.deepEqual(restored.purchases[0].plan,done.purchases[0].plan);assert.equal(restored.purchases[0].operation.paymentId,done.purchases[0].operation.paymentId);assert.equal(risk.current(s.owner).version,1);assert.equal(risk.view(s.owner).reservations[0].state,'spent')
})
test('checkout HTTP accepts only candidate identity, never price/merchant/credentials',async t=>{
 const s=await setup(t),token='abc-def';s.main.sessions.add(token);const http=bridgeHttp(s.bridge,s.main);for(const extra of [{amountMinor:1},{merchantUrl:'http://bad'},{paymentMethod:'arbitrary'}]){const r=await http(new Request('http://local/api/agent/purchases/prepare',{method:'POST',headers:{cookie:`deepsleep_demo=${token}`,origin:'http://local','content-type':'application/json'},body:JSON.stringify({taskId:s.task.taskId,expectedVersion:1,requestId:randomUUID(),candidateId:candidateId(s.searched.shoppingResult.candidates[0]),...extra})}),'prepare');assert.equal(r.status,400)}assert.equal(s.payment.creates,0)
 const body={taskId:s.task.taskId,expectedVersion:1,requestId:randomUUID(),candidateId:candidateId(s.searched.shoppingResult.candidates[0])};const prepared=await http(new Request('http://local/api/agent/purchases/prepare',{method:'POST',headers:{cookie:`deepsleep_demo=${token}`,origin:'http://local','content-type':'application/json'},body:JSON.stringify(body)}),'prepare');assert.equal(prepared.status,200);assert.equal((await prepared.json()).checkoutPreparation.status,'result_ready');assert.equal(s.payment.creates,0)
})
test('checkout: accepted soft exception cannot authorize a changed quote or task version',async t=>{
 for(const change of ['quote','task']){const s=await setup(t);s.authorize({singleSoftMinor:10000});const v=await s.prepare();await s.execute(v);const confirmation=s.risk.view(s.owner).confirmations[0];new ConfirmationService(s.risk,currentTaskResolver(s.main)).respond(s.owner,confirmation.confirmationId,true)
 if(change==='quote'){const q=v.purchases[0].quote;s.repo.db.prepare('UPDATE sandbox_plans SET quote=? WHERE id=?').run(JSON.stringify({...q,quoteId:randomUUID(),totalMinor:18000,itemSubtotalMinor:17000}),v.purchases[0].plan.planId);assert.equal((await s.execute(v)).purchases[0].operation.errorCode,'QUOTE_MISMATCH')}
 else {await s.agent.save(s.task.taskId,s.owner,{expectedVersion:1,requestId:randomUUID(),intent:'purchase',requirementDraft:{...draft(),budget:{maxMinor:19000,scope:'delivered'}}});await assert.rejects(s.execute(v),{code:'STALE_VERSION'})}
 assert.equal(s.payment.confirms,0)}
})
test('checkout: current requirement is checked again after PaymentIntent creation',async t=>{
 const s=await setup(t);s.authorize();const v=await s.prepare();s.payment.onCreate=()=>s.agent.save(s.task.taskId,s.owner,{expectedVersion:1,requestId:randomUUID(),intent:'compare',requirementDraft:draft()});const result=await s.execute(v);assert.equal(result.purchases[0].operation.paymentStatus,'requires_confirmation');assert.equal(s.payment.confirms,0);assert.equal(s.risk.view(s.owner).reservations[0].state,'released')
})
