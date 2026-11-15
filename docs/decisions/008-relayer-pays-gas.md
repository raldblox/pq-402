# 008. The facilitator relays and pays gas; no agent authenticators

- Status: accepted
- Date: 2026-11-16

## Context

A paying agent should not have to hold QOR or keep an EVM window open: it
signs, and someone else submits. QoreChain offers two ways to get there.

1. **A relayer that sends ordinary EVM transactions.** Both settlement
   contracts (`PQ402Escrow.settle`, Perennial `spend`) accept a call from
   anyone, because the authorisation is the ML-DSA-87 signature they verify
   on chain. The relayer needs its own registered key and an EVM window,
   which can be scoped to the settlement contracts with `allowedTargets`.
2. **Agent authenticators** (`x/abstractaccount`). An owner links an agent key
   to an account with spending rules; the agent signs, and a relayer submits
   `MsgExecuteEVM` / `MsgExecuteCosmos` and pays fees. No EVM window is needed.
   Read on 16 November 2026 from the `@qorechain/sdk` 0.14.0 type
   declarations: the linked key is **ed25519 or secp256k1**, and "the
   authenticator's signature IS the authorization - the external key never
   produces an ML-DSA co-signature". The owner's ML-DSA key is needed only to
   link and revoke.

## Decision

The facilitator uses option 1. It does not use agent authenticators.

- PQ-402's promise is that a payment is authorised by an ML-DSA-87 signature.
  With an authenticator, the authorisation that moves funds would be an
  ed25519 or secp256k1 signature, which a quantum attacker can forge. The
  settlement contracts would still check ML-DSA-87, so nothing would be
  gained, and the payer would need a linked key and spending rules besides.
- Option 1 already gives the agent what it needs: **the payer holds no QOR,
  sends no transaction and opens no window.** It needs a registered ML-DSA-87
  key (for verification) and a registered ML-KEM-1024 key (for sealing).
  Registering them costs one native fee each, once.
- The relayer is the facilitator's own account. Its window is scoped to the
  escrow and the vault. A leaked relayer key can only submit payments payers
  signed, to the payees they named.

## Consequences

- Who pays gas: the facilitator, per settlement (about one `pqcVerify`, 85–90k
  gas, plus calldata; the EVM lane bills at least half the gas limit). It
  recovers that in its prices.
- Spending limits for agents are enforced by what funds the payment: the
  escrow balance, or the Perennial buffer (and its cap). Agent authenticators
  with on-chain spending rules remain a good fit for limiting an agent's
  *native* activity; that is the agent runtime's concern, not PQ-402's.
- `MsgExecuteEVM` could later let the relayer submit without a window. It
  would not change who authorises payments, so it is an operational choice.
