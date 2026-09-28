export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body && !isForm ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const isJson = (res.headers.get("Content-Type") ?? "").includes("application/json");
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = isJson ? (data as { error?: { message?: string; code?: string } }).error : undefined;
    throw new ApiRequestError(err?.message ?? res.statusText, res.status, err?.code);
  }
  return data as T;
}

export const newClientMsgId = () => crypto.randomUUID();

export const fmtTime = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
