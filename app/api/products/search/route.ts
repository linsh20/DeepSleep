import { productSearchResponse } from "../../../../lib/product-search-http"
import { searchProducts } from "../../../../services/product-search"

export async function POST(request: Request) {
  return productSearchResponse(request, searchProducts)
}
