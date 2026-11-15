/** `invalidReason` / `errorReason` codes PQ-402 returns (docs/spec.md section 6). */
export const ErrorCode = {
  InvalidScheme: "invalid_scheme",
  InvalidNetwork: "invalid_network",
  InvalidVersion: "invalid_pq402_version",
  RequirementsMismatch: "invalid_pq402_requirements_mismatch",
  InvalidPayload: "invalid_pq402_payload",
  NotYetValid: "invalid_pq402_not_yet_valid",
  Expired: "invalid_pq402_expired",
  NonceUsed: "invalid_pq402_nonce_used",
  InvalidKey: "invalid_pq402_key",
  InvalidSignature: "invalid_pq402_signature",
  InsufficientFunds: "insufficient_funds",
  ChainUnavailable: "invalid_pq402_chain_unavailable",
  RequestHashMismatch: "invalid_pq402_request_hash",
  Replay: "invalid_pq402_replay",
  Sealing: "invalid_pq402_sealing",
  SettlementFailed: "invalid_transaction_state",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** A failure with a stable code; `message` is for people and may change. */
export class Pq402Error extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Pq402Error";
  }
}
