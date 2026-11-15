import { createPayload, parseExtra, SCHEME } from "@pq-402/core";
import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { Hex } from "viem";

export interface PqEscrowClientOptions {
  /** The paying account (its `0x` form). */
  payer: Hex;
  /** The payer's ML-DSA-87 secret key, matching the key registered on chain. */
  secretKey: Uint8Array;
  /** Unix seconds; defaults to the local clock. */
  now?: () => number;
}

/**
 * x402 `SchemeNetworkClient` for `pq-escrow`. A payment commits to one HTTP
 * request, which the scheme interface cannot see, so the instance registered
 * with an `x402Client` must be bound to the request first with
 * {@link PqEscrowClientScheme.forRequest}. `@pq-402/client` does this per call.
 */
export class PqEscrowClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;

  constructor(
    private readonly options: PqEscrowClientOptions,
    private readonly requestHash?: Hex,
  ) {}

  /** A copy of this scheme that pays for the request with this `requestHash`. */
  forRequest(requestHash: Hex): PqEscrowClientScheme {
    return new PqEscrowClientScheme(this.options, requestHash);
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (!this.requestHash) {
      throw new Error("PqEscrowClientScheme: bind the request first with forRequest(requestHash)");
    }
    if (!parseExtra(requirements.extra)) {
      throw new Error("payment requirements are not pq-escrow version 1");
    }
    const payload = createPayload({
      requirements,
      payer: this.options.payer,
      secretKey: this.options.secretKey,
      requestHash: this.requestHash,
      now: this.options.now?.() ?? Math.floor(Date.now() / 1000),
    });
    return { x402Version, payload: { ...payload } };
  }
}
