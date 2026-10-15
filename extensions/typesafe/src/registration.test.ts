import { readFileSync } from "node:fs";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { ConfigSchema, runtimeConfig } from "./config.js";
import { resolveRuntimeConfig } from "./credentials.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));

it("accepts only bounded source configuration and validates before reading credentials", () => {
  for (const source of ["store", "env", "file", "exec"]) {
    expect(
      Check(ConfigSchema, { apiKey: { source, provider: "default", id: "TYPESAFE_API_KEY" } }),
    ).toBe(true);
  }
  for (const config of [
    { apiKey: "synthetic-plaintext" },
    { apiKey: { source: "other", provider: "default", id: "key" } },
    { timeoutMs: 60001 },
    { model: "jev-latest" },
  ]) {
    expect(Check(ConfigSchema, config)).toBe(false);
  }
  expect(Check(ConfigSchema, {})).toBe(true);
  vi.mocked(getPreparedPluginSecretInput).mockClear();
  expect(() =>
    resolveRuntimeConfig({
      plugins: { entries: { typesafe: { config: { timeoutMs: -1 } } } },
    }),
  ).toThrow("Invalid TypeSafe configuration");
  expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
});

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);
const schemas = [ConfigSchema, manifest.configSchema];
it.each<[Record<string, unknown> & { baseUrl: string }, boolean]>([
  [{ baseUrl: "https://decision.example.com", allowNonLoopback: true }, true],
  [{ baseUrl: "https://10.0.0.5:8009/", allowNonLoopback: true }, true],
  [{ baseUrl: "https://[fd00::1]:8009", allowNonLoopback: true }, true],
  [{ baseUrl: "http://127.0.0.1:8009" }, true],
  [{ baseUrl: "https://decision.example.com" }, false],
  [{ baseUrl: "https://decision.example.com", allowNonLoopback: false }, false],
  [{ baseUrl: "https://decision.example.com", allowNonLoopback: "true" }, false],
  [{ baseUrl: "http://10.0.0.5:8009", allowNonLoopback: true }, false],
  ...[
    "https://*.example.com",
    "https://user:pass@decision.example.com",
    "https://decision.example.com/v1",
    "https://decision.example.com?x=1",
    "https://decision.example.com#x",
    " https://decision.example.com",
  ].map((baseUrl): [Record<string, unknown> & { baseUrl: string }, boolean] => [
    { baseUrl, allowNonLoopback: true },
    false,
  ]),
])("validates endpoint opt-in in source schemas and runtime: %j", (config, accepted) => {
  for (const schema of schemas) {
    expect(Check(schema, config)).toBe(accepted);
  }
  if (accepted) {
    expect(runtimeConfig(config).baseUrl).toBe(new URL(config.baseUrl).origin);
  } else {
    expect(() => runtimeConfig(config)).toThrow();
  }
});

it.each(["apiKey", "endpointAuth"])(
  "accepts only SecretRefs for %s in both source schemas",
  (path) => {
    for (const schema of schemas) {
      for (const source of ["env", "store", "file", "exec"]) {
        expect(
          Check(schema, { [path]: { source, provider: "default", id: "SYNTHETIC_KEY" } }),
        ).toBe(true);
      }
      expect(Check(schema, { [path]: "synthetic-plaintext" })).toBe(false);
      expect(Check(schema, { [path]: { source: "store", ref: "wrong-shape" } })).toBe(false);
    }
  },
);

it.each(["http://localhost:8009", "https://decision.example.com"])(
  "never reads apiKey for configured endpoint %s",
  (baseUrl) => {
    vi.mocked(getPreparedPluginSecretInput).mockClear();
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({
      revision: 1,
      value: "synthetic-endpoint-key",
    });
    const config = {
      baseUrl,
      allowNonLoopback: true,
      endpointAuth: { source: "store", provider: "default", id: "SYNTHETIC_ENDPOINT_KEY" },
      get apiKey(): never {
        throw new Error("hosted credential read");
      },
    };
    expect(resolveRuntimeConfig({ plugins: { entries: { typesafe: { config } } } })).toMatchObject({
      endpointAuth: "synthetic-endpoint-key",
    });
    expect(getPreparedPluginSecretInput).toHaveBeenCalledExactlyOnceWith(
      "typesafe",
      "endpointAuth",
    );
  },
);

it("never reads endpointAuth for hosted mode and rejects the hosted origin as baseUrl", () => {
  vi.mocked(getPreparedPluginSecretInput).mockClear();
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({
    revision: 1,
    value: "synthetic-hosted-key",
  });
  const config = {
    get endpointAuth(): never {
      throw new Error("endpoint credential read");
    },
  };
  expect(resolveRuntimeConfig({ plugins: { entries: { typesafe: { config } } } })).toEqual({
    apiKey: "synthetic-hosted-key",
    timeoutMs: 30000,
  });
  expect(getPreparedPluginSecretInput).toHaveBeenCalledExactlyOnceWith("typesafe", "apiKey");
  for (const baseUrl of ["https://api.typesafe.ai", "https://API.TYPESAFE.AI:443/"]) {
    expect(() => runtimeConfig({ baseUrl, allowNonLoopback: true })).toThrow(
      "Omit baseUrl for hosted Jev",
    );
  }
});
