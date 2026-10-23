/**
 * Durable Object 内嵌 SQLite 存储。所有状态（任务、日志、配置、session）都在这里，
 * 不需要额外的 D1 / KV 绑定。
 */
import type { LogEntry, Schedule, Settings, Step, Target, Task, TaskInput } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      target TEXT NOT NULL,
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
      detail TEXT
    )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at DESC)`,
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
  enabled: number;
  target: string;
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
  source: string;
  created_at: number;
  updated_at: number;
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
    enabled: !!row.enabled,
    target: normalizeTarget(parseJson<Target>(row.target, { kind: "user", id: "" })),
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
    const rows = this.sql
      .exec<TaskRow>("SELECT * FROM tasks WHERE name LIKE ? ORDER BY id ASC LIMIT 1", `%${trimmed}%`)
      .toArray();
    return rows.length ? rowToTask(rows[0]) : null;
  }

  createTask(input: TaskInput, now: number, nextRunAt: number | null): Task {
    this.sql.exec(
      `INSERT INTO tasks (name, enabled, target, thread_id, schedule, steps, success_keywords,
         timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, next_run_at,
         last_run_at, last_result, last_message, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.enabled ? 1 : 0,
      JSON.stringify(input.target),
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
      `UPDATE tasks SET name = ?, enabled = ?, target = ?, thread_id = ?, schedule = ?, steps = ?,
         success_keywords = ?, timeout_seconds = ?, step_delay_seconds = ?, delete_after_seconds = ?,
         cleanup_previous = ?, next_run_at = ?, last_run_at = ?, last_result = ?, last_message = ?,
         updated_at = ?
       WHERE id = ?`,
      merged.name,
      merged.enabled ? 1 : 0,
      JSON.stringify(merged.target),
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
      now,
      id,
    );
    return this.getTask(id);
  }

  setTaskNextRun(id: number, nextRunAt: number | null): void {
    this.sql.exec("UPDATE tasks SET next_run_at = ? WHERE id = ?", nextRunAt, id);
  }

  recordRun(id: number, result: "ok" | "fail", message: string, now: number): void {
    this.sql.exec(
      "UPDATE tasks SET last_run_at = ?, last_result = ?, last_message = ?, updated_at = ? WHERE id = ?",
      now,
      result,
      message,
      now,
      id,
    );
  }

  deleteTask(id: number): void {
    this.sql.exec("DELETE FROM tasks WHERE id = ?", id);
    this.sql.exec("DELETE FROM logs WHERE task_id = ?", id);
    this.deleteKv(`task:${id}:sent`);
  }

  dueTasks(now: number, limit = 5): Task[] {
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
      "INSERT INTO logs (task_id, task_name, at, ok, level, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.taskId,
      entry.taskName,
      entry.at,
      entry.ok ? 1 : 0,
      entry.level,
      entry.message,
      entry.detail,
    );
    this.sql.exec("DELETE FROM logs WHERE id <= (SELECT MAX(id) - 500 FROM logs)");
    const row = this.sql.exec<LogRow>("SELECT * FROM logs ORDER BY id DESC LIMIT 1").toArray()[0];
    return rowToLog(row);
  }

  listLogs(limit = 100, taskId?: number): LogEntry[] {
    const bounded = Math.max(1, Math.min(500, limit));
    const rows = taskId
      ? this.sql
          .exec<LogRow>("SELECT * FROM logs WHERE task_id = ? ORDER BY id DESC LIMIT ?", taskId, bounded)
          .toArray()
      : this.sql.exec<LogRow>("SELECT * FROM logs ORDER BY id DESC LIMIT ?", bounded).toArray();
    return rows.map(rowToLog);
  }

  clearLogs(): void {
    this.sql.exec("DELETE FROM logs");
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
