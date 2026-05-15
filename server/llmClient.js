const REQUEST_TIMEOUT_MS = 90_000;

function buildThinkingPayload(modelConfig, thinkingOption) {
  if (!thinkingOption) {
    return {};
  }

  if (modelConfig.thinkingParameterStyle === "openai-reasoning-effort") {
    return thinkingOption.effort ? { reasoning_effort: thinkingOption.effort } : {};
  }

  if (modelConfig.thinkingParameterStyle === "deepseek") {
    const payload = {
      thinking: {
        type: thinkingOption.type
      }
    };

    if (thinkingOption.type === "enabled" && thinkingOption.effort) {
      payload.reasoning_effort = thinkingOption.effort;
    }

    return payload;
  }

  if (modelConfig.thinkingParameterStyle === "bigmodel") {
    return {
      thinking: {
        type: thinkingOption.type,
        clear_thinking: true
      }
    };
  }

  return {};
}

function buildTokenLimitPayload(modelConfig) {
  if (modelConfig.usesMaxCompletionTokens) {
    return { max_completion_tokens: 4096 };
  }

  return { max_tokens: 4096 };
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return part?.text ?? part?.content ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function getNestedNumber(source, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], source);
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

export function calculateCost(modelConfig, usage) {
  const pricing = modelConfig.pricing;
  if (!pricing || !usage) return null;

  const promptTokens = numberOrZero(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = numberOrZero(usage.completion_tokens ?? usage.output_tokens);
  const cachedInputTokens = Math.min(
    promptTokens,
    getNestedNumber(usage, [
      "prompt_cache_hit_tokens",
      "prompt_tokens_details.cached_tokens",
      "input_tokens_details.cached_tokens"
    ])
  );
  const explicitCacheMissTokens = getNestedNumber(usage, ["prompt_cache_miss_tokens"]);
  const uncachedInputTokens =
    explicitCacheMissTokens > 0 ? explicitCacheMissTokens : Math.max(0, promptTokens - cachedInputTokens);
  const unitTokens = pricing.unitTokens || 1_000_000;
  const inputCost = (uncachedInputTokens / unitTokens) * pricing.input;
  const cachedInputCost = (cachedInputTokens / unitTokens) * (pricing.cachedInput ?? pricing.input);
  const outputCost = (completionTokens / unitTokens) * pricing.output;

  return {
    currency: pricing.currency,
    unitTokens,
    inputTokens: promptTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens: completionTokens,
    inputCost,
    cachedInputCost,
    outputCost,
    totalCost: inputCost + cachedInputCost + outputCost
  };
}

function extractErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.error?.message === "string") return payload.error.message;
  if (typeof payload.message === "string") return payload.message;
  return fallback;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function buildMessages(input, systemPrompt) {
  const userMessages = Array.isArray(input)
    ? input
        .filter((message) => message?.role && typeof message.content === "string")
        .map((message) => ({
          role: message.role,
          content: message.content
        }))
    : [
        {
          role: "user",
          content: String(input ?? "")
        }
      ];

  const messages = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim()) {
    messages.push({
      role: "system",
      content: systemPrompt.trim()
    });
  }
  messages.push(...userMessages);
  return messages;
}

function buildChatBody(modelConfig, input, thinkingOption, stream, systemPrompt) {
  const body = {
    model: modelConfig.model,
    messages: buildMessages(input, systemPrompt),
    stream,
    ...buildTokenLimitPayload(modelConfig),
    ...buildThinkingPayload(modelConfig, thinkingOption)
  };

  if (stream && modelConfig.supportsStreamOptionsUsage) {
    body.stream_options = {
      include_usage: true
    };
  }

  return body;
}

function emptyResult(modelConfig, thinkingOption, status = "success") {
  return {
    modelId: modelConfig.id,
    modelName: modelConfig.name,
    provider: modelConfig.provider,
    thinkingOption,
    status,
    content: "",
    reasoningContent: "",
    latencyMs: 0,
    usage: null,
    cost: null,
    error: null
  };
}

function extractDeltaText(delta) {
  return {
    content: normalizeContent(delta?.content),
    reasoningContent: normalizeContent(
      delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking_content
    )
  };
}

function parseSseBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data) return null;
  if (data === "[DONE]") return "[DONE]";

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function callModel(modelConfig, input, thinkingOption, systemPrompt) {
  const startedAt = Date.now();

  if (!modelConfig.apiKey || modelConfig.apiKey.startsWith("REPLACE_WITH_")) {
    return {
      ...emptyResult(modelConfig, thinkingOption, "error"),
      error: `请先在 .env 中配置 ${modelConfig.name} 的 API Key`
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const endpoint = `${modelConfig.baseUrl}${modelConfig.path}`;
  const body = buildChatBody(modelConfig, input, thinkingOption, false, systemPrompt);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${modelConfig.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await readJsonResponse(response);

    if (!response.ok) {
      const message = extractErrorMessage(payload, `${response.status} ${response.statusText}`);
      throw new Error(message);
    }

    const message = payload.choices?.[0]?.message ?? {};
    const usage = payload.usage ?? null;
    return {
      ...emptyResult(modelConfig, thinkingOption, "success"),
      status: "success",
      content: normalizeContent(message.content),
      reasoningContent: normalizeContent(message.reasoning_content),
      latencyMs: Date.now() - startedAt,
      usage,
      cost: calculateCost(modelConfig, usage),
      error: null
    };
  } catch (error) {
    const message = error.name === "AbortError" ? "请求超时" : error.message;
    return {
      ...emptyResult(modelConfig, thinkingOption, "error"),
      latencyMs: Date.now() - startedAt,
      error: message
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function callModelStream(modelConfig, input, thinkingOption, onDelta, options = {}) {
  const startedAt = Date.now();

  if (!modelConfig.apiKey || modelConfig.apiKey.startsWith("REPLACE_WITH_")) {
    return {
      ...emptyResult(modelConfig, thinkingOption, "error"),
      error: `请先在 server/config/models.js 配置 ${modelConfig.name} 的 API Key`
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromExternal = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromExternal, { once: true });

  const result = emptyResult(modelConfig, thinkingOption, "success");
  const endpoint = `${modelConfig.baseUrl}${modelConfig.path}`;
  const body = buildChatBody(modelConfig, input, thinkingOption, true, options.systemPrompt);
  options.onRequest?.(body);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${modelConfig.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const payload = await readJsonResponse(response);
      const message = extractErrorMessage(payload, `${response.status} ${response.statusText}`);
      throw new Error(message);
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const payload = parseSseBlock(block);
        if (!payload || payload === "[DONE]") continue;

        if (payload.usage) {
          result.usage = payload.usage;
        }

        const choice = payload.choices?.[0];
        const deltaSource = choice?.delta ?? choice?.message ?? {};
        const delta = extractDeltaText(deltaSource);

        if (delta.reasoningContent) {
          result.reasoningContent += delta.reasoningContent;
        }
        if (delta.content) {
          result.content += delta.content;
        }

        if (delta.content || delta.reasoningContent) {
          onDelta?.({
            modelId: modelConfig.id,
            contentDelta: delta.content,
            reasoningContentDelta: delta.reasoningContent
          });
        }
      }
    }

    if (buffer.trim()) {
      const payload = parseSseBlock(buffer);
      if (payload?.usage) {
        result.usage = payload.usage;
      }
    }

    result.latencyMs = Date.now() - startedAt;
    result.cost = calculateCost(modelConfig, result.usage);
    return result;
  } catch (error) {
    const message = error.name === "AbortError" ? "请求超时" : error.message;
    return {
      ...emptyResult(modelConfig, thinkingOption, "error"),
      latencyMs: Date.now() - startedAt,
      content: result.content,
      reasoningContent: result.reasoningContent,
      error: message
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromExternal);
  }
}
