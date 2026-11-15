import { readFileSync } from "node:fs";
import { openWithEntropyCheck } from "./helpers.js";
import { describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import {
  fromHex,
  mldsaKeyPair,
  mldsaSign,
  mldsaVerify,
  paymentMessage,
  receiptMessage,
  requestHash,
  toHex,
  utf8,
  withdrawalMessage,
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SECRET_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH,
} from "../src/index.js";

interface Vectors {
  keys: { payerSeed: Hex; payerPublicKeyKeccak256: Hex; gatewaySeed: Hex; sealSeed: Hex };
  request: { method: string; target: string; bodyUtf8: string; requestHash: Hex };
  payment: { fields: Record<string, string>; message: Hex; signature: Hex };
  withdrawal: { fields: Record<string, string>; message: Hex };
  receipt: { fields: Record<string, string>; message: Hex; signature: Hex };
  sealedRequest: { chainId: string; contentType: string; entropy: Hex; envelope: Hex };
}

const v = JSON.parse(readFileSync(new URL("./vectors/v1.json", import.meta.url), "utf8")) as Vectors;

const asPayment = (f: Record<string, string>) => ({
  chainId: BigInt(f.chainId!),
  escrow: f.escrow as Hex,
  payer: f.payer as Hex,
  payTo: f.payTo as Hex,
  asset: f.asset as Hex,
  amount: BigInt(f.amount!),
  nonce: f.nonce as Hex,
  validAfter: BigInt(f.validAfter!),
  validBefore: BigInt(f.validBefore!),
  requestHash: f.requestHash as Hex,
});

describe("known-answer vectors (test/vectors/v1.json)", () => {
  const payer = mldsaKeyPair(fromHex(v.keys.payerSeed));

  it("derives the same ML-DSA-87 key from the seed", () => {
    expect(payer.publicKey).toHaveLength(ML_DSA_87_PUBLIC_KEY_LENGTH);
    expect(payer.secretKey).toHaveLength(ML_DSA_87_SECRET_KEY_LENGTH);
    expect(keccak256(payer.publicKey)).toBe(v.keys.payerPublicKeyKeccak256);
  });

  it("computes the request hash", () => {
    const { method, target, bodyUtf8 } = v.request;
    expect(requestHash({ method, target, body: utf8(bodyUtf8) })).toBe(v.request.requestHash);
    expect(requestHash({ method: method.toLowerCase(), target, body: utf8(bodyUtf8) })).toBe(
      v.request.requestHash,
    );
  });

  it("encodes the payment message to the pinned 352 bytes", () => {
    const msg = paymentMessage(asPayment(v.payment.fields));
    expect(msg).toHaveLength(352);
    expect(toHex(msg)).toBe(v.payment.message);
  });

  it("signs deterministically and the pinned signature verifies", () => {
    const msg = fromHex(v.payment.message);
    const sig = mldsaSign(payer.secretKey, msg);
    expect(sig).toHaveLength(ML_DSA_87_SIGNATURE_LENGTH);
    expect(toHex(sig)).toBe(v.payment.signature);
    expect(mldsaVerify(payer.publicKey, msg, fromHex(v.payment.signature))).toBe(true);
  });

  it("encodes the withdrawal message", () => {
    const f = v.withdrawal.fields;
    const msg = withdrawalMessage({
      chainId: BigInt(f.chainId!),
      escrow: f.escrow as Hex,
      payer: f.payer as Hex,
      amount: BigInt(f.amount!),
      nonce: f.nonce as Hex,
      deadline: BigInt(f.deadline!),
    });
    expect(msg).toHaveLength(7 * 32);
    expect(toHex(msg)).toBe(v.withdrawal.message);
  });

  it("encodes and verifies the receipt message", () => {
    const f = v.receipt.fields;
    const msg = receiptMessage({
      chainId: BigInt(f.chainId!),
      escrow: f.escrow as Hex,
      gateway: f.gateway as Hex,
      payer: f.payer as Hex,
      payTo: f.payTo as Hex,
      amount: BigInt(f.amount!),
      nonce: f.nonce as Hex,
      requestHash: f.requestHash as Hex,
      responseHash: f.responseHash as Hex,
      transaction: f.transaction as Hex,
      settledAt: BigInt(f.settledAt!),
    });
    expect(toHex(msg)).toBe(v.receipt.message);
    const gateway = mldsaKeyPair(fromHex(v.keys.gatewaySeed));
    expect(mldsaVerify(gateway.publicKey, msg, fromHex(v.receipt.signature))).toBe(true);
  });

  it("reproduces the sealed request envelope and opens it", () => {
    const { plaintext, envelope } = openWithEntropyCheck(v);
    expect(toHex(envelope)).toBe(v.sealedRequest.envelope);
    expect(new TextDecoder().decode(plaintext)).toBe(v.request.bodyUtf8);
  });
});
