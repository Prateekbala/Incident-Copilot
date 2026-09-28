export const SERVICES = {
  "checkout-api": { databases: ["orders-db"], aliases: ["checkout", "cart", "order", "orders", "purchase"] },
  "payments-api": { databases: [], aliases: ["payment", "payments", "billing", "charge"] },
  "inventory-api": { databases: ["catalog-db"], aliases: ["inventory", "stock", "catalog"] },
  "reconciliation-cron": {
    databases: ["orders-db"],
    aliases: ["reconciliation", "cron", "batch", "nightly job"],
  },
} as const;

export const DATABASES = ["orders-db", "catalog-db"] as const;
export const METRICS = ["error_rate", "p95_latency", "rps", "cpu"] as const;
export const SCENARIOS = ["n_plus_one_deploy", "cron_cpu_spike"] as const;

export type ServiceName = keyof typeof SERVICES;
export type DatabaseName = (typeof DATABASES)[number];
export type MetricName = (typeof METRICS)[number];
export type ScenarioName = (typeof SCENARIOS)[number];

export const SERVICE_NAMES = Object.keys(SERVICES) as [ServiceName, ...ServiceName[]];

export const METRIC_UNITS: Record<MetricName, string> = {
  error_rate: "%",
  p95_latency: "ms",
  rps: "req/s",
  cpu: "%",
};

export function isService(s: unknown): s is ServiceName {
  return typeof s === "string" && s in SERVICES;
}

export function isDatabase(s: unknown): s is DatabaseName {
  return typeof s === "string" && (DATABASES as readonly string[]).includes(s);
}

export function databasesFor(service: ServiceName): readonly DatabaseName[] {
  return SERVICES[service].databases;
}

export function matchService(text: string): ServiceName | undefined {
  const lower = text.toLowerCase();
  for (const name of SERVICE_NAMES) if (lower.includes(name)) return name;
  for (const name of SERVICE_NAMES) {
    if (SERVICES[name].aliases.some((alias) => new RegExp(`\\b${alias}`, "i").test(lower))) return name;
  }
  return undefined;
}
