# PQ-402: the `pq-erc20` scheme and the `pq402-sealing` extension

Version 1. Status: draft, implemented in this repository.

The key words MUST, MUST NOT, SHOULD and MAY are to be read as in RFC 2119.

## 1. Summary

`pq-erc20` is an x402 v2 payment scheme in which the payer authorises each
payment with an **ML-DSA-87** signature, made with the key registered for its
account on QoreChain, and a contract settles it after verifying that
signature on chain. `pq402-sealing` is an x402 extension that seals the
request body to the server and the response body to the payer with
**ML-KEM-1024**, using keys from the chain's KEM key registry, and returns a
receipt signed by the server's ML-DSA-87 key.

Everything not stated here is x402 v2 as specified upstream
(`specs/x402-specification-v2.md` and `specs/transports-v2/http.md` in
<https://github.com/x402-foundation/x402>).

## 2. Network

| | |
|---|---|
| `network` | `eip155:9800` (QoreChain testnet `qorechain-diana`) |
| Precompiles | `pqcVerify` at `0x…0A01`, `pqcKeyStatus` at `0x…0A02` |
| Default asset | fUSD, `0x97143B771D34ddb9130b807b135Ae675A5a963CA`, 6 decimals |

## 3. `PaymentRequirements`

```json
{
  "scheme": "pq-erc20",
  "network": "eip155:9800",
  "amount": "10000",
  "asset": "0x97143B771D34ddb9130b807b135Ae675A5a963CA",
  "payTo": "0x…",
  "maxTimeoutSeconds": 120,
  "extra": { "escrow": "0x…", "version": "1" }
}
```

- `extra.escrow` (REQUIRED): address of the `PQ402Escrow` deployment for
  `asset`.
- `extra.version` (REQUIRED): `"1"`. A client MUST NOT pay an entry with a
  version it does not implement.
- Addresses are `0x`-prefixed hex; comparisons are case-insensitive.

## 4. `PaymentPayload.payload`

```json
{
  "payer": "0x…",
  "nonce": "0x<64 hex>",
  "validAfter": "1763200000",
  "validBefore": "1763200120",
  "requestHash": "0x<64 hex>",
  "signature": "<base64 of 4627 bytes>"
}
```

`validAfter` and `validBefore` are unix seconds as decimal strings.
`signature` is standard base64 with padding ([ADR 005](decisions/005-header-size.md)).
`accepted` MUST equal the requirements the server offered, field by field.

## 5. Signed bytes

### 5.1 Request hash

```
requestHash = keccak256(abi.encode(
  keccak256("PQ-402/v1 request"),
  keccak256(METHOD), keccak256(TARGET), keccak256(BODY)))
```

`METHOD` is the upper-case HTTP method. `TARGET` is the request target in
origin form: the path and, if present, `?` and the query, exactly as sent.
`BODY` is the body bytes as sent on the wire, the empty string if there is
none; when the body is sealed (section 8) it is the envelope.

### 5.2 Payment message

```
message = abi.encode(
  keccak256("PQ-402/v1 payment"),
  uint256 chainId, address escrow, address payer, address payTo,
  address asset, uint256 amount, bytes32 nonce,
  uint64 validAfter, uint64 validBefore, bytes32 requestHash)
```

`chainId` is the EVM chain id of `network` (9800). `escrow`, `payTo`, `asset`
and `amount` come from the accepted requirements; the rest from the payload.
The message is 352 bytes. `signature = ML-DSA-87.Sign(sk, message)` per FIPS
204 with an empty context string. Hedged and deterministic signing are both
valid.

Known-answer vectors: `packages/core/test/vectors/`. The Solidity tests check
that the contract builds the same message bytes.

## 6. Verification

A facilitator MUST perform these checks, and return the first failing code
as `invalidReason`:

| # | Check | Code |
|---|---|---|
| 1 | `scheme` is `pq-erc20`, `network` is supported | `invalid_scheme`, `invalid_network` |
| 2 | `extra.version` is `"1"`, `extra.escrow` is an address | `invalid_pq402_version` |
| 3 | `accepted` equals the requirements | `invalid_pq402_requirements_mismatch` |
| 4 | payload fields are well formed; signature is 4627 bytes | `invalid_pq402_payload` |
| 5 | `validAfter <= now` | `invalid_pq402_not_yet_valid` |
| 6 | `now + margin < validBefore` (margin: 6 s by default, time to settle) | `invalid_pq402_expired` |
| 7 | the nonce is unused on chain | `invalid_pq402_nonce_used` |
| 8 | `pqcKeyStatus(payer)` answers and reports registered, possession proven, algorithm 1, 2592-byte key | `invalid_pq402_key` |
| 9 | ML-DSA-87 verification of the signature over the message with that key | `invalid_pq402_signature` |
| 10 | the payer's escrow balance is at least `amount` | `insufficient_funds` |

A chain read that fails, or a precompile that returns data of the wrong
length, MUST make verification fail (`invalid_pq402_chain_unavailable`),
never pass.

Before calling the facilitator, a resource server using the HTTP transport
MUST recompute `requestHash` from the request it received and refuse a
mismatch with `invalid_pq402_request_hash`, and MUST refuse a nonce it
has already accepted and not yet seen fail with `invalid_pq402_replay`.

## 7. Settlement

`PQ402Escrow.settle(Payment p, bytes signature)` with

```solidity
struct Payment {
    address payer; address payTo; uint256 amount; bytes32 nonce;
    uint64 validAfter; uint64 validBefore; bytes32 requestHash;
}
```

The contract repeats checks 5 (with `block.timestamp`), 7, 8, 9 and 10 using
the precompiles, then records the nonce, debits the payer, transfers `amount`
of the asset to `payTo` and emits
`Settled(payer, payTo, nonce, amount, requestHash)`. Anyone MAY submit it;
the facilitator does, and pays the gas. `SettleResponse.transaction` is the
transaction hash; `payer` is the payer; `amount` is the amount.

The payer funds the escrow with `deposit(amount)` (after `approve`). It
withdraws in two steps: `requestWithdrawal(amount, nonce, deadline, signature)`
signed with the withdrawal message of [ADR 002](decisions/002-signed-payment-message.md),
then `withdraw(payer)` once `withdrawalDelay` has passed. Settlement draws on
the whole balance until the withdrawal executes.

## 8. Extension `pq402-sealing`

### 8.1 Declaration

In `PaymentRequired.extensions`:

```json
"pq402-sealing": {
  "info": {
    "version": "1",
    "chainId": "qorechain-diana",
    "gateway": "0x…",
    "mode": "mlkem",
    "request": "optional",
    "response": "sealed"
  },
  "schema": { "type": "object", "…": "see packages/core/src/sealing.ts" }
}
```

- `gateway`: the account whose ML-KEM-1024 key (KEM registry) seals requests
  and whose ML-DSA-87 key (`pqcKeyStatus`) signs receipts.
- `request`: `"required"` or `"optional"`.
- `response`: always `"sealed"` in version 1.

The client MUST echo the `info` object unchanged in
`PaymentPayload.extensions["pq402-sealing"]`. It MUST read the gateway's KEM
key from the chain, not from any header.

### 8.2 Sealed request

The client seals the body with QoreSeal (`@qorechain/qoreseal`):
`seal({ chainId, purpose: "pq402-request", mode: "mlkem", recipients: [gatewayKemKey], plaintext: body, aad })`
where `aad = utf8(METHOD + " " + TARGET + "\n" + contentType)`, sends the
envelope as the body with `Content-Type: application/vnd.pq402.sealed`, and
the original content type in `PQ402-Content-Type`. The server opens it with
the same `aad` before the handler runs; a failure is
`invalid_pq402_sealing`.

### 8.3 Sealed response and receipt

The server reads the payer's KEM key from the registry, seals the handler's
body with `purpose: "pq402-response"` and
`aad = requestHash || utf8(contentType)` and sends the envelope with
`Content-Type: application/vnd.pq402.sealed` and `PQ402-Content-Type`.

After settlement it signs the receipt message

```
abi.encode(keccak256("PQ-402/v1 receipt"), uint256 chainId, address escrow,
  address gateway, address payer, address payTo, uint256 amount,
  bytes32 nonce, bytes32 requestHash, bytes32 responseHash,
  bytes32 transaction, uint64 settledAt)
```

with `responseHash = keccak256(envelope)`, and returns

```json
"extensions": { "pq402-sealing": { "receipt": {
  "gateway": "0x…", "requestHash": "0x…", "responseHash": "0x…",
  "transaction": "0x…", "settledAt": "1763200003", "signature": "<base64>"
} } }
```

in the `SettleResponse`. The client MUST verify the receipt signature with the
gateway's key from `pqcKeyStatus` (same rules as check 8), MUST check
`responseHash` against the bytes it received and `requestHash` against the
request it sent, and MUST reject the response otherwise.

## 9. HTTP summary

| Header | Direction | Content |
|---|---|---|
| `PAYMENT-REQUIRED` | server → client | x402 v2, unchanged |
| `PAYMENT-SIGNATURE` | client → server | x402 v2; about 9.3 KB |
| `PAYMENT-RESPONSE` | server → client | x402 v2 with the receipt; about 7 KB |
| `PQ402-Content-Type` | both | original media type of a sealed body |

A server SHOULD accept request headers of at least 16 KB.
