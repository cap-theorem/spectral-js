import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  ADDR_ENV,
  APIError,
  AlreadyRegisteredError,
  DEFAULT_ADDR,
  InvalidRegistrationError,
  LeaseExpiredError,
  ServiceNotFoundError,
  SidecarTimeoutError,
  SidecarUnavailableError,
  SpectralClient,
} from "../src/index.ts";
import { type FakeReply, type FakeRequest, type FakeSidecar, startFakeSidecar } from "./fake-sidecar.ts";

const open: FakeSidecar[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function sidecar(respond: (req: FakeRequest) => FakeReply): Promise<[SpectralClient, FakeSidecar]> {
  const fake = await startFakeSidecar(respond);
  open.push(fake);
  return [new SpectralClient({ addr: fake.url }), fake];
}

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env[ADDR_ENV];
  if (value === undefined) {
    delete process.env[ADDR_ENV];
  } else {
    process.env[ADDR_ENV] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[ADDR_ENV];
    } else {
      process.env[ADDR_ENV] = previous;
    }
  }
}

describe("addr", () => {
  const cases: Array<[string, string | undefined, string | undefined, string]> = [
    ["default", undefined, undefined, DEFAULT_ADDR],
    ["env", undefined, "http://10.0.0.5:8007", "http://10.0.0.5:8007"],
    ["explicit beats env", "http://127.0.0.1:8003", "http://10.0.0.5:8007", "http://127.0.0.1:8003"],
    ["trailing slash", "http://127.0.0.1:8003/", undefined, "http://127.0.0.1:8003"],
  ];

  for (const [name, addr, env, want] of cases) {
    it(name, () => {
      withEnv(env, () => {
        const client = new SpectralClient(addr === undefined ? {} : { addr });
        assert.equal(client.addr, want);
      });
    });
  }

  for (const addr of ["127.0.0.1:8000", "ftp://127.0.0.1:8000", "http://", "not a url"]) {
    it(`rejects ${addr}`, () => {
      assert.throws(() => new SpectralClient({ addr }), TypeError);
    });
  }
});

describe("register", () => {
  it("sends the registration and parses the lease", async () => {
    const [client, fake] = await sidecar(() => ({
      status: 201,
      json: { token: "abc123", ttl: "10s", expires_at: "2026-11-16T12:00:10.123456789-08:00" },
    }));

    const lease = await client.register({
      service: "payments",
      instanceId: "payments-1",
      endpoint: "http://100.64.1.3:9007",
      ttlMs: 10_000,
    });

    const req = fake.requests[0];
    assert.equal(req?.method, "POST");
    assert.equal(req?.path, "/register");
    assert.equal(req?.headers["content-type"], "application/json");
    assert.deepEqual(req?.body, {
      service: "payments",
      instance_id: "payments-1",
      endpoint: "http://100.64.1.3:9007",
      ttl: "10s",
    });
    assert.equal(lease.token, "abc123");
    assert.equal(lease.ttlMs, 10_000);
    assert.equal(lease.expiresAt.toISOString(), "2026-11-16T20:00:10.123Z");
  });

  const cases: Array<[number, new (...args: never[]) => APIError]> = [
    [400, InvalidRegistrationError],
    [409, AlreadyRegisteredError],
    [504, SidecarTimeoutError],
    [500, APIError],
  ];

  for (const [status, want] of cases) {
    it(`maps http ${status} to ${want.name}`, async () => {
      const [client] = await sidecar(() => ({ status, text: "nope\n" }));

      await assert.rejects(
        client.register({ service: "payments", instanceId: "p1", endpoint: "http://127.0.0.1:9000", ttlMs: 1000 }),
        (err: unknown) => {
          assert.ok(err instanceof APIError);
          assert.equal(err.constructor, want);
          assert.equal(err.name, want.name);
          assert.equal(err.op, "register");
          assert.equal(err.status, status);
          assert.equal(err.body, "nope");
          return true;
        },
      );
    });
  }
});

describe("renew", () => {
  it("sends the token", async () => {
    const [client, fake] = await sidecar(() => ({ status: 202 }));
    await client.renew("abc123");
    assert.equal(fake.requests[0]?.method, "POST");
    assert.equal(fake.requests[0]?.path, "/renew");
    assert.deepEqual(fake.requests[0]?.body, { token: "abc123" });
  });

  it("reports an unknown token as an expired lease", async () => {
    const [client] = await sidecar(() => ({ status: 404, text: "unknown lease" }));
    await assert.rejects(client.renew("gone"), (err: unknown) => {
      assert.ok(err instanceof LeaseExpiredError);
      assert.ok(err.cause instanceof APIError);
      return true;
    });
  });
});

describe("lookup", () => {
  it("queries by service name", async () => {
    const [client, fake] = await sidecar(() => ({
      status: 200,
      json: { service: "model-server/llama 70b", instance_id: "ms-0412", endpoint: "http://100.64.1.6:9002" },
    }));

    const provider = await client.lookup("model-server/llama 70b");

    assert.equal(fake.requests[0]?.method, "GET");
    assert.equal(fake.requests[0]?.path, "/lookup");
    assert.deepEqual(fake.requests[0]?.query, { service: "model-server/llama 70b" });
    assert.deepEqual(provider, {
      service: "model-server/llama 70b",
      instanceId: "ms-0412",
      endpoint: "http://100.64.1.6:9002",
    });
  });

  it("maps 404 to ServiceNotFoundError", async () => {
    const [client] = await sidecar(() => ({ status: 404, text: "no providers" }));
    await assert.rejects(client.lookup("inventory"), ServiceNotFoundError);
  });
});

describe("status", () => {
  it("parses ready and state", async () => {
    const [client, fake] = await sidecar(() => ({ status: 200, json: { ready: true, state: "active" } }));
    assert.deepEqual(await client.status(), { ready: true, state: "active" });
    assert.equal(fake.requests[0]?.path, "/status");
  });

  it("keeps a base path prefix", async () => {
    const fake = await startFakeSidecar(() => ({ status: 200, json: { ready: true, state: "active" } }));
    open.push(fake);
    await new SpectralClient({ addr: `${fake.url}/sidecar/` }).status();
    assert.equal(fake.requests[0]?.path, "/sidecar/status");
  });

  it("rejects a malformed response", async () => {
    const [client] = await sidecar(() => ({ status: 200, json: { state: "active" } }));
    await assert.rejects(client.status(), /missing "ready"/);
  });
});

describe("transport", () => {
  it("reports an unreachable sidecar", async () => {
    const fake = await startFakeSidecar(() => ({ status: 200 }));
    await fake.close();
    await assert.rejects(new SpectralClient({ addr: fake.url }).status(), SidecarUnavailableError);
  });

  it("propagates the caller's abort", async () => {
    const [client] = await sidecar(() => ({ status: 200, json: { ready: true, state: "active" } }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.status({ signal: controller.signal }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, "AbortError");
      return true;
    });
  });
});
