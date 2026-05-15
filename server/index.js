import express from "express";
import { randomUUID as nodeRandomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultThinkingOptionForModel,
  findModel,
  findThinkingOption,
  MAX_COMPARE_MODELS,
  publicModelCatalog
} from "./config/models.js";
import { callModel, callModelStream } from "./llmClient.js";
import { getRecord, listRecordSummaries, upsertRecord } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(express.json({ limit: "1mb" }));

function createUuid() {
  return globalThis.crypto?.randomUUID?.() ?? nodeRandomUUID();
}

function resolveCompareRequest(body) {
  const prompt = String(body.prompt ?? "").trim();
  const systemPrompt =
    body.systemPrompt === undefined || body.systemPrompt === null
      ? undefined
      : String(body.systemPrompt);
  const modelSelections = Array.isArray(body.modelSelections)
    ? body.modelSelections
    : Array.isArray(body.modelIds)
      ? body.modelIds.map((modelId) => ({
          modelId,
          thinkingOptionId: body.thinkingModeId
        }))
      : [];

  if (!prompt) {
    return { error: "请输入要对比的问题", status: 400 };
  }

  if (modelSelections.length === 0 || modelSelections.length > MAX_COMPARE_MODELS) {
    return { error: `请选择 1 到 ${MAX_COMPARE_MODELS} 个模型`, status: 400 };
  }

  const uniqueSelections = [];
  const seenModelIds = new Set();
  for (const selection of modelSelections) {
    const modelId = String(selection?.modelId ?? "");
    if (!modelId || seenModelIds.has(modelId)) continue;
    seenModelIds.add(modelId);
    uniqueSelections.push({
      modelId,
      thinkingOptionId: selection?.thinkingOptionId
    });
  }

  const selectedEntries = uniqueSelections.map((selection) => {
    const model = findModel(selection.modelId);
    const thinkingOption = selection.thinkingOptionId
      ? findThinkingOption(model, String(selection.thinkingOptionId))
      : defaultThinkingOptionForModel(model);
    return {
      model,
      thinkingOption
    };
  });

  if (selectedEntries.length === 0 || selectedEntries.some((entry) => !entry.model)) {
    return { error: "包含未配置的模型", status: 400 };
  }

  const hasInvalidThinkingOption = selectedEntries.some((entry, index) => {
    const requestedOptionId = uniqueSelections[index].thinkingOptionId;
    if (!requestedOptionId || !entry.model.thinkingOptions?.length) return false;
    return !entry.model.thinkingOptions.some((option) => option.id === requestedOptionId);
  });

  if (hasInvalidThinkingOption) {
    return { error: "包含未配置的思考方式", status: 400 };
  }

  return {
    prompt,
    systemPrompt,
    selectedEntries
  };
}

function aggregateCostValues(costValues) {
  const costs = costValues.filter(Boolean);
  if (costs.length === 0) return null;

  const currency = costs[0].currency;
  if (costs.some((cost) => cost.currency !== currency)) {
    return null;
  }

  return costs.reduce(
    (total, cost) => ({
      currency,
      inputTokens: total.inputTokens + cost.inputTokens,
      cachedInputTokens: total.cachedInputTokens + cost.cachedInputTokens,
      uncachedInputTokens: total.uncachedInputTokens + cost.uncachedInputTokens,
      outputTokens: total.outputTokens + cost.outputTokens,
      inputCost: total.inputCost + cost.inputCost,
      cachedInputCost: total.cachedInputCost + cost.cachedInputCost,
      outputCost: total.outputCost + cost.outputCost,
      totalCost: total.totalCost + cost.totalCost
    }),
    {
      currency,
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      inputCost: 0,
      cachedInputCost: 0,
      outputCost: 0,
      totalCost: 0
    }
  );
}

function aggregateCosts(results) {
  return aggregateCostValues(results.map((result) => result.cost));
}

function aggregateTurnCosts(turns) {
  return aggregateCostValues(turns.map((turn) => turn.totalCost));
}

function titleFromPrompt(prompt) {
  return prompt.length > 32 ? `${prompt.slice(0, 32)}...` : prompt;
}

function modelSelectionsFromEntries(selectedEntries) {
  return selectedEntries.map((entry) => ({
    modelId: entry.model.id,
    modelName: entry.model.name,
    provider: entry.model.provider,
    thinkingOption: entry.thinkingOption
  }));
}

function buildModelMessages(record, prompt, modelId) {
  const messages = [];
  for (const turn of record?.turns ?? []) {
    if (turn.prompt) {
      messages.push({
        role: "user",
        content: turn.prompt
      });
    }

    const previousResult = turn.results?.find((result) => result.modelId === modelId);
    if (previousResult?.content) {
      messages.push({
        role: "assistant",
        content: previousResult.content
      });
    }
  }

  messages.push({
    role: "user",
    content: prompt
  });

  return messages;
}

function buildTurn({ id, prompt, selectedEntries, results, startedAt, createdAt = new Date().toISOString() }) {
  const totalCost = aggregateCosts(results);
  const modelSelections = modelSelectionsFromEntries(selectedEntries);

  return {
    id,
    title: titleFromPrompt(prompt),
    prompt,
    modelIds: selectedEntries.map((entry) => entry.model.id),
    modelSelections,
    totalCost,
    createdAt,
    durationMs: Date.now() - startedAt,
    results
  };
}

function buildConversation({ id, existingRecord, turn }) {
  const turns = [...(existingRecord?.turns ?? []), turn];
  const totalCost = aggregateTurnCosts(turns);
  const durationMs = turns.reduce((total, item) => total + (item.durationMs ?? 0), 0);

  return {
    id,
    title: existingRecord?.title ?? titleFromPrompt(turn.prompt),
    prompt: turn.prompt,
    modelIds: turn.modelIds,
    modelSelections: turn.modelSelections,
    totalCost,
    createdAt: existingRecord?.createdAt ?? turn.createdAt,
    updatedAt: turn.createdAt,
    durationMs,
    turns
  };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/api/models", (_req, res) => {
  res.json({
    models: publicModelCatalog(),
    maxCompareModels: MAX_COMPARE_MODELS
  });
});

app.get("/api/conversations", async (_req, res, next) => {
  try {
    res.json({ records: await listRecordSummaries() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/conversations/:id", async (req, res, next) => {
  try {
    const record = await getRecord(req.params.id);
    if (!record) {
      res.status(404).json({ error: "记录不存在" });
      return;
    }
    res.json({ record });
  } catch (error) {
    next(error);
  }
});

app.post("/api/compare", async (req, res, next) => {
  try {
    const resolved = resolveCompareRequest(req.body);
    if (resolved.error) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    const { prompt, systemPrompt, selectedEntries } = resolved;
    const existingRecord = req.body.conversationId ? await getRecord(String(req.body.conversationId)) : null;
    if (req.body.conversationId && !existingRecord) {
      res.status(404).json({ error: "记录不存在" });
      return;
    }

    const conversationId = existingRecord?.id ?? createUuid();
    const startedAt = Date.now();
    const results = await Promise.all(
      selectedEntries.map((entry) =>
        callModel(
          entry.model,
          buildModelMessages(existingRecord, prompt, entry.model.id),
          entry.thinkingOption,
          systemPrompt
        )
      )
    );
    const turn = buildTurn({
      id: createUuid(),
      prompt,
      selectedEntries,
      results,
      startedAt
    });
    const record = buildConversation({
      id: conversationId,
      existingRecord,
      turn
    });

    await upsertRecord(record);
    res.json({ record, turn });
  } catch (error) {
    next(error);
  }
});

app.post("/api/compare/stream", async (req, res, next) => {
  const resolved = resolveCompareRequest(req.body);
  if (resolved.error) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }

  const { prompt, systemPrompt, selectedEntries } = resolved;
  const existingRecord = req.body.conversationId ? await getRecord(String(req.body.conversationId)) : null;
  if (req.body.conversationId && !existingRecord) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }

  const startedAt = Date.now();
  const recordId = existingRecord?.id ?? createUuid();
  const turnId = createUuid();
  const turnCreatedAt = new Date().toISOString();
  let clientClosed = false;
  const abortController = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) {
      clientClosed = true;
      abortController.abort();
    }
  });

  try {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    sendSse(res, "record_start", {
      id: recordId,
      turnId,
      title: existingRecord?.title ?? titleFromPrompt(prompt),
      prompt,
      createdAt: existingRecord?.createdAt ?? turnCreatedAt,
      updatedAt: turnCreatedAt,
      modelSelections: modelSelectionsFromEntries(selectedEntries)
    });

    const results = await Promise.all(
      selectedEntries.map(async (entry) => {
        sendSse(res, "model_start", {
          turnId,
          modelId: entry.model.id
        });

        const result = await callModelStream(
          entry.model,
          buildModelMessages(existingRecord, prompt, entry.model.id),
          entry.thinkingOption,
          (delta) => {
            if (!clientClosed) {
              sendSse(res, "model_delta", {
                ...delta,
                turnId
              });
            }
          },
          { signal: abortController.signal, systemPrompt, onRequest: (body) => {
            if (!clientClosed) sendSse(res, "model_request", { modelId: entry.model.id, body });
          } }
        );

        if (!clientClosed) {
          sendSse(res, "model_done", {
            turnId,
            modelId: entry.model.id,
            result
          });
        }

        return result;
      })
    );

    if (clientClosed) return;

    const turn = buildTurn({
      id: turnId,
      prompt,
      selectedEntries,
      results,
      startedAt,
      createdAt: turnCreatedAt
    });
    const record = buildConversation({
      id: recordId,
      existingRecord,
      turn
    });

    await upsertRecord(record);
    sendSse(res, "record_done", { record, turn });
    sendSse(res, "done", {});
    res.end();
  } catch (error) {
    if (clientClosed) return;
    if (!res.headersSent) {
      next(error);
      return;
    }
    sendSse(res, "error", { error: "服务异常" });
    res.end();
  }
});

if (process.env.NODE_ENV === "production") {
  const distDir = path.resolve(__dirname, "../dist");
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "服务异常" });
});

app.listen(port, () => {
  console.log(`model-diff api listening on http://127.0.0.1:${port}`);
});
