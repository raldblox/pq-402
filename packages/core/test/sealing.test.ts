import { describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import {
  generateSealKeys,
  mldsaKeyPair,
  openRequest,
  openResponse,
  paymentOf,
  createPayload,
  parseSealingInfo,
  receiptProblem,
  requestHash,
  sealingDeclaration,
  sealRequest,
  sealResponse,
  signReceipt,
  utf8,
  ErrorCode,
  Pq402Error,
  type SealingInfo,
} from "../src/index.js";

const chainId = "qorechain-diana";
const gateway = generateSealKeys();
const payerSeal = generateSealKeys();
const body = utf8('{"prompt":"hello"}');

describe("request sealing", () => {
  const envelope = sealRequest({
    chainId,
    gatewayKey: gateway.mlkemPublicKey,
    method: "POST",
    target: "/paid/echo",
    contentType: "application/json",
    body,
  });

  it("does not contain the plaintext", () => {
    expect(Buffer.from(envelope).includes(Buffer.from(body))).toBe(false);
  });

  it("opens with the gateway's keys and the same request line", () => {
    const opened = openRequest({
      chainId,
      keys: gateway,
      method: "post",
      target: "/paid/echo",
      contentType: "application/json",
      envelope,
    });
    expect(opened).toEqual(body);
  });

  const opener = (over: Partial<Parameters<typeof openRequest>[0]>) => () =>
    openRequest({
      chainId,
      keys: gateway,
      method: "POST",
      target: "/paid/echo",
      contentType: "application/json",
      envelope,
      ...over,
    });

  it.each([
    ["another key", { keys: generateSealKeys() }],
    ["another path", { target: "/paid/other" }],
    ["another method", { method: "PUT" }],
    ["another content type", { contentType: "text/plain" }],
    ["another chain", { chainId: "qorechain-vladi" }],
  ])("fails with %s", (_name, over) => {
    expect(opener(over)).toThrow(Pq402Error);
  });

  it("fails on a flipped ciphertext byte", () => {
    const tampered = envelope.slice();
    tampered[tampered.length - 20]! ^= 1;
    expect(opener({ envelope: tampered })).toThrow(/sealing failed/);
  });

  it("is never readable as a response", () => {
    const rh = requestHash({ method: "POST", target: "/paid/echo", body: envelope });
    expect(() =>
      openResponse({ chainId, keys: gateway, requestHash: rh, contentType: "application/json", envelope }),
    ).toThrow(Pq402Error);
  });
});

describe("response sealing", () => {
  const rh = requestHash({ method: "GET", target: "/paid/hello", body: new Uint8Array() });
  const envelope = sealResponse({
    chainId,
    payerKey: payerSeal.mlkemPublicKey,
    requestHash: rh,
    contentType: "text/plain",
    body,
  });

  it("opens for the payer", () => {
    expect(
      openResponse({ chainId, keys: payerSeal, requestHash: rh, contentType: "text/plain", envelope }),
    ).toEqual(body);
  });

  it("is bound to the request and the content type", () => {
    const other = requestHash({ method: "GET", target: "/paid/other", body: new Uint8Array() });
    expect(() =>
      openResponse({ chainId, keys: payerSeal, requestHash: other, contentType: "text/plain", envelope }),
    ).toThrow(Pq402Error);
    expect(() =>
      openResponse({ chainId, keys: payerSeal, requestHash: rh, contentType: "text/html", envelope }),
    ).toThrow(Pq402Error);
  });

  it("reports the sealing error code", () => {
    try {
      openResponse({ chainId, keys: gateway, requestHash: rh, contentType: "text/plain", envelope });
      expect.unreachable();
    } catch (err) {
      expect((err as Pq402Error).code).toBe(ErrorCode.Sealing);
    }
  });
});

describe("sealing declaration", () => {
  const info: SealingInfo = {
    version: "1",
    chainId,
    gateway: "0x6666666666666666666666666666666666666666",
    mode: "mlkem",
    request: "optional",
    response: "sealed",
  };

  it("round-trips through parseSealingInfo, as a declaration or bare info", () => {
    expect(parseSealingInfo(sealingDeclaration(info))).toEqual(info);
    expect(parseSealingInfo(info)).toEqual(info);
  });

  it("rejects other modes and malformed gateways", () => {
    expect(parseSealingInfo({ ...info, mode: "hybrid" })).toBeUndefined();
    expect(parseSealingInfo({ ...info, gateway: "qor1abc" })).toBeUndefined();
    expect(parseSealingInfo({ ...info, request: "never" })).toBeUndefined();
  });
});

describe("receipts", () => {
  const gatewayKey = mldsaKeyPair(new Uint8Array(32).fill(7));
  const payerKey = mldsaKeyPair(new Uint8Array(32).fill(8));
  const gatewayAddress: Hex = "0x6666666666666666666666666666666666666666";
  const requirements = {
    scheme: "pq-erc20",
    network: "eip155:9800" as const,
    amount: "10000",
    asset: "0x97143B771D34ddb9130b807b135Ae675A5a963CA",
    payTo: "0x3333333333333333333333333333333333333333",
    maxTimeoutSeconds: 60,
    extra: { escrow: "0x1111111111111111111111111111111111111111", version: "1" },
  };
  const rh = requestHash({ method: "GET", target: "/paid/hello", body: new Uint8Array() });
  const payload = createPayload({
    requirements,
    payer: "0x2222222222222222222222222222222222222222",
    secretKey: payerKey.secretKey,
    requestHash: rh,
    now: 1_763_200_000,
  });
  const payment = paymentOf(requirements, payload);
  const responseBody = utf8("sealed response");
  const receipt = signReceipt({
    payment,
    gateway: gatewayAddress,
    secretKey: gatewayKey.secretKey,
    responseBody,
    transaction: `0x${"77".repeat(32)}`,
    settledAt: 1_763_200_003,
  });
  const check = (over: Partial<Parameters<typeof receiptProblem>[0]> = {}) =>
    receiptProblem({
      receipt,
      payment,
      gateway: gatewayAddress,
      gatewayKey: gatewayKey.publicKey,
      responseBody,
      ...over,
    });

  it("verifies", () => {
    expect(receipt.responseHash).toBe(keccak256(responseBody));
    expect(check()).toBeUndefined();
  });

  it("rejects another body, gateway, key, payment or a forged signature", () => {
    expect(check({ responseBody: utf8("other") })).toMatch(/response body/);
    expect(check({ gateway: "0x6666666666666666666666666666666666666667" })).toMatch(/another gateway/);
    expect(check({ gatewayKey: payerKey.publicKey })).toMatch(/signature is invalid/);
    expect(check({ payment: { ...payment, amount: 1n } })).toMatch(/signature is invalid/);
    expect(check({ receipt: { ...receipt, settledAt: "1763200004" } })).toMatch(/signature is invalid/);
    expect(check({ payment: { ...payment, requestHash: `0x${"00".repeat(32)}` } })).toMatch(
      /another request/,
    );
  });
});
