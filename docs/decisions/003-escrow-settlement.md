# 003. Settle through an escrow that verifies ML-DSA-87 on chain

- Status: accepted
- Date: 2026-11-15

## Context

x402's `exact` scheme on EVM settles with an EIP-3009
`transferWithAuthorization`: the token itself checks an ECDSA signature. fUSD
on QoreChain has no such entry point, and an ECDSA signature is exactly what
PQ-402 wants to avoid. QoreChain exposes ML-DSA-87 verification to Solidity
(`pqcVerify`) and the registered key of any account (`pqcKeyStatus`), so a
contract can check the payer's post-quantum signature itself.

Options considered:

1. **Escrow with per-payment vouchers.** The payer deposits fUSD once; each
   request carries a signed voucher; anyone can redeem it, and the contract
   moves funds from the payer's escrow balance to the payee.
2. **Allowance pull.** The payer `approve`s a settlement contract, which
   `transferFrom`s on each valid voucher. No deposit, but the server cannot
   rely on funds being there: the payer can spend the balance or revoke the
   allowance between verification and settlement.
3. **Native transfer per request** with the request hash in the memo. One
   hybrid-signed transaction per request from the payer, confirmed before
   serving: slow, and the payer needs a live signer for every call.

## Decision

Option 1, as `PQ402Escrow` (one deployment per asset):

- `deposit(amount)` / `depositFor(payer, amount)`: pulls the ERC-20 and credits
  the payer. A token that delivers less than `amount` (fee on transfer) is
  refused.
- `settle(Payment p, bytes signature)`: callable by anyone. It checks, in this
  order, that the nonce is unused, that `validAfter <= now < validBefore`,
  that `amount > 0` and the escrow balance covers it, reads the payer's key
  with `pqcKeyStatus` (registered, possession proven, ML-DSA-87, 2592 bytes),
  and verifies the signature over the payment message with `pqcVerify`. Then
  it marks the nonce, debits the payer and transfers to `payTo`.
- **Withdrawals are signed and delayed.** `requestWithdrawal(amount, nonce,
  deadline, signature)` needs an ML-DSA-87 signature too, so a thief with only
  the payer's classical key cannot pull the deposit out. The funds can be
  taken with `withdraw(payer)` (callable by anyone, always paid to the payer)
  after an immutable `withdrawalDelay` (set at deployment; the deploy script
  uses one hour). Settlement keeps drawing on the full balance during the
  delay, so a payment that a server has already verified cannot be pre-empted
  by an instant withdrawal.
- **Fail closed.** Every precompile call checks the call succeeded and the
  return data has the expected length; empty data (an inactive precompile)
  reverts with `PQCUnavailable`. The constructor makes the same check, so the
  contract cannot be deployed where it could never settle.
- **No owner, no pause, no upgrade.** Precompile addresses are immutable
  constructor arguments, visible in the deployment.

**Who relays and who pays gas.** The facilitator's EVM account submits
`settle` and pays its gas. It needs a registered ML-DSA-87 key and an EVM
window scoped to the escrow (`allowedTargets`), so the relayer key can do
nothing else even if it leaks. It cannot move funds anywhere the payer did not
sign. The payer pays gas only for `approve` + `deposit` and for withdrawals.

**Flow.** x402 `authorization`: the facilitator verifies (all of the above,
read-only, via `eth_call`), the server runs the handler, then the facilitator
settles and waits for the receipt. If settlement fails the server answers
`402` with the failure in `PAYMENT-RESPONSE` and does not release the
response.

## Consequences

- Each settlement costs one `pqcVerify` (25,000 gas + 8 per input byte, about
  85–90k for ML-DSA-87) plus about 75k of calldata for the signature. The EVM
  lane bills at least half the gas limit, so the facilitator sets a limit
  close to measured use.
- Batching, and cumulative vouchers where only the latest needs verifying, are
  the obvious next step for many small payments and are not built
  ([006](006-out-of-scope.md)).
- Two servers verifying different payments against the same balance at the
  same time can both pass verification; the first settlement wins and the
  second fails at settlement. The payer cannot profit from this: the second
  response is not released.
