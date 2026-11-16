/**
 * Regenerates the known-answer vectors in this folder.
 *
 *   pnpm --filter @pq402/core exec tsx test/vectors/generate.ts
 *
 * Every input is fixed, so the output is identical on every run. The vectors
 * pin the exact bytes of the signed messages, the ML-DSA-87 signature (signing
 * is deterministic) and a sealed envelope (QoreSeal's test entry point takes
 * the randomness as input). The Solidity tests check the same message bytes.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sealWithEntropy } from "@qorechain/qoreseal/testing";
import { keccak256, type Hex } from "viem";
import {
  mldsaKeyPair,
  mldsaSign,
  paymentMessage,
  perennialSpendMessage,
  receiptMessage,
  requestAad,
  requestHash,
  sealKeysFromSeed,
  toHex,
  utf8,
  withdrawalMessage,
  REQUEST_PURPOSE,
} from "../../src/index.js";

const seed = (byte: number) => new Uint8Array(32).fill(byte);

const payer = mldsaKeyPair(seed(1));
const gateway = mldsaKeyPair(seed(2));

const request = { method: "POST", target: "/paid/echo?lang=en", body: utf8('{"hello":"world"}') };
const reqHash = requestHash(request);

const payment = {
  chainId: 9800n,
  escrow: "0x1111111111111111111111111111111111111111" as Hex,
  payer: "0x2222222222222222222222222222222222222222" as Hex,
  payTo: "0x3333333333333333333333333333333333333333" as Hex,
  asset: "0x97143B771D34ddb9130b807b135Ae675A5a963CA" as Hex,
  amount: 10_000n,
  nonce: `0x${"44".repeat(32)}` as Hex,
  validAfter: 1_763_200_000n,
  validBefore: 1_763_200_120n,
  requestHash: reqHash,
};
const payMsg = paymentMessage(payment);
const paySig = mldsaSign(payer.secretKey, payMsg);

const withdrawal = {
  chainId: 9800n,
  escrow: payment.escrow,
  payer: payment.payer,
  amount: 5_000n,
  nonce: `0x${"55".repeat(32)}` as Hex,
  deadline: 1_763_203_600n,
};

const receipt = {
  chainId: 9800n,
  settlement: payment.escrow,
  gateway: "0x6666666666666666666666666666666666666666" as Hex,
  payer: payment.payer,
  payTo: payment.payTo,
  amount: payment.amount,
  paymentId: payment.nonce,
  requestHash: reqHash,
  responseHash: keccak256(utf8("sealed response bytes")),
  transaction: `0x${"77".repeat(32)}` as Hex,
  settledAt: 1_763_200_003n,
};
const recMsg = receiptMessage(receipt);

const spend = {
  chainId: 9800n,
  vault: "0x8888888888888888888888888888888888888888" as Hex,
  positionId: 7n,
  nonce: 3n,
  deadline: 1_763_200_120n,
  to: payment.payTo,
  amount: 2_000n,
  ref: reqHash,
};
const spendMsg = perennialSpendMessage(spend);

const sealKeys = sealKeysFromSeed(seed(3));
const contentType = "application/json";
const entropy = new Uint8Array(92).map((_, i) => i);
const envelope = sealWithEntropy(
  {
    chainId: "qorechain-diana",
    purpose: REQUEST_PURPOSE,
    mode: "mlkem",
    recipients: [{ mlkemPublicKey: sealKeys.mlkemPublicKey }],
    plaintext: request.body,
    aad: requestAad(request.method, request.target, contentType),
  },
  entropy,
);

const big = (v: bigint) => v.toString();
const vectors = {
  description: "PQ-402 v1 known-answer vectors; regenerate with test/vectors/generate.ts",
  keys: {
    payerSeed: toHex(seed(1)),
    payerPublicKeyKeccak256: keccak256(payer.publicKey),
    gatewaySeed: toHex(seed(2)),
    sealSeed: toHex(seed(3)),
  },
  request: {
    method: request.method,
    target: request.target,
    bodyUtf8: '{"hello":"world"}',
    requestHash: reqHash,
  },
  payment: {
    fields: {
      ...payment,
      chainId: big(payment.chainId),
      amount: big(payment.amount),
      validAfter: big(payment.validAfter),
      validBefore: big(payment.validBefore),
    },
    message: toHex(payMsg),
    signature: toHex(paySig),
  },
  withdrawal: {
    fields: {
      ...withdrawal,
      chainId: big(withdrawal.chainId),
      amount: big(withdrawal.amount),
      deadline: big(withdrawal.deadline),
    },
    message: toHex(withdrawalMessage(withdrawal)),
  },
  receipt: {
    fields: {
      ...receipt,
      chainId: big(receipt.chainId),
      amount: big(receipt.amount),
      settledAt: big(receipt.settledAt),
    },
    message: toHex(recMsg),
    signature: toHex(mldsaSign(gateway.secretKey, recMsg)),
  },
  perennialSpend: {
    fields: {
      ...spend,
      chainId: big(spend.chainId),
      positionId: big(spend.positionId),
      nonce: big(spend.nonce),
      deadline: big(spend.deadline),
      amount: big(spend.amount),
    },
    message: toHex(spendMsg),
    signature: toHex(mldsaSign(payer.secretKey, spendMsg)),
  },
  sealedRequest: {
    chainId: "qorechain-diana",
    contentType,
    entropy: toHex(entropy),
    envelope: toHex(envelope),
  },
};

const out = fileURLToPath(new URL("./v1.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${out}`);
