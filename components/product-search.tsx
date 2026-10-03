"use client"

import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import type { MustFlag, RankedSearchResult, StructuredSearchInput } from "@/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

export function ProductSearch() {
  const [productName, setProductName] = useState("lotion")
  const [volumeMin, setVolumeMin] = useState("100")
  const [volumeMax, setVolumeMax] = useState("300")
  const [priceMin, setPriceMin] = useState("100")
  const [priceMax, setPriceMax] = useState("300")
  const [includeMust, setIncludeMust] = useState("sensitive skin")
  const [includePrefer, setIncludePrefer] = useState("moisturizing, moisturising, hydration")
  const [excludeMust, setExcludeMust] = useState("alcohol, alcohol denat, ethanol")
  const [excludePrefer, setExcludePrefer] = useState("fragrance, parfum")
  const [result, setResult] = useState<RankedSearchResult | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const taskId = useRef<string | null>(null)
  const version = useRef(0)
  const active = useRef<AbortController | null>(null)

  useEffect(() => () => active.current?.abort(), [])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = parseInput()
    if (!parsed) return
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setPending(true)
    setError("")
    setResult(null)
    const timer = setTimeout(() => controller.abort(), 150000)
    void fetch("/api/products/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as RankedSearchResult
      if (controller !== active.current || parsed.requirementVersion !== version.current) return
      if (body.taskId !== parsed.taskId || body.requirementVersion !== parsed.requirementVersion ||
          !Array.isArray(body.candidates) || !Array.isArray(body.filterLogs) || !Array.isArray(body.warnings)) {
        throw new Error("Invalid response")
      }
      setResult(body)
      if (!response.ok && body.status !== "failed") throw new Error("Search failed")
    }).catch(() => {
      if (controller === active.current && parsed.requirementVersion === version.current) {
        setError(controller.signal.aborted ? "搜索请求超时，请重试。" : "无法连接商品搜索服务，请重试。")
      }
    }).finally(() => {
      clearTimeout(timer)
      if (controller === active.current && parsed.requirementVersion === version.current) setPending(false)
    })
  }

  function parseInput(): StructuredSearchInput | null {
    const volume = numericRange(volumeMin, volumeMax, 1)
    const price = numericRange(priceMin, priceMax, 100)
    if (!productName.trim() || !volume || !price) {
      setError("请填写有效品名、容量范围和最多两位小数的非负港币价格范围。")
      return null
    }
    taskId.current ??= crypto.randomUUID()
    const keywordGroup = (input: string, must: MustFlag, scope: "all" | "ingredients" = "all") => ({
      keywords: keywords(input),
      must,
      scope,
    })
    const searchInput: StructuredSearchInput = {
      taskId: taskId.current,
      requirementVersion: ++version.current,
      product_name: { value: productName.trim(), must: 1 },
      range_conditions: [
        { field: "volumeMl", ...volume, must: 1 },
        { field: "priceMinor", ...price, must: 0 },
      ],
      include_keywords: [keywordGroup(includeMust, 1), keywordGroup(includePrefer, 0)],
      exclude_keywords: [
        keywordGroup(excludeMust, 1, "ingredients"),
        keywordGroup(excludePrefer, 0, "ingredients"),
      ],
    }
    if ([...searchInput.include_keywords, ...searchInput.exclude_keywords].some((group) => group.keywords.length === 0)) {
      setError("每组关键词至少需要填写一个词。")
      return null
    }
    return searchInput
  }

  return (
    <section aria-label="结构化商品搜索" className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle><h2>结构化商品搜索</h2></CardTitle>
            <Badge variant="outline">Watsons en_HK 快照</Badge>
          </div>
          <CardDescription>硬条件由 TypeScript 筛选；条件满足度由 LLM 评分，未配置模型时使用可见的确定性降级。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-5">
            <Field label="商品品名（must）" value={productName} onChange={setProductName} />
            <div className="grid gap-4 md:grid-cols-2">
              <RangeFields label="容量（ml，must）" min={volumeMin} max={volumeMax} setMin={setVolumeMin} setMax={setVolumeMax} />
              <RangeFields label="价格（HKD，prefer）" min={priceMin} max={priceMax} setMin={setPriceMin} setMax={setPriceMax} step="0.01" />
              <Field label="必须包含（逗号分隔）" value={includeMust} onChange={setIncludeMust} />
              <Field label="希望包含（逗号分隔）" value={includePrefer} onChange={setIncludePrefer} />
              <Field label="成分必须排除（逗号分隔）" value={excludeMust} onChange={setExcludeMust} />
              <Field label="成分希望排除（逗号分隔）" value={excludePrefer} onChange={setExcludePrefer} />
            </div>
            <Button type="submit" disabled={pending}>{pending ? "搜索与排序中…" : "开始搜索"}</Button>
          </form>
        </CardContent>
      </Card>

      {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
      {result && <div className="space-y-5" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{result.message}</p>
          <Badge variant={result.status === "failed" ? "destructive" : "secondary"}>{result.status}</Badge>
        </div>
        <Card>
          <CardHeader><CardTitle>筛选日志</CardTitle></CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {result.filterLogs.map((log) => <li key={log.conditionId}>{log.message}{log.unknownCount > 0 ? `；${log.unknownCount} 种信息未知` : ""}</li>)}
            </ol>
          </CardContent>
        </Card>
        {result.warnings.length > 0 && <div role="alert" className="rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="font-medium">运行提示</p>
          <ul className="mt-2 list-inside list-disc">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>}
        <div className="grid gap-4 md:grid-cols-2">
          {result.candidates.map((item) => <Card key={`${item.candidate.productId}:${item.candidate.skuId}:${item.candidate.offerId}`}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div><CardTitle>#{item.rank} {item.candidate.title}</CardTitle><CardDescription>{item.candidate.category}</CardDescription></div>
                <Badge>{item.finalScore.toFixed(2)} / 5</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <dl className="grid grid-cols-2 gap-2">
                <div><dt className="text-muted-foreground">价格</dt><dd>{money(item.candidate.offer?.itemPriceMinor.value)}</dd></div>
                <div><dt className="text-muted-foreground">容量</dt><dd>{displayValue(item.candidate.attributes.volumeMl?.value, "ml")}</dd></div>
                <div><dt className="text-muted-foreground">评分</dt><dd>{displayValue(item.candidate.attributes.rating?.value, "/ 5")}</dd></div>
                <div><dt className="text-muted-foreground">销量</dt><dd>{displayValue(item.candidate.attributes.salesCount?.value, "")}</dd></div>
              </dl>
              {item.needsVerification.length > 0 && <p className="text-amber-700">待后续核验：{item.needsVerification.join("、")}</p>}
              <details><summary className="cursor-pointer text-muted-foreground">逐条件评分</summary>
                <ul className="mt-2 space-y-1">{item.conditionScores.map((score) => <li key={score.conditionId}>{score.conditionId}: {score.score}/5 — {score.reason}（{score.source}）</li>)}</ul>
              </details>
            </CardContent>
          </Card>)}
        </div>
      </div>}
    </section>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="space-y-2 text-sm font-medium"><span>{label}</span><Input value={value} onChange={(event) => onChange(event.target.value)} /></label>
}

function RangeFields({ label, min, max, setMin, setMax, step = "1" }: {
  label: string; min: string; max: string; setMin: (value: string) => void; setMax: (value: string) => void; step?: string
}) {
  return <fieldset className="space-y-2"><legend className="text-sm font-medium">{label}</legend><div className="grid grid-cols-2 gap-2">
    <Input aria-label={`${label}下限`} type="number" min="0" step={step} value={min} onChange={(event) => setMin(event.target.value)} />
    <Input aria-label={`${label}上限`} type="number" min="0" step={step} value={max} onChange={(event) => setMax(event.target.value)} />
  </div></fieldset>
}

function numericRange(min: string, max: string, multiplier: number): { min: number; max: number } | null {
  if (!/^\d+(\.\d{1,2})?$/.test(min) || !/^\d+(\.\d{1,2})?$/.test(max)) return null
  const parsed = { min: Math.round(Number(min) * multiplier), max: Math.round(Number(max) * multiplier) }
  return Number.isSafeInteger(parsed.min) && Number.isSafeInteger(parsed.max) && parsed.min <= parsed.max ? parsed : null
}

function keywords(input: string): string[] {
  return [...new Set(input.split(/[,，]/).map((item) => item.trim()).filter(Boolean))]
}

function money(input: number | null | undefined): string {
  return input == null ? "未知" : new Intl.NumberFormat("zh-HK", { style: "currency", currency: "HKD" }).format(input / 100)
}

function displayValue(input: string | number | boolean | null | undefined, unit: string): string {
  return input == null ? "未知" : `${String(input)}${unit ? ` ${unit}` : ""}`
}
