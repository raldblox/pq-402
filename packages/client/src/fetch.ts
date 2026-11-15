import {
  ML_DSA_87_ALGORITHM_ID,
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ORIGINAL_CONTENT_TYPE_HEADER,
  SCHEME_ERC20,
  SCHEME_PERENNIAL,
  SEALED_CONTENT_TYPE,
  SEALING_EXTENSION,
  openResponse,
  parseReceipt,
  parseSealingInfo,
  receiptProblem,
  requestHash,
  requestTarget,
  sealRequest,
  type Hex,
  type Receipt,
  type SealKeyPair,
  type SealingInfo,
} from "@pq-402/core";
import {
  PqErc20ClientScheme,
  PqPerennialClientScheme,
  describePayment,
  type PerennialPosition,
  type PqcKeyStatus,
} from "@pq-402/scheme-qorechain";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";

/** Header a sealing client sends on its first, body-less attempt (docs/spec.md section 8.2). */
export const PROBE_HEADER = "PQ402-Probe";

/** Where the client reads other accounts' keys. `EvmChainReader` implements it. */
export interface KeyDirectory {
  keyStatus(account: Hex): Promise<PqcKeyStatus>;
  kemKey(account: Hex): Promise<Uint8Array>;
  /** Needed to pay from a Perennial position: reads its current action nonce. */
  perennialPosition?(vault: Hex, positionId: bigint): Promise<PerennialPosition>;
}

export interface Pq402FetchOptions {
  /** The paying account (`0x` form); its ML-DSA-87 and ML-KEM-1024 keys must be registered on chain. */
  payer: Hex;
  mldsaSecretKey: Uint8Array;
  sealKeys: SealKeyPair;
  /** Reads the gateway's keys from the chain; the `402` only names the gateway. */
  keys: KeyDirectory;
  /** QoreChain chain id the client expects in the sealing declaration, e.g. `qorechain-diana`. */
  chainId: string;
  /** Refuse to pay more than this, in atomic units of the asset. */
  maxAmount: bigint;
  /**
   * Pay from this Perennial position (the payer is its beneficiary) whenever
   * the server offers `pq-perennial`; otherwise pay from the escrow (`pq-erc20`).
   */
  perennial?: { positionId: bigint };
  /** Seal request bodies whenever the server offers it. Default true. */
  sealRequests?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PaymentOutcome {
  requirements: PaymentRequirements;
  payload: PaymentPayload;
  settlement: SettleResponse;
  /** Present when the response was sealed: the gateway's signed receipt, already verified. */
  receipt?: Receipt;
  /** Whether the request body travelled sealed. */
  requestSealed: boolean;
}

export type Pq402Response = Response & { payment?: PaymentOutcome };

export class Pq402Error extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "Pq402Error";
  }
}

interface Init {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

const textOf = (body: Init["body"]) =>
  body === undefined ? new Uint8Array() : typeof body === "string" ? new TextEncoder().encode(body) : body;

/** A copy backed by a plain ArrayBuffer, which is what `BodyInit` accepts. */
const bodyOf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * A `fetch` that pays PQ-402 `402`s: signs with ML-DSA-87, seals the request
 * body to the gateway's registered ML-KEM-1024 key, retries, checks the signed
 * receipt and opens the sealed response. Other responses pass through.
 */
export function createPq402Fetch(options: Pq402FetchOptions) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ? { now: options.now } : {};
  const erc20 = new PqErc20ClientScheme({ payer: options.payer, secretKey: options.mldsaSecretKey, ...now });
  const readPosition = options.keys.perennialPosition?.bind(options.keys);
  const perennial =
    options.perennial && readPosition
      ? new PqPerennialClientScheme({
          payer: options.payer,
          secretKey: options.mldsaSecretKey,
          positionId: options.perennial.positionId,
          nonceOf: async (vault, id) => (await readPosition(vault, id)).nonce,
          ...now,
        })
      : undefined;
  if (options.perennial && !perennial)
    throw new Error("paying from a Perennial position needs keys.perennialPosition");
  const http = new x402HTTPClient(new x402Client());

  return async function pq402Fetch(input: string | URL, init: Init = {}): Promise<Pq402Response> {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = { ...(init.headers ?? {}) };
    const plaintext = textOf(init.body);
    const contentType =
      Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ??
      "application/octet-stream";

    // Never send a plaintext body before knowing whether the server seals: probe without it.
    const probe = plaintext.length > 0;
    const first = await doFetch(url, {
      method,
      headers: probe ? { ...headers, [PROBE_HEADER]: "1" } : headers,
      ...(probe ? {} : plaintext.length ? { body: bodyOf(plaintext) } : {}),
    });
    if (first.status !== 402) {
      if (!probe) return first;
      // Not a paid route: send the request as it is.
      return doFetch(url, { method, headers, body: bodyOf(plaintext) });
    }

    const paymentRequired: PaymentRequired = http.getPaymentRequiredResponse(
      (name) => first.headers.get(name),
      await first.json().catch(() => undefined),
    );
    const requirements =
      (perennial && paymentRequired.accepts.find((a) => a.scheme === SCHEME_PERENNIAL)) ||
      paymentRequired.accepts.find((a) => a.scheme === SCHEME_ERC20);
    if (!requirements) throw new Pq402Error("the server offers no PQ-402 payment this client can make");
    const scheme = requirements.scheme === SCHEME_PERENNIAL && perennial ? perennial : erc20;
    if (BigInt(requirements.amount) > options.maxAmount) {
      throw new Pq402Error(`price ${requirements.amount} exceeds the limit ${options.maxAmount}`);
    }

    let sealing: SealingInfo | undefined;
    const declared = paymentRequired.extensions?.[SEALING_EXTENSION];
    if (declared !== undefined) {
      sealing = parseSealingInfo(declared);
      if (!sealing) throw new Pq402Error("the server's sealing declaration is malformed");
      if (sealing.chainId !== options.chainId)
        throw new Pq402Error(`sealing is for chain ${sealing.chainId}`);
    }

    // Seal the body to the gateway's key from the chain, never from the 402.
    let wireBody = plaintext;
    const wireHeaders: Record<string, string> = { ...headers };
    const seal = sealing !== undefined && plaintext.length > 0 && (options.sealRequests ?? true);
    if (sealing?.request === "required" && plaintext.length > 0 && !seal) {
      throw new Pq402Error("the server requires sealed requests");
    }
    if (seal && sealing) {
      const gatewayKey = await options.keys.kemKey(sealing.gateway);
      wireBody = sealRequest({
        chainId: sealing.chainId,
        gatewayKey,
        method,
        target: requestTarget(url),
        contentType,
        body: plaintext,
      });
      for (const k of Object.keys(wireHeaders)) if (k.toLowerCase() === "content-type") delete wireHeaders[k];
      wireHeaders["Content-Type"] = SEALED_CONTENT_TYPE;
      wireHeaders[ORIGINAL_CONTENT_TYPE_HEADER] = contentType;
    }

    // Sign a payment that commits to exactly these bytes.
    const hash = requestHash({ method, target: requestTarget(url), body: wireBody });
    const client = new x402Client().register(requirements.network, scheme.forRequest(hash));
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload({ ...paymentRequired, accepts: [requirements] });
    if (sealing) payload.extensions = { ...payload.extensions, [SEALING_EXTENSION]: { info: sealing } };

    const paid = await doFetch(url, {
      method,
      headers: { ...wireHeaders, ...http.encodePaymentSignatureHeader(payload) },
      ...(wireBody.length ? { body: bodyOf(wireBody) } : {}),
    });

    if (paid.status === 402) {
      const settle = paid.headers.get("PAYMENT-RESPONSE");
      const reason = settle
        ? http.getPaymentSettleResponse((n) => paid.headers.get(n)).errorReason
        : http.getPaymentRequiredResponse((n) => paid.headers.get(n)).error;
      throw new Pq402Error(`payment refused: ${reason ?? "unknown"}`, reason);
    }
    if (!paid.ok) return paid;

    const settlement = http.getPaymentSettleResponse((n) => paid.headers.get(n));
    if (!settlement.success) throw new Pq402Error("settlement failed", settlement.errorReason);
    const signed = describePayment(requirements, payload.payload);
    if (!signed) throw new Pq402Error("internal: payload did not round-trip");
    const outcome: PaymentOutcome = { requirements, payload, settlement, requestSealed: seal };

    if (!sealing) {
      return Object.assign(paid, { payment: outcome });
    }

    // Sealed response: check the gateway's receipt against its on-chain key, then open.
    const envelope = await bytesOf(paid);
    const receipt = parseReceipt(
      (settlement.extensions?.[SEALING_EXTENSION] as { receipt?: unknown } | undefined)?.receipt,
    );
    if (!receipt) throw new Pq402Error("the sealed response carries no receipt");
    const status = await options.keys.keyStatus(sealing.gateway);
    if (
      !status.registered ||
      !status.possessionProven ||
      status.algorithmId !== ML_DSA_87_ALGORITHM_ID ||
      status.publicKey.length !== ML_DSA_87_PUBLIC_KEY_LENGTH
    ) {
      throw new Pq402Error("the gateway has no proven ML-DSA-87 key on chain");
    }
    const problem = receiptProblem({
      receipt,
      payment: signed.receipt,
      gateway: sealing.gateway,
      gatewayKey: status.publicKey,
      responseBody: envelope,
    });
    if (problem) throw new Pq402Error(problem);
    if (paid.headers.get("content-type") !== SEALED_CONTENT_TYPE)
      throw new Pq402Error("the response is not sealed");

    const originalType = paid.headers.get(ORIGINAL_CONTENT_TYPE_HEADER) ?? "application/octet-stream";
    const opened = openResponse({
      chainId: sealing.chainId,
      keys: options.sealKeys,
      requestHash: hash,
      contentType: originalType,
      envelope,
    });
    const out = new Response(bodyOf(opened), {
      status: paid.status,
      headers: {
        "Content-Type": originalType,
        "PAYMENT-RESPONSE": paid.headers.get("PAYMENT-RESPONSE") ?? "",
      },
    });
    return Object.assign(out, { payment: { ...outcome, receipt } });
  };
}
