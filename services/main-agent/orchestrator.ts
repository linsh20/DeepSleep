import { randomUUID } from "node:crypto"
import { clarify, completeRequirement, draftValue, intentValue, object } from "./requirement-interpreter"
import type { RequirementInterpreter } from "./requirement-interpreter"
import type { TaskRepository } from "./task-repository"
import type { ShoppingPort, ShoppingPortResult } from "./shopping-port"
import { TaskError } from "./types"
import type { Interpretation, MainTask, RequirementDraft, TaskIntent, TaskStatus } from "./types"

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  needs_clarification: ["needs_clarification", "ready_to_search"],
  ready_to_search: ["needs_clarification", "ready_to_search", "shopping"],
  shopping: ["needs_clarification", "ready_to_search", "result_ready", "needs_verification", "no_match", "failed"],
  result_ready: ["needs_clarification", "ready_to_search"],
  needs_verification: ["needs_clarification", "ready_to_search"],
  no_match: ["needs_clarification", "ready_to_search"],
  failed: ["needs_clarification", "ready_to_search", "shopping"],
}
function event(task: MainTask, type: string, detail: string) {
  task.events.push({ sequence: task.events.length + 1, at: new Date().toISOString(), requirementVersion: task.requirementVersion, type, detail })
}
function transition(task: MainTask, next: TaskStatus) {
  if (!transitions[task.status].includes(next)) throw new TaskError("INVALID_TRANSITION", "不允许的任务状态转换", 409)
  task.status = next
  event(task, "status", next)
}
async function bounded<T>(call: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(() => call(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TaskError("TIMEOUT", "工具调用超时", 504))
        controller.abort()
      }, timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
function validateResult(raw: unknown): ShoppingPortResult {
  const r = object(raw)
  if (typeof r.taskId !== "string" || !Number.isSafeInteger(r.requirementVersion) || r.dataEnvironment !== "development_mock") throw new TaskError("INVALID_INPUT", "无效 Shopping 结果")
  const base = { taskId: r.taskId, requirementVersion: Number(r.requirementVersion), dataEnvironment: "development_mock" as const }
  const text = (v: unknown) => {
    if (typeof v !== "string" || v.length > 4000) throw new TaskError("INVALID_INPUT", "无效 Shopping 字段")
    return v
  }
  switch (r.status) {
    case "result_ready": {
      const plan = object(r.plan), fact = object(plan.priceMinor)
      if (fact.status !== "mock" || fact.source !== "mock-dataset" || (fact.value !== null && (!Number.isSafeInteger(fact.value) || Number(fact.value) < 0))) throw new TaskError("INVALID_INPUT", "开发数据不得提升为已核验")
      return { ...base, status: r.status, plan: { title: text(plan.title), notice: text(plan.notice), priceMinor: {
        value: fact.value === null ? null : Number(fact.value), status: "mock", source: "mock-dataset", fetchedAt: text(fact.fetchedAt),
      } } }
    }
    case "no_match": return { ...base, status: r.status, reason: text(r.reason) }
    case "needs_verification": {
      if (!Array.isArray(r.missingFacts) || !r.missingFacts.length || r.missingFacts.length > 100) throw new TaskError("INVALID_INPUT", "缺失事实格式无效")
      return { ...base, status: r.status, missingFacts: r.missingFacts.map(text) }
    }
    case "failed": {
      const error = object(r.error)
      if (!["INVALID_INPUT", "SOURCE_UNAVAILABLE", "TIMEOUT", "UNSUPPORTED_CATEGORY"].includes(String(error.code)) || typeof error.retryable !== "boolean") throw new TaskError("INVALID_INPUT", "工具错误格式无效")
      return { ...base, status: r.status, error: { code: error.code as "INVALID_INPUT" | "SOURCE_UNAVAILABLE" | "TIMEOUT" | "UNSUPPORTED_CATEGORY", retryable: error.retryable } }
    }
    default: throw new TaskError("INVALID_INPUT", "未知 Shopping 状态")
  }
}
export type SaveRequirementInput = { requestId: string; expectedVersion: number; intent: TaskIntent; requirementDraft: RequirementDraft; userMessage?: string }
export class MainTaskOrchestrator {
  private timeoutMs: number
  private retries: number
  private modelInterpreter?: RequirementInterpreter
  private modelTimeoutMs: number
  constructor(private repository: TaskRepository, private interpreter: RequirementInterpreter, private shopping: ShoppingPort, options: { timeoutMs?: number; retries?: number; modelInterpreter?: RequirementInterpreter; modelTimeoutMs?: number } = {}) {
    this.modelInterpreter = options.modelInterpreter
    this.modelTimeoutMs = options.modelTimeoutMs ?? 60000
    if (!Number.isSafeInteger(this.modelTimeoutMs) || this.modelTimeoutMs < 1 || this.modelTimeoutMs > 60000) throw new TaskError("INVALID_INPUT", "模型超时配置无效")
    this.timeoutMs = options.timeoutMs ?? 3000
    this.retries = options.retries ?? 1
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000 || !Number.isInteger(this.retries) || this.retries < 0 || this.retries > 2) throw new TaskError("INVALID_INPUT", "调用限制无效")
  }
  get(taskId: string, userId: string) { return this.repository.get(taskId, userId) }
  private once(userId: string, requestId: string, payload: unknown, operation: () => Promise<MainTask>) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new TaskError("INVALID_INPUT", "requestId 格式无效")
    return this.repository.once(JSON.stringify([userId, requestId]), JSON.stringify(payload), operation)
  }
  create(userId: string, requestId: string) {
    return this.once(userId, requestId, ["create"], async () => {
      const task: MainTask = { taskId: randomUUID(), userId, ...clarify("unclear", {}), requirementVersion: 0,
        requirement: null, status: "needs_clarification", shoppingResult: null, events: [] }
      event(task, "created", "开发输入模式；内存存储；购买执行尚未接入")
      this.repository.insert(task)
      return task
    })
  }
  save(taskId: string, userId: string, input: SaveRequirementInput) {
    const draft = draftValue(input.requirementDraft), intent = intentValue(input.intent)
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || (input.userMessage !== undefined && (typeof input.userMessage !== "string" || input.userMessage.length > 4000))) throw new TaskError("INVALID_INPUT", "输入版本或消息无效")
    return this.once(userId, input.requestId, ["save", taskId, input.expectedVersion, intent, draft, input.userMessage ?? ""], async () => {
      const current = this.get(taskId, userId)
      if (current.requirementVersion !== input.expectedVersion) throw new TaskError("VERSION_CONFLICT", "需求已更新，请刷新后重试", 409)
      const interpreted = await bounded(signal => this.interpreter.interpret({ userMessage: input.userMessage ?? "", currentDraft: current.requirementDraft,
        context: [], developmentInput: { intent, requirementDraft: draft } }, signal), this.timeoutMs)
      // Untrusted model output is projected and validated. Model-provided missingFields cannot grant readiness.
      const checked = clarify(intentValue(interpreted.intent), draftValue(interpreted.requirementDraft))
      return this.repository.update(taskId, userId, task => {
        if (task.requirementVersion !== input.expectedVersion) throw new TaskError("VERSION_CONFLICT", "需求已更新，请刷新后重试", 409)
        this.applyInterpretation(task, checked)
      })
    })
  }
  private applyInterpretation(task: MainTask, checked: Interpretation) {
    if (task.intent === checked.intent && JSON.stringify(task.requirementDraft) === JSON.stringify(checked.requirementDraft)) return
    task.requirementVersion++
    Object.assign(task, checked)
    task.requirement = completeRequirement(checked, task.taskId, task.requirementVersion)
    task.shoppingResult = null
    task.shoppingRequest = null
    event(task, "requirement_updated", "需求变化使旧版本结果失效")
    transition(task, task.requirement ? "ready_to_search" : "needs_clarification")
  }
  message(taskId: string, userId: string, input: { requestId: string; expectedVersion: number; message: string }) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || typeof input.message !== "string" || !input.message.trim() || input.message.length > 2000) throw new TaskError("INVALID_INPUT", "消息须为 1–2000 字符，版本须有效")
    // Do not forward obvious credentials or payment details entered accidentally.
    if (/sk-[a-z0-9_-]{12,}|authorization\s*:|api[_ -]?key\s*[:=]|(?:\d[ -]?){13,19}/i.test(input.message)) throw new TaskError("SENSITIVE_INPUT", "请勿在聊天中输入密钥或支付信息")
    return this.once(userId, input.requestId, ["message", taskId, input.expectedVersion, input.message], async () => {
      const snapshot = this.repository.update(taskId, userId, task => {
        if (task.requirementVersion !== input.expectedVersion) throw new TaskError("VERSION_CONFLICT", "需求已更新，请刷新后重试", 409)
        task.conversationRevision = (task.conversationRevision ?? 0) + 1
        task.messages ??= []
        task.messages.push({ requestId: input.requestId, role: "user", content: input.message, at: new Date().toISOString() })
        event(task, "message_received", "自然语言消息已接收")
      })
      let reply: string, errorCode: string | undefined
      try {
        if (!this.modelInterpreter) throw new TaskError("MODEL_NOT_CONFIGURED", "模型未配置，请使用结构化表单", 503)
        const interpreted = await bounded(signal => this.modelInterpreter!.interpret({ userMessage: input.message,
          currentIntent: snapshot.intent, currentDraft: snapshot.requirementDraft,
          context: (snapshot.messages ?? []).slice(0, -1).filter(m => !m.errorCode).slice(-8).map(m => ({ role: m.role, content: m.content.slice(0, 1500) })),
        }, signal), this.modelTimeoutMs)
        const checked = clarify(intentValue(interpreted.intent), draftValue(interpreted.requirementDraft))
        const applied = this.repository.update(taskId, userId, task => {
          if (task.requirementVersion !== snapshot.requirementVersion || task.conversationRevision !== snapshot.conversationRevision) throw new TaskError("MODEL_SUPERSEDED", "解释期间任务或对话已更新；旧解释已丢弃", 409)
          this.applyInterpretation(task, checked)
        })
        // Same requirement with an existing result is reused. Tools remain deterministic.
        const result = applied.status === "ready_to_search"
          ? await this.search(taskId, userId, randomUUID(), applied.requirementVersion) : applied
        if (result.requirementVersion !== applied.requirementVersion || result.conversationRevision !== snapshot.conversationRevision) throw new TaskError("MODEL_SUPERSEDED", "任务已更新；请查看当前版本结果", 409)
        reply = result.status === "needs_clarification" ? result.clarificationQuestions.join("\n")
          : result.status === "result_ready" ? "已返回 development_mock 模拟方案，商品事实未核验。购买执行尚未接入。"
          : result.status === "needs_verification" ? "ShoppingStub 缺少关键事实，需要核验；未执行购买。"
          : result.status === "no_match" ? "ShoppingStub 没有符合条件的方案。"
          : result.status === "failed" ? "ShoppingStub 调用失败，请查看错误码；未执行购买。"
          : "当前版本正在搜索，请等待结果。"
      } catch (error) {
        const safe = error instanceof TaskError ? error : new TaskError("MODEL_UNAVAILABLE", "模型处理失败，原需求未修改")
        errorCode = safe.code === "TIMEOUT" ? "MODEL_TIMEOUT" : safe.code
        reply = safe.code === "TIMEOUT" ? "模型请求超时，原需求未修改；可重试或使用表单。" : safe.message
      }
      return this.repository.update(taskId, userId, task => {
        task.messages ??= []
        task.messages.push({ requestId: input.requestId, role: "assistant", content: reply, at: new Date().toISOString(), ...(errorCode ? { errorCode } : {}) })
        event(task, errorCode ? "message_error" : "message_answered", errorCode ?? "需求理解和工具处理完成；回复由服务端任务事实生成")
      })
    })
  }
  search(taskId: string, userId: string, requestId: string, expectedVersion: number) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TaskError("INVALID_INPUT", "版本无效")
    return this.once(userId, requestId, ["search", taskId, expectedVersion], async () => {
      let started = false
      const snapshot = this.repository.update(taskId, userId, task => {
        if (task.requirementVersion !== expectedVersion) throw new TaskError("VERSION_CONFLICT", "需求版本已变化", 409)
        if (task.status !== "ready_to_search" && task.status !== "failed") return
        if (!task.requirement || task.intent === "unclear") throw new TaskError("INVALID_INPUT", "需求尚未完整")
        task.shoppingResult = null
        task.shoppingRequest = { requirement: structuredClone(task.requirement), quantity: task.requirementDraft.quantity! }
        transition(task, "shopping")
        started = true
      })
      if (!started || !snapshot.requirement || !snapshot.requirementDraft.quantity) return snapshot
      const requirement = snapshot.requirement, quantity = snapshot.requirementDraft.quantity
      let result: ShoppingPortResult | undefined
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        // No retry for superseded requirements, even after timeout/failure.
        if (this.get(taskId, userId).requirementVersion !== expectedVersion) break
        this.repository.update(taskId, userId, task => event(task, "shopping_attempt", `开发工具调用 ${attempt + 1}/${this.retries + 1}`))
        try {
          result = validateResult(await bounded(signal => this.shopping.search({ requirement: structuredClone(requirement), quantity }, signal), this.timeoutMs))
          if (result.taskId !== taskId || result.requirementVersion !== expectedVersion) {
            result = { taskId, requirementVersion: expectedVersion, dataEnvironment: "development_mock", status: "failed", error: { code: "INVALID_INPUT", retryable: false } }
            this.repository.update(taskId, userId, task => event(task, "result_rejected", "工具 taskId 或 requirementVersion 不匹配"))
          }
        } catch (error) {
          result = { taskId, requirementVersion: expectedVersion, dataEnvironment: "development_mock", status: "failed", error: {
            code: error instanceof TaskError && error.code === "TIMEOUT" ? "TIMEOUT" : error instanceof TaskError ? "INVALID_INPUT" : "SOURCE_UNAVAILABLE",
            retryable: !(error instanceof TaskError) || error.code === "TIMEOUT",
          } }
        }
        if (result.status !== "failed" || !result.error.retryable) break
      }
      return this.repository.update(taskId, userId, task => {
        if (task.requirementVersion !== expectedVersion) { event(task, "stale_result_discarded", `拒绝应用旧版本 v${expectedVersion} 的结果`); return }
        if (!result) throw new TaskError("INTERNAL_ERROR", "工具未返回结果", 500)
        task.shoppingResult = result
        transition(task, result.status)
      })
    })
  }
}
