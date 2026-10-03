import type { MainTask } from "./types"
import { TaskError } from "./types"

export interface TaskRepository {
  get(taskId: string, userId: string): MainTask
  insert(task: MainTask): void
  // Must be atomic and synchronous in this single-process adapter. No await in mutation.
  update(taskId: string, userId: string, mutate: (task: MainTask) => void): MainTask
  once(key: string, fingerprint: string, operation: () => Promise<MainTask>): Promise<MainTask>
}

// DEVELOPMENT ONLY. Lost on process restart; not a mandate, budget or payment dedup ledger.
// Single-process only. A durable replacement needs transactions and persistent request claims.
export class MemoryTaskRepository implements TaskRepository {
  private tasks = new Map<string, MainTask>()
  private requests = new Map<string, { fingerprint: string; promise: Promise<MainTask> }>()
  get(taskId: string, userId: string) {
    const task = this.tasks.get(taskId)
    if (!task || task.userId !== userId) throw new TaskError("NOT_FOUND", "任务不存在或不属于当前演示会话", 404)
    return structuredClone(task)
  }
  insert(task: MainTask) {
    if (this.tasks.has(task.taskId)) throw new TaskError("CONFLICT", "任务已存在", 409)
    this.tasks.set(task.taskId, structuredClone(task))
  }
  update(taskId: string, userId: string, mutate: (task: MainTask) => void) {
    const task = this.get(taskId, userId)
    mutate(task)
    this.tasks.set(taskId, structuredClone(task))
    return structuredClone(task)
  }
  async once(key: string, fingerprint: string, operation: () => Promise<MainTask>) {
    const existing = this.requests.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new TaskError("REQUEST_CONFLICT", "相同 requestId 不可用于不同请求", 409)
      return structuredClone(await existing.promise)
    }
    // Register before executing, including concurrent duplicate calls and failed outcomes.
    const promise = Promise.resolve().then(operation)
    this.requests.set(key, { fingerprint, promise })
    return structuredClone(await promise)
  }
}
