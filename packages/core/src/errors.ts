/** `invalidReason` / `errorReason` codes PQ-402 returns (docs/spec.md section 6). */
export const ErrorCode = {
  InvalidScheme: "invalid_scheme",
  InvalidNetwork: "invalid_network",
  InvalidVersion: "invalid_pq_escrow_version",
  RequirementsMismatch: "invalid_pq_escrow_requirements_mismatch",
  InvalidPayload: "invalid_pq_escrow_payload",
  NotYetValid: "invalid_pq_escrow_not_yet_valid",
  Expired: "invalid_pq_escrow_expired",
  NonceUsed: "invalid_pq_escrow_nonce_used",
  InvalidKey: "invalid_pq_escrow_key",
  InvalidSignature: "invalid_pq_escrow_signature",
  InsufficientFunds: "insufficient_funds",
  ChainUnavailable: "invalid_pq_escrow_chain_unavailable",
  RequestHashMismatch: "invalid_pq_escrow_request_hash",
  Replay: "invalid_pq_escrow_replay",
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
