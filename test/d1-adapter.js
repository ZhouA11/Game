// D1 接口适配器（基于 node:sqlite，Node >= 22.5）
// 实现内核所用到的 D1 子集：prepare().bind().first()/all()/run() 与 batch()（原子事务）
// batch 语义与 D1 一致：任一语句失败整体回滚
// prepare 采用惰性编译：语句合法性在执行时才校验（与真实 D1 行为一致）

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function runInfo(info) {
  return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }
}

export function createTestDB() {
  const raw = new DatabaseSync(':memory:')

  const makeBound = (sql, args) => {
    let stmt = null
    const get = () => (stmt ?? (stmt = raw.prepare(sql)))
    return {
      // 允许对未绑定语句再次 .bind()（模拟 D1 prepare 链式用法）
      bind: (...next) => makeBound(sql, next),
      first: async () => get().get(...args) ?? null,
      all: async () => ({ results: get().all(...args) }),
      run: async () => runInfo(get().run(...args)),
      // 测试内省用
      _sql: sql,
      _args: args,
      _execSync: () => runInfo(get().run(...args)),
    }
  }

  const DB = {
    prepare: (sql) => makeBound(sql, []),
    async batch(stmts) {
      raw.exec('BEGIN')
      try {
        const out = stmts.map(s => s._execSync())
        raw.exec('COMMIT')
        return out
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      }
    },
    // 测试辅助：直接执行任意 SQL
    _raw: raw,
    exec(sql) { raw.exec(sql) },
  }
  return DB
}

// 依序应用 migrations/*.sql（与 wrangler d1 migrations apply 一致）
export function applyMigrations(DB, migrationsDir) {
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), 'utf8')
    DB._raw.exec(sql)
  }
  return files
}

// 构造一个在命中指定 SQL 片段时抛错的 DB 代理（用于验证事务回滚）
export function withFailureOn(DB, marker, stage = 'before') {
  return {
    prepare: (sql) => {
      const bound = DB.prepare(sql)
      return {
        bind: (...args) => {
          const b = bound.bind(...args)
          return {
            first: b.first.bind(b),
            all: b.all.bind(b),
            run: b.run.bind(b),
            _sql: b._sql,
            _args: b._args,
            _execSync: b._execSync,
          }
        },
        first: bound.first.bind(bound),
        all: bound.all.bind(bound),
        run: bound.run.bind(bound),
        _sql: bound._sql,
        _args: bound._args,
        _execSync: bound._execSync,
      }
    },
    async batch(stmts) {
      const hit = stmts.findIndex(s => (s._sql || '').includes(marker))
      if (hit >= 0) {
        if (stage === 'before') {
          // 执行前面的语句后抛错：batch 原子性要求这些语句全部回滚
          DB._raw.exec('BEGIN')
          try {
            for (let i = 0; i < hit; i++) stmts[i]._execSync()
          } finally {
            DB._raw.exec('ROLLBACK')
          }
          throw new Error(`INJECTED_FAILURE: ${marker}`)
        }
        throw new Error(`INJECTED_FAILURE: ${marker}`)
      }
      return DB.batch(stmts)
    },
  }
}
