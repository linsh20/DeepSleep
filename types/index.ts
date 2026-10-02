export type Product = {
  id: number
  name: string
  category: string
  price: number
  shipping: number
  rating: number
}

export type ShoppingDecision = {
  status: "APPROVED" | "BLOCKED"
  product?: Product
  total?: number
  reason: string
}