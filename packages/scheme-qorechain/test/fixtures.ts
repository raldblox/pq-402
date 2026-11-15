import { mldsaKeyPair, requestHash, type Hex } from "@pq-402/core";
import type { PaymentRequirements } from "@x402/core/types";
import { MemoryChain, PqEscrowClientScheme, PqEscrowFacilitator } from "../src/index.js";

export const ESCROW: Hex = "0x1111111111111111111111111111111111111111";
export const PAYER: Hex = "0x2222222222222222222222222222222222222222";
export const PAYEE: Hex = "0x3333333333333333333333333333333333333333";
export const RELAYER: Hex = "0x4444444444444444444444444444444444444444";
export const T0 = 1_763_200_000;

export const payerKeys = mldsaKeyPair(new Uint8Array(32).fill(11));

export const requirements: PaymentRequirements = {
  scheme: "pq-escrow",
  network: "eip155:9800",
  amount: "10000",
  asset: "0x97143B771D34ddb9130b807b135Ae675A5a963CA",
  payTo: PAYEE,
  maxTimeoutSeconds: 120,
  extra: { escrow: ESCROW, version: "1" },
};

export const REQUEST_HASH = requestHash({ method: "GET", target: "/paid/hello", body: new Uint8Array() });

export function setup() {
  const chain = new MemoryChain(ESCROW, T0);
  chain.registerKey(PAYER, payerKeys.publicKey);
  chain.deposit(PAYER, 1_000_000n);
  const facilitator = new PqEscrowFacilitator({
    networks: ["eip155:9800"],
    reader: chain,
    settler: chain.settler(RELAYER),
  });
  const client = new PqEscrowClientScheme({ payer: PAYER, secretKey: payerKeys.secretKey, now: () => T0 });
  return { chain, facilitator, client };
}

export async function paymentPayload(client: PqEscrowClientScheme, r = requirements, hash = REQUEST_HASH) {
  const { x402Version, payload } = await client.forRequest(hash).createPaymentPayload(2, r);
  return { x402Version, accepted: r, payload };
}
