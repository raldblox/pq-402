import { ErrorCode, generateSealKeys, mldsaKeyPair, type Hex } from "@pq-402/core";
import { MemoryChain, PqErc20Facilitator, qorechainTestnet } from "@pq-402/scheme-qorechain";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { NonceCache, PaymentGate, type GateRequest, type Handler } from "../src/index.js";

const ESCROW: Hex = "0x1111111111111111111111111111111111111111";
const GATEWAY: Hex = "0x3333333333333333333333333333333333333333";

function gate(sealing = true) {
  const chain = new MemoryChain(ESCROW);
  return new PaymentGate({
    network: qorechainTestnet,
    escrow: ESCROW,
    facilitator: new PqErc20Facilitator({ networks: ["eip155:9800"], reader: chain }),
    kemKeys: chain,
    ...(sealing
      ? {
          gateway: {
            address: GATEWAY,
            mldsaSecretKey: mldsaKeyPair().secretKey,
            sealKeys: generateSealKeys(),
          },
        }
      : {}),
    routes: { "GET /paid": { price: "$0.25", payTo: GATEWAY, description: "paid thing" } },
  });
}

const request = (target: string, headers: Record<string, string> = {}): GateRequest => ({
  method: "GET",
  target,
  url: `http://localhost${target}`,
  header: (n) => headers[n.toLowerCase()],
  body: new Uint8Array(),
});

let calls = 0;
const handler: Handler = async () => {
  calls += 1;
  return { status: 200, contentType: "text/plain", body: new TextEncoder().encode("ok") };
};

describe("PaymentGate", () => {
  it("answers an unpaid request with an x402 v2 402 and does not run the handler", async () => {
    calls = 0;
    const res = await gate().handle(request("/paid?q=1"), handler);
    expect(res.status).toBe(402);
    expect(calls).toBe(0);
    const required = decodePaymentRequiredHeader(res.headers["PAYMENT-REQUIRED"]!);
    expect(required).toEqual(JSON.parse(new TextDecoder().decode(res.body)));
    expect(required.resource).toEqual({ url: "http://localhost/paid?q=1", description: "paid thing" });
    expect(required.accepts).toEqual([
      {
        scheme: "pq-erc20",
        network: "eip155:9800",
        asset: "0x97143B771D34ddb9130b807b135Ae675A5a963CA",
        amount: "250000",
        payTo: GATEWAY,
        maxTimeoutSeconds: 120,
        extra: { escrow: ESCROW, version: "1" },
      },
    ]);
    expect(required.extensions?.["pq402-sealing"]).toMatchObject({
      info: { gateway: GATEWAY, chainId: "qorechain-diana", mode: "mlkem", request: "optional" },
      schema: { type: "object" },
    });
    expect(res.headers["Access-Control-Expose-Headers"]).toContain("PAYMENT-REQUIRED");
  });

  it("declares no extension without a gateway identity", async () => {
    const res = await gate(false).handle(request("/paid"), handler);
    expect(decodePaymentRequiredHeader(res.headers["PAYMENT-REQUIRED"]!).extensions).toBeUndefined();
  });

  it("refuses a malformed PAYMENT-SIGNATURE", async () => {
    const res = await gate().handle(request("/paid", { "payment-signature": "not base64 json" }), handler);
    expect(res.status).toBe(402);
    expect(decodePaymentRequiredHeader(res.headers["PAYMENT-REQUIRED"]!).error).toBe(
      ErrorCode.InvalidPayload,
    );
  });

  it("refuses a payload that does not echo the sealing declaration", async () => {
    const g = gate();
    const unpaid = decodePaymentRequiredHeader(
      (await g.handle(request("/paid"), handler)).headers["PAYMENT-REQUIRED"]!,
    );
    const { requestHash } = await import("@pq-402/core");
    const payload = {
      x402Version: 2,
      accepted: unpaid.accepts[0]!,
      payload: {
        payer: "0x2222222222222222222222222222222222222222",
        nonce: `0x${"ab".repeat(32)}`,
        validAfter: "0",
        validBefore: "9999999999",
        requestHash: requestHash({ method: "GET", target: "/paid", body: new Uint8Array() }),
        signature: Buffer.alloc(4627).toString("base64"),
      },
    };
    const res = await g.handle(
      request("/paid", { "payment-signature": encodePaymentSignatureHeader(payload) }),
      handler,
    );
    expect(decodePaymentRequiredHeader(res.headers["PAYMENT-REQUIRED"]!).error).toBe(ErrorCode.Sealing);
  });

  it("answers a probe to an unpaid route without running the handler", async () => {
    calls = 0;
    const res = await gate().handle(request("/free", { "pq402-probe": "1" }), handler);
    expect(res.status).toBe(204);
    expect(calls).toBe(0);
  });

  it("passes unpaid routes straight to the handler", async () => {
    calls = 0;
    const res = await gate().handle(request("/free"), handler);
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});

describe("NonceCache", () => {
  it("holds a nonce until it expires, case-insensitively", () => {
    const c = new NonceCache();
    expect(c.claim("erc20:0xAA:0xBB", 100, 0)).toBe(true);
    expect(c.claim("erc20:0xaa:0xbb", 100, 50)).toBe(false);
    expect(c.claim("erc20:0xaa:0xbb", 200, 100)).toBe(true);
    c.release("ERC20:0xAA:0xBB");
    expect(c.size).toBe(0);
  });
});
