import { PROTOCOL_VERSION, SCHEME, sameAddress } from "@pq-402/core";
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import type { Hex } from "viem";
import type { QoreNetwork } from "./network.js";

export interface PqEscrowServerOptions {
  network: QoreNetwork;
  /** The `PQ402Escrow` deployment for the network's default asset. */
  escrow: Hex;
}

/**
 * x402 `SchemeNetworkServer` for `pq-escrow`: turns a price into requirements
 * and adds the escrow address and protocol version to `extra`.
 */
export class PqEscrowServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"] as const, default: "authorization" as const },
  };

  constructor(private readonly options: PqEscrowServerOptions) {}

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    this.requireNetwork(network);
    if (typeof price === "object") return price;
    const asset = this.options.network.defaultAsset;
    const { amount, symbol } = parseMoney(price);
    if (symbol !== undefined && symbol.toUpperCase() !== asset.symbol.toUpperCase()) {
      throw new Error(`cannot price in ${symbol} on ${network}; use ${asset.symbol}`);
    }
    return { asset: asset.address, amount: convertToTokenAmount(amount, asset.decimals) };
  }

  getAssetDecimals(asset: string, network: Network): number | undefined {
    this.requireNetwork(network);
    const known = this.options.network.defaultAsset;
    return sameAddress(asset, known.address) ? known.decimals : undefined;
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    this.requireNetwork(requirements.network);
    return {
      ...requirements,
      extra: { ...requirements.extra, escrow: this.options.escrow, version: PROTOCOL_VERSION },
    };
  }

  private requireNetwork(network: Network): void {
    if (network !== this.options.network.network) {
      throw new Error(`this scheme serves ${this.options.network.network}, not ${network}`);
    }
  }
}
