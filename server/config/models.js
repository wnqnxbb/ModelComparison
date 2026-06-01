import "dotenv/config";

const API_KEYS = {
  deepseek: process.env.DEEPSEEK_API_KEY ?? "",
  bigmodel: process.env.BIGMODEL_API_KEY ?? "",
  gpt55: process.env.GPT55_API_KEY ?? ""
};

const DEEPSEEK_THINKING_OPTIONS = [
  {
    id: "off",
    label: "关闭思考",
    type: "disabled",
    effort: null
  },
  {
    id: "on",
    label: "开启思考",
    type: "enabled",
    effort: null
  },
  {
    id: "high",
    label: "深度思考",
    type: "enabled",
    effort: "high"
  },
  {
    id: "max",
    label: "最强思考",
    type: "enabled",
    effort: "max"
  }
];

const GLM_THINKING_OPTIONS = [
  {
    id: "off",
    label: "关闭思考",
    type: "disabled",
    effort: null
  },
  {
    id: "on",
    label: "开启思考",
    type: "enabled",
    effort: null
  }
];

const OPENAI_GPT55_THINKING_OPTIONS = [
  {
    id: "none",
    label: "None",
    effort: "none"
  },
  {
    id: "low",
    label: "Low",
    effort: "low"
  },
  {
    id: "medium",
    label: "Medium",
    effort: "medium"
  },
  {
    id: "high",
    label: "High",
    effort: "high"
  },
  {
    id: "xhigh",
    label: "XHigh",
    effort: "xhigh"
  }
];

const USD = "USD";

export const MODEL_CATALOG = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: API_KEYS.deepseek,
    baseUrl: "https://api.deepseek.com",
    path: "/chat/completions",
    thinkingParameterStyle: "deepseek",
    thinkingOptions: DEEPSEEK_THINKING_OPTIONS,
    defaultThinkingOptionId: "on",
    supportsStreamOptionsUsage: true,
    pricing: {
      currency: USD,
      unitTokens: 1_000_000,
      input: 0.435,
      cachedInput: 0.003625,
      output: 0.87,
      note: "DeepSeek V4 Pro promotional price until 2026-05-31"
    }
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiKey: API_KEYS.deepseek,
    baseUrl: "https://api.deepseek.com",
    path: "/chat/completions",
    thinkingParameterStyle: "deepseek",
    thinkingOptions: DEEPSEEK_THINKING_OPTIONS,
    defaultThinkingOptionId: "on",
    supportsStreamOptionsUsage: true,
    pricing: {
      currency: USD,
      unitTokens: 1_000_000,
      input: 0.14,
      cachedInput: 0.0028,
      output: 0.28
    }
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    provider: "bigmodel",
    model: "glm-5.1",
    apiKey: API_KEYS.bigmodel,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    path: "/chat/completions",
    thinkingParameterStyle: "bigmodel",
    thinkingOptions: GLM_THINKING_OPTIONS,
    defaultThinkingOptionId: "on",
    supportsStreamOptionsUsage: false,
    pricing: {
      currency: USD,
      unitTokens: 1_000_000,
      input: 1.4,
      cachedInput: 0.26,
      output: 4.4,
      note: "Z.AI public USD pricing"
    }
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai-compatible",
    model: "gpt-5.5",
    apiKey: API_KEYS.gpt55,
    baseUrl: "https://icoe.pp.ua/v1",
    path: "/chat/completions",
    thinkingParameterStyle: "openai-reasoning-effort",
    thinkingOptions: OPENAI_GPT55_THINKING_OPTIONS,
    defaultThinkingOptionId: "medium",
    usesMaxCompletionTokens: true,
    supportsStreamOptionsUsage: true,
    pricing: {
      currency: USD,
      unitTokens: 1_000_000,
      input: 5,
      cachedInput: 0.5,
      output: 30
    }
  }
];

export const MAX_COMPARE_MODELS = 4;

export function publicModelCatalog() {
  return MODEL_CATALOG.map(({ apiKey, ...model }) => model);
}

export function findModel(id) {
  return MODEL_CATALOG.find((model) => model.id === id);
}

export function defaultThinkingOptionForModel(model) {
  if (!model?.thinkingOptions?.length) return null;
  return (
    model.thinkingOptions.find((option) => option.id === model.defaultThinkingOptionId) ??
    model.thinkingOptions[0]
  );
}

export function findThinkingOption(model, optionId) {
  if (!model?.thinkingOptions?.length) return null;
  return (
    model.thinkingOptions.find((option) => option.id === optionId) ??
    defaultThinkingOptionForModel(model)
  );
}
