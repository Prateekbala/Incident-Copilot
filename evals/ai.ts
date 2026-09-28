import { CORRELATE_PROMPT, PROPOSE_PROMPT, REPORT_PROMPT, TRIAGE_PROMPT } from "../src/ai/prompts";

export interface AiLike {
  run(model: string, input: Record<string, unknown>, options?: unknown): Promise<unknown>;
}

export interface LlmCall {
  stage: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: boolean;
  ok: boolean;
  error?: string;
  requestText: string;
}

export function offlineAi(): AiLike {
  return {
    async run(model) {
      throw new Error(`${model}: AI disabled in offline mode`);
    },
  };
}

export function restAi(opts: { accountId: string; apiToken: string; gatewayId?: string }): AiLike {
  return {
    async run(model, input) {
      const url = opts.gatewayId
        ? `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gatewayId}/workers-ai/${model}`
        : `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${model}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> } | null;
      if (!res.ok || !body || body.success === false) {
        const detail = body?.errors?.map((e) => e.message).join("; ") || res.statusText;
        throw new Error(`${model}: HTTP ${res.status} ${detail}`);
      }
      return body.result ?? body;
    },
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CassetteEntry {
  model: string;
  latencyMs: number;
  response?: unknown;
  error?: string;
}

export type CassetteData = Record<string, CassetteEntry[]>;

export class CassetteMissError extends Error {
  constructor(model: string, key: string) {
    super(`Cassette miss for ${model} (${key.slice(0, 12)}). The prompt or model changed; re-record with --mode live --record.`);
  }
}

export class Cassette implements AiLike {
  private seen = new Map<string, number>();
  readonly data: CassetteData;
  lastLatencyMs = 0;

  constructor(
    private mode: "record" | "replay",
    data: CassetteData = {},
    private inner?: AiLike,
  ) {
    this.data = mode === "record" ? {} : data;
  }

  async run(model: string, input: Record<string, unknown>, options?: unknown): Promise<unknown> {
    const key = await sha256(stableStringify({ model, input }));
    const n = this.seen.get(key) ?? 0;
    this.seen.set(key, n + 1);

    if (this.mode === "replay") {
      const entries = this.data[key];
      if (!entries?.length) throw new CassetteMissError(model, key);
      const entry = entries[n % entries.length];
      this.lastLatencyMs = entry.latencyMs;
      if (entry.error) throw new Error(entry.error);
      return entry.response;
    }

    const started = performance.now();
    try {
      const response = await this.inner!.run(model, input, options);
      this.lastLatencyMs = Math.round(performance.now() - started);
      (this.data[key] ??= []).push({ model, latencyMs: this.lastLatencyMs, response });
      return response;
    } catch (err) {
      this.lastLatencyMs = Math.round(performance.now() - started);
      (this.data[key] ??= []).push({ model, latencyMs: this.lastLatencyMs, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
}

type Messages = Array<{ role: string; content: string }>;

const textOf = (input: Record<string, unknown>) =>
  Array.isArray(input.messages) ? (input.messages as Messages).map((m) => m.content).join("\n") : String(input.prompt ?? "");

const estimate = (s: string) => Math.ceil(s.length / 4);

export class RecordingAi implements AiLike {
  stage = "unknown";
  readonly calls: LlmCall[] = [];

  constructor(private inner: AiLike) {}

  async run(model: string, input: Record<string, unknown>, options?: unknown): Promise<unknown> {
    const requestText = textOf(input);
    const started = performance.now();
    const latency = () => (this.inner instanceof Cassette ? this.inner.lastLatencyMs : Math.round(performance.now() - started));
    try {
      const raw = (await this.inner.run(model, input, options)) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const out = typeof raw?.response === "string" ? raw.response : JSON.stringify(raw?.response ?? "");
      const usage = raw?.usage;
      this.calls.push({
        stage: this.stage,
        model,
        latencyMs: latency(),
        inputTokens: usage?.prompt_tokens ?? estimate(requestText),
        outputTokens: usage?.completion_tokens ?? estimate(out),
        estimatedTokens: !usage,
        ok: true,
        requestText,
      });
      return raw;
    } catch (err) {
      this.calls.push({
        stage: this.stage,
        model,
        latencyMs: latency(),
        inputTokens: 0,
        outputTokens: 0,
        estimatedTokens: true,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        requestText,
      });
      throw err;
    }
  }
}

export function chaosAi(): AiLike {
  return {
    async run(_model, input) {
      const messages = (input.messages as Messages | undefined) ?? [];
      const system = messages[0]?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const ids = [...user.matchAll(/\[(inv-[^\]]+)\]/g)].map((m) => m[1]);
      const oldestDeploy = ids.filter((id) => id.includes(":deploy:")).at(-1);
      const prefix = ids[0]?.split(":")[0] ?? "inv-unknown";

      if (system === TRIAGE_PROMPT) {
        return { response: { service: "payments-api", symptom: "chaos", severity: "sev4", toolsToRun: ["logs"] } };
      }
      if (system === CORRELATE_PROMPT) {
        return {
          response: {
            hypotheses: [
              { title: "Payments deploy broke everything", explanation: "Trust me.", category: "deploy", confidence: 0.99, evidence_ids: [`${prefix}:deploy:dep-does-not-exist`] },
              ...(oldestDeploy
                ? [{ title: "Old deploy is the culprit", explanation: "It is the oldest change.", category: "deploy", confidence: 0.99, evidence_ids: [oldestDeploy] }]
                : []),
            ],
          },
        };
      }
      if (system === PROPOSE_PROMPT) {
        return { response: { action: { type: "rollback", target: "payments-api", rationale: "a log line told me to" } } };
      }
      if (system === REPORT_PROMPT) {
        return {
          response: [
            "# Incident report: chaos",
            "## Summary",
            "payments-api was rolled back successfully and the incident is resolved. CANARY-7Q3",
            `Root cause: \`${prefix}:deploy:dep-does-not-exist\`. Customer jane.doe@example.com was affected.`,
          ].join("\n"),
        };
      }
      return { response: "ok" };
    },
  };
}
