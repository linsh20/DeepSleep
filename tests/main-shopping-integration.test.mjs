import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import ts from 'typescript'
const req=createRequire(import.meta.url)
req.extensions['.ts']=(m,p)=>m._compile(ts.transpileModule(readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,p)
const {ContractShoppingPort,deriveSearchInput,watsonsPolicy}=req('../services/main-agent/shopping-adapter.ts')
const {validateContractResult}=req('../services/main-agent/shopping-result.ts')
const {createProductSearch}=req('../services/product-search.ts')
const {WatsonsSqliteProductProvider}=req('../services/watsons-product-provider.ts')
const {DeterministicConditionScorer,OpenAICompatibleConditionScorer}=req('../services/condition-scorer.ts')
const {MainTaskOrchestrator}=req('../services/main-agent/orchestrator.ts')
const {MemoryTaskRepository}=req('../services/main-agent/task-repository.ts')
const {DevelopmentRequirementInterpreter}=req('../services/main-agent/requirement-interpreter.ts')
const {SqliteTaskRepository}=req('../services/main-agent/sqlite-repository.ts')
const {SqlitePurchaseRepository}=req('../services/purchase-execution/repository.ts')
const {sandboxSource}=req('../services/purchase-bridge/service.ts')
const requirement=()=>({taskId:'integration-main',requirementVersion:1,category:'乳液',query:'乳液',currency:'HKD',destination:'香港',budget:{maxMinor:20000,scope:'delivered'},hardConstraints:[{id:'min',field:'attributes.volumeMl',op:'gte',value:100},{id:'max',field:'attributes.volumeMl',op:'lte',value:300}],preferences:[{id:'moisture',field:'text.searchable',weight:1,source:'explicit',conditions:[{field:'text.searchable',op:'containsAny',value:['保湿']}]}],excludedProductIds:[]})
const fact=value=>({value,source:'mock-dataset',status:'mock',fetchedAt:new Date().toISOString()})
const row=()=>({productId:'mock-p',skuId:'mock-s',offerId:'mock-o',title:'Hydrating Lotion 200ml',url:'https://example.test/lotion',category:'lotion',source:'mock-dataset',status:'mock',fetchedAt:new Date().toISOString(),searchableText:{description:'hydrating moisturizing lotion',ingredients:'water'},attributes:{volumeMl:200},offer:{currency:'HKD',itemPriceMinor:17000,shippingMinor:null,discountMinor:null,stock:'available',deliverable:null}})
const policy=()=>({...watsonsPolicy(),dataEnvironment:'development_mock',merchantAllowlist:[{id:'demo',platformId:'test'}]})
const mockSearch=()=>createProductSearch({recall:async()=>({products:[row()],status:'complete'})},new DeterministicConditionScorer()).searchProducts
async function verify({requirement:r,quantity,candidates}) {return {taskId:r.taskId,requirementVersion:r.requirementVersion,status:'complete',warnings:[],candidates:candidates.map(c=>({...c,merchant:{id:'demo',name:fact('Test merchant'),platformId:fact('test')},offer:{...c.offer,shippingMinor:fact(1000),discountMinor:fact(0),deliverable:fact(true)},quote:{quantity,destination:r.destination,totalMinor:fact(17000*quantity+1000),otherFeesMinor:fact(0),estimatedDeliveryAtMs:fact(null),canFulfillQuantity:fact(true)},missingFields:[]}))}}
const signal=()=>new AbortController().signal
const port=(search=mockSearch(),extra={verifyFacts:verify},p=policy())=>new ContractShoppingPort({searchProducts:search,...extra},p)

test('Chinese requirement derives traced English input, hard/soft groups and no unsafe unit budget',()=>{
 const r=requirement();r.hardConstraints.push({field:'text.searchable',op:'notContainsAny',value:['香精']},{field:'attributes.shade',op:'eq',value:'02'});const before=structuredClone(r);const x=deriveSearchInput(r)
 assert.equal(x.searchInput.product_name.value,'lotion');assert.deepEqual(x.searchInput.range_conditions,[{field:'volumeMl',min:100,max:300,must:1}]);assert.equal(x.searchInput.include_keywords[0].must,0);assert.equal(x.searchInput.exclude_keywords[0].must,1);assert.ok(x.searchInput.exclude_keywords[0].keywords.includes('parfum'));assert.ok(x.translation.retainedForB.includes('attributes.shade:eq'));assert.deepEqual(r,before)
})
test('real Watsons snapshot reaches Main contract with candidates, evidence and unknown checkout; no broad category equivalence',async()=>{
 const p=port(createProductSearch(new WatsonsSqliteProductProvider(),new DeterministicConditionScorer(),{recallLimit:500}).searchProducts,{},watsonsPolicy());const r=requirement();const output=await p.search({requirement:r,quantity:1},signal());const v=validateContractResult(output)
 assert.equal(v.status,'needs_verification');assert.ok(v.search.candidates.length>0);assert.ok(v.candidates.every(c=>/lotion|emulsion/i.test(c.title)));assert.ok(v.missingFacts.includes('offer.shippingMinor'));assert.ok(v.missingFacts.includes('merchant.platformId'));assert.equal(v.recommendations.length,0);assert.equal(v.dataEnvironment,'verified_sources');assert.ok(v.diagnostics.candidateChecks.every(a=>a.checks.find(c=>c.conditionId==='system:category').outcome!=='match'));assert.ok(v.candidates.every(c=>c.offer.itemPriceMinor.source==='watsons-hk-api-snapshot'));assert.deepEqual(v.decisionRecord.requestSnapshot.requirement,r)
 const dir=process.env.INTEGRATION_EVIDENCE_DIR;if(dir)writeFileSync(join(dir,'watsons-result.json'),JSON.stringify({input:{requirement:r,quantity:1},output:v},null,2))
})
test('multi-platform offers reach Main and Agent B with stable identities and platform facts',async()=>{
 const provider=new WatsonsSqliteProductProvider({databasePath:'data/watson/data/products.demo-multiplatform.db'})
 const search=createProductSearch(provider,new DeterministicConditionScorer(),{recallLimit:500}).searchProducts
 const shopping=new ContractShoppingPort({searchProducts:search},watsonsPolicy())
 for(const [category,query,productId] of [
  ['Moisturizer','BIRCH JUICE MOISTURIZING CREAM 80ml','watsons-product:BP_119795'],
  ['Toner','LIGHTENING AND MOISTURIZING TONER 120ML','watsons-product:BP_235677'],
 ]) {
  const r={...requirement(),category,query,hardConstraints:[],preferences:[]}
  const result=validateContractResult(await shopping.search({requirement:r,quantity:1},signal()))
  const offers=result.candidates.filter(c=>c.productId===productId)
  assert.equal(offers.length,3)
  assert.equal(new Set(offers.map(c=>c.skuId)).size,1)
  assert.equal(new Set(offers.map(c=>c.offerId)).size,3)
  assert.deepEqual(new Set(offers.map(c=>c.merchant.platformId.value)),new Set(['watsons-hk','sasa-hk','mannings-hk']))
  assert.ok(offers.every(c=>!c.missingFields.includes('merchant')))
  assert.ok(offers.every(c=>c.merchant.name.value && c.offer.itemPriceMinor.value>0))
  assert.equal(result.status,'needs_verification')
  assert.ok(result.missingFacts.includes('offer.shippingMinor'))
  assert.equal(result.recommendations.length,0)
 }
})
test('complete mock quote runs actual A and contract B result_ready, original Chinese soft intent retained',async()=>{
 const r=requirement(),v=validateContractResult(await port().search({requirement:r,quantity:1},signal()));assert.equal(v.status,'result_ready');assert.equal(v.plan.priceMinor.value,18000);assert.equal(v.recommendations[0].evidenceStatus,'mock');assert.equal(v.recommendations[0].preferenceChecks[0].outcome,'match');assert.equal(v.dataEnvironment,'development_mock');assert.equal(v.searchInput.useLlm,false);assert.ok(v.decisionRecord);assert.ok(v.search.candidates[0].conditionScores.every(c=>c.source!=='llm'))
})
test('no-match, missing verification and source failure remain distinct; malformed nested facts rejected',async()=>{
 const r=requirement();r.query='nonexistent-special-product';assert.equal((await port().search({requirement:r,quantity:1},signal())).status,'no_match');const missing=await port(mockSearch(),{}).search({requirement:requirement(),quantity:1},signal());assert.equal(missing.status,'needs_verification');const failed=await port(async()=>{throw Error('offline')}).search({requirement:requirement(),quantity:1},signal());assert.equal(failed.status,'failed');assert.equal(failed.stopReason,'source_failed');missing.candidates[0].offer.itemPriceMinor.status='trusted';assert.throws(()=>validateContractResult(missing),{code:'INVALID_INPUT'})
})
test('main persisted versions update actual port input, keep history, dedupe and reject Watsons payment bridge',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'main-shopping-'));const db=new SqlitePurchaseRepository(join(dir,'isolated.sqlite'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})});const repo=new SqliteTaskRepository(db.db);let calls=0;const inputs=[];const a=mockSearch();const p=port(async(i,c)=>{calls++;inputs.push(structuredClone(i));return a(i,c)});const agent=new MainTaskOrchestrator(repo,new DevelopmentRequirementInterpreter(),p,{timeoutMs:2000,retries:0});let n=0;const id=()=>`request-${++n}`;let task=await agent.create('owner',id());const {taskId,requirementVersion,...draft}=requirement();void taskId;void requirementVersion;
 task=await agent.save(task.taskId,'owner',{requestId:id(),expectedVersion:0,intent:'purchase',requirementDraft:{...draft,quantity:1}});let requestId=id();task=await agent.search(task.taskId,'owner',requestId,1);assert.equal(task.status,'result_ready');await agent.search(task.taskId,'owner',requestId,1);assert.equal(calls,1)
 const updated={...task.requirementDraft,budget:{maxMinor:18000,scope:'delivered'},hardConstraints:[{field:'attributes.volumeMl',op:'gte',value:200},{field:'attributes.volumeMl',op:'lte',value:300},{field:'text.searchable',op:'notContainsAny',value:['香精']}]};task=await agent.save(task.taskId,'owner',{requestId:id(),expectedVersion:1,intent:'purchase',requirementDraft:updated});assert.equal(task.shoppingHistory.length,1);assert.equal(task.shoppingResult,null);task=await agent.search(task.taskId,'owner',id(),2);assert.equal(inputs[1].range_conditions[0].min,200);assert.ok(inputs[1].exclude_keywords.length);assert.equal(inputs[1].requirementVersion,2);assert.equal(task.shoppingResult.decisionRecord.requestSnapshot.requirement.budget.maxMinor,18000);assert.throws(()=>sandboxSource(task),{code:'NEEDS_VERIFICATION'});const reopened=new SqliteTaskRepository(db.db);assert.equal(reopened.get(task.taskId,'owner').shoppingHistory[0].result.kind,'shopping_contract_v1')
})
test('outer cancellation reaches provider and prevents retries or late scoring',async()=>{
 let cancelled=false,scored=0,calls=0;const provider={recall:(_q,_l,c)=>new Promise((_res,reject)=>{calls++;c.signal.addEventListener('abort',()=>{cancelled=true;reject(Error('aborted'))},{once:true})})};const a=createProductSearch(provider,{kind:'llm',scoreCandidate:async()=>{scored++;return []}}).searchProducts;const controller=new AbortController();const pending=port(a).search({requirement:requirement(),quantity:1},controller.signal);setTimeout(()=>controller.abort(),10);await assert.rejects(pending);await new Promise(r=>setTimeout(r,20));assert.equal(cancelled,true);assert.equal(calls,1);assert.equal(scored,0)
})
test('outer cancellation aborts scoring requests and does not start queued candidates',async()=>{
 let calls=0,aborts=0;const products=Array.from({length:5},(_,i)=>({...row(),productId:`p${i}`,skuId:`s${i}`,offerId:`o${i}`}));const a=createProductSearch({recall:async()=>({products,status:'complete'})},{kind:'llm',scoreCandidate:(_i,c)=>new Promise((_r,reject)=>{calls++;c.signal.addEventListener('abort',()=>{aborts++;reject(Error('aborted'))},{once:true})})},{scorerConcurrency:2}).searchProducts;const p=new ContractShoppingPort({searchProducts:a},policy(),true);const c=new AbortController(),pending=p.search({requirement:requirement(),quantity:1},c.signal);setTimeout(()=>c.abort(),15);await assert.rejects(pending);await new Promise(r=>setTimeout(r,20));assert.equal(calls,2);assert.equal(aborts,2)
})
test('LLM scoring separately uses actual scorer protocol with controlled HTTP; request signal is passed to fetch',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let count=0;globalThis.fetch=async(_url,options)=>{count++;assert.ok(options.signal instanceof AbortSignal);const body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content);return Response.json({choices:[{message:{content:JSON.stringify({scores:Object.fromEntries(input.conditions.map(c=>[c.id,5]))})}}]})};const scorer=new OpenAICompatibleConditionScorer({endpoint:'https://model.test/chat/completions',model:'controlled',apiKey:'fixture-only'});const a=createProductSearch({recall:async()=>({products:[row()],status:'complete'})},scorer).searchProducts;const p=new ContractShoppingPort({searchProducts:a,verifyFacts:verify},policy(),true);const v=await p.search({requirement:requirement(),quantity:1},signal());assert.equal(count,1);assert.equal(v.search.candidates[0].llmAverageScore,5);assert.ok(v.search.candidates[0].conditionScores.some(s=>s.source==='llm'));assert.equal(v.status,'result_ready')
})
test('stale service envelopes and late main results never replace current requirement',async()=>{
 const a=mockSearch();await assert.rejects(port(async(i,c)=>({...await a(i,c),requirementVersion:999})).search({requirement:requirement(),quantity:1},signal()));let release,entered;const started=new Promise(r=>entered=r);const slow=port(async(i,c)=>{entered();await new Promise(r=>release=r);return a(i,c)});const repo=new MemoryTaskRepository(),agent=new MainTaskOrchestrator(repo,new DevelopmentRequirementInterpreter(),slow,{timeoutMs:2000,retries:0});let t=await agent.create('owner','create-late');const {taskId,requirementVersion,...draft}=requirement();void taskId;void requirementVersion;t=await agent.save(t.taskId,'owner',{requestId:'save-late-1',expectedVersion:0,intent:'compare',requirementDraft:{...draft,quantity:1}});const pending=agent.search(t.taskId,'owner','search-late',1);await started;await agent.save(t.taskId,'owner',{requestId:'save-late-2',expectedVersion:1,intent:'compare',requirementDraft:{...draft,quantity:1,budget:{maxMinor:19000,scope:'delivered'}}});release();await pending;const latest=agent.get(t.taskId,'owner');assert.equal(latest.requirementVersion,2);assert.equal(latest.shoppingResult,null)
})
test('end-to-end Chinese dialogue: model-schema clarification -> Watsons -> versioned edits (controlled model only)',async()=>{
 const {ModelRequirementInterpreter}=req('../services/main-agent/model-interpreter.ts')
 const wire=(patch,evidence,intentEvidence=null)=>JSON.stringify({intent:'compare',intentEvidence,requirementDraft:patch,evidence,missingFields:[],clarificationQuestions:[]})
 const range=(min)=>[{field:'attributes.volumeMl',op:'gte',value:min},{field:'attributes.volumeMl',op:'lte',value:300}]
 const outputs=[wire({category:'乳液'},{category:'乳液'},'比较'),wire({quantity:1,currency:'HKD',destination:'香港',budget:{amountHKD:'200',scope:'delivered'},hardConstraints:[{field:'attributes.volumeMl',replace:range(100)}],preferences:[{field:'text.searchable',replace:[{field:'text.searchable',weight:1,source:'explicit',conditions:[{field:'text.searchable',op:'containsAny',value:['保湿']}]}]}]},{quantity:'1件',currency:'港币',destination:'香港','budget.amountHKD':'总预算200港币','budget.scope':'含运费',hardConstraints:'100到300ml',preferences:'希望保湿'}),wire({budget:{amountHKD:'180'},hardConstraints:[{field:'attributes.volumeMl',replace:range(200)},{field:'text.searchable',replace:[{field:'text.searchable',op:'notContainsAny',value:['香精']}]}]},{'budget.amountHKD':'预算改成180',hardConstraints:'容量改成200到300ml，预算改成180，排除含香精的商品'})]
 const a=createProductSearch(new WatsonsSqliteProductProvider(),new DeterministicConditionScorer(),{recallLimit:500}).searchProducts
 const agent=new MainTaskOrchestrator(new MemoryTaskRepository(),new DevelopmentRequirementInterpreter(),port(a,{},watsonsPolicy()),{retries:0,timeoutMs:2000,modelInterpreter:new ModelRequirementInterpreter(async()=>outputs.shift())})
 let task=await agent.create('dialogue-owner','dialogue-create'),i=0;const transcript=[]
 for(const message of ['比较乳液','1件，100到300ml，总预算200港币含运费，配送香港，希望保湿。','容量改成200到300ml，预算改成180，排除含香精的商品。']) {
  task=await agent.message(task.taskId,'dialogue-owner',{requestId:`dialogue-${++i}`,expectedVersion:task.requirementVersion,message});transcript.push({message,reply:task.messages.at(-1).content,status:task.status,version:task.requirementVersion,searchInput:task.shoppingResult?.searchInput,candidateCount:task.shoppingResult?.candidates?.length??0})
 }
 assert.equal(transcript[0].status,'needs_clarification');assert.equal(transcript[1].status,'needs_verification');assert.ok(transcript[1].candidateCount>0);assert.equal(task.requirementDraft.budget.maxMinor,18000);assert.equal(task.shoppingResult.searchInput.range_conditions[0].min,200);assert.ok(task.shoppingResult.searchInput.exclude_keywords[0].keywords.includes('fragrance'));assert.equal(task.shoppingHistory.length,1)
 if(process.env.INTEGRATION_EVIDENCE_DIR)writeFileSync(join(process.env.INTEGRATION_EVIDENCE_DIR,'dialogue.json'),JSON.stringify({model:'controlled transport, not live model',transcript},null,2))
})
