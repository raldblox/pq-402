import {
  ErrorCode,
  fromBase64,
  mldsaKeyPair,
  perennialSpendMessage,
  perennialSpendOf,
  toBase64,
  type Hex,
} from "@pq402/core";
import type { PaymentRequirements } from "@x402/core/types";
import { x402Facilitator } from "@x402/core/facilitator";
import { describe, expect, it } from "vitest";
import {
  MemoryChain,
  PqErc20Facilitator,
  PqPerennialClientScheme,
  PqPerennialFacilitator,
  PqPerennialServerScheme,
  describePayment,
  qorechainTestnet,
} from "../src/index.js";
import { ESCROW, PAYEE, RELAYER, REQUEST_HASH, T0 } from "./fixtures.js";

const VAULT: Hex = "0x8888888888888888888888888888888888888888";
const AGENT: Hex = "0x5555555555555555555555555555555555555555";
const agentKeys = mldsaKeyPair(new Uint8Array(32).fill(31));

const requirements: PaymentRequirements = {
  scheme: "pq-perennial",
  network: "eip155:9800",
  amount: "2000",
  asset: "0x97143B771D34ddb9130b807b135Ae675A5a963CA",
  payTo: PAYEE,
  maxTimeoutSeconds: 120,
  extra: { vault: VAULT, version: "1" },
};

function setup(buffer = 10_000n) {
  const chain = new MemoryChain(ESCROW, T0);
  chain.registerKey(AGENT, agentKeys.publicKey);
  chain.openPosition(VAULT, 7n, AGENT, buffer);
  const facilitator = new PqPerennialFacilitator({
    networks: ["eip155:9800"],
    reader: chain,
    settler: chain.settler(RELAYER),
  });
  const client = new PqPerennialClientScheme({
    payer: AGENT,
    secretKey: agentKeys.secretKey,
    positionId: 7n,
    nonceOf: async (vault, id) => (await chain.perennialPosition(vault, id)).nonce,
    now: () => T0,
  });
  return { chain, facilitator, client };
}

async function payload(client: PqPerennialClientScheme, r = requirements) {
  const { x402Version, payload } = await client.forRequest(REQUEST_HASH).createPaymentPayload(2, r);
  return { x402Version, accepted: r, payload };
}

describe("pq-perennial", () => {
  it("signs a vault spend of the price to payTo with ref = request hash", async () => {
    const { client } = setup();
    const pp = await payload(client);
    expect(pp.payload).toMatchObject({
      payer: AGENT,
      positionId: "7",
      nonce: "0",
      deadline: String(T0 + 120),
      ref: REQUEST_HASH,
    });
    const spend = perennialSpendOf(requirements, pp.payload as never);
    expect(spend).toMatchObject({ vault: VAULT, to: PAYEE, amount: 2000n, ref: REQUEST_HASH });
  });

  it("verifies, settles once, and the position nonce then refuses the same spend", async () => {
    const { chain, facilitator, client } = setup();
    const pp = await payload(client);
    expect(await facilitator.verify(pp, requirements)).toEqual({ isValid: true, payer: AGENT });
    const settled = await facilitator.settle(pp, requirements);
    expect(settled.success).toBe(true);
    expect(chain.paidTo(PAYEE)).toBe(2000n);
    expect((await chain.perennialPosition(VAULT, 7n)).buffer).toBe(8000n);
    const again = await facilitator.settle(pp, requirements);
    expect(again.errorReason).toBe(ErrorCode.NonceUsed);
    expect(chain.paidTo(PAYEE)).toBe(2000n);
  });

  it("refuses a spend signed by a key other than the beneficiary's", async () => {
    const { chain, facilitator } = setup();
    const thief = new PqPerennialClientScheme({
      payer: AGENT,
      secretKey: mldsaKeyPair(new Uint8Array(32).fill(66)).secretKey,
      positionId: 7n,
      nonceOf: async () => 0n,
      now: () => T0,
    });
    expect((await facilitator.verify(await payload(thief), requirements)).invalidReason).toBe(
      ErrorCode.InvalidSignature,
    );
    expect(chain.paidTo(PAYEE)).toBe(0n);
  });

  it("refuses a payer who is not the beneficiary", async () => {
    const { chain, facilitator } = setup();
    const other: Hex = "0x6666666666666666666666666666666666666666";
    chain.registerKey(other, agentKeys.publicKey);
    const impostor = new PqPerennialClientScheme({
      payer: other,
      secretKey: agentKeys.secretKey,
      positionId: 7n,
      nonceOf: async () => 0n,
      now: () => T0,
    });
    expect((await facilitator.verify(await payload(impostor), requirements)).invalidReason).toBe(
      ErrorCode.InvalidKey,
    );
  });

  it("refuses a spend redirected to another payee or amount", async () => {
    const { facilitator, client } = setup();
    const pp = await payload(client);
    const moved = { ...requirements, payTo: "0x7777777777777777777777777777777777777777" };
    expect((await facilitator.verify({ ...pp, accepted: moved }, moved)).invalidReason).toBe(
      ErrorCode.InvalidSignature,
    );
    const more = { ...requirements, amount: "2001" };
    expect((await facilitator.verify({ ...pp, accepted: more }, more)).invalidReason).toBe(
      ErrorCode.InvalidSignature,
    );
  });

  it("refuses a flipped signature bit, an expired deadline and a spend above the buffer", async () => {
    const { chain, facilitator, client } = setup();
    const pp = await payload(client);
    const sig = fromBase64((pp.payload as { signature: string }).signature);
    sig[5]! ^= 1;
    expect(
      (
        await facilitator.verify(
          { ...pp, payload: { ...pp.payload, signature: toBase64(sig) } },
          requirements,
        )
      ).invalidReason,
    ).toBe(ErrorCode.InvalidSignature);
    chain.advance(120);
    expect((await facilitator.verify(pp, requirements)).invalidReason).toBe(ErrorCode.Expired);

    const poor = setup(1_999n);
    expect((await poor.facilitator.verify(await payload(poor.client), requirements)).invalidReason).toBe(
      ErrorCode.InsufficientFunds,
    );
  });

  it("signs exactly the bytes of the vault's actionMessage encoding", async () => {
    const { client } = setup();
    const pp = await payload(client);
    const p = pp.payload as { signature: string };
    const message = perennialSpendMessage(perennialSpendOf(requirements, pp.payload as never));
    const { mldsaVerify } = await import("@pq402/core");
    expect(mldsaVerify(agentKeys.publicKey, message, fromBase64(p.signature))).toBe(true);
  });

  it("adds the vault to extra and registers next to pq-erc20 on one x402Facilitator", async () => {
    const server = new PqPerennialServerScheme({ network: qorechainTestnet, vault: VAULT });
    const r = await server.enhancePaymentRequirements({ ...requirements, extra: {} });
    expect(r.extra).toEqual({ vault: VAULT, version: "1" });

    const { chain, facilitator, client } = setup();
    const x402 = new x402Facilitator()
      .register("eip155:9800", facilitator)
      .register("eip155:9800", new PqErc20Facilitator({ networks: ["eip155:9800"], reader: chain }));
    expect(
      x402
        .getSupported()
        .kinds.map((k) => k.scheme)
        .sort(),
    ).toEqual(["pq-erc20", "pq-perennial"]);
    expect((await x402.settle(await payload(client), requirements)).success).toBe(true);
  });

  it("is described for the HTTP layer with ref as the request hash", async () => {
    const { client } = setup();
    const pp = await payload(client);
    const view = describePayment(requirements, pp.payload);
    expect(view).toMatchObject({
      scheme: "pq-perennial",
      payer: AGENT,
      requestHash: REQUEST_HASH,
      expiresAt: T0 + 120,
    });
    expect(view?.receipt.settlement).toBe(VAULT);
    expect(describePayment(requirements, { payer: AGENT })).toBeUndefined();
  });
});
