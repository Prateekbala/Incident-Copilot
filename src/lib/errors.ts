export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "rate_limited"
  | "ai_unavailable"
  | "conflict"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  rate_limited: 429,
  ai_unavailable: 503,
  conflict: 409,
  internal: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["rate_limited", "ai_unavailable", "internal"]);

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }

  get status(): number {
    return STATUS[this.code];
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: RETRYABLE.has(this.code),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class AiUnavailableError extends Error {
  constructor(message = "AI temporarily unavailable", public cause?: unknown) {
    super(message);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
