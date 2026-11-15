import {
  ErrorCode,
  ORIGINAL_CONTENT_TYPE_HEADER,
  PROTOCOL_VERSION,
  SCHEME_ERC20,
  SEALED_CONTENT_TYPE,
  SEALING_EXTENSION,
  openRequest,
  parsePayload,
  parseSealingInfo,
  paymentOf,
  requestHash,
  sealResponse,
  sealingDeclaration,
  signReceipt,
  type Hex,
  type SealKeyPair,
  type SealingInfo,
} from "@pq-402/core";
import { PqErc20ServerScheme, type QoreNetwork } from "@pq-402/scheme-qorechain";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  Price,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { NonceCache } from "./nonces.js";

/** Header a sealing client sends on its first, body-less attempt (docs/spec.md section 8.2). */
export const PROBE_HEADER = "PQ402-Probe";

/** Anything with x402 facilitator `verify` and `settle`: an `x402Facilitator`, an `HTTPFacilitatorClient`, or a `PqErc20Facilitator`. */
export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

/** The gateway's own keys: its registered ML-KEM-1024 key opens requests, its ML-DSA-87 key signs receipts. */
export interface GatewayIdentity {
  address: Hex;
  mldsaSecretKey: Uint8Array;
  sealKeys: SealKeyPair;
}

export interface PaidRoute {
  /** `"$0.01"`, `"0.01 fUSD"`, or `{ asset, amount }` in atomic units. */
  price: Price;
  payTo: Hex;
  description?: string;
  mimeType?: string;
  /** Whether the request body must be sealed. Default `"optional"`. */
  requestSealing?: "required" | "optional";
}

export interface PaymentGateOptions {
  network: QoreNetwork;
  escrow: Hex;
  facilitator: Facilitator;
  /** Reads the payer's ML-KEM-1024 key from the KEM registry, to seal responses. */
  kemKeys: { kemKey(account: Hex): Promise<Uint8Array> };
  /** Enables the `pq402-sealing` extension: sealed bodies and signed receipts. */
  gateway?: GatewayIdentity;
  /** Paid routes keyed by `"METHOD /path"` (no query). */
  routes: Record<string, PaidRoute>;
  maxTimeoutSeconds?: number;
  now?: () => number;
}

export interface GateRequest {
  method: string;
  /** Path and query as received. */
  target: string;
  /** Absolute URL, used as `resource.url`. */
  url: string;
  header(name: string): string | undefined;
  /** Body bytes as received. */
  body: Uint8Array;
}

/** What the application handler sees: the request with its body opened. */
export interface PaidRequest {
  method: string;
  target: string;
  header(name: string): string | undefined;
  contentType: string | undefined;
  body: Uint8Array;
  payer: Hex | undefined;
}

export interface HandlerResult {
  status: number;
  contentType: string;
  body: Uint8Array;
  headers?: Record<string, string>;
}

export type Handler = (req: PaidRequest) => Promise<HandlerResult>;

export interface GateResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const EXPOSE = ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", ORIGINAL_CONTENT_TYPE_HEADER].join(", ");
const empty = new Uint8Array();
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/**
 * The PQ-402 resource-server flow (x402 `authorization` flow): answer `402`,
 * check the request binding and replay, verify, open the sealed request, run
 * the handler, seal the response, settle, sign the receipt.
 */
export class PaymentGate {
  private readonly scheme: PqErc20ServerScheme;
  private readonly nonces = new NonceCache();
  private readonly now: () => number;

  constructor(private readonly options: PaymentGateOptions) {
    this.scheme = new PqErc20ServerScheme({ network: options.network, escrow: options.escrow });
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  routeOf(method: string, target: string): PaidRoute | undefined {
    const path = target.split("?")[0] ?? target;
    return this.options.routes[`${method.toUpperCase()} ${path}`];
  }

  /** The `pq402-sealing` info this gate declares for a route, if sealing is on. */
  sealingInfo(route: PaidRoute): SealingInfo | undefined {
    const g = this.options.gateway;
    if (!g) return undefined;
    return {
      version: PROTOCOL_VERSION,
      chainId: this.options.network.chainId,
      gateway: g.address,
      mode: "mlkem",
      request: route.requestSealing ?? "optional",
      response: "sealed",
    };
  }

  async requirementsFor(route: PaidRoute): Promise<PaymentRequirements> {
    const network = this.options.network.network;
    const { asset, amount } = await this.scheme.parsePrice(route.price, network);
    return this.scheme.enhancePaymentRequirements(
      {
        scheme: SCHEME_ERC20,
        network,
        asset,
        amount,
        payTo: route.payTo,
        maxTimeoutSeconds: this.options.maxTimeoutSeconds ?? 120,
        extra: {},
      },
      { x402Version: 2, scheme: SCHEME_ERC20, network },
      [],
    );
  }

  async handle(req: GateRequest, handler: Handler): Promise<GateResponse> {
    const route = this.routeOf(req.method, req.target);
    const probe = req.header(PROBE_HEADER) === "1";
    if (!route) {
      if (probe) return { status: 204, headers: { "Access-Control-Expose-Headers": EXPOSE }, body: empty };
      const out = await handler({ ...req, contentType: req.header("content-type"), payer: undefined });
      return {
        status: out.status,
        headers: { ...out.headers, "Content-Type": out.contentType },
        body: out.body,
      };
    }

    const requirements = await this.requirementsFor(route);
    const sealing = this.sealingInfo(route);
    const paymentRequired = (error: string): PaymentRequired => ({
      x402Version: 2,
      error,
      resource: {
        url: req.url,
        ...(route.description ? { description: route.description } : {}),
        ...(route.mimeType ? { mimeType: route.mimeType } : {}),
      },
      accepts: [requirements],
      ...(sealing ? { extensions: { [SEALING_EXTENSION]: sealingDeclaration(sealing) } } : {}),
    });
    const refuse = (error: string): GateResponse => {
      const body = paymentRequired(error);
      return {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body),
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Expose-Headers": EXPOSE,
        },
        body: json(body),
      };
    };

    const header = req.header("PAYMENT-SIGNATURE");
    if (!header || probe) return refuse("PAYMENT-SIGNATURE header is required");

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return refuse(ErrorCode.InvalidPayload);
    }
    const p = parsePayload(payload.payload);
    if (!p) return refuse(ErrorCode.InvalidPayload);

    // The payment must commit to the bytes this server received.
    const received = requestHash({ method: req.method, target: req.target, body: req.body });
    if (received.toLowerCase() !== p.requestHash.toLowerCase()) return refuse(ErrorCode.RequestHashMismatch);

    if (sealing) {
      const echoed = parseSealingInfo(payload.extensions?.[SEALING_EXTENSION]);
      if (!echoed || JSON.stringify(echoed) !== JSON.stringify(sealing)) return refuse(ErrorCode.Sealing);
    }

    if (!this.nonces.claim(p.payer, p.nonce, Number(p.validBefore), this.now()))
      return refuse(ErrorCode.Replay);
    let keepNonce = false;
    try {
      const verified = await this.options.facilitator.verify(payload, requirements);
      if (!verified.isValid) return refuse(verified.invalidReason ?? ErrorCode.InvalidPayload);
      // From here on the payment is valid; never let it be presented twice.
      keepNonce = true;

      // Open the request body.
      const sealed = (req.header("content-type") ?? "").split(";")[0]?.trim() === SEALED_CONTENT_TYPE;
      let body = req.body;
      let contentType = req.header("content-type");
      if (sealed) {
        if (!sealing || !this.options.gateway) return refuse(ErrorCode.Sealing);
        contentType = req.header(ORIGINAL_CONTENT_TYPE_HEADER) ?? "application/octet-stream";
        try {
          body = openRequest({
            chainId: sealing.chainId,
            keys: this.options.gateway.sealKeys,
            method: req.method,
            target: req.target,
            contentType,
            envelope: req.body,
          });
        } catch {
          return refuse(ErrorCode.Sealing);
        }
      } else if (sealing?.request === "required" && req.body.length > 0) {
        return refuse(ErrorCode.Sealing);
      }

      // The response is sealed to the payer's registered key: fetch it before doing any work.
      let payerKem: Uint8Array | undefined;
      if (sealing) {
        try {
          payerKem = await this.options.kemKeys.kemKey(p.payer);
        } catch {
          return refuse(ErrorCode.Sealing);
        }
      }

      const out = await handler({
        method: req.method,
        target: req.target,
        header: req.header,
        contentType,
        body,
        payer: p.payer,
      });
      if (out.status >= 400) {
        // Nothing is charged for a failed request; the payment was not settled.
        return {
          status: out.status,
          headers: { ...out.headers, "Content-Type": out.contentType },
          body: out.body,
        };
      }

      let responseBody = out.body;
      const headers: Record<string, string> = { ...out.headers, "Access-Control-Expose-Headers": EXPOSE };
      if (sealing && payerKem) {
        responseBody = sealResponse({
          chainId: sealing.chainId,
          payerKey: payerKem,
          requestHash: p.requestHash,
          contentType: out.contentType,
          body: out.body,
        });
        headers["Content-Type"] = SEALED_CONTENT_TYPE;
        headers[ORIGINAL_CONTENT_TYPE_HEADER] = out.contentType;
      } else {
        headers["Content-Type"] = out.contentType;
      }

      const settled = await this.options.facilitator.settle(payload, requirements);
      if (!settled.success) {
        return {
          status: 402,
          headers: {
            "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled),
            "Content-Type": "application/json",
            "Access-Control-Expose-Headers": EXPOSE,
          },
          body: json({}),
        };
      }

      let response: SettleResponse = settled;
      const g = this.options.gateway;
      if (sealing && g) {
        const settledAt = typeof settled.extra?.settledAt === "number" ? settled.extra.settledAt : this.now();
        const receipt = signReceipt({
          payment: paymentOf(requirements, p),
          gateway: g.address,
          secretKey: g.mldsaSecretKey,
          responseBody,
          transaction: settled.transaction as Hex,
          settledAt,
        });
        response = { ...settled, extensions: { ...settled.extensions, [SEALING_EXTENSION]: { receipt } } };
      }
      headers["PAYMENT-RESPONSE"] = encodePaymentResponseHeader(response);
      return { status: out.status, headers, body: responseBody };
    } finally {
      if (!keepNonce) this.nonces.release(p.payer, p.nonce);
    }
  }
}
