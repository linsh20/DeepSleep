"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ProductSearch } from "@/components/product-search"

type Decision = {
  status: "APPROVED" | "BLOCKED"
  product: string
  price: number
  shipping: number
  total: number
  reason: string
}

export default function Home() {
  const [request, setRequest] = useState("Wireless headphones")
  const [budget, setBudget] = useState(500)
  const [decision, setDecision] = useState<Decision | null>(null)

  function runSuccessfulPurchase() {
    const product = {
      name: "SoundPro Wireless Headphones",
      price: 399,
      shipping: 20,
    }

    const total = product.price + product.shipping

    setDecision({
      status: total <= budget ? "APPROVED" : "BLOCKED",
      product: product.name,
      price: product.price,
      shipping: product.shipping,
      total,
      reason:
        total <= budget
          ? `Purchase allowed because HK$${total} ≤ budget HK$${budget}.`
          : `Purchase blocked because HK$${total} exceeds budget HK$${budget}.`,
    })
  }

  function runBlockedPurchase() {
    const product = {
      name: "Premium Wireless Headphones",
      price: 480,
      shipping: 40,
    }

    const total = product.price + product.shipping

    setDecision({
      status: total <= budget ? "APPROVED" : "BLOCKED",
      product: product.name,
      price: product.price,
      shipping: product.shipping,
      total,
      reason:
        total <= budget
          ? `Purchase allowed because HK$${total} ≤ budget HK$${budget}.`
          : `Purchase blocked because HK$${total} exceeds budget HK$${budget} by HK$${total - budget}.`,
    })
  }

  return (
    <main className="min-h-screen bg-muted/40 p-8">
      <div className="mx-auto max-w-4xl space-y-6">

        <div>
          <h1 className="text-3xl font-bold">WalletAgent</h1>
          <p className="text-muted-foreground">
            AI shopping with enforceable spending controls
          </p>
        </div>

        <ProductSearch />

        <details className="space-y-6">
          <summary className="cursor-pointer text-sm text-muted-foreground">Legacy purchase demo</summary>
        <Card>
          <CardHeader>
            <CardTitle>Shopping Request</CardTitle>
            <CardDescription>
              Delegate a purchase while keeping control of the wallet.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium">
                What do you want to buy?
              </p>

              <Input
                value={request}
                onChange={(e) => setRequest(e.target.value)}
              />
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">
                Maximum budget (HKD)
              </p>

              <Input
                type="number"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                Allowed category:
              </span>

              <Badge>Electronics</Badge>

              <Badge variant="outline">
                Mandate Active
              </Badge>
            </div>

            <Separator />

            <div className="flex gap-3">
              <Button onClick={runSuccessfulPurchase}>
                Find & Buy
              </Button>

              <Button
                variant="destructive"
                onClick={runBlockedPurchase}
              >
                Test Blocked Transaction
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agent Mandate</CardTitle>
          </CardHeader>

          <CardContent className="grid gap-3 md:grid-cols-3">
            <div>
              <p className="text-sm text-muted-foreground">Request</p>
              <p className="font-medium">{request}</p>
            </div>

            <div>
              <p className="text-sm text-muted-foreground">Budget</p>
              <p className="font-medium">HK${budget}</p>
            </div>

            <div>
              <p className="text-sm text-muted-foreground">Category</p>
              <p className="font-medium">Electronics</p>
            </div>
          </CardContent>
        </Card>

        {decision && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Transaction Decision</CardTitle>

                <Badge
                  variant={
                    decision.status === "APPROVED"
                      ? "default"
                      : "destructive"
                  }
                >
                  {decision.status}
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="space-y-3">
              <div className="grid gap-3 md:grid-cols-4">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Product
                  </p>
                  <p className="font-medium">{decision.product}</p>
                </div>

                <div>
                  <p className="text-sm text-muted-foreground">
                    Price
                  </p>
                  <p>HK${decision.price}</p>
                </div>

                <div>
                  <p className="text-sm text-muted-foreground">
                    Shipping
                  </p>
                  <p>HK${decision.shipping}</p>
                </div>

                <div>
                  <p className="text-sm text-muted-foreground">
                    Final Total
                  </p>
                  <p className="font-bold">HK${decision.total}</p>
                </div>
              </div>

              <Separator />

              <div>
                <p className="text-sm font-medium">Decision reason</p>
                <p className="text-muted-foreground">
                  {decision.reason}
                </p>
              </div>
            </CardContent>
          </Card>
        )}
        </details>

      </div>
    </main>
  )
}