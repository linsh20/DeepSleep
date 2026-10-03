import { CHECKOUT_PRODUCT, CheckoutCatalogProvider, checkoutPolicy } from "../checkout/catalog"
import { createShoppingAgent, type ShoppingDependencies } from "../shopping-agent"
import { createProductSearch } from "../product-search"
import { WatsonsSqliteProductProvider } from "../watsons-product-provider"
import { DeterministicConditionScorer, createConfiguredConditionScorer } from "../condition-scorer"
import type { Constraint, ContractBPolicy, Requirement, StructuredSearchInput } from "../../types"
import type { ShoppingPort, ShoppingPortInput, ShoppingPortResult } from "./shopping-port"
import { TaskError } from "./types"

// Reviewed lexical equivalences only. No model-generated taxonomy or brand translation.
export const SEARCH_ALIASES: Record<string, string[]> = {
  "乳液": ["lotion", "emulsion"], "爽肤水": ["toner"], "爽膚水": ["toner"],
  "精华": ["serum"], "精華": ["serum"], "面霜": ["face cream", "facial cream"],
  "保湿": ["moisturizing", "moisturising", "hydrating"], "保濕": ["moisturizing", "moisturising", "hydrating"],
  "香精": ["fragrance", "parfum"],
}
export type SearchTranslation = { dictionaryVersion: "en-hk-v1"; originalQuery: string; originalCategory: string; mappings: { original: string; aliases: string[] }[]; retainedForB: string[]; warnings: string[] }
export function deriveSearchInput(requirement: Requirement, useLlm = false): { searchInput: StructuredSearchInput; translation: SearchTranslation } {
  const r = requirement
  const translation: SearchTranslation = { dictionaryVersion: "en-hk-v1", originalQuery: r.query, originalCategory: r.category, mappings: [], retainedForB: [], warnings: ["整单预算保留给 B 按数量和报价审核，不转换为召回单价上限。"] }
  const aliases = (text: string) => {
    const key = text.normalize("NFKC").trim()
    const list = Object.hasOwn(SEARCH_ALIASES,key) ? SEARCH_ALIASES[key] : []
    if (list.length) translation.mappings.push({ original: text, aliases: [...list] })
    return [text, ...list]
  }
  const names = aliases(r.query)
  const searchInput: StructuredSearchInput = { taskId:r.taskId,requirementVersion:r.requirementVersion,useLlm,
    product_name:{value:names[1] ?? names[0],aliases:names.filter(x => x !== (names[1] ?? names[0])),must:1},range_conditions:[],include_keywords:[],exclude_keywords:[] }
  if (/[\u3400-\u9fff]/u.test(r.query) && names.length === 1) translation.warnings.push("品名不在已审阅英文词表中：保留原词，不猜测其他商品；可明确提供英文品名。")
  const map = (conditions: Constraint[], must: 0 | 1) => {
    let min: number | null = null, max: number | null = null
    for (const c of conditions) {
      if (c.field === "attributes.volumeMl" && typeof c.value === "number" && Number.isSafeInteger(c.value) && ["gte","lte","eq"].includes(c.op)) {
        if (c.op !== "lte") min = Math.max(min ?? -Infinity,c.value)
        if (c.op !== "gte") max = Math.min(max ?? Infinity,c.value)
      } else if (c.field === "text.searchable" && Array.isArray(c.value) && ["containsAny","notContainsAny"].includes(c.op)) {
        const words = [...new Set(c.value.flatMap(aliases))]
        if (words.length <= 20) (c.op === "containsAny" ? searchInput.include_keywords : searchInput.exclude_keywords).push({keywords:words,must,scope:"all"})
        else translation.retainedForB.push(c.id ?? `${c.field}:${c.op}`)
      } else translation.retainedForB.push(c.id ?? `${c.field}:${c.op}`)
    }
    if (min !== null || max !== null) searchInput.range_conditions.push({field:"volumeMl",min,max,must})
  }
  map(r.hardConstraints,1)
  for (const p of r.preferences) map(p.conditions ?? [],0)
  // Requirement is never translated/replaced; B retains every original condition and relative weight.
  return { searchInput, translation }
}
export const SHOPPING_TIMEOUT_MS = 20000
export function watsonsPolicy(): ContractBPolicy {
  return { policyVersion:"main-watsons-search-v1",searchOnly:true,dataEnvironment:"verified_sources",merchantAllowlist:[],priceBenchmarks:[],
    offerTtlMs:300000,staticTtlMs:86400000,
    categoryAliases:{"乳液":"lotion",lotion:"lotion",emulsion:"lotion","爽肤水":"toner","爽膚水":"toner","精华":"serum","精華":"serum"},
    textAliases:SEARCH_ALIASES,broadCategories:["Face Treatment", "Moisturizer"] }
}
export class ContractShoppingPort implements ShoppingPort {
  constructor(private dependencies: ShoppingDependencies, private policy: ContractBPolicy, private useLlm = false) {}
  async search(input: ShoppingPortInput, signal: AbortSignal): Promise<ShoppingPortResult> {
    signal.throwIfAborted()
    const derived = deriveSearchInput(input.requirement,this.useLlm)
    const result = await createShoppingAgent(this.dependencies,this.policy,{timeoutMs:SHOPPING_TIMEOUT_MS-1000,maxVerificationRounds:1})
      .runShoppingTask({...structuredClone(input),searchInput:derived.searchInput},{signal})
    signal.throwIfAborted()
    // Debug payloads are not a durable product/decision contract.
    if (result.search) delete result.search.debug
    result.diagnostics.warnings.push(...derived.translation.warnings,"搜索价格不是最终结账报价；推荐不构成授权。仅服务端登记的演示商品可另行准备模拟报价及 B 复核，Watsons 尚不支持。")
    return {...result,kind:"shopping_contract_v1",searchInput:derived.searchInput,translation:derived.translation}
  }
}
export function configuredShoppingPort(): ShoppingPort {
  const llm = process.env.SHOPPING_SCORING_MODE === "llm"
  if (llm && ![process.env.LLM_API_URL,process.env.LLM_MODEL,process.env.LLM_API_KEY].every(v=>v?.trim())) {
    return { async search() { throw new TaskError("INVALID_INPUT","Shopping 评分需要独立配置 LLM_API_URL、LLM_MODEL、LLM_API_KEY；未调用评分模型") } }
  }
  const scorer = llm ? createConfiguredConditionScorer() : new DeterministicConditionScorer()
  const search = createProductSearch(new WatsonsSqliteProductProvider(),scorer,{recallLimit:500,providerTimeoutMs:4000,scorerTimeoutMs:5000,scorerConcurrency:2,includeLlmDebug:false})
  const watsons = new ContractShoppingPort(search,watsonsPolicy(),llm)
  const demo = new ContractShoppingPort(createProductSearch(new CheckoutCatalogProvider(),new DeterministicConditionScorer()),checkoutPolicy(),false)
  return { search(input,signal) { return (input.requirement.category === CHECKOUT_PRODUCT.category && input.requirement.query === CHECKOUT_PRODUCT.title ? demo : watsons).search(input,signal) } }
}
