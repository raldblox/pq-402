import { mldsaKeyPair, toBase64, fromBase64, ErrorCode } from "@pq-402/core";
import { x402Facilitator } from "@x402/core/facilitator";
import { describe, expect, it } from "vitest";
import { PqErc20ClientScheme, PqErc20Facilitator } from "../src/index.js";
import { PAYEE, PAYER, RELAYER, T0, paymentPayload, requirements, setup } from "./fixtures.js";

describe("PqErc20Facilitator.verify", () => {
  it("accepts a payment signed with the payer's registered key", async () => {
    const { facilitator, client } = setup();
    const result = await facilitator.verify(await paymentPayload(client), requirements);
    expect(result).toEqual({ isValid: true, payer: PAYER });
  });

  it("refuses a forged signature (other key)", async () => {
    const { facilitator } = setup();
    const mallory = mldsaKeyPair(new Uint8Array(32).fill(66));
    const forger = new PqErc20ClientScheme({ payer: PAYER, secretKey: mallory.secretKey, now: () => T0 });
    const result = await facilitator.verify(await paymentPayload(forger), requirements);
    expect(result.invalidReason).toBe(ErrorCode.InvalidSignature);
  });

  it("refuses a signature with one flipped bit", async () => {
    const { facilitator, client } = setup();
    const pp = await paymentPayload(client);
    const sig = fromBase64(pp.payload.signature as string);
    sig[100]! ^= 1;
    const result = await facilitator.verify(
      { ...pp, payload: { ...pp.payload, signature: toBase64(sig) } },
      requirements,
    );
    expect(result.invalidReason).toBe(ErrorCode.InvalidSignature);
  });

  it("refuses when the payload's accepted terms differ from the requirements", async () => {
    const { facilitator, client } = setup();
    const pp = await paymentPayload(client);
    for (const changed of [
      { ...requirements, amount: "1" },
      { ...requirements, payTo: "0x5555555555555555555555555555555555555555" },
      { ...requirements, extra: { escrow: "0x6666666666666666666666666666666666666666", version: "1" } },
    ]) {
      const result = await facilitator.verify(pp, changed);
      expect(result.invalidReason).toBe(ErrorCode.RequirementsMismatch);
    }
  });

  it("refuses a payment for another payee even if accepted is edited to match", async () => {
    const { facilitator, client } = setup();
    const pp = await paymentPayload(client);
    const other = { ...requirements, payTo: "0x5555555555555555555555555555555555555555" };
    const result = await facilitator.verify({ ...pp, accepted: other }, other);
    expect(result.invalidReason).toBe(ErrorCode.InvalidSignature);
  });

  it("refuses a payer without a proven key, with another algorithm, or with no key", async () => {
    for (const register of [
      (c: ReturnType<typeof setup>["chain"], k: Uint8Array) =>
        c.registerKey(PAYER, k, { possessionProven: false }),
      (c: ReturnType<typeof setup>["chain"], k: Uint8Array) => c.registerKey(PAYER, k, { algorithmId: 2 }),
    ]) {
      const { chain, facilitator, client } = setup();
      register(chain, mldsaKeyPair(new Uint8Array(32).fill(11)).publicKey);
      const result = await facilitator.verify(await paymentPayload(client), requirements);
      expect(result.invalidReason).toBe(ErrorCode.InvalidKey);
    }
    const { facilitator } = setup();
    const stranger = new PqErc20ClientScheme({
      payer: "0x7777777777777777777777777777777777777777",
      secretKey: mldsaKeyPair().secretKey,
      now: () => T0,
    });
    const result = await facilitator.verify(await paymentPayload(stranger), requirements);
    expect(result.invalidReason).toBe(ErrorCode.InvalidKey);
  });

  it("enforces the time window with a settlement margin", async () => {
    const { chain, facilitator, client } = setup();
    const pp = await paymentPayload(client);
    chain.advance(120 - 6);
    expect((await facilitator.verify(pp, requirements)).invalidReason).toBe(ErrorCode.Expired);

    const early = setup();
    const future = new PqErc20ClientScheme({ payer: PAYER, secretKey: setupKey(), now: () => T0 + 600 });
    expect((await early.facilitator.verify(await paymentPayload(future), requirements)).invalidReason).toBe(
      ErrorCode.NotYetValid,
    );
  });

  it("refuses more than the escrow balance", async () => {
    const { facilitator, client } = setup();
    const big = { ...requirements, amount: "1000001" };
    const result = await facilitator.verify(await paymentPayload(client, big), big);
    expect(result.invalidReason).toBe(ErrorCode.InsufficientFunds);
  });

  it("refuses malformed payloads, other schemes, networks and versions", async () => {
    const { facilitator, client } = setup();
    const pp = await paymentPayload(client);
    expect((await facilitator.verify({ ...pp, payload: { payer: PAYER } }, requirements)).invalidReason).toBe(
      ErrorCode.InvalidPayload,
    );
    const exact = { ...requirements, scheme: "exact" };
    expect((await facilitator.verify({ ...pp, accepted: exact }, exact)).invalidReason).toBe(
      ErrorCode.InvalidScheme,
    );
    const base = { ...requirements, network: "eip155:8453" as const };
    expect((await facilitator.verify({ ...pp, accepted: base }, base)).invalidReason).toBe(
      ErrorCode.InvalidNetwork,
    );
    const v2 = { ...requirements, extra: { ...requirements.extra, version: "2" } };
    expect((await facilitator.verify({ ...pp, accepted: v2 }, v2)).invalidReason).toBe(
      ErrorCode.InvalidVersion,
    );
  });

  it("fails closed when the chain cannot be read", async () => {
    const { chain, facilitator, client } = setup();
    const pp = await paymentPayload(client);
    chain.offline = true;
    const result = await facilitator.verify(pp, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(ErrorCode.ChainUnavailable);
  });
});

describe("PqErc20Facilitator.settle", () => {
  it("settles once and refuses the same payload again", async () => {
    const { chain, facilitator, client } = setup();
    const pp = await paymentPayload(client);
    const first = await facilitator.settle(pp, requirements);
    expect(first.success).toBe(true);
    expect(first.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.amount).toBe("10000");
    expect(chain.paidTo(PAYEE)).toBe(10_000n);

    const again = await facilitator.settle(pp, requirements);
    expect(again.success).toBe(false);
    expect(again.errorReason).toBe(ErrorCode.NonceUsed);
    expect(chain.paidTo(PAYEE)).toBe(10_000n);
  });

  it("does not settle without a settler", async () => {
    const { chain, client } = setup();
    const verifyOnly = new PqErc20Facilitator({ networks: ["eip155:9800"], reader: chain });
    const result = await verifyOnly.settle(await paymentPayload(client), requirements);
    expect(result.success).toBe(false);
    expect(verifyOnly.getSigners("eip155:9800")).toEqual([]);
  });

  it("plugs into x402Facilitator from @x402/core", async () => {
    const { facilitator, client } = setup();
    const x402 = new x402Facilitator().register("eip155:9800", facilitator);
    expect(x402.getSupported().kinds).toEqual([
      { x402Version: 2, scheme: "pq-erc20", network: "eip155:9800" },
    ]);
    expect(x402.getSupported().signers).toEqual({ "eip155:*": [RELAYER] });
    const pp = await paymentPayload(client);
    expect((await x402.verify(pp, requirements)).isValid).toBe(true);
    expect((await x402.settle(pp, requirements)).success).toBe(true);
  });
});

function setupKey() {
  return mldsaKeyPair(new Uint8Array(32).fill(11)).secretKey;
}
