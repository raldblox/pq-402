import {
  ErrorCode,
  fromBase64,
  mldsaVerify,
  parseExtra,
  parsePayload,
  paymentMessage,
  paymentOf,
  sameAddress,
  ML_DSA_87_ALGORITHM_ID,
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  SCHEME_ERC20,
  type Payment,
} from "@pq-402/core";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { ChainReader, Settler } from "./chain.js";

export interface PqErc20FacilitatorOptions {
  /** Networks this facilitator serves, e.g. `["eip155:9800"]`. */
  networks: Network[];
  reader: ChainReader;
  /** Needed to settle; a verify-only facilitator may omit it. */
  settler?: Settler;
  /** Seconds a payment must still be valid for when verified, to leave time to settle. Default 6. */
  settlementMargin?: number;
}

type Outcome =
  { ok: true; payment: Payment; signature: Uint8Array } | { ok: false; code: ErrorCode; message: string };

const fail = (code: ErrorCode, message: string): Outcome => ({ ok: false, code, message });

/**
 * x402 `SchemeNetworkFacilitator` for `pq-erc20` (docs/spec.md, sections 6 and 7).
 * Register it on an `x402Facilitator`, or call `verify` / `settle` directly.
 */
export class PqErc20Facilitator implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME_ERC20;
  readonly caipFamily = "eip155:*";
  private readonly margin: number;

  constructor(private readonly options: PqErc20FacilitatorOptions) {
    this.margin = options.settlementMargin ?? 6;
  }

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return this.options.settler ? [this.options.settler.address] : [];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const outcome = await this.check(payload, requirements);
    if (!outcome.ok) {
      const payer = parsePayload(payload.payload)?.payer;
      return {
        isValid: false,
        invalidReason: outcome.code,
        invalidMessage: outcome.message,
        ...(payer ? { payer } : {}),
      };
    }
    return { isValid: true, payer: outcome.payment.payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    const outcome = await this.check(payload, requirements);
    if (!outcome.ok) {
      const payer = parsePayload(payload.payload)?.payer;
      return {
        success: false,
        errorReason: outcome.code,
        errorMessage: outcome.message,
        transaction: "",
        network,
        ...(payer ? { payer } : {}),
      };
    }
    const settler = this.options.settler;
    if (!settler) {
      return {
        success: false,
        errorReason: ErrorCode.SettlementFailed,
        errorMessage: "this facilitator has no settler",
        transaction: "",
        network,
        payer: outcome.payment.payer,
      };
    }
    try {
      const result = await settler.settle(outcome.payment, outcome.signature);
      return {
        success: true,
        transaction: result.transaction,
        network,
        payer: outcome.payment.payer,
        amount: outcome.payment.amount.toString(),
        extra: { settledAt: result.settledAt },
      };
    } catch (err) {
      return {
        success: false,
        errorReason: ErrorCode.SettlementFailed,
        errorMessage: err instanceof Error ? err.message : String(err),
        transaction: "",
        network,
        payer: outcome.payment.payer,
      };
    }
  }

  /** The checks of docs/spec.md section 6, in order; the first failure wins. */
  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Outcome> {
    const accepted = payload.accepted;
    if (requirements.scheme !== SCHEME_ERC20 || accepted?.scheme !== SCHEME_ERC20) {
      return fail(ErrorCode.InvalidScheme, `scheme must be ${SCHEME_ERC20}`);
    }
    if (!this.options.networks.includes(requirements.network)) {
      return fail(ErrorCode.InvalidNetwork, `network ${requirements.network} is not served here`);
    }
    if (!parseExtra(requirements.extra)) {
      return fail(ErrorCode.InvalidVersion, "requirements.extra must carry version 1 and an escrow address");
    }
    if (!sameRequirements(accepted, requirements)) {
      return fail(ErrorCode.RequirementsMismatch, "accepted does not match the requirements");
    }
    const p = parsePayload(payload.payload);
    if (!p) return fail(ErrorCode.InvalidPayload, "payload is malformed");

    let payment: Payment;
    try {
      payment = paymentOf(requirements, p);
    } catch (err) {
      return fail(ErrorCode.InvalidPayload, err instanceof Error ? err.message : "payload is malformed");
    }
    const signature = fromBase64(p.signature);
    const { reader } = this.options;

    try {
      const now = BigInt(await reader.now());
      if (payment.validAfter > now) return fail(ErrorCode.NotYetValid, "payment is not valid yet");
      if (now + BigInt(this.margin) >= payment.validBefore)
        return fail(ErrorCode.Expired, "payment has expired");

      if (await reader.nonceUsed(payment.escrow, payment.payer, payment.nonce)) {
        return fail(ErrorCode.NonceUsed, "nonce was already settled");
      }

      const key = await reader.keyStatus(payment.payer);
      if (
        !key.registered ||
        !key.possessionProven ||
        key.algorithmId !== ML_DSA_87_ALGORITHM_ID ||
        key.publicKey.length !== ML_DSA_87_PUBLIC_KEY_LENGTH
      ) {
        return fail(ErrorCode.InvalidKey, "payer has no proven ML-DSA-87 key on chain");
      }
      if (!mldsaVerify(key.publicKey, paymentMessage(payment), signature)) {
        return fail(ErrorCode.InvalidSignature, "signature does not verify against the payer's key");
      }

      const balance = await reader.escrowBalance(payment.escrow, payment.payer);
      if (balance < payment.amount) return fail(ErrorCode.InsufficientFunds, "escrow balance is too low");
    } catch (err) {
      return fail(ErrorCode.ChainUnavailable, err instanceof Error ? err.message : "chain read failed");
    }
    return { ok: true, payment, signature };
  }
}

function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  const ea = parseExtra(a.extra);
  const eb = parseExtra(b.extra);
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
    sameAddress(a.asset, b.asset) &&
    sameAddress(a.payTo, b.payTo) &&
    ea !== undefined &&
    eb !== undefined &&
    sameAddress(ea.escrow, eb.escrow)
  );
}
