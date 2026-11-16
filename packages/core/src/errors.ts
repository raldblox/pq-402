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
  BudgetExceeded: "invalid_pq402_budget_exceeded",
  ChainUnavailable: "invalid_pq402_chain_unavailable",
  RequestHashMismatch: "invalid_pq402_request_hash",
  Replay: "invalid_pq402_replay",
  Sealing: "invalid_pq402_sealing",
  SettlementFailed: "invalid_transaction_state",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const EXPLANATIONS: Record<string, string> = {
  [ErrorCode.InsufficientFunds]:
    "not enough money behind the payment: the escrow balance, or the Perennial position's buffer and principal, cannot cover it",
  [ErrorCode.BudgetExceeded]:
    "the Perennial position's spending budget for the current period is used up; it refills when the next period starts",
  [ErrorCode.NonceUsed]: "this payment was already used, or another signed action on the position came first",
  [ErrorCode.Expired]: "the payment expired before it could settle",
  [ErrorCode.InvalidKey]:
    "the payer has no proven ML-DSA-87 key on chain, or is not the position's beneficiary",
  [ErrorCode.InvalidSignature]: "the signature does not match the payer's key on chain",
  [ErrorCode.Sealing]: "the sealed body could not be opened, or a party has no registered ML-KEM-1024 key",
  [ErrorCode.ChainUnavailable]: "the chain could not be read, so the payment was refused rather than trusted",
  [ErrorCode.SettlementFailed]: "the settlement transaction failed",
};

/** A sentence a person can act on for a PQ-402 error code; `undefined` for codes without one. */
export function explainError(code: string | undefined): string | undefined {
  return code === undefined ? undefined : EXPLANATIONS[code];
}

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
