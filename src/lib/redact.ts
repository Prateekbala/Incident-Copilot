const RULES: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer [REDACTED_TOKEN]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, "[REDACTED_KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]"],
  [/\b(api[_-]?key|secret|password|token)=([^\s&"']+)/gi, "$1=[REDACTED]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  [/\b(?:\d[ -]?){13,16}\b/g, "[REDACTED_CARD]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}
