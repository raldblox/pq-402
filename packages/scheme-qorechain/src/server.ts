import { PROTOCOL_VERSION, SCHEME_ERC20, sameAddress } from "@pq402/core";
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

export interface PqErc20ServerOptions {
  network: QoreNetwork;
  /** The `PQ402Escrow` deployment for the network's default asset. */
  escrow: Hex;
}

/**
 * Price handling shared by both PQ-402 server schemes: `$…` and `… fUSD`
 * prices resolve to the network's default asset, in atomic units.
 */
export abstract class PriceParser implements SchemeNetworkServer {
  abstract readonly scheme: string;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"] as const, default: "authorization" as const },
  };

  constructor(protected readonly qore: QoreNetwork) {}

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    this.requireNetwork(network);
    if (typeof price === "object") return price;
    const asset = this.qore.defaultAsset;
    const { amount, symbol } = parseMoney(price);
    if (symbol !== undefined && symbol.toUpperCase() !== asset.symbol.toUpperCase()) {
      throw new Error(`cannot price in ${symbol} on ${network}; use ${asset.symbol}`);
    }
    return { asset: asset.address, amount: convertToTokenAmount(amount, asset.decimals) };
  }

  getAssetDecimals(asset: string, network: Network): number | undefined {
    this.requireNetwork(network);
    const known = this.qore.defaultAsset;
    return sameAddress(asset, known.address) ? known.decimals : undefined;
  }

  abstract enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements>;

  protected requireNetwork(network: Network): void {
    if (network !== this.qore.network) {
      throw new Error(`this scheme serves ${this.qore.network}, not ${network}`);
    }
  }
}

/**
 * x402 `SchemeNetworkServer` for `pq-erc20`: turns a price into requirements
 * and adds the escrow address and protocol version to `extra`.
 */
export class PqErc20ServerScheme extends PriceParser {
  readonly scheme = SCHEME_ERC20;

  constructor(private readonly options: PqErc20ServerOptions) {
    super(options.network);
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind?: SupportedKind,
    _facilitatorExtensions?: string[],
  ): Promise<PaymentRequirements> {
    this.requireNetwork(requirements.network);
    return {
      ...requirements,
      extra: { ...requirements.extra, escrow: this.options.escrow, version: PROTOCOL_VERSION },
    };
  }
}
