import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { APIError, type Lease, LeaseExpiredError, SpectralClient } from "../src/index.ts";
import { type FakeReply, type FakeRequest, type FakeSidecar, startFakeSidecar } from "./fake-sidecar.ts";

const open: FakeSidecar[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function client(respond: (req: FakeRequest) => FakeReply): Promise<SpectralClient> {
  const fake = await startFakeSidecar(respond);
  open.push(fake);
  return new SpectralClient({ addr: fake.url, timeoutMs: 2000 });
}

function lease(ttlMs: number): Lease {
  return { token: "abc123", ttlMs, expiresAt: new Date() };
}

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (condition()) {
        resolve();
      } else if (performance.now() - start > timeoutMs) {
        reject(new Error("condition never became true"));
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

describe("keepAlive", () => {
  it("renews until aborted, then resolves", async () => {
    let renews = 0;
    const c = await client(() => {
      renews += 1;
      return { status: 202 };
    });

    const controller = new AbortController();
    const running = c.keepAlive(lease(60), { signal: controller.signal });

    await waitFor(() => renews >= 3);
    controller.abort();
    await running;
  });

  it("stops when the sidecar rejects the lease", async () => {
    const c = await client(() => ({ status: 404, text: "unknown lease" }));
    await assert.rejects(c.keepAlive(lease(60)), LeaseExpiredError);
  });

  it("gives up after a full ttl of failures", async () => {
    const c = await client(() => ({ status: 500, text: "boom" }));
    const start = performance.now();

    await assert.rejects(c.keepAlive(lease(60)), (err: unknown) => {
      assert.ok(err instanceof LeaseExpiredError);
      assert.ok(err.cause instanceof APIError);
      assert.equal(err.cause.status, 500);
      return true;
    });
    assert.ok(performance.now() - start >= 60);
  });

  it("retries a transient failure", async () => {
    let calls = 0;
    let renewed = false;
    const c = await client(() => {
      calls += 1;
      if (calls === 1) {
        return { status: 500, text: "blip" };
      }
      renewed = true;
      return { status: 202 };
    });

    const controller = new AbortController();
    const running = c.keepAlive(lease(60), { signal: controller.signal });

    await waitFor(() => renewed);
    controller.abort();
    await running;
  });

  it("rejects a ttl too short to renew", async () => {
    const c = await client(() => ({ status: 202 }));
    await assert.rejects(c.keepAlive(lease(2)), RangeError);
  });
});
