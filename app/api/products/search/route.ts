import { productSearchResponse } from "../../../../lib/product-search-http"
import { searchCandidates } from "../../../../services/search-agent"

export async function POST(request: Request) {
  return productSearchResponse(request, searchCandidates)
}
