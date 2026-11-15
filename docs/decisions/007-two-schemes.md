# 007. Two schemes on one wire format: `pq-erc20` and `pq-perennial`

- Status: accepted
- Date: 2026-11-16

## Context

The first use case is an agent that pays for each inference call out of the
yield of a deposit it can never spend. That deposit lives in a Perennial v2
vault, whose positions have a beneficiary (the agent's account and ML-DSA-87
key) and a buffer of harvested yield. Perennial v2 exposes one signed action
for this, with a fixed signature:

```solidity
function spend(uint256 positionId, address to, uint256 amount, bytes32 ref,
               uint256 deadline, bytes signature);
event Spent(uint256 indexed positionId, address indexed to, uint256 amount,
            bytes32 indexed ref);
```

The signature is ML-DSA-87 by the beneficiary over the vault's
`actionMessage(positionId, Action.Spend = 4, nonce, deadline, paramsHash)`,
with `paramsHash = keccak256(abi.encode(to, amount, ref))`. Anyone may relay
it. The vault harvests first and reverts if the buffer cannot cover the
amount.

So a Perennial `spend` already is a post-quantum signed payment authorisation
that a relayer can settle. An agent paying this way needs no escrow deposit
of its own.

## Decision

PQ-402 has two x402 schemes on the same wire format, network, sealing
extension and receipts:

| Scheme | Paid from | Signed bytes | Settled by | Replay protection |
|---|---|---|---|---|
| `pq-erc20` | the payer's balance in `PQ402Escrow` | PQ-402 payment message ([002](002-signed-payment-message.md)) | `escrow.settle` | random 32-byte nonce per payer |
| `pq-perennial` | a Perennial position's buffer | the vault's `actionMessage` for `Spend` | `vault.spend` | the position's action nonce |

- **Names.** Both carry a `pq-` prefix so a stock x402 client can never
  mistake them for an upstream scheme, and they say what pays: an ERC-20 held
  in escrow, or a Perennial position. They replace the name `pq-escrow` used
  before this decision.
- **`pq-perennial` requirements**: `extra = { vault, version: "1" }`;
  `asset` is the vault's asset (fUSD); `amount` and `payTo` as usual.
- **`pq-perennial` payload**: `{ payer, positionId, nonce, deadline, ref,
  signature }`, numbers as decimal strings, `signature` base64. `ref` is the
  PQ-402 request hash ([002](002-signed-payment-message.md)), so the payee can
  find the payment with an indexed `Spent(…, ref)` filter and the server can
  check the binding exactly as for `pq-erc20`.
- **Verification** reads the position (`position`, `pendingYield`) and
  requires: the payer is the beneficiary; the position is neither closed nor
  in succession; the payload's nonce is the position's current nonce; the
  deadline leaves the settlement margin; the beneficiary's key from
  `pqcKeyStatus` is registered, possession-proven ML-DSA-87; the signature
  verifies over the action message; `buffer + pendingYield >= amount`.
- **Settlement** relays `vault.spend(...)` and requires a matching
  `Spent(positionId, to, amount, ref)` event in the receipt before calling the
  payment settled.
- **Receipts** keep one byte layout for both schemes: the address word is the
  settlement contract (escrow or vault) and the 32-byte word is a payment id
  (the nonce for `pq-erc20`; `keccak256(abi.encode(positionId, nonce))` for
  `pq-perennial`). The bytes of the existing vectors did not change.
- A server may offer both in one `402`. It lists `pq-perennial` first; a
  client configured with a position uses it, any other PQ-402 client pays
  from the escrow.

## Consequences

- **One payment in flight per position.** Every signed action consumes the
  position's nonce, so two concurrent requests signed against the same nonce
  cannot both settle, and a check-in or claim by the beneficiary invalidates a
  spend signed before it. The client reads the nonce just before signing.
  An agent that needs parallel calls uses several positions or `pq-erc20`.
- A Perennial `spend` counts as the beneficiary's check-in (Perennial's rule),
  so an agent that keeps paying keeps its position alive.
- The worst a stolen agent key can do through `pq-perennial` is spend the
  unspent buffer; the principal is not reachable by `spend`.
- The vault lives in the Perennial repository. PQ-402 carries a copy of the
  ABI fragment it uses (`packages/scheme-qorechain/src/abi.ts`), checks the
  message encoding against Perennial's source in a Solidity test, and tests
  the scheme against an in-memory model of `spend`. It has not been run
  against a deployed v2 vault.
