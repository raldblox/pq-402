import {
  SCHEME_ERC20,
  SCHEME_PERENNIAL,
  erc20ReceiptPayment,
  parsePayload,
  parsePerennialPayload,
  paymentOf,
  perennialReceiptPayment,
  perennialSpendOf,
  type Hex,
  type ReceiptPayment,
} from "@pq402/core";
import type { PaymentRequirements } from "@x402/core/types";

/** What the HTTP layer needs to know about a payment, whichever PQ-402 scheme carries it. */
export interface PaymentView {
  scheme: typeof SCHEME_ERC20 | typeof SCHEME_PERENNIAL;
  payer: Hex;
  /** The request hash the signature commits to (`requestHash`, or `ref` for a Perennial spend). */
  requestHash: Hex;
  /** Unique per payment; a server refuses a second request with the same key. */
  replayKey: string;
  /** Unix seconds after which the payment can no longer settle. */
  expiresAt: number;
  /** The payment as the gateway's receipt describes it. */
  receipt: ReceiptPayment;
}

/** Reads a PQ-402 payload against the requirements it accepted; `undefined` when malformed. */
export function describePayment(
  requirements: PaymentRequirements,
  payload: unknown,
): PaymentView | undefined {
  try {
    if (requirements.scheme === SCHEME_ERC20) {
      const p = parsePayload(payload);
      if (!p) return undefined;
      const payment = paymentOf(requirements, p);
      return {
        scheme: SCHEME_ERC20,
        payer: p.payer,
        requestHash: p.requestHash,
        replayKey: `erc20:${payment.escrow}:${p.payer}:${p.nonce}`.toLowerCase(),
        expiresAt: Number(p.validBefore),
        receipt: erc20ReceiptPayment(payment),
      };
    }
    if (requirements.scheme === SCHEME_PERENNIAL) {
      const p = parsePerennialPayload(payload);
      if (!p) return undefined;
      const spend = perennialSpendOf(requirements, p);
      return {
        scheme: SCHEME_PERENNIAL,
        payer: p.payer,
        requestHash: p.ref,
        replayKey: `perennial:${spend.vault}:${p.positionId}:${p.nonce}`.toLowerCase(),
        expiresAt: Number(p.deadline),
        receipt: perennialReceiptPayment(spend, p.payer),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
