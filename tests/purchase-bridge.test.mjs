import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import ts from 'typescript'
const requireTS=createRequire(import.meta.url)
requireTS.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f)
const {SqlitePurchaseRepository}=requireTS('../services/purchase-execution/repository.ts')
const {SqliteTaskRepository}=requireTS('../services/main-agent/sqlite-repository.ts')
const {MainTaskOrchestrator}=requireTS('../services/main-agent/orchestrator.ts')
const {DevelopmentRequirementInterpreter}=requireTS('../services/main-agent/requirement-interpreter.ts')
const {ShoppingStub}=requireTS('../services/main-agent/shopping-port.ts')
const {DemoMerchantAdapter}=requireTS('../services/purchase-execution/demo-merchant.ts')
const {RiskRepository}=requireTS('../services/risk-control/repository.ts')
const {AuthorizationService}=requireTS('../services/risk-control/authorization.ts')
const {PurchaseBridge}=requireTS('../services/purchase-bridge/service.ts')
const {bridgeHttp}=requireTS('../services/purchase-bridge/http.ts')
const {createAgentHttp}=requireTS('../services/main-agent/http.ts')
class Payment {
 creates=0;confirms=0;retrieves=0;states=new Map()
 configured(){return true} configurationId(){return 'test'}
 async create(op){this.creates++;const p={id:'pi_'+op.operationId.replaceAll('-',''),livemode:false,status:'requires_confirmation',amount:op.quote.totalMinor,currency:'hkd',operationId:op.operationId,orderId:op.orderId,planId:op.planId};this.states.set(p.id,p);await this.onCreate?.();return structuredClone(p)}
 async confirm(op){this.confirms++;const p=this.states.get(op.paymentId);p.status='succeeded';return structuredClone(p)}
 async retrieve(id){this.retrieves++;return structuredClone(this.states.get(id))}
 verifyWebhook(raw){return JSON.parse(raw)}
}
const draft=()=>({category:'沙盒测试乳液',query:'测试乳液 200ml',quantity:1,currency:'HKD',destination:'香港',budget:{maxMinor:20000,scope:'delivered'}})
async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'bridge-')),path=join(dir,'test.sqlite');const repo=new SqlitePurchaseRepository(path),main=new SqliteTaskRepository(repo.db),payment=new Payment(),merchant=new DemoMerchantAdapter(repo),bridge=new PurchaseBridge(main,repo,merchant,payment),agent=new MainTaskOrchestrator(main,new DevelopmentRequirementInterpreter(),new ShoppingStub());
 const extraRepos=[];t.after(()=>{for(const extra of extraRepos)extra.close();try{repo.close()}catch{}rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
 main.sessions.add('owner-token');const owner=main.owner('owner-token');
 // Explicit test authorization; historical bridge assertions remain unchanged.
 new AuthorizationService(new RiskRepository(repo)).save(owner,{startsAt:Date.now()-1000,expiresAt:Date.now()+3600000,singleSoftMinor:20000,singleHardMinor:20000,monthlySoftMinor:100000,monthlyHardMinor:100000,productIds:['sandbox-lotion'],merchantIds:['demo-merchant'],paymentMethods:['stripe_test_card']},0,randomUUID(),true);
 const created=await agent.create(owner,randomUUID());const task=await agent.save(created.taskId,owner,{requestId:randomUUID(),expectedVersion:0,intent:'purchase',requirementDraft:draft()});
 const change=(input={},intent='purchase')=>agent.save(task.taskId,owner,{requestId:randomUUID(),expectedVersion:main.get(task.taskId,owner).requirementVersion,intent,requirementDraft:{...draft(),...input}})
 const prepare=()=>bridge.prepare(task.taskId,owner,{requestId:randomUUID(),expectedVersion:main.get(task.taskId,owner).requirementVersion})
 const execute=v=>bridge.execute(task.taskId,owner,{planId:v.purchases[0].plan.planId,expectedVersion:v.requirementVersion,requestId:randomUUID(),testPermission:true})
 return {dir,path,repo,main,payment,merchant,bridge,agent,owner,task,change,prepare,execute,trackRepo:extra=>{extraRepos.push(extra);return extra}}
}
test('bridge: prepare never pays, same main task IDs, duplicate/concurrent executions pay once, GET is read only',async t=>{
 const s=await setup(t);const [a,b]=await Promise.all([s.prepare(),s.prepare()]);assert.equal(a.purchases[0].plan.planId,b.purchases[0].plan.planId);assert.equal(a.purchases[0].plan.taskId,s.task.taskId);assert.equal(s.payment.creates,0)
 await Promise.all([s.execute(a),s.execute(b)]);const done=await s.execute(a);assert.equal(s.payment.creates,1);assert.equal(s.payment.confirms,1);assert.equal(done.purchases[0].operation.paymentStatus,'succeeded');assert.equal(done.purchases[0].order.status,'confirmed');const n=s.payment.retrieves;s.bridge.state(s.task.taskId,s.owner);assert.equal(n,s.payment.retrieves)
})
test('bridge: compare and foreign owners/plans rejected',async t=>{
 const s=await setup(t),v=await s.prepare(),plan=v.purchases[0].plan.planId
 assert.throws(()=>s.bridge.state(s.task.taskId,'foreign'),{code:'NOT_FOUND'})
 await assert.rejects(s.bridge.execute(s.task.taskId,'foreign',{planId:plan,requestId:randomUUID(),expectedVersion:1,testPermission:true}),{code:'NOT_FOUND'})
 await assert.rejects(s.bridge.execute(s.task.taskId,s.owner,{planId:'foreign',requestId:randomUUID(),expectedVersion:1,testPermission:true}),{code:'NOT_FOUND'})
 await s.change({},'compare');await assert.rejects(s.prepare(),{code:'COMPARE_NOT_EXECUTABLE'});await assert.rejects(s.execute(v),{code:'COMPARE_NOT_EXECUTABLE'});assert.equal(s.payment.creates,0)
})
test('bridge: changing budget invalidates unexecuted plan',async t=>{const s=await setup(t),v=await s.prepare();await s.change({budget:{maxMinor:19000,scope:'delivered'}});await assert.rejects(s.execute(v),{code:'STALE_VERSION'});assert.equal(s.payment.creates,0);assert.equal(s.bridge.state(s.task.taskId,s.owner).purchases[0].stale,true)})
test('bridge: task changed while creating PI is re-read before confirmation',async t=>{const s=await setup(t),v=await s.prepare();s.payment.onCreate=()=>s.change({budget:{maxMinor:19000,scope:'delivered'}});const result=await s.execute(v);assert.equal(s.payment.creates,1);assert.equal(s.payment.confirms,0);assert.equal(result.purchases[0].operation.errorCode,'STALE_VERSION');assert.equal(result.purchases[0].operation.paymentStatus,'requires_confirmation')})
test('bridge: successful historical payment survives requirement removal/compare; merchant failure remains separate',async t=>{const s=await setup(t),v=await s.prepare();s.merchant.confirm=async()=>{throw Error('merchant offline')};const paid=await s.execute(v);assert.equal(paid.purchases[0].operation.paymentStatus,'succeeded');assert.equal(paid.purchases[0].order.status,'confirmation_failed');await s.change({query:''},'compare');const history=s.bridge.state(s.task.taskId,s.owner);assert.equal(history.purchases[0].operation.paymentId,paid.purchases[0].operation.paymentId);assert.equal(history.purchases[0].operation.paymentStatus,'succeeded');assert.equal(history.purchases[0].stale,true);await s.bridge.recover(s.task.taskId,s.owner,v.purchases[0].plan.planId);assert.equal(s.payment.confirms,1)})
test('bridge: unsupported hard constraints, preferences, unknown query and excluded product stop preparation',async t=>{const s=await setup(t);for(const patch of [{hardConstraints:[{field:'attributes.brand',op:'eq',value:'A'}]},{preferences:[{field:'text.searchable',weight:1,source:'explicit',conditions:[{field:'text.searchable',op:'containsAny',value:['保湿']}]}]},{query:'真实乳液'},{excludedProductIds:['sandbox-lotion']}]){await s.change(patch);await assert.rejects(s.prepare(),e=>['NEEDS_VERIFICATION','NO_MATCH'].includes(e.code))}assert.equal(s.payment.creates,0);assert.equal(s.repo.db.prepare('SELECT count(*) n FROM main_purchase_links').get().n,0)})
test('bridge: task/session/request/links/payments restore across SQLite reopen without CLI reassignment',async t=>{
 const s=await setup(t),v=await s.prepare(),paid=await s.execute(v),requestId=randomUUID();const replay=await s.agent.create(s.owner,requestId);s.repo.close();const repo=s.trackRepo(new SqlitePurchaseRepository(s.path));const main=new SqliteTaskRepository(repo.db),agent=new MainTaskOrchestrator(main,new DevelopmentRequirementInterpreter(),new ShoppingStub()),bridge=new PurchaseBridge(main,repo,new DemoMerchantAdapter(repo),s.payment)
 assert.ok(main.sessions.has('owner-token'));assert.equal((await agent.create(s.owner,requestId)).taskId,replay.taskId);assert.equal(main.get(s.task.taskId,s.owner).requirementVersion,1);assert.equal(bridge.state(s.task.taskId,s.owner).purchases[0].operation.paymentId,paid.purchases[0].operation.paymentId)
 const cli=await bridge.execution.createFixture('local-stripe-smoke',randomUUID());assert.throws(()=>bridge.state(cli.task.taskId,s.owner),{code:'NOT_FOUND'});assert.equal(bridge.state(s.task.taskId,s.owner).purchases.length,1)
})
test('durable request claims survive restart and do not replay interrupted messages',async t=>{const s=await setup(t);let resolve;const held=s.main.once('claim','payload',()=>new Promise(r=>{resolve=r}));await Promise.resolve();const other=new SqliteTaskRepository(s.repo.db);await assert.rejects(other.once('claim','payload',async()=>{throw Error('must not run')}),{code:'REQUEST_PENDING'});await assert.rejects(other.once('claim','different',async()=>s.task),{code:'REQUEST_CONFLICT'});resolve(s.task);await held;assert.equal((await other.once('claim','payload',async()=>{throw Error('must not run')})).taskId,s.task.taskId)})
test('bridge HTTP rejects client authority/credentials and uses main server-issued session',async t=>{
 const s=await setup(t),agentHttp=createAgentHttp(s.agent,true,s.main.sessions),http=bridgeHttp(s.bridge,s.main)
 const session=await agentHttp(new Request('http://local/api/agent/session',{method:'POST',headers:{origin:'http://local','content-type':'application/json'},body:'{}'}),'session');const cookie=session.headers.get('set-cookie').split(';')[0];assert.equal(session.status,200)
 const request=body=>new Request('http://local/api/agent/purchases/prepare',{method:'POST',headers:{origin:'http://local','content-type':'application/json',cookie},body:JSON.stringify(body)})
 const valid={taskId:s.task.taskId,expectedVersion:1,requestId:randomUUID()}
 assert.equal((await http(request(valid),'prepare')).status,404)
 assert.equal((await http(request({...valid,userId:s.owner}),'prepare')).status,400)
 assert.equal((await http(request({...valid,amount:1,paymentMethod:'pm_any'}),'prepare')).status,400)
 assert.equal(s.payment.creates,0)
})
test('bridge: unknown payment prevents another version from masking it; explicit recovery preserves original ID',async t=>{
 const s=await setup(t),v=await s.prepare();s.payment.onCreate=async()=>{throw Error('transport interrupted')};const failed=await s.execute(v);assert.equal(failed.purchases[0].operation.paymentStatus,'unknown');await s.change({budget:{maxMinor:19000,scope:'delivered'}});await assert.rejects(s.prepare(),{code:'PRIOR_PAYMENT_UNRESOLVED'});assert.equal(s.payment.creates,1)
})
test('durable main repository preserves stale model guards across connections',async t=>{
 const s=await setup(t);let release;let entered;const started=new Promise(r=>{entered=r});const slow=new MainTaskOrchestrator(s.main,new DevelopmentRequirementInterpreter(),new ShoppingStub(),{modelInterpreter:{interpret:async()=>{entered();await new Promise(r=>{release=r});return {intent:'purchase',requirementDraft:draft(),missingFields:[],clarificationQuestions:[]}}}})
 const pending=slow.message(s.task.taskId,s.owner,{requestId:randomUUID(),expectedVersion:1,message:'预算200'});await started;const second=new SqliteTaskRepository(s.repo.db);second.update(s.task.taskId,s.owner,task=>{task.requirementVersion++;task.intent='compare'});release();const result=await pending;assert.equal(result.intent,'compare');assert.equal(result.messages.at(-1).errorCode,'MODEL_SUPERSEDED');assert.equal(result.requirementVersion,2)
})
