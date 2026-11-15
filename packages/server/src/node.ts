import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { GateRequest, Handler, PaymentGate } from "./gate.js";

export interface NodeAdapterOptions {
  /** Largest request body accepted, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Origin used for `resource.url` when the request has no Host header. */
  fallbackOrigin?: string;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) return undefined;
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * A `node:http` request listener that runs every request through the gate.
 * Express, Fastify and Koa sit on the same request and response objects, so
 * the listener can also be mounted under them.
 */
export function nodeListener(
  gate: PaymentGate,
  handler: Handler,
  options: NodeAdapterOptions = {},
): RequestListener {
  const limit = options.maxBodyBytes ?? 1024 * 1024;
  return (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req, limit);
      if (!body) {
        res.writeHead(413).end();
        return;
      }
      const target = req.url ?? "/";
      const origin = req.headers.host
        ? `http://${req.headers.host}`
        : (options.fallbackOrigin ?? "http://localhost");
      const request: GateRequest = {
        method: req.method ?? "GET",
        target,
        url: new URL(target, origin).toString(),
        header: (name) => {
          const v = req.headers[name.toLowerCase()];
          return Array.isArray(v) ? v.join(", ") : v;
        },
        body,
      };
      const out = await gate.handle(request, handler);
      res.writeHead(out.status, out.headers);
      res.end(Buffer.from(out.body.buffer, out.body.byteOffset, out.body.byteLength));
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(err instanceof Error ? "internal error" : "");
    });
  };
}
