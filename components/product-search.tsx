"use client"

import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import type { Candidate, Fact, Requirement, SearchResult } from "@/types/shopping"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

const fieldLabels: Record<string, string> = {
  "attributes.weightGrams": "Weight", "attributes.batteryLifeHours": "Battery life",
  "attributes.color": "Color", "attributes.brand": "Brand", "attributes.wireless": "Wireless support",
  "offer.itemPriceMinor": "Item price", "offer.shippingMinor": "Shipping",
  "offer.discountMinor": "Discount", "offer.stock": "Stock", "offer.deliverable": "Delivery",
  skuId: "SKU", offerId: "Offer ID", offer: "Offer",
}
const keyFor = (candidate: Candidate) => JSON.stringify([candidate.productId, candidate.skuId, candidate.offerId])
const money = (value: number | null | undefined, currency = "HKD") => value == null ? "Unknown" :
  new Intl.NumberFormat("en-HK", { style: "currency", currency }).format(value / 100)
const attribute = (fact: Fact<number | string | boolean> | undefined, unit: string) =>
  fact?.value == null ? "Unknown" : `${fact.value} ${unit}`
const verifiableFields = (candidate: Candidate) => candidate.missingFields.filter((field) =>
  field.startsWith("attributes.") || (candidate.offer !== null && field.startsWith("offer.")))

export function ProductSearch() {
  const [query, setQuery] = useState("Wireless headphones")
  const [budget, setBudget] = useState("500")
  const [scope, setScope] = useState<Requirement["budget"]["scope"]>("delivered")
  const [excluded, setExcluded] = useState<string[]>([])
  const [snapshot, setSnapshot] = useState<{ requirement: Requirement; result: SearchResult } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const taskId = useRef<string | null>(null)
  const version = useRef(0)
  const active = useRef<AbortController | null>(null)

  useEffect(() => () => active.current?.abort(), [])

  // Input edits immediately invalidate in-flight requests and their old results.
  function invalidate() {
    version.current++
    active.current?.abort()
    setPending(null)
    setSnapshot(null)
    setError("")
    setNotice("")
  }

  async function send(endpoint: "search" | "verify", payload: object, requirement: Requirement, loading: string) {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setPending(loading)
    setError("")
    setNotice("")
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(`/api/products/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: controller.signal,
      })
      const result = await response.json() as SearchResult
      if (controller !== active.current || version.current !== requirement.requirementVersion) return
      if (result.taskId !== requirement.taskId || result.requirementVersion !== requirement.requirementVersion ||
          !Array.isArray(result.candidates) || !Array.isArray(result.warnings) ||
          !["complete", "partial", "failed"].includes(result.status)) {
        throw new Error("Invalid search response")
      }
      if (!response.ok && result.status !== "failed") throw new Error("Search request failed")
      setSnapshot({ requirement, result })
      if (endpoint === "verify") setNotice(result.status === "complete"
        ? "Requested facts updated." : "Fact lookup finished. Some information could not be updated.")
    } catch {
      if (controller === active.current && version.current === requirement.requirementVersion) {
        setError(controller.signal.aborted ? "The request timed out. Please try again." : "Could not reach the product service. Please try again.")
      }
    } finally {
      clearTimeout(timer)
      if (controller === active.current && version.current === requirement.requirementVersion) setPending(null)
    }
  }

  function search(excludedProductIds = excluded) {
    if (!query.trim() || !/^\d+(\.\d{1,2})?$/.test(budget) || !Number.isSafeInteger(Math.round(Number(budget) * 100))) {
      setError("Enter a product keyword and a non-negative budget with up to two decimal places.")
      return
    }
    taskId.current ??= crypto.randomUUID()
    const requirement: Requirement = {
      taskId: taskId.current, requirementVersion: ++version.current,
      category: "Electronics", query: query.trim(), currency: "HKD",
      budget: { maxMinor: Math.round(Number(budget) * 100), scope },
      hardConstraints: [], preferences: [], excludedProductIds, destination: "HK",
    }
    setSnapshot(null)
    void send("search", { requirement, limit: 20 }, requirement, "search")
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    search()
  }

  function exclude(candidate: Candidate) {
    const next = [...new Set([...excluded, candidate.productId])]
    setExcluded(next)
    search(next)
  }

  function verify(candidate: Candidate) {
    if (!snapshot || snapshot.requirement.requirementVersion !== version.current) return
    const { requirement, result } = snapshot
    void send("verify", {
      requirement, candidates: result.candidates,
      requests: [{ productId: candidate.productId, skuId: candidate.skuId, offerId: candidate.offerId,
        fields: verifiableFields(candidate), reason: "Requested missing product details from the homepage." }],
    }, requirement, keyFor(candidate))
  }

  return (
    <section aria-label="Product search" className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle><h2>Find candidate products</h2></CardTitle>
            <Badge variant="outline">Mock data</Badge>
          </div>
          <CardDescription>Explore electronics and fill in missing details. Demo prices and availability are not live.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <label htmlFor="search-query" className="text-sm font-medium">Product keywords</label>
                <Input id="search-query" value={query} required maxLength={200} onChange={(event) => { invalidate(); setQuery(event.target.value) }} />
              </div>
              <div className="space-y-2">
                <label htmlFor="search-budget" className="text-sm font-medium">Maximum budget (HKD)</label>
                <Input id="search-budget" type="number" min="0" step="0.01" value={budget} required
                  onChange={(event) => { invalidate(); setBudget(event.target.value) }} />
              </div>
              <div className="space-y-2">
                <label htmlFor="search-scope" className="text-sm font-medium">Budget covers</label>
                <select id="search-scope" value={scope} className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
                  onChange={(event) => { invalidate(); setScope(event.target.value as typeof scope) }}>
                  <option value="delivered">Item + shipping, after discounts</option>
                  <option value="item">Item only, after discounts</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="secondary">Electronics</Badge><span>Delivery to Hong Kong</span>
              {excluded.length > 0 && <span>· {excluded.length} product(s) excluded</span>}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={pending !== null}>{pending === "search" ? "Searching…" : "Search products"}</Button>
              {excluded.length > 0 && <Button type="button" variant="outline" disabled={pending !== null}
                onClick={() => { setExcluded([]); search([]) }}>Reset exclusions</Button>}
            </div>
          </form>
        </CardContent>
      </Card>

      {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {pending ? (pending === "search" ? "Searching the demo catalog…" : "Looking up missing facts…") : notice}
      </div>

      {snapshot && <div aria-busy={pending !== null} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold">{snapshot.result.candidates.length} candidate offer{snapshot.result.candidates.length === 1 ? "" : "s"}</h3>
          <Badge variant={snapshot.result.status === "failed" ? "destructive" : "secondary"}>
            {snapshot.result.status === "complete" ? "Search complete" : snapshot.result.status === "partial" ? "Partial results" : "Search failed"}
          </Badge>
        </div>
        {snapshot.result.warnings.length > 0 && <div role="alert" className="rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="font-medium">Some information is unavailable</p>
          <ul className="mt-2 list-inside list-disc break-words">
            {snapshot.result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>}
        {snapshot.result.candidates.length === 0 && snapshot.result.status !== "failed" &&
          <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">No matching products. Try different keywords, a higher budget, or reset exclusions.</p>}
        <div className="grid gap-4 md:grid-cols-2">
          {snapshot.result.candidates.map((candidate) => {
            const offer = candidate.offer
            const price = offer?.itemPriceMinor.value
            const shipping = offer?.shippingMinor.value
            const discount = offer?.discountMinor.value
            const total = price != null && shipping != null && discount != null ? price + shipping - discount : null
            const fields = verifiableFields(candidate)
            return <Card key={keyFor(candidate)} role="article" aria-label={candidate.title}>
              <CardHeader>
                <CardTitle>{candidate.title}</CardTitle>
                <CardDescription>{candidate.attributes.color?.value ?? "Color unknown"}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-muted-foreground">Item price</dt><dd>{money(price, offer?.currency)}</dd></div>
                  <div><dt className="text-muted-foreground">Shipping</dt><dd>{money(shipping, offer?.currency)}</dd></div>
                  <div><dt className="text-muted-foreground">Discount</dt><dd>{money(discount, offer?.currency)}</dd></div>
                  <div><dt className="text-muted-foreground">Delivered total</dt><dd className="font-semibold">{money(total, offer?.currency)}</dd></div>
                  <div><dt className="text-muted-foreground">Weight</dt><dd>{attribute(candidate.attributes.weightGrams, "g")}</dd></div>
                  <div><dt className="text-muted-foreground">Battery life</dt><dd>{attribute(candidate.attributes.batteryLifeHours, "hours")}</dd></div>
                  <div><dt className="text-muted-foreground">Stock</dt><dd>{offer?.stock.value === "available" ? "In stock" : offer?.stock.value === "unavailable" ? "Out of stock" : "Unknown"}</dd></div>
                  <div><dt className="text-muted-foreground">Delivery</dt><dd>{offer?.deliverable.value === true ? "Available" : offer?.deliverable.value === false ? "Unavailable" : "Unknown"}</dd></div>
                </dl>
                {candidate.missingFields.length > 0 && <p className="text-sm text-muted-foreground">
                  Missing: {candidate.missingFields.map((field) => fieldLabels[field] ?? field).join(", ")}
                </p>}
                <div className="flex flex-wrap gap-2">
                  {fields.length > 0 && <Button type="button" variant="outline" disabled={pending !== null} onClick={() => verify(candidate)}>
                    {pending === keyFor(candidate) ? "Checking…" : "Look up missing facts"}
                  </Button>}
                  <Button type="button" variant="ghost" disabled={pending !== null} onClick={() => exclude(candidate)}>Exclude product</Button>
                </div>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Sources and identifiers</summary>
                  <div className="mt-2 space-y-1 break-all">
                    <p>Product: {candidate.productId}</p><p>SKU: {candidate.skuId ?? "Unknown"}</p><p>Offer: {candidate.offerId ?? "Unknown"}</p>
                    {Object.entries(candidate.attributes).map(([field, fact]) => <p key={field}>
                      {field}: {fact.source || "No source"} · {fact.status} · {fact.fetchedAt || "Not fetched"}
                    </p>)}
                    {offer && Object.entries(offer).filter(([field]) => field !== "currency").map(([field, value]) => {
                      const fact = value as Fact<unknown>
                      return <p key={field}>{field}: {fact.source || "No source"} · {fact.status} · {fact.fetchedAt || "Not fetched"}</p>
                    })}
                  </div>
                </details>
              </CardContent>
            </Card>
          })}
        </div>
      </div>}
    </section>
  )
}
