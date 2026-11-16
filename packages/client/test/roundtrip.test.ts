import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ErrorCode, generateSealKeys, mldsaKeyPair, SEALED_CONTENT_TYPE, type Hex } from "@pq402/core";
import { MemoryChain, PqErc20Facilitator, qorechainTestnet } from "@pq402/scheme-qorechain";
import { nodeListener, PaymentGate, type Facilitator, type Handler } from "@pq402/server";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { afterEach, describe, expect, it } from "vitest";
import { createPq402Fetch, Pq402Error, type KeyDirectory } from "../src/index.js";

const ESCROW: Hex = "0x1111111111111111111111111111111111111111";
const PAYER: Hex = "0x2222222222222222222222222222222222222222";
const GATEWAY: Hex = "0x3333333333333333333333333333333333333333";
const RELAYER: Hex = "0x4444444444444444444444444444444444444444";

const payerMldsa = mldsaKeyPair(new Uint8Array(32).fill(21));
const payerSeal = generateSealKeys();
const gatewayMldsa = mldsaKeyPair(new Uint8Array(32).fill(22));
const gatewaySeal = generateSealKeys();

interface Wire {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Paid routes: GET /paid/hello and POST /paid/echo ($0.01 each); GET /free is unpaid. */
const handler: Handler = async (req) => {
  if (req.target.startsWith("/paid/hello")) {
    return { status: 200, contentType: "text/plain", body: new TextEncoder().encode(`hello ${req.payer}`) };
  }
  if (req.target.startsWith("/paid/echo") || req.target.startsWith("/free")) {
    return { status: 200, contentType: req.contentType ?? "application/octet-stream", body: req.body };
  }
  return { status: 404, contentType: "text/plain", body: new Uint8Array() };
};

async function start(
  opts: { facilitator?: (f: Facilitator) => Facilitator; sealing?: boolean; chain?: MemoryChain } = {},
) {
  const chain = opts.chain ?? new MemoryChain(ESCROW);
  if (!opts.chain) {
    chain.registerKey(PAYER, payerMldsa.publicKey);
    chain.registerKemKey(PAYER, payerSeal.mlkemPublicKey);
    chain.registerKey(GATEWAY, gatewayMldsa.publicKey);
    chain.registerKemKey(GATEWAY, gatewaySeal.mlkemPublicKey);
    chain.deposit(PAYER, 1_000_000n);
  }
  const base = new PqErc20Facilitator({
    networks: ["eip155:9800"],
    reader: chain,
    settler: chain.settler(RELAYER),
  });
  const gate = new PaymentGate({
    network: qorechainTestnet,
    escrow: ESCROW,
    facilitator: opts.facilitator ? opts.facilitator(base) : base,
    kemKeys: chain,
    ...(opts.sealing === false
      ? {}
      : { gateway: { address: GATEWAY, mldsaSecretKey: gatewayMldsa.secretKey, sealKeys: gatewaySeal } }),
    routes: {
      "GET /paid/hello": { price: "$0.01", payTo: GATEWAY, description: "A paid greeting" },
      "POST /paid/echo": { price: "$0.01", payTo: GATEWAY, requestSealing: "required" },
    },
  });
  const server = createServer(nodeListener(gate, handler));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { chain, gate, origin };
}

/** A fetch that records every request on the wire. */
function recordingFetch(log: Wire[], tamper?: (res: Response) => Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array();
    log.push({ method: init?.method ?? "GET", url: String(input), headers, body });
    const res = await fetch(input, init);
    return tamper ? tamper(res) : res;
  }) as typeof fetch;
}

function payerFetch(chain: KeyDirectory, extra: Partial<Parameters<typeof createPq402Fetch>[0]> = {}) {
  return createPq402Fetch({
    payer: PAYER,
    mldsaSecretKey: payerMldsa.secretKey,
    sealKeys: payerSeal,
    keys: chain,
    chainId: "qorechain-diana",
    maxAmount: 50_000n,
    ...extra,
  });
}

describe("paid round trip over node:http", () => {
  it("pays, receives a sealed response with a verified receipt, and opens it", async () => {
    const { chain, origin } = await start();
    const wire: Wire[] = [];
    const res = await payerFetch(chain, { fetch: recordingFetch(wire) })(`${origin}/paid/hello`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`hello ${PAYER}`);
    expect(res.payment?.settlement.success).toBe(true);
    expect(res.payment?.receipt?.gateway).toBe(GATEWAY);
    expect(chain.paidTo(GATEWAY)).toBe(10_000n);
    expect(wire).toHaveLength(2);
    expect(wire[1]?.headers["payment-signature"]).toBeDefined();
  });

  it("seals the request body: the plaintext never crosses the wire", async () => {
    const { chain, origin } = await start();
    const wire: Wire[] = [];
    const secret = '{"prompt":"a confidential question"}';
    const res = await payerFetch(chain, { fetch: recordingFetch(wire) })(`${origin}/paid/echo?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: secret,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(secret);
    expect(res.payment?.requestSealed).toBe(true);
    // First attempt is a body-less probe; the paid retry carries only the envelope.
    expect(wire[0]?.headers["pq402-probe"]).toBe("1");
    expect(wire[0]?.body).toHaveLength(0);
    expect(wire[1]?.headers["content-type"]).toBe(SEALED_CONTENT_TYPE);
    for (const w of wire) expect(Buffer.from(w.body).includes(Buffer.from("confidential"))).toBe(false);
  });

  it("keeps both payment headers within Node's default 16 KiB header limit", async () => {
    const { chain, origin } = await start();
    const wire: Wire[] = [];
    const res = await payerFetch(chain, { fetch: recordingFetch(wire) })(`${origin}/paid/hello`);
    const signatureHeader = wire[1]?.headers["payment-signature"] ?? "";
    const responseHeader = res.headers.get("payment-response") ?? "";
    console.log(
      `PAYMENT-SIGNATURE ${signatureHeader.length} bytes, PAYMENT-RESPONSE ${responseHeader.length} bytes`,
    );
    expect(signatureHeader.length).toBeGreaterThan(6_000);
    expect(signatureHeader.length).toBeLessThan(16_384);
    expect(responseHeader.length).toBeGreaterThan(6_000);
    expect(responseHeader.length).toBeLessThan(16_384);
  });

  it("works without sealing when the server does not declare it", async () => {
    const { chain, origin } = await start({ sealing: false });
    const res = await payerFetch(chain)(`${origin}/paid/hello`);
    expect(await res.text()).toBe(`hello ${PAYER}`);
    expect(res.payment?.receipt).toBeUndefined();
    expect(chain.paidTo(GATEWAY)).toBe(10_000n);
  });

  it("passes unpaid routes through, probing first when there is a body", async () => {
    const { chain, origin } = await start();
    const wire: Wire[] = [];
    const res = await payerFetch(chain, { fetch: recordingFetch(wire) })(`${origin}/free`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "free text",
    });
    expect(await res.text()).toBe("free text");
    expect(wire.map((w) => w.headers["pq402-probe"])).toEqual(["1", undefined]);
    expect(chain.paidTo(GATEWAY)).toBe(0n);
  });
});

describe("what a stock x402 client sees", () => {
  it("parses the 402 but has no scheme to pay it with", async () => {
    const { origin } = await start();
    const res = await fetch(`${origin}/paid/hello`);
    expect(res.status).toBe(402);
    const http = new x402HTTPClient(new x402Client());
    const required = http.getPaymentRequiredResponse((n) => res.headers.get(n), await res.json());
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0]?.scheme).toBe("pq-erc20");
    expect(required.accepts[0]?.amount).toBe("10000");
    expect(required.extensions?.["pq402-sealing"]).toBeDefined();
    await expect(http.createPaymentPayload(required)).rejects.toThrow();
  });
});

describe("attacks", () => {
  async function capturedPayment() {
    const ctx = await start();
    const wire: Wire[] = [];
    await payerFetch(ctx.chain, { fetch: recordingFetch(wire) })(`${ctx.origin}/paid/hello`);
    return { ...ctx, paid: wire[1]! };
  }

  it("refuses a replayed PAYMENT-SIGNATURE to the same server", async () => {
    const { origin, paid } = await capturedPayment();
    const res = await fetch(`${origin}/paid/hello`, {
      headers: { "payment-signature": paid.headers["payment-signature"]! },
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe(ErrorCode.Replay);
  });

  it("refuses the replay after a server restart because the nonce is used on chain", async () => {
    const { chain, paid } = await capturedPayment();
    const restarted = await start({ chain });
    const res = await fetch(`${restarted.origin}/paid/hello`, {
      headers: { "payment-signature": paid.headers["payment-signature"]! },
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe(ErrorCode.NonceUsed);
    expect(chain.paidTo(GATEWAY)).toBe(10_000n);
  });

  it("refuses a payment moved to another request", async () => {
    const { origin, paid } = await capturedPayment();
    const res = await fetch(`${origin}/paid/hello?other=1`, {
      headers: { "payment-signature": paid.headers["payment-signature"]! },
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe(ErrorCode.RequestHashMismatch);
  });

  it("refuses a sealed body swapped for another envelope", async () => {
    const ctx = await start();
    const wire: Wire[] = [];
    await payerFetch(ctx.chain, { fetch: recordingFetch(wire) })(`${ctx.origin}/paid/echo`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "original",
    });
    const paid = wire[1]!;
    const tampered = paid.body.slice();
    tampered[tampered.length - 1]! ^= 1;
    const res = await fetch(`${ctx.origin}/paid/echo`, {
      method: "POST",
      headers: paid.headers,
      body: tampered,
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe(ErrorCode.RequestHashMismatch);
  });

  it("refuses a plaintext body where sealing is required", async () => {
    const { chain, origin } = await start();
    const f = payerFetch(chain, { sealRequests: false });
    await expect(f(`${origin}/paid/echo`, { method: "POST", body: "x" })).rejects.toThrow(/requires sealed/);
  });

  it("cannot open a request sealed to a key that is not the gateway's", async () => {
    const { chain, origin } = await start();
    const wrongKeys: KeyDirectory = {
      keyStatus: (a) => chain.keyStatus(a),
      kemKey: async () => generateSealKeys().mlkemPublicKey,
    };
    const f = payerFetch(wrongKeys);
    const err = await f(`${origin}/paid/echo`, { method: "POST", body: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Pq402Error);
    expect((err as Pq402Error).reason).toBe(ErrorCode.Sealing);
    expect(chain.paidTo(GATEWAY)).toBe(0n);
  });

  it("rejects a response altered in transit", async () => {
    const { chain, origin } = await start();
    const flip = async (res: Response) => {
      if (res.status !== 200) return res;
      const body = new Uint8Array(await res.arrayBuffer());
      body[body.length - 1]! ^= 1;
      return new Response(body, { status: 200, headers: res.headers });
    };
    const f = payerFetch(chain, { fetch: recordingFetch([], flip) });
    await expect(f(`${origin}/paid/hello`)).rejects.toThrow(/receipt does not match/);
  });

  it("rejects a receipt not signed by the gateway's registered key", async () => {
    const { chain, origin } = await start();
    const impostor: KeyDirectory = {
      keyStatus: async () => ({
        registered: true,
        algorithmId: 1,
        publicKey: mldsaKeyPair(new Uint8Array(32).fill(99)).publicKey,
        possessionProven: true,
      }),
      kemKey: (a) => chain.kemKey(a),
    };
    await expect(payerFetch(impostor)(`${origin}/paid/hello`)).rejects.toThrow(
      /receipt signature is invalid/,
    );
  });

  it("refuses to pay above the client's limit, before signing anything", async () => {
    const { chain, origin } = await start();
    const wire: Wire[] = [];
    const f = payerFetch(chain, { maxAmount: 9_999n, fetch: recordingFetch(wire) });
    await expect(f(`${origin}/paid/hello`)).rejects.toThrow(/exceeds the limit/);
    expect(wire).toHaveLength(1);
  });

  it("refuses a payer with no registered KEM key, without running the handler", async () => {
    const chain = new MemoryChain(ESCROW);
    chain.registerKey(PAYER, payerMldsa.publicKey);
    chain.registerKey(GATEWAY, gatewayMldsa.publicKey);
    chain.registerKemKey(GATEWAY, gatewaySeal.mlkemPublicKey);
    chain.deposit(PAYER, 1_000_000n);
    const { origin } = await start({ chain });
    const err = await payerFetch(chain)(`${origin}/paid/hello`).catch((e: unknown) => e);
    expect((err as Pq402Error).reason).toBe(ErrorCode.Sealing);
    expect(chain.paidTo(GATEWAY)).toBe(0n);
  });

  it("does not release the response when settlement fails", async () => {
    const { chain, origin } = await start({
      facilitator: (f) => ({
        verify: (p, r) => f.verify(p, r),
        settle: async (_p, r) => ({
          success: false,
          errorReason: "insufficient_funds",
          transaction: "",
          network: r.network,
        }),
      }),
    });
    const err = await payerFetch(chain)(`${origin}/paid/hello`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Pq402Error);
    expect((err as Pq402Error).reason).toBe("insufficient_funds");
  });
});
