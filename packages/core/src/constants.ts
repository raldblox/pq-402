import { keccak256, stringToBytes } from "viem";

/** x402 scheme identifiers of PQ-402 payments (docs/decisions/007-two-schemes.md). */
export const SCHEME_ERC20 = "pq-erc20";
export const SCHEME_PERENNIAL = "pq-perennial";

/** Version of the PQ-402 message formats, carried in `requirements.extra.version`. */
export const PROTOCOL_VERSION = "1";

/** x402 extension key of request and response sealing. */
export const SEALING_EXTENSION = "pq402-sealing";

/** CAIP-2 id and EVM chain id of the QoreChain testnet. */
export const QORECHAIN_TESTNET = {
  network: "eip155:9800",
  evmChainId: 9800,
  chainId: "qorechain-diana",
} as const;

/** fUSD, the QoreChain testnet dollar token (ERC-20, 6 decimals). */
export const TESTNET_FUSD = {
  address: "0x97143B771D34ddb9130b807b135Ae675A5a963CA",
  decimals: 6,
  symbol: "fUSD",
} as const;

/** QoreChain PQC precompiles. */
export const PQC_VERIFY_ADDRESS = "0x0000000000000000000000000000000000000a01";
export const PQC_KEY_STATUS_ADDRESS = "0x0000000000000000000000000000000000000a02";

/** Algorithm id `pqcKeyStatus` reports for ML-DSA-87. */
export const ML_DSA_87_ALGORITHM_ID = 1;
export const ML_DSA_87_PUBLIC_KEY_LENGTH = 2592;
export const ML_DSA_87_SECRET_KEY_LENGTH = 4896;
export const ML_DSA_87_SIGNATURE_LENGTH = 4627;

/** Domain tags: the first word of every signed message (see docs/spec.md, section 5). */
export const PAYMENT_DOMAIN = keccak256(stringToBytes("PQ-402/v1 payment"));
export const REQUEST_DOMAIN = keccak256(stringToBytes("PQ-402/v1 request"));
export const WITHDRAWAL_DOMAIN = keccak256(stringToBytes("PQ-402/v1 withdrawal"));
export const RECEIPT_DOMAIN = keccak256(stringToBytes("PQ-402/v1 receipt"));

/** QoreSeal purposes, which feed its key derivation. */
export const REQUEST_PURPOSE = "pq402-request";
export const RESPONSE_PURPOSE = "pq402-response";

/** Media type of a sealed body, and the header carrying the original type. */
export const SEALED_CONTENT_TYPE = "application/vnd.pq402.sealed";
export const ORIGINAL_CONTENT_TYPE_HEADER = "PQ402-Content-Type";
