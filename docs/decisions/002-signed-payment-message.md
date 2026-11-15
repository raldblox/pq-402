# 002. What the ML-DSA-87 signature covers

- Status: accepted
- Date: 2026-11-15

## Context

The payer authorises a payment by signing it with the ML-DSA-87 key
registered for its account on QoreChain. The same bytes must be produced by
the TypeScript client, recomputed by the facilitator, and rebuilt inside the
escrow contract, which hands them to `pqcVerify`. They must bind everything an
attacker could otherwise change: chain, contract, payer, payee, asset, amount,
time and the request being paid for, and they must never be valid for a second
payment or for a different kind of message.

## Decision

### Encoding

Every signed PQ-402 message is a Solidity `abi.encode` of fixed-size words.
`abi.encode` of static types is unambiguous (each value takes exactly one
32-byte word), is what the contract can rebuild cheaply, and is what `viem`
produces in TypeScript. The first word is a domain tag, the `keccak256` of an
ASCII label that names the protocol, its version and the message kind.

**Payment** (11 words, 352 bytes):

```
abi.encode(
  bytes32 keccak256("PQ-402/v1 payment"),
  uint256 chainId,       // EVM chain id, 9800 on the testnet
  address escrow,        // the PQ402Escrow that will settle it
  address payer,         // whose escrow balance pays, and whose key signs
  address payTo,         // who receives the amount
  address asset,         // ERC-20 held by the escrow
  uint256 amount,        // atomic units
  bytes32 nonce,         // 32 random bytes chosen by the payer
  uint64  validAfter,    // unix seconds
  uint64  validBefore,   // unix seconds
  bytes32 requestHash    // see below
)
```

**Request hash** (binds the payment to one HTTP request):

```
keccak256(abi.encode(
  bytes32 keccak256("PQ-402/v1 request"),
  bytes32 keccak256(method),   // upper-case ASCII, e.g. "POST"
  bytes32 keccak256(target),   // path and query as sent, e.g. "/paid/echo?x=1"
  bytes32 keccak256(body)      // the body bytes on the wire; empty when none
))
```

When the body is sealed, `body` is the sealed envelope, so the payment commits
to the ciphertext: the server can check the binding before it decrypts
anything. The host is not part of the hash; `payTo`, `escrow` and the nonce
already stop a payment from being redeemed elsewhere, and proxies commonly
rewrite the host.

**Withdrawal request** (7 words):

```
abi.encode(
  bytes32 keccak256("PQ-402/v1 withdrawal"),
  uint256 chainId, address escrow, address payer,
  uint256 amount, bytes32 nonce, uint64 deadline
)
```

**Receipt** (signed by the gateway, see [004](004-sealing.md)):

```
abi.encode(
  bytes32 keccak256("PQ-402/v1 receipt"),
  uint256 chainId, address escrow, address gateway, address payer,
  address payTo, uint256 amount, bytes32 nonce,
  bytes32 requestHash, bytes32 responseHash,
  bytes32 transaction,   // settlement transaction hash
  uint64  settledAt      // unix seconds
)
```

### Signature

ML-DSA-87 (FIPS 204), deterministic signing as `mldsa.sign(secretKey, message)`
in `@qorechain/pqc` does by default, empty context string, over the raw bytes
above (no pre-hash). This is the form `pqcVerify` was measured to accept
(see `docs/qorechain-notes.md`). Deterministic signing also makes the
known-answer vectors in `packages/core/test/vectors` reproducible; the chain
accepts hedged signatures too, and verification does not depend on the choice.

The verifying key is never taken from the payload. The facilitator and the
contract both read it with `pqcKeyStatus(payer)` and require
`registered && possessionProven && algorithmId == 1 && length == 2592`.

### Replay

- The payer picks a fresh random 32-byte `nonce` per payment. The contract
  records `(payer, nonce)` when it settles and refuses it forever after.
  Withdrawal requests draw from the same nonce space.
- `validAfter <= block.timestamp < validBefore` is checked on chain;
  the client sets `validBefore` to now plus the requirement's
  `maxTimeoutSeconds`.
- `chainId` and `escrow` stop cross-chain and cross-deployment replay; the
  domain tag stops a payment signature from being read as a withdrawal or a
  receipt.
- Between verification and settlement the nonce is not yet on chain. The
  server middleware keeps the nonces it has accepted in memory and refuses a
  second request carrying one of them, so a captured `PAYMENT-SIGNATURE`
  cannot be replayed against the same server while the first is in flight.
  A restart forgets that set; the chain still refuses the second settlement,
  so the cost of a replay after a restart is one served response, not money.

## Consequences

- Each signature costs 4627 bytes; see [005](005-header-size.md).
- A change to any field, including one bit of the body, invalidates the
  signature. Known-answer vectors pin the bytes in both languages: the
  TypeScript test and the Solidity test check the same expected message.
