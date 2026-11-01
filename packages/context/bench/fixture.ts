export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "src/auth/session.ts": `export interface SessionClaims { subject: string; expiresAt: number; }
export function validateSessionToken(token: string, now = Date.now()): SessionClaims | null {
  const claims = decodeToken(token);
  if (!claims || claims.expiresAt <= now) return null;
  return claims;
}
function decodeToken(token: string): SessionClaims | null { return token ? { subject: token, expiresAt: 9999999999999 } : null; }
`,
  "src/auth/cookies.ts": `import { validateSessionToken } from "./session";
export function sessionFromCookie(cookie: string) { return validateSessionToken(cookie); }
`,
  "src/auth/middleware.ts": `import { validateSessionToken } from "./session";
export function requireSession(header: string) { return validateSessionToken(header); }
`,
  "src/auth/refresh.ts": `import { validateSessionToken } from "./session";
export function refreshSession(token: string) { return validateSessionToken(token); }
`,
  "src/auth/password.ts": `export function verifyPassword(candidate: string, digest: string) { return candidate === digest; }
`,
  "src/billing/invoice.ts": `export interface InvoiceLine { sku: string; quantity: number; }
export function buildInvoice(accountId: string, lines: InvoiceLine[]) {
  return { accountId, totalLines: lines.length, createdAt: Date.now() };
}
export function normalizeCurrency(amount: number) { return Math.round(amount * 100) / 100; }
`,
  "src/billing/ledger.ts": `import { buildInvoice } from "./invoice";
export function postInvoice(id: string) { return buildInvoice(id, []); }
export function readLedgerEntry(entryId: string) { return { entryId, posted: true }; }
`,
  "src/billing/tax.ts": `export function calculateRegionalTax(subtotal: number, rate: number) { return subtotal * rate; }
`,
  "src/billing/refunds.ts": `export function issueRefund(invoiceId: string, amount: number) { return { invoiceId, amount }; }
`,
  "src/http/routes/quota.ts": `export interface QuotaRequest { accountId: string; requested: number; }
export function enforceQuota(request: QuotaRequest, allowance: number) {
  if (request.requested > allowance) throw new Error("quota exceeded");
  return true;
}
`,
  "src/http/routes/accounts.ts": `export function getAccount(accountId: string) { return { accountId, active: true }; }
`,
  "src/http/routes/invoices.ts": `import { buildInvoice } from "../../billing/invoice";
export function createInvoice(id: string) { return buildInvoice(id, []); }
`,
  "src/http/routes/health.ts": `export function healthStatus() { return { status: "ok" }; }
`,
  "src/http/router.ts": `export function registerRoutes() { return ["accounts", "invoices", "quota", "health"]; }
`,
  "src/utils/backoff.ts": `export function nextDelay(attempt: number, baseMs = 100) {
  return Math.min(baseMs * 2 ** attempt, 30000);
}
export function jitter(value: number) { return Math.floor(value * 0.9); }
`,
  "src/utils/ids.ts": `export function makeRequestId(now: number) { return \`req-\${now}\`; }
`,
  "src/utils/date.ts": `export function formatUtcDate(value: Date) { return value.toISOString(); }
`,
  "src/utils/collections.ts": `export function groupByKey<T>(items: T[], key: (item: T) => string) { return items.reduce((acc, item) => acc.set(key(item), item), new Map()); }
`,
  "src/storage/retention.py": `from datetime import datetime
def retain_artifact(artifact_id, policy):
    return {"artifact": artifact_id, "retained": policy.keep}

def expire_artifact(artifact_id):
    return {"artifact": artifact_id, "expired_at": datetime.utcnow()}
`,
  "src/storage/manifest.py": `def load_manifest(path):
    return {"path": path, "items": []}
`,
  "src/storage/cleanup.py": `def remove_orphan(blob_id):
    return blob_id
`,
  "src/notifications/email.ts": `export function sendEmail(address: string, subject: string) { return { address, subject }; }
`,
  "src/notifications/webhook.ts": `export function dispatchWebhook(endpoint: string, payload: unknown) { return { endpoint, payload }; }
`,
  "src/search/index.ts": `export function searchRecords(query: string) { return query.trim().split(" "); }
`,
  "src/search/query.ts": `export function parseSearchQuery(value: string) { return { value, terms: value.split(" ") }; }
`,
  "src/config/settings.ts": `export const defaultSettings = { retries: 3, timeoutMs: 5000 };
`,
  "src/config/feature-flags.ts": `export function isFeatureEnabled(flag: string) { return flag.length > 0; }
`,
  "src/telemetry/events.ts": `export interface TelemetryEvent { name: string; timestamp: number; }
export function recordEvent(name: string): TelemetryEvent { return { name, timestamp: Date.now() }; }
`,
  "src/telemetry/sanitize.ts": `export function sanitizeLabel(value: string) { return value.replace(/[^a-z0-9]/gi, "_"); }
`,
  "tests/auth.test.ts": `import { validateSessionToken } from "../src/auth/session";
export const acceptsValidCredentials = () => validateSessionToken("token");
`,
  "tests/billing.test.ts": `export function invoiceFixture() { return { accountId: "acct-1", lines: [] }; }
`,
};

export function createScaledFixtureFiles(): Readonly<Record<string, string>> {
  const words = [
    "amber",
    "birch",
    "cedar",
    "delta",
    "ember",
    "frost",
    "grove",
    "harbor",
    "indigo",
    "juniper",
    "kestrel",
    "lumen",
  ];
  const files: Record<string, string> = { ...FIXTURE_FILES };
  const distractorCount = 300;
  for (let index = 0; index < distractorCount; index += 1) {
    const word = words[index % words.length] as string;
    const targetIndices = [
      (index + 1) % distractorCount,
      ...(index % 2 === 0 ? [(index + 17) % distractorCount] : []),
    ];
    const imports = targetIndices.map((targetIndex, importIndex) => {
      const targetWord = words[targetIndex % words.length] as string;
      const relativePath =
        targetWord === word
          ? `./${targetWord}-${targetIndex}`
          : `../${targetWord}/${targetWord}-${targetIndex}`;
      return `import { ${targetWord}Module${targetIndex}Function0 as dependency${importIndex} } from "${relativePath}";`;
    });
    const functions = Array.from(
      { length: 3 + (index % 3) },
      (_, functionIndex) => {
        const calls = targetIndices
          .map((_, importIndex) => `dependency${importIndex}(value)`)
          .join(" + ");
        return `export function ${word}Module${index}Function${functionIndex}(value: number) { return value + ${calls}; }`;
      },
    );
    files[`src/modules/${word}/${word}-${index}.ts`] = [
      ...imports,
      ...functions,
      "",
    ].join("\n");
  }
  return files;
}

export interface NavigationTask {
  id: string;
  query: string;
  mentioned_symbols?: string[];
  targets: Array<{ path: string; symbol: string; expected_line: number }>;
}

export const NAVIGATION_TASKS: readonly NavigationTask[] = [
  {
    id: "session-validation",
    query:
      "Trace which credentials are checked before a browser session can be renewed.",
    targets: [
      {
        path: "src/auth/session.ts",
        symbol: "validateSessionToken",
        expected_line: 2,
      },
    ],
  },
  {
    id: "credential-expiry",
    query: "Find where stale identity proofs are rejected during a request.",
    targets: [
      {
        path: "src/auth/session.ts",
        symbol: "validateSessionToken",
        expected_line: 2,
      },
    ],
  },
  {
    id: "invoice-assembly",
    query:
      "Understand how a customer's charges are gathered into a billing document.",
    targets: [
      {
        path: "src/billing/invoice.ts",
        symbol: "buildInvoice",
        expected_line: 2,
      },
    ],
  },
  {
    id: "account-allowance",
    query: "Which endpoint refuses work when a tenant has used its allocation?",
    targets: [
      {
        path: "src/http/routes/quota.ts",
        symbol: "enforceQuota",
        expected_line: 2,
      },
    ],
  },
  {
    id: "delivery-retry",
    query: "Track how the wait period grows after repeated delivery failures.",
    targets: [
      {
        path: "src/utils/backoff.ts",
        symbol: "nextDelay",
        expected_line: 1,
      },
    ],
  },
  {
    id: "retention-policy",
    query:
      "Locate where long-lived records are admitted to the archive process.",
    targets: [
      {
        path: "src/storage/retention.py",
        symbol: "retain_artifact",
        expected_line: 2,
      },
    ],
  },
];
