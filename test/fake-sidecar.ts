import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeReply {
  status: number;
  json?: unknown;
  text?: string;
}

export interface FakeSidecar {
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

export async function startFakeSidecar(respond: (req: FakeRequest) => FakeReply): Promise<FakeSidecar> {
  const requests: FakeRequest[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://fake");
      const request: FakeRequest = {
        method: req.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw === "" ? undefined : JSON.parse(raw),
      };
      requests.push(request);

      const reply = respond(request);
      if (reply.text !== undefined) {
        res.writeHead(reply.status, { "content-type": "text/plain; charset=utf-8" });
        res.end(reply.text);
      } else if (reply.json !== undefined) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.json));
      } else {
        res.writeHead(reply.status);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
