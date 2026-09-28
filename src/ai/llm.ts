import type { Env } from "../env";
import { backoffMs, sleep, withTimeout } from "../lib/async";
import { AiUnavailableError, errorMessage } from "../lib/errors";
import { extractJson } from "../lib/json";

export const DEFAULT_PRIMARY = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const DEFAULT_FALLBACK = "@cf/meta/llama-3.1-8b-instruct";

export type AiEnv = Pick<Env, "AI" | "AI_GATEWAY_ID" | "PRIMARY_MODEL" | "FALLBACK_MODEL">;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LLMResult {
  text: string;
  toolCalls: ToolCall[];
  model: string;
  degraded: boolean;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  attempts?: number;
  allowFallback?: boolean;
  cheap?: boolean;
  timeoutMs?: number;
}

type RawAiResponse = {
  response?: unknown;
  tool_calls?: Array<Record<string, unknown>>;
};

async function runModel(env: AiEnv, model: string, input: Record<string, unknown>, timeoutMs: number): Promise<RawAiResponse> {
  const options = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
  const run = env.AI.run as unknown as (m: string, i: unknown, o?: unknown) => Promise<RawAiResponse>;
  return withTimeout(run.call(env.AI, model, input, options), timeoutMs, `Workers AI ${model}`);
}

let callCounter = 0;
const newCallId = () => `call_${Date.now().toString(36)}_${(callCounter++).toString(36)}`;

function parseArgs(args: unknown): unknown {
  if (typeof args === "string") return extractJson(args) ?? {};
  return args ?? {};
}

export function parseTextToolCalls(text: string, toolNames: string[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const fnTag = /<function=(\w+)>([\s\S]*?)<\/function>/g;
  for (const m of text.matchAll(fnTag)) {
    if (toolNames.includes(m[1])) calls.push({ id: newCallId(), name: m[1], arguments: parseArgs(m[2]) });
  }
  if (calls.length) return calls;

  const trimmed = text.trim();
  if (!/^[[{]|```/.test(trimmed)) return [];
  const parsed = extractJson(trimmed);
  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fn = (o.function as Record<string, unknown> | undefined) ?? o;
    const name = fn.name;
    if (typeof name === "string" && toolNames.includes(name)) {
      calls.push({ id: newCallId(), name, arguments: parseArgs(fn.parameters ?? fn.arguments) });
    }
  }
  return calls;
}

export function normalizeResponse(raw: RawAiResponse, toolNames: string[]): { text: string; toolCalls: ToolCall[] } {
  const text = typeof raw.response === "string" ? raw.response : raw.response === undefined || raw.response === null ? "" : JSON.stringify(raw.response);
  const structured: ToolCall[] = (raw.tool_calls ?? [])
    .map((tc) => {
      const fn = (tc.function as Record<string, unknown> | undefined) ?? tc;
      return {
        id: typeof tc.id === "string" ? tc.id : newCallId(),
        name: String(fn.name ?? ""),
        arguments: parseArgs(fn.arguments ?? fn.parameters),
      };
    })
    .filter((tc) => tc.name);
  const toolCalls = structured.length ? structured : toolNames.length ? parseTextToolCalls(text, toolNames) : [];
  return { text: toolCalls.length ? "" : text, toolCalls };
}

export async function chat(env: AiEnv, opts: ChatOptions): Promise<LLMResult> {
  const primary = env.PRIMARY_MODEL || DEFAULT_PRIMARY;
  const fallback = env.FALLBACK_MODEL || DEFAULT_FALLBACK;
  const attempts = opts.cheap ? 0 : (opts.attempts ?? 3);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const toolNames = (opts.tools ?? []).map((t) => t.name);
  const base = {
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.2,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const input: Record<string, unknown> = { ...base };
      if (opts.tools?.length) input.tools = opts.tools;
      if (opts.jsonSchema && attempt === 0) input.response_format = { type: "json_schema", json_schema: opts.jsonSchema };
      const raw = await runModel(env, primary, input, timeoutMs);
      return { ...normalizeResponse(raw, toolNames), model: primary, degraded: false };
    } catch (err) {
      lastError = err;
      console.warn(`[llm] ${primary} attempt ${attempt + 1}/${attempts} failed: ${errorMessage(err)}`);
      if (attempt < attempts - 1) await sleep(backoffMs(attempt));
    }
  }

  if (opts.allowFallback !== false) {
    try {
      const raw = await runModel(env, fallback, base, timeoutMs);
      return { ...normalizeResponse(raw, []), model: fallback, degraded: !opts.cheap };
    } catch (err) {
      lastError = err;
      console.warn(`[llm] fallback ${fallback} failed: ${errorMessage(err)}`);
    }
  }
  throw new AiUnavailableError(`AI temporarily unavailable: ${errorMessage(lastError)}`, lastError);
}

export async function chatJson<T>(
  env: AiEnv,
  opts: ChatOptions & { validate: (value: unknown) => { success: true; data: T } | { success: false; error: string } },
): Promise<{ data: T; model: string } | undefined> {
  const first = await chat(env, opts);
  const parsed = opts.validate(extractJson(first.text));
  if (parsed.success) return { data: parsed.data, model: first.model };

  const repair = await chat(env, {
    ...opts,
    jsonSchema: undefined,
    messages: [
      ...opts.messages,
      { role: "assistant", content: first.text.slice(0, 4000) },
      {
        role: "user",
        content: `Your previous reply was not valid. Validation error: ${parsed.error.slice(0, 500)}. Reply with ONLY the corrected JSON object, no prose.`,
      },
    ],
  });
  const repaired = opts.validate(extractJson(repair.text));
  return repaired.success ? { data: repaired.data, model: repair.model } : undefined;
}
