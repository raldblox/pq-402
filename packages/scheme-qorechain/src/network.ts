import { QORECHAIN_TESTNET, TESTNET_FUSD } from "@pq-402/core";
import type { Hex } from "viem";

/** Everything PQ-402 needs to know about one QoreChain network. */
export interface QoreNetwork {
  /** CAIP-2 id, e.g. `eip155:9800`. */
  network: `${string}:${string}`;
  evmChainId: number;
  /** QoreChain chain id, which QoreSeal binds into its key derivation. */
  chainId: string;
  evmRpc: string;
  rest: string;
  /** The dollar asset prices in `$…` resolve to. */
  defaultAsset: { address: Hex; decimals: number; symbol: string };
}

/** The QoreChain testnet (`qorechain-diana`), as read on 15 November 2026. */
export const qorechainTestnet: QoreNetwork = {
  network: QORECHAIN_TESTNET.network,
  evmChainId: QORECHAIN_TESTNET.evmChainId,
  chainId: QORECHAIN_TESTNET.chainId,
  evmRpc: "https://evm-testnet.qore.host",
  rest: "https://api-testnet.qore.host",
  defaultAsset: { ...TESTNET_FUSD },
};
