import { productSearchResponse } from "../../../../lib/product-search-http"
import { verifyFacts } from "../../../../services/search-agent"

export async function POST(request: Request) {
  return productSearchResponse(request, verifyFacts)
}
