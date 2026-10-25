/**
 * Durable Object 内嵌 SQLite 存储。所有状态（任务、日志、配置、session）都在这里，
 * 不需要额外的 D1 / KV 绑定。
 */
import type { LogEntry, Schedule, Settings, Step, Target, Task, TaskInput } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { taskFingerprint } from "./task";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_auto INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      target TEXT NOT NULL,
      targets TEXT,
      thread_id INTEGER,
      schedule TEXT NOT NULL,
      steps TEXT NOT NULL,
      success_keywords TEXT NOT NULL DEFAULT '[]',
      timeout_seconds INTEGER NOT NULL DEFAULT 25,
      step_delay_seconds INTEGER NOT NULL DEFAULT 3,
      delete_after_seconds INTEGER NOT NULL DEFAULT 0,
      cleanup_previous INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_result TEXT,
      last_message TEXT,
      last_detail TEXT,
      fail_streak INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'ui',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_next ON tasks(enabled, next_run_at)`,
  `CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      task_name TEXT,
      at INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      source TEXT,
      duration_ms INTEGER
    )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at DESC)`,
  `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, at)`,
  `CREATE TABLE IF NOT EXISTS auth_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      at INTEGER NOT NULL,
      ok INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_at ON auth_attempts(at)`,
  `CREATE TABLE IF NOT EXISTS deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat TEXT NOT NULL,
      msg_ids TEXT NOT NULL,
      due_at INTEGER NOT NULL
    )`,
];

type Row = Record<string, SqlStorageValue>;

interface TaskRow extends Row {
  id: number;
  name: string;
  name_auto: number | null;
  enabled: number;
  target: string;
  targets: string | null;
  thread_id: number | null;
  schedule: string;
  steps: string;
  success_keywords: string;
  timeout_seconds: number;
  step_delay_seconds: number | null;
  delete_after_seconds: number;
  cleanup_previous: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: string | null;
  last_message: string | null;
  last_detail: string | null;
  fail_streak: number | null;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface LogFilter {
  limit?: number;
  offset?: number;
  beforeId?: number | null;
  taskId?: number | null;
  level?: string | null;
  query?: string | null;
  /** 只看这个时间点之后的日志（ms） */
  since?: number | null;
}

export interface LogRow extends Row {
  id: number;
  task_id: number | null;
  task_name: string | null;
  at: number;
  ok: number;
  level: string;
  message: string;
  detail: string | null;
  source: string | null;
  duration_ms: number | null;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** 去掉和 username 重复的 title（历史数据里可能存了 "@bot"） */
function normalizeTarget(target: Target): Target {
  if (target.title && target.username && target.title === `@${target.username}`) {
    return { ...target, title: undefined };
  }
  return target;
}

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    nameAuto: row.name_auto === null || row.name_auto === undefined ? undefined : row.name_auto === 1,
    enabled: !!row.enabled,
    target: normalizeTarget(parseJson<Target>(row.target, { kind: "user", id: "" })),
    targets: (() => {
      const parsed = parseJson<Target[]>(row.targets ?? "[]", []);
      return Array.isArray(parsed) && parsed.length > 1 ? parsed : undefined;
    })(),
    threadId: row.thread_id,
    schedule: parseJson<Schedule>(row.schedule, { kind: "daily", time: "09:00" }),
    steps: parseJson<Step[]>(row.steps, []),
    successKeywords: parseJson<string[]>(row.success_keywords, []),
    timeoutSeconds: row.timeout_seconds ?? 30,
    stepDelaySeconds: row.step_delay_seconds ?? 3,
    deleteAfterSeconds: row.delete_after_seconds,
    cleanupPrevious: !!row.cleanup_previous,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastResult: (row.last_result as Task["lastResult"]) ?? null,
    lastMessage: row.last_message,
    lastDetail: row.last_detail,
    failStreak: row.fail_streak ?? 0,
    source: (row.source as Task["source"]) ?? "ui",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToLog(row: LogRow): LogEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name,
    at: row.at,
    ok: !!row.ok,
    level: (row.level as LogEntry["level"]) ?? "info",
    message: row.message,
    detail: row.detail,
    source: (row.source as LogEntry["source"]) ?? null,
    durationMs: row.duration_ms ?? null,
  };
}

export class Store {
  constructor(private readonly sql: SqlStorage) {
    for (const statement of SCHEMA) this.sql.exec(statement);
    // 老库补列（新库会因为列已存在而报错，忽略即可）
    try {
      this.sql.exec("ALTER TABLE tasks ADD COLUMN step_delay_seconds INTEGER NOT NULL DEFAULT 3");
    } catch {
      /* 列已存在 */
    }
    try {
      this.sql.exec("ALTER TABLE tasks ADD COLUMN last_detail TEXT");
    } catch {
      /* 列已存在 */
    }
    try {
      this.sql.exec("ALTER TABLE tasks ADD COLUMN targets TEXT");
    } catch {
      /* 列已存在 */
    }
    try {
      this.sql.exec("ALTER TABLE tasks ADD COLUMN name_auto INTEGER");
    } catch {
      /* 列已存在 */
    }
    try {
      this.sql.exec("ALTER TABLE tasks ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* 列已存在 */
    }
    try {
      this.sql.exec("ALTER TABLE logs ADD COLUMN source TEXT");
    } catch {
      /* 列已存在 */
    }
    try {
      this.sql.exec("ALTER TABLE logs ADD COLUMN duration_ms INTEGER");
    } catch {
      /* 列已存在 */
    }
  }

  /** 统一的行查询：DO 的 SqlStorage 泛型约束较严，这里集中做一次断言 */
  private rows<T>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as unknown as T[];
  }

  // ---------- kv ----------
  getKv(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray();
    return rows.length ? rows[0].value : null;
  }

  setKv(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  deleteKv(key: string): void {
    this.sql.exec("DELETE FROM kv WHERE key = ?", key);
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.getKv(key);
    return raw ? parseJson<T>(raw, fallback) : fallback;
  }

  setJson(key: string, value: unknown): void {
    this.setKv(key, JSON.stringify(value));
  }

  // ---------- settings ----------
  getSettings(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.getJson<Partial<Settings>>("settings", {}) };
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.getSettings(), ...patch };
    this.setJson("settings", next);
    return next;
  }

  // ---------- tasks ----------
  listTasks(): Task[] {
    return this.rows<TaskRow>("SELECT * FROM tasks ORDER BY enabled DESC, next_run_at ASC, id ASC").map(rowToTask);
  }

  getTask(id: number): Task | null {
    const rows = this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", id).toArray();
    return rows.length ? rowToTask(rows[0]) : null;
  }

  findTask(query: string): Task | null {
    const trimmed = query.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isInteger(numeric) && numeric > 0) {
      const byId = this.getTask(numeric);
      if (byId) return byId;
    }
    // LIKE 里的 % / _ 要转义，否则「删除 %」这类输入会一次匹配到不相干的任务
    const escaped = trimmed.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = this.rows<TaskRow>(
      "SELECT * FROM tasks WHERE name LIKE ? ESCAPE '\\' ORDER BY id ASC LIMIT 1",
      `%${escaped}%`,
    );
    return rows.length ? rowToTask(rows[0]) : null;
  }

  /**
   * 找「同一个目标 + 同样的调度 + 同样的动作」的任务。
   * 用于阻止同一条触发配置被发多次、或反复点保存造成的重复任务（到点会连着发好几条）。
   */
  findDuplicateTask(input: TaskInput): Task | null {
    const fingerprint = taskFingerprint(input);
    if (!fingerprint) return null;
    for (const task of this.listTasks()) {
      if (taskFingerprint(task) !== fingerprint) continue;
      // 名字不同视为"有意为之"（比如同一动作跑到不同话题/不同备注），不拦
      if (task.name !== input.name) continue;
      return task;
    }
    return null;
  }

  createTask(input: TaskInput, now: number, nextRunAt: number | null): Task {
    this.sql.exec(
      `INSERT INTO tasks (name, name_auto, enabled, target, targets, thread_id, schedule, steps, success_keywords,
         timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, next_run_at,
         last_run_at, last_result, last_message, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.nameAuto === undefined ? null : input.nameAuto ? 1 : 0,
      input.enabled ? 1 : 0,
      JSON.stringify(input.target),
      input.targets && input.targets.length > 1 ? JSON.stringify(input.targets) : null,
      input.threadId ?? null,
      JSON.stringify(input.schedule),
      JSON.stringify(input.steps),
      JSON.stringify(input.successKeywords ?? []),
      input.timeoutSeconds ?? 25,
      input.stepDelaySeconds ?? 3,
      input.deleteAfterSeconds ?? 0,
      input.cleanupPrevious ? 1 : 0,
      nextRunAt,
      input.lastRunAt ?? null,
      input.lastResult ?? null,
      input.lastMessage ?? null,
      input.source ?? "ui",
      now,
      now,
    );
    const row = this.sql.exec<TaskRow>("SELECT * FROM tasks ORDER BY id DESC LIMIT 1").toArray()[0];
    return rowToTask(row);
  }

  updateTask(id: number, patch: Partial<TaskInput>, now: number): Task | null {
    const current = this.getTask(id);
    if (!current) return null;
    const merged: Task = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now,
    } as Task;

    this.sql.exec(
      `UPDATE tasks SET name = ?, name_auto = ?, enabled = ?, target = ?, targets = ?, thread_id = ?, schedule = ?, steps = ?,
         success_keywords = ?, timeout_seconds = ?, step_delay_seconds = ?, delete_after_seconds = ?,
         cleanup_previous = ?, next_run_at = ?, last_run_at = ?, last_result = ?, last_message = ?,
         last_detail = ?, updated_at = ?
       WHERE id = ?`,
      merged.name,
      merged.nameAuto === undefined ? null : merged.nameAuto ? 1 : 0,
      merged.enabled ? 1 : 0,
      JSON.stringify(merged.target),
      merged.targets && merged.targets.length > 1 ? JSON.stringify(merged.targets) : null,
      merged.threadId ?? null,
      JSON.stringify(merged.schedule),
      JSON.stringify(merged.steps),
      JSON.stringify(merged.successKeywords ?? []),
      merged.timeoutSeconds ?? 25,
      merged.stepDelaySeconds ?? 3,
      merged.deleteAfterSeconds ?? 0,
      merged.cleanupPrevious ? 1 : 0,
      merged.nextRunAt ?? null,
      merged.lastRunAt ?? null,
      merged.lastResult ?? null,
      merged.lastMessage ?? null,
      merged.lastDetail ?? null,
      now,
      id,
    );
    return this.getTask(id);
  }

  setTaskNextRun(id: number, nextRunAt: number | null): void {
    this.sql.exec("UPDATE tasks SET next_run_at = ? WHERE id = ?", nextRunAt, id);
  }

  recordRun(id: number, result: "ok" | "fail", message: string, detail: string | null, now: number): void {
    this.sql.exec(
      `UPDATE tasks SET last_run_at = ?, last_result = ?, last_message = ?, last_detail = ?,
         fail_streak = CASE WHEN ? = 'ok' THEN 0 ELSE fail_streak + 1 END, updated_at = ?
       WHERE id = ?`,
      now,
      result,
      message,
      detail,
      result,
      now,
      id,
    );
  }

  failStreakOf(id: number): number {
    const rows = this.rows<{ fail_streak: number | null }>("SELECT fail_streak FROM tasks WHERE id = ?", id);
    return rows.length ? Number(rows[0].fail_streak ?? 0) : 0;
  }


  deleteTask(id: number): void {
    this.sql.exec("DELETE FROM tasks WHERE id = ?", id);
    this.sql.exec("DELETE FROM logs WHERE task_id = ?", id);
    this.deleteKv(`task:${id}:sent`);
    // 多目标时按目标分键存过 sent，还有失败提醒的节流时间，一并清掉
    this.sql.exec("DELETE FROM kv WHERE key LIKE ?", `task:${id}:sent:%`);
    this.deleteKv(`notify:${id}:at`);
  }

  dueTasks(now: number, limit = 20): Task[] {
    return this.sql
      .exec<TaskRow>(
        "SELECT * FROM tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?",
        now,
        limit,
      )
      .toArray()
      .map(rowToTask);
  }

  earliestNextRun(): number | null {
    const rows = this.sql
      .exec<{ next: number | null }>(
        "SELECT MIN(next_run_at) AS next FROM tasks WHERE enabled = 1 AND next_run_at IS NOT NULL",
      )
      .toArray();
    return rows.length ? rows[0].next : null;
  }

  // ---------- logs ----------
  addLog(entry: Omit<LogEntry, "id">): LogEntry {
    this.sql.exec(
      "INSERT INTO logs (task_id, task_name, at, ok, level, message, detail, source, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      entry.taskId,
      entry.taskName,
      entry.at,
      entry.ok ? 1 : 0,
      entry.level,
      entry.message,
      entry.detail,
      entry.source ?? "system",
      entry.durationMs ?? null,
    );
    // 只保留最近 2000 条，避免 DO 存储无限增长
    this.sql.exec("DELETE FROM logs WHERE id <= (SELECT MAX(id) - 2000 FROM logs)");
    const row = this.sql.exec<LogRow>("SELECT * FROM logs ORDER BY id DESC LIMIT 1").toArray()[0];
    return rowToLog(row);
  }

  /**
   * 日志列表（游标分页）。
   * @param options.beforeId 只取 id 更小的（「加载更多」）—— 比 page/pageSize 稳，插入新日志不会跳行
   * @param options.level "ok"（成功）/ "fail"（失败）/ 具体 level
   */
  /** 日志筛选条件（分页 + 任务 + 级别 + 关键字） */
  private logFilter(options: LogFilter): { where: string; bindings: SqlStorageValue[] } {
    const where: string[] = [];
    const bindings: SqlStorageValue[] = [];

    if (options.taskId) {
      where.push("task_id = ?");
      bindings.push(options.taskId);
    }
    if (options.beforeId) {
      where.push("id < ?");
      bindings.push(options.beforeId);
    }
    if (options.since) {
      where.push("at >= ?");
      bindings.push(options.since);
    }
    if (options.level === "ok") where.push("ok = 1");
    else if (options.level === "fail") where.push("ok = 0");
    else if (options.level) {
      where.push("level = ?");
      bindings.push(options.level);
    }
    const query = (options.query ?? "").trim();
    if (query) {
      // LIKE 通配符要转义，避免 `%` 一把梭
      const escaped = query.slice(0, 60).replace(/[\\%_]/g, (char) => `\\${char}`);
      where.push("(message LIKE ? ESCAPE '\\' OR task_name LIKE ? ESCAPE '\\')");
      bindings.push(`%${escaped}%`, `%${escaped}%`);
    }

    return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", bindings };
  }

  listLogs(options: LogFilter = {}): LogEntry[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    const offset = Math.max(0, Math.min(1_000_000, options.offset ?? 0));
    const { where, bindings } = this.logFilter(options);
    const sql = `SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;
    return this.rows<LogRow>(sql, ...bindings, limit, offset).map(rowToLog);
  }

  /** 当前筛选条件下的总条数（前端显示"已加载 x / 共 y"） */
  countLogs(options: LogFilter = {}): number {
    const { where, bindings } = this.logFilter({ ...options, beforeId: null });
    const rows = this.rows<{ total: number | null }>(`SELECT COUNT(*) AS total FROM logs ${where}`, ...bindings);
    return rows.length ? Number(rows[0].total ?? 0) : 0;
  }

  clearLogs(): void {
    this.sql.exec("DELETE FROM logs");
  }

  // ---------- 事件计数（只记事件名 + 时间，不记内容） ----------
  recordEvent(name: string): void {
    const at = Date.now();
    const key = name.slice(0, 40);
    // 累计总数单独存 kv：events 表每类只留 5000 条，用它统计会静默封顶
    const totalKey = `event:total:${key}`;
    this.setKv(totalKey, String(Number(this.getKv(totalKey) ?? 0) + 1));
    this.sql.exec("INSERT INTO events (name, at) VALUES (?, ?)", key, at);
    // 每类事件只留最近 5000 条，避免无限增长
    this.sql.exec(
      "DELETE FROM events WHERE name = ? AND id <= (SELECT MAX(id) - 5000 FROM events WHERE name = ?)",
      key,
      key,
    );
  }

  /** 取某类事件在 since 之后的样本（用于趋势图） */
  listEventSamples(prefix: string, since: number): Array<{ name: string; at: number }> {
    return this.sql
      .exec("SELECT name, at FROM events WHERE name LIKE ? AND at >= ? ORDER BY at", `${prefix}%`, since)
      .toArray() as unknown as Array<{ name: string; at: number }>;
  }

  countEvent(name: string): number {
    // 优先用累计计数器（不受 5000 条上限影响）
    const totalKey = `event:total:${name}`;
    const stored = this.getKv(totalKey);
    if (stored !== null && stored !== undefined) return Number(stored) || 0;

    // 老部署第一次读：用现有条数初始化计数器，再写回去，避免升级后数字突然变 0
    const rows = this.rows<{ total: number | null }>("SELECT COUNT(*) AS total FROM events WHERE name = ?", name);
    const legacy = rows.length ? Number(rows[0].total ?? 0) : 0;
    this.setKv(totalKey, String(legacy));
    return legacy;
  }

  firstEventAt(name: string): number | null {
    const rows = this.rows<{ at: number | null }>("SELECT MIN(at) AS at FROM events WHERE name = ?", name);
    return rows.length ? rows[0].at : null;
  }

  // ---------- 登录尝试（限速） ----------
  /** 窗口内该 IP 的失败次数 */
  countAuthFailures(ip: string, since: number): number {
    const rows = this.rows<{ failures: number | null }>(
      "SELECT COUNT(*) AS failures FROM auth_attempts WHERE ip = ? AND ok = 0 AND at > ?",
      ip.slice(0, 64),
      since,
    );
    return rows.length ? Number(rows[0].failures ?? 0) : 0;
  }

  /** 记录一次登录失败，返回窗口内累计失败次数 */
  recordAuthAttempt(ip: string, ok: boolean, at: number): number {
    this.sql.exec("INSERT INTO auth_attempts (ip, at, ok) VALUES (?, ?, ?)", ip.slice(0, 64), at, ok ? 1 : 0);
    this.sql.exec("DELETE FROM auth_attempts WHERE at < ?", at - 24 * 3600_000);
    return this.countAuthFailures(ip, at - 10 * 60_000);
  }

  clearAuthAttempts(ip: string): void {
    this.sql.exec("DELETE FROM auth_attempts WHERE ip = ?", ip.slice(0, 64));
  }

  // ---------- 待删除消息（延迟删除） ----------
  addDeletion(chat: string, msgIds: number[], dueAt: number): void {
    if (!msgIds.length) return;
    this.sql.exec(
      "INSERT INTO deletions (chat, msg_ids, due_at) VALUES (?, ?, ?)",
      chat,
      JSON.stringify(msgIds),
      dueAt,
    );
  }

  dueDeletions(now: number): Array<{ id: number; chat: string; msgIds: number[] }> {
    return this.sql
      .exec<{ id: number; chat: string; msg_ids: string; due_at: number }>(
        "SELECT * FROM deletions WHERE due_at <= ? LIMIT 20",
        now,
      )
      .toArray()
      .map((row) => ({ id: row.id, chat: row.chat, msgIds: parseJson<number[]>(row.msg_ids, []) }));
  }

  nextDeletionAt(): number | null {
    const rows = this.sql
      .exec<{ next: number | null }>("SELECT MIN(due_at) AS next FROM deletions")
      .toArray();
    return rows.length ? rows[0].next : null;
  }

  deleteDeletion(id: number): void {
    this.sql.exec("DELETE FROM deletions WHERE id = ?", id);
  }
}
