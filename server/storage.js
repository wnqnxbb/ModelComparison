import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../data");
const dataFile = path.join(dataDir, "conversations.json");

async function ensureStore() {
  await mkdir(dataDir, { recursive: true });
  try {
    await readFile(dataFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeFile(dataFile, "[]", "utf8");
      return;
    }
    throw error;
  }
}

export async function readRecords() {
  await ensureStore();
  const content = await readFile(dataFile, "utf8");
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addCosts(costs) {
  const validCosts = costs.filter(Boolean);
  if (validCosts.length === 0) return null;
  const currency = validCosts[0].currency;
  if (validCosts.some((cost) => cost.currency !== currency)) return null;

  return validCosts.reduce(
    (total, cost) => ({
      currency,
      inputTokens: total.inputTokens + (cost.inputTokens ?? 0),
      cachedInputTokens: total.cachedInputTokens + (cost.cachedInputTokens ?? 0),
      uncachedInputTokens: total.uncachedInputTokens + (cost.uncachedInputTokens ?? 0),
      outputTokens: total.outputTokens + (cost.outputTokens ?? 0),
      inputCost: total.inputCost + (cost.inputCost ?? 0),
      cachedInputCost: total.cachedInputCost + (cost.cachedInputCost ?? 0),
      outputCost: total.outputCost + (cost.outputCost ?? 0),
      totalCost: total.totalCost + (cost.totalCost ?? 0)
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

export function normalizeRecord(record) {
  if (!record) return null;

  if (Array.isArray(record.turns)) {
    const turns = record.turns.map((turn, index) => ({
      ...turn,
      id: turn.id ?? `${record.id}-turn-${index}`,
      title: turn.title ?? (turn.prompt?.length > 32 ? `${turn.prompt.slice(0, 32)}...` : turn.prompt),
      results: Array.isArray(turn.results) ? turn.results : []
    }));
    return {
      ...record,
      turns,
      updatedAt: record.updatedAt ?? turns.at(-1)?.createdAt ?? record.createdAt,
      totalCost: record.totalCost ?? addCosts(turns.map((turn) => turn.totalCost))
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
    id: record.id,
    title: record.title ?? legacyTurn.title,
    prompt: legacyTurn.prompt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt ?? record.createdAt,
    modelIds: legacyTurn.modelIds,
    modelSelections: legacyTurn.modelSelections,
    totalCost: record.totalCost ?? null,
    durationMs: record.durationMs ?? legacyTurn.durationMs,
    turns: [legacyTurn]
  };
}

export async function listRecordSummaries() {
  const records = (await readRecords()).map(normalizeRecord);
  return records
    .slice()
    .sort((a, b) => new Date(b.updatedAt ?? b.createdAt) - new Date(a.updatedAt ?? a.createdAt))
    .map((record) => {
      const latestTurn = record.turns.at(-1);
      return {
        id: record.id,
        title: record.title,
        prompt: latestTurn?.prompt ?? record.prompt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        turnCount: record.turns.length,
        modelCount: latestTurn?.results?.length ?? 0,
        totalCost: record.totalCost ?? null,
        thinkingLabel:
          latestTurn?.modelSelections
          ?.map((selection) => selection.thinkingOption?.label)
          .filter(Boolean)
          .join(" / ") ??
        record.thinkingMode?.label ??
        ""
      };
    });
}

export async function getRecord(id) {
  const records = await readRecords();
  return normalizeRecord(records.find((record) => record.id === id) ?? null);
}

export async function saveRecord(record) {
  const records = await readRecords();
  records.push(record);
  await writeFile(dataFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  return record;
}

export async function upsertRecord(record) {
  const records = await readRecords();
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    records[index] = record;
  } else {
    records.push(record);
  }
  await writeFile(dataFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  return record;
}
