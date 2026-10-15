import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import type { LookupFunction, Server } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  acquireTestPortBlock,
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "openclaw/plugin-sdk/test-env";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import plugin from "../index.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn<LookupFn>() }));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

// Only the fixture's final socket routing is substituted. The real guard must first
// authorize and pin this RFC1918 answer; TLS still verifies the original hostname.
class FixtureAgent extends Agent {
  constructor(options: Agent.Options = {}) {
    assert(options.connect && typeof options.connect !== "function" && "lookup" in options.connect);
    const pinnedLookup = options.connect.lookup;
    assert(pinnedLookup);
    const routedLookup: LookupFunction = (hostname, opts, callback) =>
      pinnedLookup(hostname, opts, (error, address, family) => {
        if (error) {
          callback(error, address, family);
          return;
        }
        if (Array.isArray(address)) {
          expect(address).toEqual([{ address: "10.123.0.5", family: 4 }]);
          callback(null, [{ address: "127.0.0.1", family: 4 }]);
        } else {
          expect(address).toBe("10.123.0.5");
          callback(null, "127.0.0.1", 4);
        }
      });
    super({ ...options, connect: { ...options.connect, lookup: routedLookup } });
  }
}
async function listen<T extends Server>(listener: T) {
  const claim = await acquireTestPortBlock({ offsets: [0] });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(claim.port, "127.0.0.1", resolve);
  });
  return {
    listener,
    claim,
    releaseListener: () =>
      new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const batch = {
  state: { evidence: "Synthetic outage" },
  questions: { q: { type: "boolean" as const } },
};
const answer = {
  model: "nemotron-deciffusion",
  answers: { q: { type: "noul", noul: 0.75 } },
  usage: { input_tokens: 8, output_tokens: 1 },
};
const received: Array<{ url?: string; host?: string; authorization?: string; body: unknown }> = [];
let redirect: string | undefined;
let fixture: Awaited<ReturnType<typeof listen<ReturnType<typeof createServer>>>>;
let baseUrl: string;
const originalCAs = getCACertificates("default");

beforeAll(async () => {
  fixture = await listen(
    createServer(
      { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.push({
            url: request.url,
            host: request.headers.host,
            authorization: request.headers.authorization,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          if (redirect) {
            response.writeHead(302, { location: redirect });
            response.end();
          } else {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(answer));
          }
        });
      },
    ),
  );
  baseUrl = `https://files.proxy.test:${fixture.claim.port}`;
});
afterAll(async () => {
  await fixture.releaseListener();
  await fixture.claim.release();
});
beforeEach(() => {
  received.length = 0;
  redirect = undefined;
  setDefaultCACertificates([...originalCAs, PROXY_FIXTURE_CERTIFICATE]);
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([{ address: "10.123.0.5", family: 4 }]);
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
    Agent: FixtureAgent,
    EnvHttpProxyAgent,
    ProxyAgent,
    fetch: undiciFetch,
  });
  vi.mocked(getPreparedPluginSecretInput).mockReset();
  vi.mocked(getPreparedPluginSecretInput).mockImplementation((_plugin, path) => ({
    revision: 1,
    value: path === "endpointAuth" ? "synthetic-endpoint-key" : "synthetic-hosted-key",
  }));
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(key, "http://127.0.0.1:1");
  }
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "false");
});
afterEach(() => {
  setDefaultCACertificates(originalCAs);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function provider(config: Record<string, unknown>) {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: { config: { current: () => ({ plugins: { entries: { typesafe: { config } } } }) } },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const registered = registerDecisionProvider.mock.calls[0]?.[0];
  assert(registered);
  return registered;
}
const context = () => ({
  model: "nemotron-deciffusion",
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 3000,
});
const endpointRef = { source: "store", provider: "default", id: "SYNTHETIC_ENDPOINT_TOKEN" };

it.each([false, true])(
  "reaches a private HTTPS reverse-proxy origin with endpoint auth=%s, ignoring ambient proxies",
  async (auth) => {
    const registered = provider({
      baseUrl,
      allowNonLoopback: true,
      apiKey: "must-not-read",
      ...(auth ? { endpointAuth: endpointRef } : {}),
    });
    expect(registered.isReady?.()).toBe(true);
    await expect(registered.evaluate(batch, context())).resolves.toMatchObject({
      status: "ok",
      result: {
        model: "nemotron-deciffusion",
        answers: { q: { type: "boolean", probabilityTrue: 0.75 } },
      },
    });
    expect(received).toEqual([
      {
        url: "/v1/systemone",
        host: new URL(baseUrl).host,
        authorization: auth ? "Bearer synthetic-endpoint-key" : undefined,
        body: {
          ...batch,
          model: "nemotron-deciffusion",
          questions: { q: { type: "noul", instructions: null } },
        },
      },
    ]);
    expect(lookup).toHaveBeenCalled();
    expect(vi.mocked(lookup).mock.calls.every(([host]) => host === "files.proxy.test")).toBe(true);
    expect(
      vi
        .mocked(getPreparedPluginSecretInput)
        .mock.calls.every(([, path]) => path === "endpointAuth"),
    ).toBe(true);
  },
);

it.each(["untrusted certificate", "hostname mismatch"])(
  "retains TLS verification: %s",
  async (failure) => {
    if (failure === "untrusted certificate") {
      setDefaultCACertificates(originalCAs);
    }
    const registered = provider({
      baseUrl:
        failure === "hostname mismatch"
          ? baseUrl.replace("files.proxy.test", "other.proxy.test")
          : baseUrl,
      allowNonLoopback: true,
    });
    await expect(registered.evaluate(batch, context())).resolves.toEqual({
      status: "unavailable",
      reason: "transport",
    });
    expect(received).toHaveLength(0);
  },
);

it.each(["https://api.typesafe.ai/v1/systemone", "https://other.proxy.test/sink"])(
  "never follows a redirect to %s",
  async (target) => {
    redirect = target;
    await expect(
      provider({ baseUrl, allowNonLoopback: true, endpointAuth: endpointRef }).evaluate(
        batch,
        context(),
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "transport" });
    expect(received).toHaveLength(1);
    expect(received[0]?.host).toBe(new URL(baseUrl).host);
  },
);

it.each(["origin", "opt-in", "credential", "credential loss"])(
  "rechecks current %s authority after DNS before sending",
  async (change) => {
    const config = { baseUrl, allowNonLoopback: true, endpointAuth: endpointRef };
    const registered = provider(config);
    vi.mocked(lookup).mockImplementationOnce(async () => {
      if (change === "origin") {
        config.baseUrl = "https://other.proxy.test";
      }
      if (change === "opt-in") {
        config.allowNonLoopback = false;
      }
      if (change.startsWith("credential")) {
        vi.mocked(getPreparedPluginSecretInput).mockReturnValue({
          revision: 2,
          value: change === "credential" ? "synthetic-rotated" : undefined,
        });
      }
      return [{ address: "10.123.0.5", family: 4 }];
    });
    await expect(registered.evaluate(batch, context())).resolves.toEqual({
      status: "unavailable",
      reason: "transport",
    });
    expect(received).toHaveLength(0);
  },
);

it("honors an explicit managed proxy rather than bypassing its refusal", async () => {
  const connects: string[] = [];
  const proxy = await listen(createHttpServer());
  proxy.listener.on("connect", (request, socket) => {
    connects.push(request.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  try {
    const url = `http://127.0.0.1:${proxy.claim.port}`;
    vi.stubEnv("HTTPS_PROXY", url);
    vi.stubEnv("https_proxy", url);
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    await expect(
      provider({ baseUrl, allowNonLoopback: true, endpointAuth: endpointRef }).evaluate(
        batch,
        context(),
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "transport" });
    expect(connects).toEqual([new URL(baseUrl).host]);
    expect(received).toHaveLength(0);
  } finally {
    await proxy.releaseListener();
    await proxy.claim.release();
  }
});

it("fails cold for an unavailable endpoint credential and observes rotation and recovery", async () => {
  const registered = provider({
    baseUrl,
    allowNonLoopback: true,
    endpointAuth: endpointRef,
    apiKey: "synthetic-hosted-key",
  });
  for (const key of [
    undefined,
    "synthetic-first",
    "synthetic-rotated",
    undefined,
    "synthetic-recovered",
  ]) {
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: key });
    expect(registered.isReady?.()).toBe(Boolean(key));
    received.length = 0;
    const result = await registered.evaluate(batch, context());
    if (key) {
      expect(result.status).toBe("ok");
      expect(received).toHaveLength(1);
      expect(received[0]?.authorization).toBe(`Bearer ${key}`);
    } else {
      expect(result).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
      expect(received).toHaveLength(0);
    }
  }
  expect(
    vi.mocked(getPreparedPluginSecretInput).mock.calls.every(([, path]) => path === "endpointAuth"),
  ).toBe(true);
});

it.each(["127.0.0.1", "169.254.169.254", "0.0.0.0"])(
  "does not expand exact-origin permission to unsafe DNS answer %s",
  async (address) => {
    vi.mocked(lookup).mockResolvedValue([{ address, family: 4 }]);
    await expect(
      provider({ baseUrl, allowNonLoopback: true }).evaluate(batch, context()),
    ).resolves.toEqual({ status: "unavailable", reason: "transport" });
    expect(received).toHaveLength(0);
  },
);
