# spectral-js

JavaScript/TypeScript client for the Spectral sidecar.

Every service instance runs next to a Spectral sidecar. Your service uses this client to talk to its own sidecar over HTTP: register itself, keep its lease alive, and look up other services. The sidecar handles everything else (gossip, failure detection, keeping the directory in sync across machines).

## Install

```sh
npm install @cap-theorem/spectral
```

Node 20.3+. ESM only, no runtime dependencies (uses the built-in `fetch`). Types are included.

## Quickstart

```ts
import { ServiceNotFoundError, SpectralClient } from "@cap-theorem/spectral";

const client = new SpectralClient();

const lease = await client.register({
  service: "payments",
  instanceId: "payments-1",
  endpoint: "http://100.64.1.3:9007",
  ttlMs: 10_000,
});

const shutdown = new AbortController();
client.keepAlive(lease, { signal: shutdown.signal });

try {
  const inventory = await client.lookup("inventory");
  await fetch(`${inventory.endpoint}/stock`);
} catch (err) {
  if (!(err instanceof ServiceNotFoundError)) throw err;
}
```

A runnable version is in [`examples/quickstart.ts`](examples/quickstart.ts) (`node examples/quickstart.ts` on Node 24).

## Connecting to the sidecar

`new SpectralClient({ addr?, timeoutMs?, fetch? })` picks the sidecar address in this order:

1. `addr`, if given
2. the `SPECTRAL_ADDR` environment variable
3. `http://127.0.0.1:8000`, the sidecar's default API port

`timeoutMs` (default 10 000) applies to each request. Pass `fetch` to use your own implementation. Every method also takes `{ signal }` to cancel; an aborted call rejects with the signal's reason.

## API

| Method | What it does |
|---|---|
| `register({ service, instanceId, endpoint, ttlMs }): Promise<Lease>` | Announce this instance. The sidecar spreads it to the whole network. |
| `renew(token): Promise<void>` | Extend the lease once. |
| `keepAlive(lease, { signal }): Promise<void>` | Renew every `ttlMs / 3` until `signal` aborts, then resolve. Retries failed renewals and rejects with `LeaseExpiredError` if none succeed for a full TTL, or right away if the sidecar no longer knows the lease. |
| `lookup(service): Promise<Provider>` | Get one healthy instance of a service, answered from the sidecar's local copy of the directory. |
| `status(): Promise<Status>` | Whether the sidecar is ready, and its state. |

`Lease` is `{ token, ttlMs, expiresAt: Date }`. `Provider` is `{ service, instanceId, endpoint }`. `Status` is `{ ready, state }`.

If your instance stops renewing (crash, hang, keep-alive stopped), the lease expires and the instance disappears from every sidecar's directory. There is no explicit deregister: stop renewing, or shut the sidecar down.

## Errors

Every error extends `SpectralError`; check with `instanceof`:

| Error | Meaning |
|---|---|
| `InvalidRegistrationError` | The sidecar rejected the registration (missing fields, bad endpoint URL, non-positive TTL). |
| `AlreadyRegisteredError` | This registration already exists. |
| `ServiceNotFoundError` | No healthy instance of that service is known. |
| `LeaseExpiredError` | The lease is gone; register again. |
| `SidecarTimeoutError` | The sidecar accepted the request but did not answer in time. |
| `SidecarUnavailableError` | The sidecar could not be reached at all. |
| `APIError` | Any other non-2xx response. Base class of the four HTTP errors above; has `op`, `status` and `body`. |

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Tests run the TypeScript sources directly, which needs Node 22.18+ or 24.

## HTTP contract

This is the sidecar API the client speaks. Every Spectral SDK uses the same contract.

| Call | Request | Success | Errors |
|---|---|---|---|
| `POST /register` | `{"service", "instance_id", "endpoint", "ttl": "10s"}` | `201 {"token", "ttl", "expires_at"}` | `400` invalid, `409` exists, `504` timeout |
| `POST /renew` | `{"token"}` | `202` | `404` unknown or expired lease, `504` timeout |
| `GET /lookup?service=<name>` | | `200 {"service", "instance_id", "endpoint"}` | `404` no provider, `504` timeout |
| `GET /status` | | `200 {"ready", "state"}` | `504` timeout |

Durations are Go duration strings (`"10s"`, `"1m30s"`). Timestamps are RFC 3339. Error bodies are plain text.
