export function extractJson(input: unknown): unknown {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "object") return input;
  const text = String(input).trim();
  if (!text) return undefined;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1], text] : [text];

  for (const candidate of candidates) {
    const direct = tryParse(candidate.trim());
    if (direct !== undefined) return direct;
    const balanced = firstBalanced(candidate);
    if (balanced) {
      const parsed = tryParse(balanced);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function firstBalanced(s: string): string | undefined {
  const start = s.search(/[[{]/);
  if (start < 0) return undefined;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return s.slice(start, i + 1);
  }
  return undefined;
}

export function safeJsonParse<T = unknown>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
