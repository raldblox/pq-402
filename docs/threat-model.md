# Threat model

What PQ-402 v1 defends against, how, and what it does not. The "Tested"
column names where the defence is exercised. The Solidity tests run against a
stand-in for the PQC precompiles; the TypeScript tests use real ML-DSA-87 and
ML-KEM-1024 against an in-memory model of the chain. What has been run on the
real chain is listed in the README.

## Assets

- The payer's escrow balance, and the buffer of a Perennial position.
- The confidentiality of request and response bodies.
- The server's assurance that a served response was paid for.
- The payer's assurance that a response came from the server it paid.

## Adversaries

- **Network attacker**: reads, records, replays, reorders and modifies
  traffic between client and server, including at a TLS-terminating proxy.
- **Quantum attacker**: in addition, can forge ECDSA/secp256k1 and ed25519
  signatures and break X25519, now or later on recorded traffic.
- **Classical-key thief**: holds the payer's or relayer's secp256k1 key (on
  QoreChain enough to send EVM transactions within an open window), but not
  the ML-DSA-87 key.
- **Malicious server or facilitator**: wants more money than the payer
  signed for.
- **Malicious payer**: wants a response without paying.

## Attacks considered

Test files: `E` = `contracts/test/Escrow.t.sol`, `F` = `EscrowFuzz.t.sol`,
`I` = `EscrowInvariants.t.sol`, `V` = `Vectors.t.sol`;
`fac` = `packages/scheme-qorechain/test/facilitator.test.ts`,
`per` = `.../perennial.test.ts`, `rt` = `packages/client/test/roundtrip.test.ts`,
`seal` = `packages/core/test/sealing.test.ts`.

| Attack | Defence | Tested |
|---|---|---|
| Forge a payment | ML-DSA-87 signature verified against the key from `pqcKeyStatus` | E, F (wrong signer, garbage); fac, per (other key, flipped bit) |
| Put a key in the payload | Keys are never taken from the payload, only from `pqcKeyStatus` | by construction |
| Key registered without proof of possession, or another algorithm | `possessionProven`, algorithm 1 and 2592 bytes required | E, fac |
| Replay a payment on chain | `pq-erc20`: `(payer, nonce)` recorded; `pq-perennial`: the position nonce is consumed | E, F, I; fac, per |
| Replay to the same server | server keeps accepted payments until they expire | rt (replay refused) |
| Replay after a server restart | the chain refuses the used nonce | rt |
| Replay on another chain, contract, or as another message kind | chain id, contract and a domain tag in every message | E (other escrow, other chain, withdrawal signature) |
| Change amount, payee or time window | all inside the signed bytes | E, F; fac, per |
| Pay for one request, use it for another | request hash over method, target and body bytes, checked by the server | rt (moved to another target; swapped envelope) |
| Read a sealed body | ML-KEM-1024 (QoreSeal `mlkem` mode) to keys from the KEM registry | seal (other key fails); rt (plaintext never on the wire) |
| Tamper with a sealed body | QoreSeal AEAD; the request hash covers the envelope | seal, rt |
| Move a sealed response to another request, or relabel its type | `aad = requestHash ‖ contentType` | seal |
| Seal to a key that is not the gateway's | the gateway cannot open it; payment is not taken | rt |
| Forge or alter a response | receipt signed by the gateway's ML-DSA-87 key and bound to the response bytes | rt (altered body, impostor key) |
| Inactive or missing precompile read as "valid" | return length checked; the constructor refuses to deploy; readers fail closed | E (both precompiles), fac (chain offline), `schemes.test.ts` (empty `eth_call`) |
| Classical-key thief drains the escrow | withdrawals need an ML-DSA-87 signature, wait a delay and pay only the payer | E |
| Payer withdraws between verification and settlement | settlement draws on the full balance during the delay | E |
| Classical-key thief controls the relayer | it can only submit what payers signed, to the payees they named; its window is scoped | by construction |
| Stolen agent key with `pq-perennial` | a spend pays only from the buffer; the principal is not reachable by `spend` | Perennial's own tests, not this repository |
| Fee-on-transfer token under-delivers a deposit | balance difference checked; such deposits revert | E |
| Re-entrancy through the token | checks-effects-interactions and a reentrancy guard | by construction; no re-entrant token test |
| Pay more than the client allows | client refuses before signing | rt |

## Not covered

Stated flatly:

- **Metadata is public.** Method, path, query, other headers, sizes, timing,
  addresses and amounts are visible on the wire and on chain. Only bodies are
  sealed.
- **Sealed envelopes are not signed.** Anyone can seal a request to the
  gateway; origin comes from the payment signature.
- **The request hash is checked by the PQ-402 server only.** A generic x402
  facilitator checks the signature over whatever hash the payload carries.
- **Double spending across servers before settlement.** Two servers can both
  verify payments against the same balance or buffer; the first settlement
  wins and the other server does not release its response.
- **One `pq-perennial` payment in flight per position.** Concurrent spends
  signed against the same nonce cannot both settle; any other signed action
  on the position invalidates a pending spend.
- **Server restarts forget accepted payments.** A payload replayed after a
  restart, before its settlement lands, is served again; its second
  settlement fails on chain.
- **No refunds or disputes.** The signed receipt is evidence, nothing more.
- **Receipts are not anchored on chain.**
- **Denial of service.** Each paid request costs RPC reads and an ML-DSA-87
  verification; there is no rate limiting.
- **Compromise of ML-DSA-87 or ML-KEM-1024 secret keys**, or of the machines
  running client or server.
- **QoreSeal, `@qorechain/pqc` and `@x402/core` are trusted.** QoreSeal's
  README says its construction is pending external review.
- **The stand-ins prove nothing about the chain.** The precompile mock models
  the interface, not the cryptography; the in-memory chain models the escrow
  and the Perennial vault as specified, not as deployed.
- **Proxy header limits.** A proxy with an 8 KB header limit drops the
  payment ([ADR 005](decisions/005-header-size.md)).
- **Browser clients** are not supported in v1.
