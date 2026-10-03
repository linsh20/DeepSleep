import { productSelectionResponse } from "../../../../lib/product-selection-http"
import { selectProduct } from "../../../../services/product-selection"

export const runtime = "nodejs"

export async function POST(request: Request) {
  return productSelectionResponse(request, selectProduct)
}
