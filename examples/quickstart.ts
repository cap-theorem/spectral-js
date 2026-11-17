import { ServiceNotFoundError, SpectralClient } from "../src/index.ts";

const client = new SpectralClient();

const lease = await client.register({
  service: "payments",
  instanceId: "payments-1",
  endpoint: "http://127.0.0.1:9000",
  ttlMs: 10_000,
});
console.log(`registered with ${client.addr}, lease expires at ${lease.expiresAt.toISOString()}`);

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

const keepingAlive = client.keepAlive(lease, { signal: shutdown.signal }).catch((err: unknown) => {
  console.error("keepalive stopped:", err);
  shutdown.abort();
});

try {
  const inventory = await client.lookup("inventory");
  console.log(`inventory is at ${inventory.endpoint}`);
} catch (err) {
  if (!(err instanceof ServiceNotFoundError)) {
    throw err;
  }
  console.log("no inventory instance registered yet");
}

await keepingAlive;
