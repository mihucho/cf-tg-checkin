/**
 * editor.js — 任务编辑器（右侧抽屉）。
 * 表单状态保存在内存 model 中，DOM 只是投影；步骤列表可增删/上下移动。
 */

import {
  el,
  icon,
  api,
  toast,
  field,
  openModal,
  withLoading,
  targetLabel,
} from "./lib.js";

const STEP_TYPES = [
  { value: "text", label: "发送文本" },
  { value: "random", label: "随机文本" },
  { value: "click", label: "点击按钮" },
  { value: "number", label: "发送数字" },
  { value: "wait", label: "等待" },
];

const SCHEDULE_KINDS = [
  { value: "daily", label: "每天定时" },
  { value: "window", label: "时间窗口" },
  { value: "interval", label: "周期循环" },
  { value: "once", label: "仅一次" },
];

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const timeValue = (value) => {
  const text = String(value || "").trim();
  if (/^\d{1,2}:\d{2}/.test(text)) {
    const [h, m] = text.split(":");
    return `${String(h).padStart(2, "0")}:${m.slice(0, 2)}`;
  }
  return "";
};

const splitLines = (value) =>
  String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function defaultStep(type) {
  switch (type) {
    case "random":
      return { type, _raw: "", options: [] };
    case "click":
      return { type, _mode: "text", text: "", row: 0, column: 0 };
    case "number":
      return { type, value: "" };
    case "wait":
      return { type, seconds: 3 };
    default:
      return { type: "text", text: "" };
  }
}

function fromStep(step) {
  if (!step || typeof step !== "object") return defaultStep("text");
  switch (step.type) {
    case "random":
      return { type: "random", _raw: (step.options || []).join("\n"), options: [...(step.options || [])] };
    case "click":
      return {
        type: "click",
        _mode: step.row !== undefined && step.row !== null && step.column !== undefined && step.column !== null
          ? "pos"
          : "text",
        text: step.text || "",
        row: Number.isFinite(Number(step.row)) ? Number(step.row) : 0,
        column: Number.isFinite(Number(step.column)) ? Number(step.column) : 0,
      };
    case "number":
      return { type: "number", value: String(step.value ?? "") };
    case "wait":
      return { type: "wait", seconds: Number(step.seconds) || 0 };
    default:
      return { type: "text", text: step.text || "" };
  }
}

const targetQueryOf = (target) => {
  if (!target) return "";
  if (target.username) return `@${target.username}`;
  return String(target.id ?? "");
};

export function openTaskEditor({ task = null, defaultTarget = "", onSaved } = {}) {
  const isEdit = Boolean(task && task.id);
  const uid = Math.random().toString(36).slice(2, 7);
  const id = (name) => `${uid}-${name}`;

  const initialTargetQuery = targetQueryOf(task && task.target);
  const model = {
    name: task?.name || "",
    enabled: task ? task.enabled !== false : true,
    targetQuery: initialTargetQuery,
    resolved: task?.target ? { ...task.target } : null,
    resolvedFor: initialTargetQuery,
    schedule: {
      kind: task?.schedule?.kind || "daily",
      time: timeValue(task?.schedule?.time) || "09:30",
      windowEnd: timeValue(task?.schedule?.windowEnd) || "10:30",
      intervalMinutes: Number(task?.schedule?.intervalMinutes) || 60,
      jitterSeconds: Number(task?.schedule?.jitterSeconds) || 0,
    },
    steps: (task?.steps && task.steps.length ? task.steps : [defaultStep("text")]).map(fromStep),
    successKeywords: (task?.successKeywords || []).join(", "),
    timeoutSeconds: task?.timeoutSeconds ?? 30,
    stepDelaySeconds: task?.stepDelaySeconds ?? 3,
    deleteAfterSeconds: task?.deleteAfterSeconds ?? 0,
    cleanupPrevious: Boolean(task?.cleanupPrevious),
  };

  /* ---------------- 基础字段 ---------------- */

  const nameInput = el("input", {
    class: "input",
    id: id("name"),
    value: model.name,
    placeholder: "例如：jerry bot 签到",
    autocomplete: "off",
    maxlength: "60",
    "data-autofocus": "",
    oninput: (event) => {
      model.name = event.target.value;
    },
  });

  const targetInput = el("input", {
    class: "input",
    id: id("target"),
    value: model.targetQuery,
    placeholder: "@username 或 数字 id",
    autocomplete: "off",
    spellcheck: "false",
    oninput: (event) => {
      model.targetQuery = event.target.value;
      renderTargetState();
    },
  });

  const targetResult = el("div", { class: "target-state" });
  let resolveButton = null;

  const enabledToggle = el("input", {
    type: "checkbox",
    id: id("enabled"),
    checked: model.enabled,
    onchange: (event) => {
      model.enabled = event.target.checked;
    },
  });

  /* ---------------- 调度 ---------------- */

  const scheduleFields = el("div", { class: "schedule-fields" });

  function renderScheduleFields() {
    scheduleFields.innerHTML = "";
    const s = model.schedule;

    if (s.kind === "daily" || s.kind === "once") {
      scheduleFields.append(
        fieldRow(
          field({ id: id("time"), label: s.kind === "once" ? "执行时间" : "每天执行时间", control: timeInput("time", s.time) }),
          s.kind === "once"
            ? el("p", { class: "field-hint" }, "只执行一次，执行后任务会自动停用（若服务端支持）。")
            : null,
        ),
      );
    } else if (s.kind === "window") {
      scheduleFields.append(
        fieldRow(
          field({ id: id("time"), label: "窗口开始", control: timeInput("time", s.time) }),
          field({ id: id("windowEnd"), label: "窗口结束", control: timeInput("windowEnd", s.windowEnd) }),
        ),
        el("p", { class: "field-hint" }, "在起止时间之间随机挑一个时间点执行一次。"),
      );
    } else if (s.kind === "interval") {
      scheduleFields.append(
        fieldRow(
          field({
            id: id("intervalMinutes"),
            label: "间隔（分钟）",
            control: numberInput("intervalMinutes", s.intervalMinutes, { min: 1, max: 10080, step: 1 }),
          }),
        ),
        el("p", { class: "field-hint" }, "例如 120 表示每 2 小时执行一次。"),
      );
    }

    scheduleFields.append(
      fieldRow(
        field({
          id: id("jitterSeconds"),
          label: "随机延迟（秒）",
          control: numberInput("jitterSeconds", s.jitterSeconds, { min: 0, max: 3600, step: 1 }),
          hint: "每次执行前随机等待 0–N 秒，避免固定时间点被识别。",
        }),
      ),
    );
  }

  function timeInput(key, value) {
    const input = el("input", {
      class: "input",
      id: id(key),
      type: "time",
      value: value || "",
      oninput: (event) => {
        model.schedule[key] = event.target.value;
      },
    });
    return input;
  }

  function numberInput(key, value, { min, max, step } = {}) {
    const input = el("input", {
      class: "input",
      id: id(key),
      type: "number",
      inputmode: "numeric",
      min: min === undefined ? undefined : String(min),
      max: max === undefined ? undefined : String(max),
      step: step === undefined ? undefined : String(step),
      value: String(value ?? 0),
      oninput: (event) => {
        model.schedule[key] = event.target.value === "" ? "" : Number(event.target.value);
      },
    });
    return input;
  }

  const scheduleSegments = el(
    "div",
    { class: "segments", role: "radiogroup", "aria-label": "调度类型" },
    SCHEDULE_KINDS.map((kind) =>
      el(
        "label",
        { class: "segment" },
        el("input", {
          type: "radio",
          name: id("schedule-kind"),
          value: kind.value,
          checked: model.schedule.kind === kind.value,
          onchange: () => {
            model.schedule.kind = kind.value;
            renderScheduleFields();
          },
        }),
        el("span", {}, kind.label),
      ),
    ),
  );

  /* ---------------- 步骤 ---------------- */

  const stepsList = el("div", { class: "steps-list" });

  function renderSteps() {
    stepsList.innerHTML = "";
    if (model.steps.length === 0) {
      stepsList.append(
        el("p", { class: "steps-empty" }, "还没有动作。签到任务通常需要至少一步，例如发送「签到」或点击「立即签到」。"),
      );
    }
    model.steps.forEach((step, index) => stepsList.append(renderStepRow(step, index)));
  }

  function renderStepRow(step, index) {
    const fields = el("div", { class: "step-fields" });
    renderStepFields(step, index, fields);

    const typeSelect = el(
      "select",
      {
        class: "select step-type",
        "aria-label": `第 ${index + 1} 步的动作类型`,
        onchange: (event) => {
          const nextType = event.target.value;
          const replacement = defaultStep(nextType);
          // 保留可复用的文本
          if (nextType === "text" && (step.text || "").trim()) replacement.text = step.text;
          if (nextType === "random" && step.type === "text" && (step.text || "").trim()) {
            replacement._raw = step.text;
            replacement.options = splitLines(step.text);
          }
          model.steps[index] = replacement;
          renderSteps();
        },
      },
      STEP_TYPES.map((type) =>
        el(
          "option",
          { value: type.value, selected: type.value === step.type ? true : undefined },
          type.label,
        ),
      ),
    );

    return el(
      "div",
      { class: "step", dataset: { index: String(index) } },
      el(
        "div",
        { class: "step-head" },
        el("span", { class: "step-index" }, String(index + 1)),
        typeSelect,
        el(
          "div",
          { class: "step-tools" },
          iconBtn("up", `上移第 ${index + 1} 步`, index === 0, () => {
            if (index === 0) return;
            const [item] = model.steps.splice(index, 1);
            model.steps.splice(index - 1, 0, item);
            renderSteps();
          }),
          iconBtn("down", `下移第 ${index + 1} 步`, index === model.steps.length - 1, () => {
            if (index >= model.steps.length - 1) return;
            const [item] = model.steps.splice(index, 1);
            model.steps.splice(index + 1, 0, item);
            renderSteps();
          }),
          iconBtn("trash", `删除第 ${index + 1} 步`, false, () => {
            model.steps.splice(index, 1);
            renderSteps();
          }, "is-danger"),
        ),
      ),
      fields,
    );
  }

  function iconBtn(name, label, disabled, onClick, extraClass = "") {
    return el(
      "button",
      {
        class: `btn btn-icon btn-xs${extraClass ? ` ${extraClass}` : ""}`,
        type: "button",
        title: label,
        "aria-label": label,
        disabled: disabled || undefined,
        onclick: onClick,
      },
      icon(name, { size: 14 }),
    );
  }

  function renderStepFields(step, index, container) {
    container.innerHTML = "";
    const prefix = `step-${index}`;

    if (step.type === "text") {
      container.append(
        field({
          id: id(`${prefix}-text`),
          label: "文本内容",
          control: el("input", {
            class: "input",
            id: id(`${prefix}-text`),
            value: step.text || "",
            placeholder: "签到",
            oninput: (event) => {
              step.text = event.target.value;
            },
          }),
        }),
      );
    } else if (step.type === "random") {
      container.append(
        field({
          id: id(`${prefix}-options`),
          label: "候选项（一行一个）",
          control: el("textarea", {
            class: "textarea",
            id: id(`${prefix}-options`),
            rows: "3",
            placeholder: "早安\n午安\n晚上好",
            oninput: (event) => {
              step._raw = event.target.value;
              step.options = splitLines(event.target.value);
            },
          }, step._raw || ""),
          hint: "每次执行随机挑一条发送。",
        }),
      );
    } else if (step.type === "click") {
      const modeSelect = el(
        "select",
        {
          class: "select",
          id: id(`${prefix}-mode`),
          onchange: (event) => {
            step._mode = event.target.value;
            renderSteps();
          },
        },
        el("option", { value: "text", selected: step._mode !== "pos" ? true : undefined }, "按按钮文本"),
        el("option", { value: "pos", selected: step._mode === "pos" ? true : undefined }, "按行列位置"),
      );
      container.append(
        field({ id: id(`${prefix}-mode`), label: "怎么找按钮", control: modeSelect }),
      );
      if (step._mode === "pos") {
        container.append(
          fieldRow(
            field({
              id: id(`${prefix}-row`),
              label: "行（0 基）",
              control: el("input", {
                class: "input",
                id: id(`${prefix}-row`),
                type: "number",
                min: "0",
                step: "1",
                value: String(step.row ?? 0),
                oninput: (event) => {
                  step.row = Number(event.target.value);
                },
              }),
            }),
            field({
              id: id(`${prefix}-column`),
              label: "列（0 基）",
              control: el("input", {
                class: "input",
                id: id(`${prefix}-column`),
                type: "number",
                min: "0",
                step: "1",
                value: String(step.column ?? 0),
                oninput: (event) => {
                  step.column = Number(event.target.value);
                },
              }),
            }),
          ),
        );
      } else {
        container.append(
          field({
            id: id(`${prefix}-click-text`),
            label: "按钮文本",
            control: el("input", {
              class: "input",
              id: id(`${prefix}-click-text`),
              value: step.text || "",
              placeholder: "立即签到",
              oninput: (event) => {
                step.text = event.target.value;
              },
            }),
            hint: "先找文字完全一致的，再找包含这段文字的。",
          }),
        );
      }
    } else if (step.type === "number") {
      container.append(
        field({
          id: id(`${prefix}-value`),
          label: "数字",
          control: el("input", {
            class: "input",
            id: id(`${prefix}-value`),
            value: step.value || "",
            inputmode: "numeric",
            placeholder: "1",
            oninput: (event) => {
              step.value = event.target.value;
            },
          }),
          hint: "部分 bot 用数字键盘交互，直接发送数字即可。",
        }),
      );
    } else if (step.type === "wait") {
      container.append(
        field({
          id: id(`${prefix}-seconds`),
          label: "等待秒数",
          control: el("input", {
            class: "input",
            id: id(`${prefix}-seconds`),
            type: "number",
            min: "0.5",
            step: "0.5",
            value: String(step.seconds ?? 0),
            oninput: (event) => {
              step.seconds = Number(event.target.value);
            },
          }),
          hint: "用于等待 bot 响应或翻牌动画。",
        }),
      );
    }
  }

  const addStepButtons = el(
    "div",
    { class: "steps-add" },
    el("span", { class: "steps-add-label" }, "添加动作"),
    STEP_TYPES.map((type) =>
      el(
        "button",
        {
          class: "btn btn-ghost btn-xs",
          type: "button",
          onclick: () => {
            model.steps.push(defaultStep(type.value));
            renderSteps();
          },
        },
        `+ ${type.label}`,
      ),
    ),
  );

  /* ---------------- 高级 ---------------- */

  const advanced = el(
    "details",
    { class: "editor-advanced" },
    el("summary", {}, "高级选项"),
    el(
      "div",
      { class: "advanced-body" },
      field({
        id: id("keywords"),
        label: "成功关键词",
        control: el("input", {
          class: "input",
          id: id("keywords"),
          value: model.successKeywords,
          placeholder: "签到成功, 已签到",
          oninput: (event) => {
            model.successKeywords = event.target.value;
          },
        }),
        hint: "用逗号分隔。机器人回复里出现任意一个词就算成功；留空则只要没报错就算成功。",
      }),
      fieldRow(
        field({
          id: id("timeout"),
          label: "超时（秒）",
          control: el("input", {
            class: "input",
            id: id("timeout"),
            type: "number",
            min: "5",
            max: "120",
            step: "1",
            value: String(model.timeoutSeconds ?? 30),
            oninput: (event) => {
              model.timeoutSeconds = Number(event.target.value);
            },
          }),
        }),
        field({
          id: id("delete-after"),
          label: "执行后删除消息（秒）",
          control: el("input", {
            class: "input",
            id: id("delete-after"),
            type: "number",
            min: "0",
            max: "86400",
            step: "1",
            value: String(model.deleteAfterSeconds ?? 0),
            oninput: (event) => {
              model.deleteAfterSeconds = Number(event.target.value);
            },
          }),
          hint: "0 表示不删。填了就在这么多秒后删掉自己发出的消息。",
        }),
      ),
      field({
        id: id("step-delay"),
        label: "两步之间间隔（秒）",
        control: el("input", {
          class: "input",
          id: id("step-delay"),
          type: "number",
          min: "0",
          max: "60",
          step: "1",
          value: String(model.stepDelaySeconds ?? 3),
          oninput: (event) => {
            model.stepDelaySeconds = Number(event.target.value);
          },
        }),
        hint: "每执行完一步停多久再做下一步，默认 3 秒。机器人反应慢可以调大。",
      }),
      el(
        "label",
        { class: "check-row" },
        el("input", {
          type: "checkbox",
          id: id("cleanup"),
          checked: model.cleanupPrevious,
          onchange: (event) => {
            model.cleanupPrevious = event.target.checked;
          },
        }),
        el("span", {}, "每次执行前删除上一次自己发的消息"),
      ),
    ),
  );

  /* ---------------- 目标解析 ---------------- */

  function renderTargetState(message) {
    targetResult.innerHTML = "";
    const query = model.targetQuery.trim();
    if (!query) {
      targetResult.append(
        el(
          "p",
          { class: "field-hint" },
          defaultTarget
            ? `留空时，会发到设置里的默认目标：${defaultTarget}`
            : "填 @username 或数字 id；点「解析」可以确认解析到的会话。",
        ),
      );
      return;
    }
    if (model.resolved && model.resolvedFor === query) {
      targetResult.append(
        el(
          "div",
          { class: "resolved-chip" },
          icon("check", { size: 14 }),
          el("span", {}, targetLabel(model.resolved)),
          model.resolved.kind ? el("span", { class: "muted small" }, `${model.resolved.kind}${model.resolved.id ? ` · ${model.resolved.id}` : ""}`) : null,
        ),
      );
      return;
    }
    targetResult.append(
      el(
        "p",
        { class: message ? "field-hint is-error" : "field-hint" },
        message || "未解析。保存时会按原值写入目标，服务端发送时再解析。",
      ),
    );
  }

  async function doResolve() {
    const query = model.targetQuery.trim();
    if (!query) {
      toast("先填一个目标再解析", { kind: "error" });
      targetInput.focus();
      return;
    }
    await withLoading(resolveButton, async () => {
      try {
        const res = await api("/api/resolve", { method: "POST", body: { query } });
        const peer = res && res.peer;
        if (!peer) throw new Error("服务端没有返回目标信息");
        model.resolved = peer;
        model.resolvedFor = query;
        renderTargetState();
        toast(`已解析：${targetLabel(peer)}`, { kind: "ok" });
      } catch (error) {
        model.resolved = null;
        model.resolvedFor = "";
        renderTargetState(error.message || "解析失败");
        toast(error.message || "解析失败", { kind: "error" });
      }
    });
  }

  resolveButton = el(
    "button",
    { class: "btn", type: "button", onclick: doResolve },
    icon("target", { size: 15 }),
    el("span", {}, "解析"),
  );

  /* ---------------- 组装 ---------------- */

  const body = el(
    "div",
    { class: "editor" },
    el(
      "div",
      { class: "editor-top" },
      el(
        "label",
        { class: "switch", for: id("enabled") },
        enabledToggle,
        el("span", { class: "switch-track", "aria-hidden": "true" }),
        el("span", { class: "switch-text" }, model.enabled ? "任务已启用" : "任务已停用"),
      ),
      el("span", { class: "muted small" }, isEdit ? `任务 #${task.id}` : "新建任务"),
    ),
    el(
      "section",
      { class: "editor-section" },
      el("h3", { class: "editor-section-title" }, "基本信息"),
      field({ id: id("name"), label: "任务名称", control: nameInput }),
      el(
        "div",
        { class: "field" },
        el("label", { class: "field-label", for: id("target") }, "目标会话"),
        el("div", { class: "input-row" }, targetInput, resolveButton),
        targetResult,
      ),
    ),
    el(
      "section",
      { class: "editor-section" },
      el("h3", { class: "editor-section-title" }, "调度"),
      scheduleSegments,
      scheduleFields,
    ),
    el(
      "section",
      { class: "editor-section" },
      el("h3", { class: "editor-section-title" }, "动作"),
      el("p", { class: "editor-section-desc" }, "按顺序执行。需要等机器人回复时，中间加一步「等待」即可。"),
      stepsList,
      addStepButtons,
    ),
    advanced,
  );

  // 启用开关的文案跟随变化
  enabledToggle.addEventListener("change", () => {
    const text = body.querySelector(".switch-text");
    if (text) text.textContent = model.enabled ? "任务已启用" : "任务已停用";
  });

  const errorBox = el("p", { class: "form-error", role: "alert", hidden: true });

  const cancelButton = el(
    "button",
    { class: "btn", type: "button", onclick: () => closeEditor() },
    "取消",
  );
  const saveButton = el(
    "button",
    { class: "btn btn-primary", type: "button", "data-autofocus": "", onclick: save },
    "保存任务",
  );

  const modal = openModal({
    title: isEdit ? "编辑任务" : "新建任务",
    variant: "drawer",
    body: el("div", {}, body, errorBox),
    footer: el("div", { class: "dialog-actions" }, cancelButton, saveButton),
  });

  function closeEditor() {
    modal?.close();
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
    toast(message, { kind: "error" });
  }

  /** 目标显示名：群名 / 机器人名 → @username → id */
  function targetDisplayName(target) {
    if (!target) return "";
    return target.title || (target.username ? `@${target.username}` : "") || String(target.id || "");
  }

  /** 任务名为空时，用「目标名 + 第一个动作」自动生成 */
  function suggestName() {
    const target = model.resolved && model.resolvedFor === model.targetQuery.trim() ? model.resolved : null;
    const base = targetDisplayName(target) || model.targetQuery.trim();
    if (!base) return "";
    const firstText = (model.steps.find((step) => step.type === "text") || {}).text || "";
    const firstRandom = (model.steps.find((step) => step.type === "random") || {}).options?.[0] || "";
    const action = firstText || firstRandom || "签到";
    const name = `${base} ${action}`.trim();
    return name.length > 40 ? name.slice(0, 40) : name;
  }

  function buildTarget() {
    const query = model.targetQuery.trim();
    if (!query) return null;
    if (model.resolved && model.resolvedFor === query) return { ...model.resolved };
    if (/^-?\d+$/.test(query)) return { kind: "user", id: query, title: query, username: null };
    const username = query.startsWith("@") ? query.slice(1) : null;
    return { kind: "user", id: query, title: query, username };
  }

  function buildSchedule() {
    const s = model.schedule;
    const jitterSeconds = clampInt(s.jitterSeconds, 0, 3600, 0);
    if (s.kind === "interval") {
      const minutes = clampInt(s.intervalMinutes, 1, 10080, 0);
      if (!minutes) throw new Error("间隔至少 1 分钟");
      return { kind: "interval", intervalMinutes: minutes, jitterSeconds };
    }
    const time = timeValue(s.time);
    if (!time) throw new Error("请填写执行时间（HH:MM）");
    if (s.kind === "window") {
      const windowEnd = timeValue(s.windowEnd);
      if (!windowEnd) throw new Error("请填写窗口结束时间");
      if (windowEnd === time) throw new Error("窗口开始和结束时间不能相同");
      return { kind: "window", time, windowEnd, jitterSeconds };
    }
    if (s.kind === "once") return { kind: "once", time, jitterSeconds };
    return { kind: "daily", time, jitterSeconds };
  }

  function buildSteps() {
    if (model.steps.length === 0) throw new Error("至少需要一个动作");
    return model.steps.map((step, index) => {
      const label = `第 ${index + 1} 步`;
      if (step.type === "text") {
        const text = String(step.text || "").trim();
        if (!text) throw new Error(`${label}：文本内容不能为空`);
        return { type: "text", text };
      }
      if (step.type === "random") {
        const options = splitLines(step._raw ?? (step.options || []).join("\n"));
        if (options.length === 0) throw new Error(`${label}：至少填一个候选项`);
        return { type: "random", options };
      }
      if (step.type === "click") {
        if (step._mode === "pos") {
          const row = clampInt(step.row, 0, 99, -1);
          const column = clampInt(step.column, 0, 99, -1);
          if (row < 0 || column < 0) throw new Error(`${label}：行列必须是 ≥ 0 的整数`);
          return { type: "click", row, column };
        }
        const text = String(step.text || "").trim();
        if (!text) throw new Error(`${label}：按钮文本不能为空`);
        return { type: "click", text };
      }
      if (step.type === "number") {
        const value = String(step.value ?? "").trim();
        if (!value) throw new Error(`${label}：数字不能为空`);
        return { type: "number", value };
      }
      if (step.type === "wait") {
        const seconds = Number(step.seconds);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${label}：等待秒数必须大于 0`);
        return { type: "wait", seconds };
      }
      throw new Error(`${label}：未知的动作类型`);
    });
  }

  async function save() {
    errorBox.hidden = true;
    await withLoading(saveButton, async () => {
      try {
        let name = model.name.trim();
        if (!name) {
          name = suggestName();
          if (!name) throw new Error("请填写任务名称");
          model.name = name;
        }
        const target = buildTarget();
        if (!target) throw new Error("请填写任务目标，或使用设置里的默认目标");
        const schedule = buildSchedule();
        const steps = buildSteps();
        const keywords = String(model.successKeywords || "")
          .split(/[,，、\n]+/)
          .map((item) => item.trim())
          .filter(Boolean);

        const payload = {
          name,
          enabled: Boolean(model.enabled),
          target,
          schedule,
          steps,
          successKeywords: keywords,
          timeoutSeconds: clampInt(model.timeoutSeconds, 5, 120, 30),
          stepDelaySeconds: clampInt(model.stepDelaySeconds, 0, 60, 3),
          deleteAfterSeconds: clampInt(model.deleteAfterSeconds, 0, 86400, 0),
          cleanupPrevious: Boolean(model.cleanupPrevious),
        };
        if (task && task.threadId) payload.threadId = task.threadId;

        const res = isEdit
          ? await api(`/api/tasks/${task.id}`, { method: "PATCH", body: payload })
          : await api("/api/tasks", { method: "POST", body: payload });

        toast(isEdit ? "任务已更新" : "任务已创建", { kind: "ok" });
        closeEditor();
        if (typeof onSaved === "function") await onSaved(res && res.task);
      } catch (error) {
        showError(error.message || "保存失败");
      }
    });
  }

  /* ---------------- 初始化 ---------------- */

  renderSteps();
  renderScheduleFields();
  renderTargetState();

  return { close: closeEditor };
}

/* ---------------- 局部小工具 ---------------- */

function fieldRow(...children) {
  const rows = children.filter(Boolean);
  return el("div", { class: `form-row${rows.length > 1 ? "" : " form-row-single"}` }, rows);
}
