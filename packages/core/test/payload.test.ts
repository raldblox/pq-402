import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  createPayload,
  evmChainIdOf,
  fromBase64,
  mldsaKeyPair,
  mldsaVerify,
  parseExtra,
  parsePayload,
  paymentMessage,
  paymentOf,
  requestHash,
  toBase64,
  utf8,
} from "../src/index.js";

const payer = mldsaKeyPair(new Uint8Array(32).fill(9));
const requirements: PaymentRequirements = {
  scheme: "pq-erc20",
  network: "eip155:9800",
  amount: "10000",
  asset: "0x97143B771D34ddb9130b807b135Ae675A5a963CA",
  payTo: "0x3333333333333333333333333333333333333333",
  maxTimeoutSeconds: 120,
  extra: { escrow: "0x1111111111111111111111111111111111111111", version: "1" },
};
const payerAddress: Hex = "0x2222222222222222222222222222222222222222";
const reqHash = requestHash({ method: "GET", target: "/paid/hello", body: new Uint8Array() });

describe("createPayload", () => {
  const payload = createPayload({
    requirements,
    payer: payerAddress,
    secretKey: payer.secretKey,
    requestHash: reqHash,
    now: 1_763_200_000,
  });

  it("sets the time window from now, skew and maxTimeoutSeconds", () => {
    expect(payload.validAfter).toBe("1763199970");
    expect(payload.validBefore).toBe("1763200120");
  });

  it("signs the payment message the requirements and payload describe", () => {
    const msg = paymentMessage(paymentOf(requirements, payload));
    expect(mldsaVerify(payer.publicKey, msg, fromBase64(payload.signature))).toBe(true);
  });

  it("uses a fresh random nonce each time", () => {
    const again = createPayload({
      requirements,
      payer: payerAddress,
      secretKey: payer.secretKey,
      requestHash: reqHash,
      now: 1_763_200_000,
    });
    expect(again.nonce).not.toBe(payload.nonce);
  });

  it("is invalid for any other amount, payee, asset, escrow, chain or request", () => {
    const sig = fromBase64(payload.signature);
    const variants: PaymentRequirements[] = [
      { ...requirements, amount: "10001" },
      { ...requirements, payTo: "0x3333333333333333333333333333333333333334" },
      { ...requirements, asset: "0x97143B771D34ddb9130b807b135Ae675A5a963CB" },
      { ...requirements, extra: { escrow: "0x1111111111111111111111111111111111111112", version: "1" } },
      { ...requirements, network: "eip155:9801" },
    ];
    for (const r of variants) {
      expect(mldsaVerify(payer.publicKey, paymentMessage(paymentOf(r, payload)), sig)).toBe(false);
    }
    const otherRequest = {
      ...payload,
      requestHash: requestHash({ method: "GET", target: "/paid/other", body: utf8("") }),
    };
    expect(mldsaVerify(payer.publicKey, paymentMessage(paymentOf(requirements, otherRequest)), sig)).toBe(
      false,
    );
  });
});

describe("parsePayload", () => {
  const good = {
    payer: payerAddress,
    nonce: `0x${"ab".repeat(32)}`,
    validAfter: "1",
    validBefore: "2",
    requestHash: reqHash,
    signature: toBase64(new Uint8Array(4627)),
  };

  it("accepts a well-formed payload", () => {
    expect(parsePayload(good)).toEqual(good);
  });

  it.each([
    ["missing payer", { ...good, payer: undefined }],
    ["short nonce", { ...good, nonce: "0xab" }],
    ["numeric time", { ...good, validAfter: 1 }],
    ["leading zero", { ...good, validBefore: "02" }],
    ["time over uint64", { ...good, validBefore: "18446744073709551616" }],
    ["short signature", { ...good, signature: toBase64(new Uint8Array(4626)) }],
    ["hex signature", { ...good, signature: `0x${"00".repeat(4627)}` }],
    ["not an object", "payload"],
  ])("rejects %s", (_name, value) => {
    expect(parsePayload(value)).toBeUndefined();
  });
});

describe("requirements helpers", () => {
  it("reads the extra of v1 only", () => {
    expect(parseExtra(requirements.extra)).toEqual(requirements.extra);
    expect(parseExtra({ ...requirements.extra, version: "2" })).toBeUndefined();
    expect(parseExtra({ version: "1" })).toBeUndefined();
  });

  it("reads the chain id of an eip155 network", () => {
    expect(evmChainIdOf("eip155:9800")).toBe(9800n);
    expect(() => evmChainIdOf("solana:abc")).toThrow();
  });
});
