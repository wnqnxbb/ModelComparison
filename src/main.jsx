import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChevronDown,
  CircleAlert,
  Loader2,
  MessageSquarePlus,
  Send,
  Settings,
  Sparkles,
  X
} from "lucide-react";
import "./styles.css";

const EMPTY_STATE_TEXT = "准备好了，随时开始";
const SYSTEM_PROMPT_STORAGE_KEY = "model-compare:system-prompt";

function fallbackUuid() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join("")
  ].join("-");
}

function createUuid() {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
}

function normalizeSystemPrompt(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatMoney(cost) {
  if (!cost || !Number.isFinite(Number(cost.totalCost))) return "";
  const amount = Number(cost.totalCost);
  const currency = cost.currency || "USD";
  if (amount > 0 && amount < 0.0001) {
    return `< ${new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 4,
      maximumFractionDigits: 4
    }).format(0.0001)}`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: amount < 0.01 ? 6 : 4,
    maximumFractionDigits: amount < 0.01 ? 6 : 4
  }).format(amount);
}

function providerLabel(provider) {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "bigmodel") return "智谱";
  if (provider === "openai-compatible") return "OpenAI 兼容";
  return provider;
}

function defaultThinkingOptionId(model) {
  if (!model?.thinkingOptions?.length) return "";
  return model.defaultThinkingOptionId ?? model.thinkingOptions[0].id;
}

function titleFromPrompt(prompt) {
  return prompt.length > 32 ? `${prompt.slice(0, 32)}...` : prompt;
}

function thinkingOptionForModel(model, thinkingOptionId) {
  if (!model?.thinkingOptions?.length) return null;
  return (
    model.thinkingOptions.find((option) => option.id === thinkingOptionId) ??
    model.thinkingOptions.find((option) => option.id === defaultThinkingOptionId(model)) ??
    model.thinkingOptions[0]
  );
}

function normalizeClientRecord(record) {
  if (!record) return null;

  if (Array.isArray(record.turns)) {
    const turns = record.turns.map((turn, index) => ({
      ...turn,
      id: turn.id ?? `${record.id}-turn-${index}`,
      results: Array.isArray(turn.results) ? turn.results : []
    }));
    return {
      ...record,
      turns,
      prompt: turns.at(-1)?.prompt ?? record.prompt,
      updatedAt: record.updatedAt ?? turns.at(-1)?.createdAt ?? record.createdAt
    };
  }

  const legacyTurn = {
    id: `${record.id}-turn-0`,
    title: record.title,
    prompt: record.prompt ?? "",
    modelIds: record.modelIds ?? record.results?.map((result) => result.modelId) ?? [],
    modelSelections: record.modelSelections ?? [],
    totalCost: record.totalCost ?? null,
    createdAt: record.createdAt,
    durationMs: record.durationMs ?? 0,
    results: Array.isArray(record.results) ? record.results : []
  };

  return {
    ...record,
    turns: [legacyTurn],
    updatedAt: record.updatedAt ?? record.createdAt
  };
}

function createPendingTurn(prompt, modelSelections, models) {
  const createdAt = new Date().toISOString();
  const results = modelSelections.map((selection) => {
    const model = models.find((item) => item.id === selection.modelId);
    const thinkingOption = thinkingOptionForModel(model, selection.thinkingOptionId);
    return {
      modelId: selection.modelId,
      modelName: model?.name ?? selection.modelId,
      provider: model?.provider ?? "",
      thinkingOption,
      status: "loading",
      content: "",
      reasoningContent: "",
      latencyMs: 0,
      usage: null,
      cost: null,
      error: null
    };
  });

  return {
    id: `pending-turn-${createUuid()}`,
    title: titleFromPrompt(prompt),
    prompt,
    modelIds: modelSelections.map((selection) => selection.modelId),
    modelSelections: results.map((result) => ({
      modelId: result.modelId,
      modelName: result.modelName,
      provider: result.provider,
      thinkingOption: result.thinkingOption
    })),
    totalCost: null,
    createdAt,
    durationMs: 0,
    results
  };
}

function createPendingConversation(prompt, modelSelections, models, currentRecord) {
  const base = normalizeClientRecord(currentRecord);
  const turn = createPendingTurn(prompt, modelSelections, models);

  if (base?.id && !String(base.id).startsWith("pending-")) {
    return {
      ...base,
      prompt,
      modelIds: turn.modelIds,
      modelSelections: turn.modelSelections,
      updatedAt: turn.createdAt,
      turns: [...base.turns, turn]
    };
  }

  return {
    id: `pending-${createUuid()}`,
    title: titleFromPrompt(prompt),
    prompt,
    modelIds: turn.modelIds,
    modelSelections: turn.modelSelections,
    totalCost: null,
    createdAt: turn.createdAt,
    updatedAt: turn.createdAt,
    durationMs: 0,
    turns: [turn]
  };
}

function updateTurnResult(record, turnId, modelId, updater) {
  const normalized = normalizeClientRecord(record);
  if (!normalized) return normalized;
  const targetTurnId = turnId ?? normalized.turns.at(-1)?.id;

  return {
    ...normalized,
    turns: normalized.turns.map((turn) => {
      if (turn.id !== targetTurnId) return turn;
      return {
        ...turn,
        results: turn.results.map((result) => {
          if (result.modelId !== modelId) return result;
          return updater(result);
        })
      };
    })
  };
}

async function readSseStream(response, onEvent) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  function processBlock(block) {
    const eventLine = block.split(/\r?\n/).find((line) => line.startsWith("event:"));
    const event = eventLine ? eventLine.slice(6).trim() : "message";
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!data) return;
    onEvent(event, JSON.parse(data));
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    blocks.filter(Boolean).forEach(processBlock);
  }

  if (buffer.trim()) {
    processBlock(buffer);
  }
}

function UsageLine({ result }) {
  if (!result.usage && !result.cost) return null;
  const pieces = [
    result.usage?.prompt_tokens ? `输入 ${result.usage.prompt_tokens}` : "",
    result.usage?.completion_tokens ? `输出 ${result.usage.completion_tokens}` : "",
    result.usage?.total_tokens ? `合计 ${result.usage.total_tokens}` : "",
    result.cost ? `费用 ${formatMoney(result.cost)}` : ""
  ].filter(Boolean);
  if (pieces.length === 0) return null;
  return <span>{pieces.join(" / ")}</span>;
}

function Sidebar({ records, activeRecordId, onNew, onSelect }) {
  const sidebarCost = records
    .map((record) => record.totalCost)
    .filter(Boolean)
    .reduce(
      (total, cost) => {
        if (total.currency && cost.currency !== total.currency) return total;
        return {
          currency: cost.currency,
          totalCost: total.totalCost + cost.totalCost
        };
      },
      { currency: "", totalCost: 0 }
    );

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <span>LLM 对比</span>
        </div>
        {sidebarCost.totalCost > 0 ? <div className="sidebar-cost">累计 {formatMoney(sidebarCost)}</div> : null}
        <button className="new-chat" type="button" onClick={onNew}>
          <MessageSquarePlus size={18} />
          <span>新对比</span>
        </button>
      </div>

      <div className="record-section">
        <div className="section-title">最近</div>
        <div className="record-list">
          {records.map((record) => (
            <button
              key={record.id}
              type="button"
              className={`record-item ${record.id === activeRecordId ? "active" : ""}`}
              onClick={() => onSelect(record.id)}
            >
              <span className="record-title">{record.title}</span>
              <span className="record-meta">
                {formatTime(record.updatedAt ?? record.createdAt)} · {record.turnCount ?? 1} 轮 ·{" "}
                {record.modelCount} 个模型
                {record.totalCost ? ` · ${formatMoney(record.totalCost)}` : ""}
              </span>
            </button>
          ))}
          {records.length === 0 ? <div className="empty-list">暂无记录</div> : null}
        </div>
      </div>
    </aside>
  );
}

function ModelPicker({
  models,
  selectedIds,
  modelThinkingOptionIds,
  maxCompareModels,
  onSelectionChange,
  onThinkingOptionChange
}) {
  const selectedModels = models.filter((model) => selectedIds.includes(model.id));
  const label =
    selectedModels.length > 0
      ? selectedModels.map((model) => model.name.replace("DeepSeek ", "")).join("、")
      : "选择模型";
  const pickerRef = useRef(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event) {
      if (!pickerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  function toggleModel(modelId) {
    if (selectedIds.includes(modelId)) {
      onSelectionChange(selectedIds.filter((id) => id !== modelId));
      return;
    }
    if (selectedIds.length >= maxCompareModels) return;
    onSelectionChange([...selectedIds, modelId]);
  }

  function selectedThinkingOptionId(model) {
    return modelThinkingOptionIds[model.id] ?? defaultThinkingOptionId(model);
  }

  return (
    <details
      ref={pickerRef}
      className="picker"
      open={open}
      onBlur={(event) => {
        const nextFocusTarget = event.relatedTarget;
        if (nextFocusTarget && pickerRef.current?.contains(nextFocusTarget)) return;
        setOpen(false);
      }}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        <Sparkles size={16} />
        <span className="picker-summary-value" title={label}>
          {label}
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className="picker-menu">
        {models.map((model) => {
          const checked = selectedIds.includes(model.id);
          const disabled = !checked && selectedIds.length >= maxCompareModels;
          return (
            <div key={model.id} className={`model-row ${disabled ? "disabled" : ""}`}>
              <button
                type="button"
                className="check-row"
                disabled={disabled}
                aria-pressed={checked}
                onClick={() => toggleModel(model.id)}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly
                  tabIndex={-1}
                  aria-hidden="true"
                />
                <span>
                  <strong>{model.name}</strong>
                  <small>{providerLabel(model.provider)}</small>
                </span>
              </button>
              {checked && model.thinkingOptions?.length ? (
                <label className="model-thinking">
                  <span>思考</span>
                  <select
                    value={selectedThinkingOptionId(model)}
                    onChange={(event) => onThinkingOptionChange(model.id, event.target.value)}
                  >
                    {model.thinkingOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          );
        })}
        <div className="picker-note">最多同时对比 {maxCompareModels} 个模型</div>
      </div>
    </details>
  );
}

function Composer({
  models,
  selectedModelIds,
  modelThinkingOptionIds,
  maxCompareModels,
  loading,
  onSelectedModelsChange,
  onThinkingOptionChange,
  onSubmit,
  onOpenSystemPrompt,
  systemPromptConfigured
}) {
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 190)}px`;
  }, [prompt]);

  function submit() {
    const text = prompt.trim();
    if (!text || loading || selectedModelIds.length === 0) return;
    onSubmit(
      text,
      selectedModelIds.map((modelId) => {
        const model = models.find((item) => item.id === modelId);
        return {
          modelId,
          thinkingOptionId: modelThinkingOptionIds[modelId] ?? defaultThinkingOptionId(model)
        };
      })
    );
    setPrompt("");
  }

  return (
    <div className="composer-shell">
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="有问题，尽管问"
          rows={1}
        />
        <button
          className="send-button"
          type="button"
          disabled={loading || !prompt.trim() || selectedModelIds.length === 0}
          onClick={submit}
          aria-label="发送"
        >
          {loading ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
        </button>
      </div>
      <div className="composer-controls">
        <ModelPicker
          models={models}
          selectedIds={selectedModelIds}
          modelThinkingOptionIds={modelThinkingOptionIds}
          maxCompareModels={maxCompareModels}
          onSelectionChange={onSelectedModelsChange}
          onThinkingOptionChange={onThinkingOptionChange}
        />
        <button
          type="button"
          className={`system-prompt-button ${systemPromptConfigured ? "configured" : ""}`}
          onClick={onOpenSystemPrompt}
        >
          <Settings size={16} />
          <span>配置 system prompt</span>
        </button>
      </div>
    </div>
  );
}

function ResultCard({ result, fallbackThinkingLabel }) {
  const success = result.status === "success";
  const loading = result.status === "loading";
  const errored = result.status === "error";
  const thinkingLabel = result.thinkingOption?.label ?? fallbackThinkingLabel;
  const meta = [providerLabel(result.provider), thinkingLabel].filter(Boolean).join(" · ");
  return (
    <article className={`result-card ${errored ? "error" : ""} ${loading ? "loading" : ""}`}>
      <header className="result-header">
        <div>
          <div className="model-name">{result.modelName}</div>
          <div className="model-provider">{meta}</div>
        </div>
        <span className={`status-pill ${success ? "ok" : errored ? "bad" : "pending"}`}>
          {success ? `${Math.max(1, Math.round(result.latencyMs / 1000))}s` : null}
          {errored ? "失败" : null}
          {loading ? (
            <>
              <Loader2 size={13} className="spin" />
              <span>输出中</span>
            </>
          ) : null}
        </span>
      </header>

      {!errored ? (
        <>
          {result.reasoningContent ? (
            <details className="reasoning">
              <summary>查看思考过程</summary>
              <div>{result.reasoningContent}</div>
            </details>
          ) : null}
          <div className={`answer ${loading && !result.content ? "placeholder" : ""}`}>
            {result.content || (loading ? "正在连接模型..." : "模型没有返回正文。")}
            {loading && result.content ? <span className="stream-caret" /> : null}
          </div>
          <footer className="result-foot">
            <UsageLine result={result} />
          </footer>
        </>
      ) : (
        <div className="error-box">
          <CircleAlert size={18} />
          <span>{result.error || "请求失败"}</span>
        </div>
      )}
    </article>
  );
}

function CompareView({ record, loading }) {
  const normalized = normalizeClientRecord(record);

  if (loading && !record) {
    return (
      <main className="main empty">
        <h1>{EMPTY_STATE_TEXT}</h1>
        <div className="loading-line">
          <Loader2 className="spin" size={18} />
          <span>正在等待模型返回</span>
        </div>
      </main>
    );
  }

  if (!normalized) {
    return (
      <main className="main empty">
        <h1>{EMPTY_STATE_TEXT}</h1>
      </main>
    );
  }

  return (
    <main className="main conversation-main">
      {normalized.totalCost ? (
        <div className="conversation-cost">累计费用 {formatMoney(normalized.totalCost)}</div>
      ) : null}
      {normalized.turns.map((turn, index) => (
        <section className="turn-block" key={turn.id}>
          <section className="prompt-block">
            <div className="prompt-label">
              <span>第 {index + 1} 轮</span>
              {turn.totalCost ? <span>本轮费用 {formatMoney(turn.totalCost)}</span> : null}
            </div>
            <p>{turn.prompt}</p>
          </section>
          <section className="compare-grid">
            {turn.results.map((result) => (
              <ResultCard
                key={result.modelId}
                result={result}
                fallbackThinkingLabel={turn.thinkingMode?.label ?? ""}
              />
            ))}
          </section>
        </section>
      ))}
    </main>
  );
}

function SystemPromptModal({ initialValue, onClose, onSave }) {
  const [draft, setDraft] = useState(initialValue ?? "");
  const textareaRef = useRef(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const clearDisabled = draft.length === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-header">
          <span>配置 system prompt</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <textarea
          ref={textareaRef}
          className="modal-textarea"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="请填写 system prompt（留空表示不发送 system 消息）"
        />
        <footer className="modal-footer">
          <button
            type="button"
            className="modal-button ghost"
            disabled={clearDisabled}
            onClick={() => setDraft("")}
          >
            清除
          </button>
          <button type="button" className="modal-button primary" onClick={() => onSave(draft)}>
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}

function App() {
  const [models, setModels] = useState([]);
  const [maxCompareModels, setMaxCompareModels] = useState(4);
  const [records, setRecords] = useState([]);
  const [activeRecord, setActiveRecord] = useState(null);
  const [selectedModelIds, setSelectedModelIds] = useState([]);
  const [modelThinkingOptionIds, setModelThinkingOptionIds] = useState({});
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(() => {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(SYSTEM_PROMPT_STORAGE_KEY);
    return normalizeSystemPrompt(stored);
  });
  const [systemPromptModalOpen, setSystemPromptModalOpen] = useState(false);

  async function refreshRecords() {
    const response = await fetch("/api/conversations");
    const payload = await response.json();
    setRecords(payload.records ?? []);
  }

  useEffect(() => {
    async function bootstrap() {
      const response = await fetch("/api/models");
      const payload = await response.json();
      const loadedModels = payload.models ?? [];
      setModels(loadedModels);
      setMaxCompareModels(payload.maxCompareModels ?? 4);
      setSelectedModelIds([]);
      setModelThinkingOptionIds(
        Object.fromEntries(loadedModels.map((model) => [model.id, defaultThinkingOptionId(model)]))
      );
      await refreshRecords();
    }
    bootstrap().catch((error) => setToast(error.message));
  }, []);

  async function loadRecord(id) {
    setToast("");
    const response = await fetch(`/api/conversations/${id}`);
    const payload = await response.json();
    if (!response.ok) {
      setToast(payload.error ?? "记录读取失败");
      return;
    }
    const record = normalizeClientRecord(payload.record);
    setActiveRecord(record);

    const latestTurn = record?.turns.at(-1);
    if (latestTurn?.modelSelections?.length) {
      setSelectedModelIds(latestTurn.modelSelections.map((selection) => selection.modelId));
      setModelThinkingOptionIds((current) => ({
        ...current,
        ...Object.fromEntries(
          latestTurn.modelSelections
            .filter((selection) => selection.thinkingOption?.id)
            .map((selection) => [selection.modelId, selection.thinkingOption.id])
        )
      }));
      return;
    }

    setSelectedModelIds([]);
  }

  function updateSelectedModels(nextModelIds) {
    setSelectedModelIds(nextModelIds);
    setModelThinkingOptionIds((current) => {
      const next = { ...current };
      for (const modelId of nextModelIds) {
        if (!next[modelId]) {
          const model = models.find((item) => item.id === modelId);
          next[modelId] = defaultThinkingOptionId(model);
        }
      }
      return next;
    });
  }

  function updateModelThinkingOption(modelId, thinkingOptionId) {
    setModelThinkingOptionIds((current) => ({
      ...current,
      [modelId]: thinkingOptionId
    }));
  }

  async function submitCompare(prompt, modelSelections) {
    setLoading(true);
    setToast("");
    const existingRecord =
      activeRecord?.id && !String(activeRecord.id).startsWith("pending-")
        ? normalizeClientRecord(activeRecord)
        : null;
    const pendingConversation = createPendingConversation(prompt, modelSelections, models, existingRecord);
    const pendingTurnId = pendingConversation.turns.at(-1)?.id;
    let currentTurnId = pendingTurnId;
    setActiveRecord(pendingConversation);
    try {
      const response = await fetch("/api/compare/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          conversationId: existingRecord?.id,
          prompt,
          modelSelections,
          ...(systemPrompt === null ? {} : { systemPrompt })
        })
      });

      console.log("[submitCompare] systemPrompt state:", systemPrompt, "sent:", systemPrompt === null ? "(not sent)" : systemPrompt);

      if (!response.ok) {
        const payload = await response.json();
        setToast(payload.error ?? "请求失败");
        return;
      }

      await readSseStream(response, (event, data) => {
        if (event === "record_start") {
          currentTurnId = data.turnId ?? currentTurnId;
          setActiveRecord((current) => {
            const normalized = normalizeClientRecord(current);
            if (!normalized) return normalized;
            return {
              ...normalized,
              id: data.id,
              title: data.title ?? normalized.title,
              prompt: data.prompt,
              createdAt: data.createdAt ?? normalized.createdAt,
              updatedAt: data.updatedAt ?? normalized.updatedAt,
              modelSelections: data.modelSelections ?? normalized.modelSelections,
              turns: normalized.turns.map((turn) => {
                if (turn.id !== pendingTurnId) return turn;
                return {
                  ...turn,
                  id: currentTurnId,
                  createdAt: data.updatedAt ?? turn.createdAt,
                  modelSelections: data.modelSelections ?? turn.modelSelections
                };
              })
            };
          });
        }

        if (event === "model_request") {
          console.log(`[${data.modelId}] request body:`, JSON.stringify(data.body, null, 2));
        }

        if (event === "model_start") {
          setActiveRecord((current) =>
            updateTurnResult(current, data.turnId ?? currentTurnId, data.modelId, (result) => ({
              ...result,
              status: "loading"
            }))
          );
        }

        if (event === "model_delta") {
          setActiveRecord((current) =>
            updateTurnResult(current, data.turnId ?? currentTurnId, data.modelId, (result) => ({
              ...result,
              status: "loading",
              content: `${result.content ?? ""}${data.contentDelta ?? ""}`,
              reasoningContent: `${result.reasoningContent ?? ""}${data.reasoningContentDelta ?? ""}`
            }))
          );
        }

        if (event === "model_done") {
          setActiveRecord((current) =>
            updateTurnResult(current, data.turnId ?? currentTurnId, data.modelId, () => data.result)
          );
        }

        if (event === "record_done") {
          setActiveRecord(normalizeClientRecord(data.record));
          refreshRecords().catch((error) => setToast(error.message));
        }

        if (event === "error") {
          setToast(data.error ?? "服务异常");
        }
      });
    } catch (error) {
      setToast(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <Sidebar
        records={records}
        activeRecordId={activeRecord?.id}
        onNew={() => {
          setActiveRecord(null);
          setSelectedModelIds([]);
          setToast("");
        }}
        onSelect={loadRecord}
      />
      <div className="workspace">
        {toast ? <div className="toast">{toast}</div> : null}
        <CompareView record={activeRecord} loading={loading} />
        <Composer
          models={models}
          selectedModelIds={selectedModelIds}
          modelThinkingOptionIds={modelThinkingOptionIds}
          maxCompareModels={maxCompareModels}
          loading={loading}
          onSelectedModelsChange={updateSelectedModels}
          onThinkingOptionChange={updateModelThinkingOption}
          onSubmit={submitCompare}
          onOpenSystemPrompt={() => setSystemPromptModalOpen(true)}
          systemPromptConfigured={systemPrompt !== null}
        />
      </div>
      {systemPromptModalOpen ? (
        <SystemPromptModal
          initialValue={systemPrompt ?? ""}
          onClose={() => setSystemPromptModalOpen(false)}
          onSave={(value) => {
            const normalizedValue = normalizeSystemPrompt(value);
            setSystemPrompt(normalizedValue);
            if (typeof window !== "undefined") {
              if (normalizedValue === null) {
                window.localStorage.removeItem(SYSTEM_PROMPT_STORAGE_KEY);
              } else {
                window.localStorage.setItem(SYSTEM_PROMPT_STORAGE_KEY, normalizedValue);
              }
            }
            setSystemPromptModalOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
