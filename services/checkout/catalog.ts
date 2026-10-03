import type { RawProduct, ProductProvider } from "../product-provider"
import type { ContractBPolicy } from "../../types"
export const CHECKOUT_PRODUCT = {
  productId: "demo-shopping-lotion", skuId: "demo-shopping-lotion-200ml", referenceOfferId: "demo-reference-lotion-v1",
  title: "DEEPSLEEP DEMO LOTION 200ML", category: "沙盒目录乳液", merchantId: "demo-merchant" as const,
  unitMinor: 16000, shippingMinor: 1000, discountMinor: 0, otherFeesMinor: 0,
  referenceUrl: "https://example.com/deepsleep/demo-shopping-lotion", catalogVersion: "demo-catalog-v1",
}
export const SUPPORTED_PRODUCT_IDS = ["sandbox-lotion", CHECKOUT_PRODUCT.productId]
export const SUPPORTED_MERCHANT_IDS = ["demo-merchant"]
export const SUPPORTED_PAYMENT_METHODS = ["stripe_test_card"]
export const checkoutPolicy = (): ContractBPolicy => ({policyVersion:"demo-checkout-b-v1",dataEnvironment:"development_mock",merchantAllowlist:[{id:"demo-merchant",platformId:"deepsleep-demo"}],priceBenchmarks:[],offerTtlMs:300000,staticTtlMs:86400000})
// Independent, explicitly fictional catalogue. Never refresh Watsons facts using this fixture.
export class CheckoutCatalogProvider implements ProductProvider {
  async recall(_hint:string,limit:number,context:Parameters<ProductProvider["recall"]>[2]) {
    context.signal.throwIfAborted()
    const c=CHECKOUT_PRODUCT
    const product:RawProduct={productId:c.productId,skuId:c.skuId,offerId:c.referenceOfferId,title:c.title,url:c.referenceUrl,category:c.category,
      source:"mock-dataset",fetchedAt:new Date().toISOString(),status:"mock",attributes:{volumeMl:200,brand:"DeepSleep Demo"},
      searchableText:{description:"Fictional demonstration lotion 200ml",ingredients:null},
      offer:{currency:"HKD",itemPriceMinor:c.unitMinor,shippingMinor:null,discountMinor:null,stock:null,deliverable:null}}
    return {products:[product].slice(0,limit),status:"complete" as const,warnings:["完整演示目录的商品身份与容量为测试数据；成分和功效未知；不是 Watsons 商品。"]}
  }
}
