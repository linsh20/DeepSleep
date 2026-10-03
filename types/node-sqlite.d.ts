declare module "node:sqlite" {
  export type DatabaseSyncOptions = {
    open?: boolean
    readOnly?: boolean
    allowExtension?: boolean
    enableForeignKeyConstraints?: boolean
    enableDoubleQuotedStringLiterals?: boolean
    timeout?: number
  }

  export class StatementSync {
    all(...anonymousParameters: unknown[]): Record<string, unknown>[]
    get(...anonymousParameters: unknown[]): Record<string, unknown> | undefined
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions)
    prepare(sql: string): StatementSync
    close(): void
  }
}
