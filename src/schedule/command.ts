/**
 * 任务 → 指令文本（`taskToCommand`）。
 *
 * 和 `parseTrigger` 互为反函数：编辑器里配好的任务可以「复制为指令」，
 * 便于备份、分享、或直接在收藏夹里重建。
 */
import type { Step, Target, Task } from "../types";
import { defaultName } from "./dsl";

export interface CommandSource {
  name?: string;
  target: Target;
  targets?: Target[];
  schedule: Task["schedule"];
  steps: Step[];
  successKeywords?: string[];
  timeoutSeconds?: number;
  stepDelaySeconds?: number;
  deleteAfterSeconds?: number;
  cleanupPrevious?: boolean;
  threadId?: number | null;
}

/** 需要加引号的片段：含空格 / 逗号 / 竖线 / 引号（避免被指令语法拆开） */
function quoteIfNeeded(value: string): string {
  const text = String(value ?? "");
  if (!text) return '""';
  if (/[\s|,"'\\]/.test(text)) return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return text;
}

/**
 * 这段文本直接写进指令，会不会被当成别的语法单元？
 *
 * 会的话必须加 `say:` 前缀，否则「复制指令 → 重建任务」会得到一个不一样的��务
 * （例如文本 `#kw:签到` 会被当成关键词、`btn:签到` 会被当成按钮步骤）。
 */
function needsSayPrefix(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (/^[#＃]/.test(value)) return true; // 修饰符
  if (/^(?:btn|num|rand|say|text|wait|kw|to|at|到|说|文本|按钮|数字|等待|关键词|每)\s*[:：]/i.test(value)) return true;
  if (/^[\d０-９]/.test(value)) return true; // 时间 / 数字：09:30、9点半、0930、每30分
  if (/^(?:每|once|每日|每天)$/i.test(value)) return true;
  if (/^(?:帮助|列表|help|list|删除|删除全部|禁用|启用|暂停|resume|pause)$/i.test(value)) return true;
  if (/^(?:https?:\/\/|t\.me\/|telegram\.me\/|@)/i.test(value)) return true; // 会被当成目标
  return false;
}

function textToCommand(text: string): string {
  const value = String(text ?? "");
  return needsSayPrefix(value) ? `say:${quoteIfNeeded(value)}` : quoteIfNeeded(value);
}

function scheduleToCommand(schedule: Task["schedule"]): string {
  const time = schedule.time ?? "09:00";
  switch (schedule.kind) {
    case "window":
      return `${time}-${schedule.windowEnd ?? time}`;
    case "interval": {
      const minutes = Math.max(1, Number(schedule.intervalMinutes ?? 60));
      if (minutes % 60 === 0) return `每${minutes / 60}小时`;
      return `每${minutes}分`;
    }
    case "once":
      return `${time} once`;
    case "daily":
    default:
      return time;
  }
}

function targetToCommand(target: Target): string {
  if (target.username) return `@${target.username.replace(/^@/, "")}`;
  return `到:${target.id}`;
}

function stepsToCommand(steps: Step[]): string[] {
  const parts: string[] = [];
  for (const step of steps) {
    switch (step.type) {
      case "text":
        parts.push(textToCommand(step.text ?? ""));
        break;
      case "random":
        // 选项里的 `|` 是分隔符，语法上无法表达 —— 降级成空格；含空格的要加引号
        parts.push(
          `rand:${(step.options ?? [])
            .map((item) => quoteIfNeeded(String(item).replace(/\|/g, " ")))
            .join("|")}`,
        );
        break;
      case "click":
        parts.push(
          step.text !== undefined && step.text !== ""
            ? `btn:${quoteIfNeeded(step.text)}`
            : `btn:${step.row ?? 0},${step.column ?? 0}`,
        );
        break;
      case "number":
        parts.push(`num:${quoteIfNeeded(step.value ?? "")}`);
        break;
      case "wait":
        parts.push(`wait:${Math.max(0, Number(step.seconds ?? 3))}`);
        break;
    }
  }
  return parts;
}

/**
 * @param prefix 指令前缀（设置里的 triggerPrefix）；为空则不加
 */
export function taskToCommand(task: CommandSource, prefix = "tg"): string {
  const parts: string[] = [];
  const trimmedPrefix = (prefix ?? "").trim();
  if (trimmedPrefix) parts.push(trimmedPrefix);

  parts.push(scheduleToCommand(task.schedule));
  const targets = (task.targets ?? []).filter(Boolean);
  const withThread = (item: Target) =>
    `${item.username ? `@${item.username.replace(/^@/, "")}` : item.id}${item.threadId ? `#${item.threadId}` : ""}`;
  if (targets.length > 1) {
    parts.push(`到:${targets.map(withThread).join("|")}`);
  } else if (task.target.threadId) {
    parts.push(`到:${withThread(task.target)}`);
  } else {
    parts.push(targetToCommand(task.target));
  }
  parts.push(...stepsToCommand(task.steps ?? []));

  const keywords = (task.successKeywords ?? []).filter(Boolean);
  if (keywords.length) parts.push(`#kw:${keywords.map((item) => quoteIfNeeded(String(item))).join("|")}`);

  const jitter = Math.max(0, Math.min(3600, Number(task.schedule.jitterSeconds ?? 0)));
  if (jitter > 0) parts.push(`#jitter:${jitter}`);

  const delay = Number(task.stepDelaySeconds ?? 3);
  if (Number.isFinite(delay) && delay !== 3) parts.push(`#delay:${Math.max(0, delay)}`);

  const timeout = Number(task.timeoutSeconds ?? 30);
  if (Number.isFinite(timeout) && timeout !== 30) parts.push(`#timeout:${timeout}`);

  const deleteAfter = Number(task.deleteAfterSeconds ?? 0);
  if (Number.isFinite(deleteAfter) && deleteAfter > 0) parts.push(`#delete:${deleteAfter}`);

  if (task.threadId) parts.push(`#thread:${task.threadId}`);
  if (task.cleanupPrevious === false) parts.push("#keep");

  const autoName = defaultName(task.target, "", task.steps ?? []);
  const name = (task.name ?? "").trim();
  if (name && name !== autoName) parts.push(`#name:${quoteIfNeeded(name)}`);

  return parts.join(" ");
}

/** 供前端/调试：把指令里的时间换成更易读的说明 */
export function describeScheduleKind(schedule: Task["schedule"]): string {
  switch (schedule.kind) {
    case "window":
      return "每天窗口内随机";
    case "interval":
      return "按间隔循环";
    case "once":
      return "只执行一次";
    default:
      return "每天固定时间";
  }
}
