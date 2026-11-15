import {
  ErrorCode,
  SCHEME_PERENNIAL,
  PROTOCOL_VERSION,
  createPerennialPayload,
  fromBase64,
  mldsaVerify,
  parsePerennialExtra,
  parsePerennialPayload,
  perennialSpendMessage,
  perennialSpendOf,
  sameAddress,
  ML_DSA_87_ALGORITHM_ID,
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  type PerennialSpend,
} from "@pq-402/core";
import type {
  Network,
  PaymentPayload,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SettleResponse,
  SupportedKind,
  VerifyResponse,
} from "@x402/core/types";
import type { Hex } from "viem";
import type { ChainReader, Settler } from "./chain.js";
import type { QoreNetwork } from "./network.js";
import { PriceParser } from "./server.js";

// ---------------------------------------------------------------- resource server

export interface PqPerennialServerOptions {
  network: QoreNetwork;
  /** The Perennial v2 vault whose positions pay. Its asset must be the network's default asset. */
  vault: Hex;
}

/** x402 `SchemeNetworkServer` for `pq-perennial`: requirements with the vault in `extra`. */
export class PqPerennialServerScheme extends PriceParser {
  readonly scheme = SCHEME_PERENNIAL;

  constructor(private readonly perennial: PqPerennialServerOptions) {
    super(perennial.network);
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind?: SupportedKind,
    _facilitatorExtensions?: string[],
  ): Promise<PaymentRequirements> {
    this.requireNetwork(requirements.network);
    return {
      ...requirements,
      extra: { ...requirements.extra, vault: this.perennial.vault, version: PROTOCOL_VERSION },
    };
  }
}

// ---------------------------------------------------------------- client

export interface PqPerennialClientOptions {
  /** The position's beneficiary (the paying agent's account). */
  payer: Hex;
  secretKey: Uint8Array;
  positionId: bigint;
  /** Reads the position's current action nonce from the vault. */
  nonceOf: (vault: Hex, positionId: bigint) => Promise<bigint>;
  now?: () => number;
}

/**
 * x402 `SchemeNetworkClient` for `pq-perennial`: signs a Perennial `spend` of
 * the price from the position's buffer to `payTo`, with `ref` set to the
 * request hash. Bind it to the request with `forRequest` first.
 */
export class PqPerennialClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME_PERENNIAL;

  constructor(
    private readonly options: PqPerennialClientOptions,
    private readonly requestHash?: Hex,
  ) {}

  forRequest(requestHash: Hex): PqPerennialClientScheme {
    return new PqPerennialClientScheme(this.options, requestHash);
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (!this.requestHash) {
      throw new Error("PqPerennialClientScheme: bind the request first with forRequest(requestHash)");
    }
    const extra = parsePerennialExtra(requirements.extra);
    if (!extra) throw new Error("payment requirements are not pq-perennial version 1");
    const nonce = await this.options.nonceOf(extra.vault, this.options.positionId);
    const payload = createPerennialPayload({
      requirements,
      payer: this.options.payer,
      secretKey: this.options.secretKey,
      positionId: this.options.positionId,
      nonce,
      requestHash: this.requestHash,
      now: this.options.now?.() ?? Math.floor(Date.now() / 1000),
    });
    return { x402Version, payload: { ...payload } };
  }
}

// ---------------------------------------------------------------- facilitator

export interface PqPerennialFacilitatorOptions {
  networks: Network[];
  reader: ChainReader;
  settler?: Settler;
  /** Seconds a spend must still be valid for when verified. Default 6. */
  settlementMargin?: number;
}

type Outcome =
  | { ok: true; spend: PerennialSpend; payer: Hex; signature: Uint8Array }
  | { ok: false; code: ErrorCode; message: string };

const fail = (code: ErrorCode, message: string): Outcome => ({ ok: false, code, message });

/**
 * x402 `SchemeNetworkFacilitator` for `pq-perennial` (docs/spec.md, section 6.2):
 * checks the spend against the position and the beneficiary's on-chain key,
 * then relays `vault.spend(...)` and confirms the `Spent` event.
 */
export class PqPerennialFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME_PERENNIAL;
  readonly caipFamily = "eip155:*";
  private readonly margin: number;

  constructor(private readonly options: PqPerennialFacilitatorOptions) {
    this.margin = options.settlementMargin ?? 6;
  }

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return this.options.settler ? [this.options.settler.address] : [];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const o = await this.check(payload, requirements);
    if (!o.ok) {
      const payer = parsePerennialPayload(payload.payload)?.payer;
      return {
        isValid: false,
        invalidReason: o.code,
        invalidMessage: o.message,
        ...(payer ? { payer } : {}),
      };
    }
    return { isValid: true, payer: o.payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    const o = await this.check(payload, requirements);
    if (!o.ok) {
      const payer = parsePerennialPayload(payload.payload)?.payer;
      return {
        success: false,
        errorReason: o.code,
        errorMessage: o.message,
        transaction: "",
        network,
        ...(payer ? { payer } : {}),
      };
    }
    const spend = this.options.settler?.spend;
    if (!spend) {
      return {
        success: false,
        errorReason: ErrorCode.SettlementFailed,
        errorMessage: "this facilitator cannot relay Perennial spends",
        transaction: "",
        network,
        payer: o.payer,
      };
    }
    try {
      const result = await spend.call(this.options.settler, o.spend, o.signature);
      return {
        success: true,
        transaction: result.transaction,
        network,
        payer: o.payer,
        amount: o.spend.amount.toString(),
        extra: { settledAt: result.settledAt },
      };
    } catch (err) {
      return {
        success: false,
        errorReason: ErrorCode.SettlementFailed,
        errorMessage: err instanceof Error ? err.message : String(err),
        transaction: "",
        network,
        payer: o.payer,
      };
    }
  }

  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Outcome> {
    const accepted = payload.accepted;
    if (requirements.scheme !== SCHEME_PERENNIAL || accepted?.scheme !== SCHEME_PERENNIAL) {
      return fail(ErrorCode.InvalidScheme, `scheme must be ${SCHEME_PERENNIAL}`);
    }
    if (!this.options.networks.includes(requirements.network)) {
      return fail(ErrorCode.InvalidNetwork, `network ${requirements.network} is not served here`);
    }
    const extra = parsePerennialExtra(requirements.extra);
    if (!extra) return fail(ErrorCode.InvalidVersion, "requirements.extra must carry version 1 and a vault");
    const acceptedExtra = parsePerennialExtra(accepted.extra);
    if (
      !acceptedExtra ||
      !sameAddress(acceptedExtra.vault, extra.vault) ||
      accepted.network !== requirements.network ||
      accepted.amount !== requirements.amount ||
      accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds ||
      !sameAddress(accepted.asset, requirements.asset) ||
      !sameAddress(accepted.payTo, requirements.payTo)
    ) {
      return fail(ErrorCode.RequirementsMismatch, "accepted does not match the requirements");
    }
    const p = parsePerennialPayload(payload.payload);
    if (!p) return fail(ErrorCode.InvalidPayload, "payload is malformed");
    let spend: PerennialSpend;
    try {
      spend = perennialSpendOf(requirements, p);
    } catch (err) {
      return fail(ErrorCode.InvalidPayload, err instanceof Error ? err.message : "payload is malformed");
    }
    if (spend.amount === 0n) return fail(ErrorCode.InvalidPayload, "amount must be positive");
    const readPosition = this.options.reader.perennialPosition?.bind(this.options.reader);
    if (!readPosition)
      return fail(ErrorCode.ChainUnavailable, "this facilitator cannot read Perennial positions");

    try {
      const now = BigInt(await this.options.reader.now());
      if (now + BigInt(this.margin) >= spend.deadline) return fail(ErrorCode.Expired, "spend has expired");

      const position = await readPosition(spend.vault, spend.positionId);
      if (!sameAddress(position.beneficiary, p.payer)) {
        return fail(ErrorCode.InvalidKey, "payer is not the position's beneficiary");
      }
      if (position.closed || position.succeeded) {
        return fail(ErrorCode.InvalidPayload, "position is closed or in succession");
      }
      if (position.nonce !== spend.nonce) return fail(ErrorCode.NonceUsed, "position nonce has moved on");

      const key = await this.options.reader.keyStatus(position.beneficiary);
      if (
        !key.registered ||
        !key.possessionProven ||
        key.algorithmId !== ML_DSA_87_ALGORITHM_ID ||
        key.publicKey.length !== ML_DSA_87_PUBLIC_KEY_LENGTH
      ) {
        return fail(ErrorCode.InvalidKey, "beneficiary has no proven ML-DSA-87 key on chain");
      }
      const signature = fromBase64(p.signature);
      if (!mldsaVerify(key.publicKey, perennialSpendMessage(spend), signature)) {
        return fail(ErrorCode.InvalidSignature, "signature does not verify against the beneficiary's key");
      }
      if (position.buffer + position.pendingYield < spend.amount) {
        return fail(ErrorCode.InsufficientFunds, "the position's buffer cannot cover the spend");
      }
      return { ok: true, spend, payer: p.payer, signature };
    } catch (err) {
      return fail(ErrorCode.ChainUnavailable, err instanceof Error ? err.message : "chain read failed");
    }
  }
}
