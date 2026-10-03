import { ProductSearch } from "@/components/product-search"

export default function Home() {
  return (
    <main className="min-h-screen bg-muted/40 p-6 md:p-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="text-3xl font-bold">DeepSleep 商品搜索</h1>
          <p className="mt-2 text-muted-foreground">从结构化条件到前十名候选，供后续授权验证依次检查。</p>
        </header>
        <ProductSearch />
      </div>
    </main>
  )
}
