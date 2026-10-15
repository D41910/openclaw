import { Type } from "typebox";

const LOCAL_BASE_URL_PATTERN = String.raw`^https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?/?$`;
const REMOTE_BASE_URL_PATTERN = String.raw`^https://(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?/?$`;
const localBaseUrlPattern = new RegExp(LOCAL_BASE_URL_PATTERN);
const remoteBaseUrlPattern = new RegExp(REMOTE_BASE_URL_PATTERN);
export const HOSTED_ORIGIN = "https://api.typesafe.ai";
const SecretRefSchema = Type.Object(
  {
    source: Type.Union([
      Type.Literal("env"),
      Type.Literal("store"),
      Type.Literal("file"),
      Type.Literal("exec"),
    ]),
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    id: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
);
export const ConfigSchema = Type.Object(
  {
    baseUrl: Type.Optional(Type.String({ maxLength: 128 })),
    allowNonLoopback: Type.Optional(Type.Boolean({ default: false })),
    apiKey: Type.Optional(SecretRefSchema),
    endpointAuth: Type.Optional(SecretRefSchema),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 30000 })),
  },
  {
    additionalProperties: false,
    anyOf: [
      { properties: { baseUrl: { pattern: LOCAL_BASE_URL_PATTERN } } },
      {
        required: ["allowNonLoopback"],
        properties: {
          allowNonLoopback: { const: true },
          baseUrl: { pattern: REMOTE_BASE_URL_PATTERN },
        },
      },
    ],
  },
);

export type RuntimeConfig = {
  apiKey?: string;
  baseUrl?: string;
  allowNonLoopback?: boolean;
  endpointAuth?: string;
  endpointAuthRequired?: boolean;
  timeoutMs: number;
};

/** Operator consent grants one exact origin, not arbitrary private-network access. */
export function configuredBaseUrl(value: unknown, allowNonLoopback?: boolean): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed =
    typeof value === "string" &&
    value.length <= 128 &&
    value === value.trim() &&
    (localBaseUrlPattern.test(value) ||
      (allowNonLoopback === true && remoteBaseUrlPattern.test(value)))
      ? URL.parse(value)
      : null;
  if (!parsed || parsed.origin === HOSTED_ORIGIN) {
    throw new Error(
      "Invalid TypeSafe baseUrl; use an http(s) loopback origin, or opt in with allowNonLoopback: true for a non-hosted HTTPS origin. Paths, credentials, query, and fragment are not allowed. Omit baseUrl for hosted Jev.",
    );
  }
  return parsed.origin;
}

/** Validate runtime settings and recognize materialized credentials without resolving inputs. */
export function runtimeConfig(config: Record<string, unknown> | undefined): RuntimeConfig {
  const allowNonLoopback = config?.allowNonLoopback;
  if (allowNonLoopback !== undefined && typeof allowNonLoopback !== "boolean") {
    throw new Error("Invalid TypeSafe allowNonLoopback; use an explicit boolean.");
  }
  const baseUrl = configuredBaseUrl(config?.baseUrl, allowNonLoopback);
  const timeoutMs = config?.timeoutMs ?? 30000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  ) {
    throw new Error("Invalid TypeSafe configuration; check plugin Settings.");
  }
  if (baseUrl) {
    const auth = config?.endpointAuth;
    return {
      baseUrl,
      timeoutMs,
      ...(allowNonLoopback === true ? { allowNonLoopback } : {}),
      ...(auth !== undefined
        ? {
            endpointAuthRequired: true,
            endpointAuth: typeof auth === "string" && auth.trim() ? auth : undefined,
          }
        : {}),
    };
  }
  const key = config?.apiKey;
  return { apiKey: typeof key === "string" && key.trim() ? key : undefined, timeoutMs };
}

export function hasCredentials(config: RuntimeConfig): boolean {
  return config.baseUrl
    ? !config.endpointAuthRequired || Boolean(config.endpointAuth)
    : Boolean(config.apiKey);
}
