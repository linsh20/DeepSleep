import { durableStore } from "@/services/main-agent/storage"
import { RiskRepository } from "@/services/risk-control/repository"
import { riskHttp } from "@/services/risk-control/http"
export const runtime = "nodejs"
async function handle(request:Request,context:{params:Promise<{action:string}>}) {
  if(process.env.NODE_ENV!=="development")return Response.json({error:{code:"DEVELOPMENT_ONLY"}},{status:404})
  const {main,purchase}=durableStore()
  return riskHttp(new RiskRepository(purchase),main)(request,(await context.params).action)
}
export const GET=handle
export const POST=handle
