import { createPayload, parseExtra, SCHEME_ERC20 } from "@pq-402/core";
import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { Hex } from "viem";

export interface PqErc20ClientOptions {
  /** The paying account (its `0x` form). */
  payer: Hex;
  /** The payer's ML-DSA-87 secret key, matching the key registered on chain. */
  secretKey: Uint8Array;
  /** Unix seconds; defaults to the local clock. */
  now?: () => number;
}

/**
 * x402 `SchemeNetworkClient` for `pq-erc20`. A payment commits to one HTTP
 * request, which the scheme interface cannot see, so the instance registered
 * with an `x402Client` must be bound to the request first with
 * {@link PqErc20ClientScheme.forRequest}. `@pq-402/client` does this per call.
 */
export class PqErc20ClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME_ERC20;

  constructor(
    private readonly options: PqErc20ClientOptions,
    private readonly requestHash?: Hex,
  ) {}

  /** A copy of this scheme that pays for the request with this `requestHash`. */
  forRequest(requestHash: Hex): PqErc20ClientScheme {
    return new PqErc20ClientScheme(this.options, requestHash);
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (!this.requestHash) {
      throw new Error("PqErc20ClientScheme: bind the request first with forRequest(requestHash)");
    }
    if (!parseExtra(requirements.extra)) {
      throw new Error("payment requirements are not pq-erc20 version 1");
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
