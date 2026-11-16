# PQ-402: the `pq-erc20` and `pq-perennial` schemes and the `pq402-sealing` extension

Version 1. Status: draft, implemented in this repository.

The key words MUST, MUST NOT, SHOULD and MAY are to be read as in RFC 2119.

## 1. Summary

PQ-402 is two x402 v2 payment schemes and one extension:

- **`pq-erc20`**: the payer authorises each payment with an **ML-DSA-87**
  signature by the key registered for its account on QoreChain; the
  `PQ402Escrow` contract checks it with the chain's PQC precompiles and pays
  from the payer's escrowed balance.
- **`pq-perennial`**: the payment is a Perennial vault `spend` action,
  ML-DSA-87 signed by the position's beneficiary; the vault checks it and pays
  from the position's buffer of harvested yield.
- **`pq402-sealing`**: request and response bodies are sealed with
  **ML-KEM-1024** to keys from the chain's KEM key registry, and the server
  returns a receipt signed with its own ML-DSA-87 key.

Everything not stated here is x402 v2 as specified upstream
(`specs/x402-specification-v2.md` and `specs/transports-v2/http.md` in
<https://github.com/x402-foundation/x402>). Decisions behind this document are
in [`decisions/`](decisions/).

## 2. Network

| | |
|---|---|
| `network` | `eip155:9800` (QoreChain testnet `qorechain-diana`) |
| Precompiles | `pqcVerify` at `0x…0a01`, `pqcKeyStatus` at `0x…0a02` |
| Default asset | fUSD, `0x97143B771D34ddb9130b807b135Ae675A5a963CA`, 6 decimals |

## 3. `PaymentRequirements`

Common fields as in x402. Scheme-specific `extra`:

| Scheme | `extra` |
|---|---|
| `pq-erc20` | `{ "escrow": "0x…", "version": "1" }`: the `PQ402Escrow` for `asset` |
| `pq-perennial` | `{ "vault": "0x…", "version": "1" }`: the Perennial vault; `asset` is its asset |

A client MUST NOT pay an entry with a `version` it does not implement.
Addresses are `0x`-prefixed hex and compared case-insensitively. A server MAY
offer both schemes in one `402`, at the same price and payee.

## 4. `PaymentPayload.payload`

### 4.1 `pq-erc20`

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

### 4.2 `pq-perennial`

```json
{
  "payer": "0x…",
  "positionId": "7",
  "nonce": "3",
  "deadline": "1763200120",
  "ref": "0x<64 hex>",
  "signature": "<base64 of 4627 bytes>"
}
```

`payer` is the position's beneficiary; `nonce` is the position's action nonce
when signing; `ref` is the request hash of section 5.1.

Numbers are decimal strings. `signature` is standard base64 with padding
([ADR 005](decisions/005-header-size.md)). `accepted` MUST equal the
requirements the server offered.

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

### 5.2 `pq-erc20` payment message

```
abi.encode(
  keccak256("PQ-402/v1 payment"),
  uint256 chainId, address escrow, address payer, address payTo,
  address asset, uint256 amount, bytes32 nonce,
  uint64 validAfter, uint64 validBefore, bytes32 requestHash)
```

352 bytes. `chainId` is the EVM chain id of `network` (9800).

### 5.3 `pq-perennial` spend message

The vault's `actionMessage` for `Action.Spend = 4`:

```
abi.encode(
  keccak256("Perennial.Action.v1"),
  uint256 chainId, address vault, uint256 positionId, uint8 4,
  uint256 nonce, uint256 deadline,
  keccak256(abi.encode(address payTo, uint256 amount, bytes32 ref)))
```

256 bytes.

### 5.4 Signature

`signature = ML-DSA-87.Sign(sk, message)` per FIPS 204, empty context string,
over the raw bytes. Hedged and deterministic signing are both valid; the
reference client signs deterministically.

Known-answer vectors for every message: `packages/core/test/vectors/v1.json`.
The Solidity tests (`contracts/test/Vectors.t.sol`) build the same bytes.

## 6. Verification

A facilitator MUST perform these checks in order and return the first failing
code as `invalidReason`. A chain read that fails, or a precompile that returns
data of the wrong length, MUST fail verification
(`invalid_pq402_chain_unavailable`), never pass it.

### 6.1 `pq-erc20`

| # | Check | Code |
|---|---|---|
| 1 | scheme and network are served | `invalid_scheme`, `invalid_network` |
| 2 | `extra.version` is `"1"`, `extra.escrow` is an address | `invalid_pq402_version` |
| 3 | `accepted` equals the requirements | `invalid_pq402_requirements_mismatch` |
| 4 | payload well formed; signature 4627 bytes | `invalid_pq402_payload` |
| 5 | `validAfter <= now` | `invalid_pq402_not_yet_valid` |
| 6 | `now + margin < validBefore` (margin 6 s by default) | `invalid_pq402_expired` |
| 7 | `(payer, nonce)` unused in the escrow | `invalid_pq402_nonce_used` |
| 8 | `pqcKeyStatus(payer)`: registered, possession proven, algorithm 1, 2592-byte key | `invalid_pq402_key` |
| 9 | the signature verifies over 5.2 with that key | `invalid_pq402_signature` |
| 10 | escrow balance of `payer` ≥ `amount` | `insufficient_funds` |

### 6.2 `pq-perennial`

| # | Check | Code |
|---|---|---|
| 1–4 | as 6.1, with `extra.vault` | as 6.1 |
| 5 | `now + margin < deadline` | `invalid_pq402_expired` |
| 6 | `payer` is the position's beneficiary | `invalid_pq402_key` |
| 7 | the position is neither closed nor in succession | `invalid_pq402_payload` |
| 8 | the payload's `nonce` is the position's current nonce | `invalid_pq402_nonce_used` |
| 9 | `pqcKeyStatus(beneficiary)` as 6.1 #8 | `invalid_pq402_key` |
| 10 | the signature verifies over 5.3 with that key | `invalid_pq402_signature` |
| 11 | `buffer + pendingYield ≥ amount` | `insufficient_funds` |

### 6.3 Resource server

Before calling the facilitator, a resource server using the HTTP transport
MUST recompute the request hash from the request it received and refuse a
mismatch with `invalid_pq402_request_hash`, and MUST refuse a payment it has
already accepted (same escrow, payer and nonce, or same vault, position and
nonce) with `invalid_pq402_replay`.

## 7. Settlement

The facilitator submits the settlement transaction from its own account and
pays the gas ([ADR 008](decisions/008-relayer-pays-gas.md)). The payer sends
no transaction.

- **`pq-erc20`**: `PQ402Escrow.settle(Payment p, bytes signature)` with
  `Payment = (payer, payTo, amount, nonce, validAfter, validBefore, requestHash)`.
  The contract repeats checks 5, 6 (without margin), 7, 8, 9 and 10 with the
  precompiles, records the nonce, debits the payer, transfers to `payTo` and
  emits `Settled(payer, payTo, nonce, amount, requestHash)`. The payer funds
  the escrow with `deposit`; withdrawals are ML-DSA-87 signed and delayed
  ([ADR 003](decisions/003-escrow-settlement.md)).
- **`pq-perennial`**: `vault.spend(positionId, payTo, amount, ref, deadline,
  signature)`. The vault verifies the signature against the beneficiary's
  registered key, harvests, pays from the buffer and emits
  `Spent(positionId, to, amount, ref)`. The facilitator MUST NOT report
  success unless that event, with these values, is in the transaction
  receipt. A payee can find its payments by filtering on the indexed `ref`.

`SettleResponse.transaction` is the transaction hash, `payer` the payer,
`amount` the amount.

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

- `gateway`: the account whose ML-KEM-1024 key (KEM registry) opens requests
  and whose ML-DSA-87 key (`pqcKeyStatus`) signs receipts.
- `request`: `"required"` or `"optional"`. `response`: always `"sealed"`.

The client MUST echo `info` unchanged in
`PaymentPayload.extensions["pq402-sealing"]`, and MUST read the gateway's KEM
key from the chain, never from a header.

### 8.2 Probe and sealed request

A client that seals MUST NOT send a plaintext body before it has seen the
`402`. Its first attempt carries no body and the header `PQ402-Probe: 1`. A
PQ-402 server answers a probe to a paid route with the `402`, and a probe to
an unpaid route with `204` without running the handler; the client then sends
the request unchanged.

The client seals the body with QoreSeal (`@qorechain/qoreseal`):
`seal({ chainId, purpose: "pq402-request", mode: "mlkem", recipients: [gatewayKemKey], plaintext: body, aad })`
with `aad = utf8(METHOD + " " + TARGET + "\n" + contentType)`, sends the
envelope with `Content-Type: application/vnd.pq402.sealed`, and the original
type in `PQ402-Content-Type`. The server opens it with the same `aad` before
the handler runs; failure is `invalid_pq402_sealing`.

### 8.3 Sealed response and receipt

The server reads the payer's KEM key from the registry before running the
handler (and refuses with `invalid_pq402_sealing` if there is none), seals the
handler's body with `purpose: "pq402-response"` and
`aad = requestHash ‖ utf8(contentType)`, and sends the envelope with
`Content-Type: application/vnd.pq402.sealed` and `PQ402-Content-Type`.

After settlement it signs the receipt message

```
abi.encode(keccak256("PQ-402/v1 receipt"), uint256 chainId,
  address settlement, address gateway, address payer, address payTo,
  uint256 amount, bytes32 paymentId, bytes32 requestHash,
  bytes32 responseHash, bytes32 transaction, uint64 settledAt)
```

where `settlement` is the escrow or the vault, `paymentId` is the payer's
nonce (`pq-erc20`) or `keccak256(abi.encode(positionId, nonce))`
(`pq-perennial`), and `responseHash = keccak256(envelope)`. It returns

```json
"extensions": { "pq402-sealing": { "receipt": {
  "gateway": "0x…", "requestHash": "0x…", "responseHash": "0x…",
  "transaction": "0x…", "settledAt": "1763200003", "signature": "<base64>"
} } }
```

in the `SettleResponse`. The client MUST verify the receipt signature with the
gateway's key from `pqcKeyStatus` (rules of 6.1 #8), MUST check
`responseHash` against the bytes received and `requestHash` against the
request sent, and MUST reject the response otherwise.

## 9. HTTP summary

| Header | Direction | Content |
|---|---|---|
| `PAYMENT-REQUIRED` | server → client | x402 v2, unchanged |
| `PAYMENT-SIGNATURE` | client → server | x402 v2; 9,396 bytes measured |
| `PAYMENT-RESPONSE` | server → client | x402 v2 with the receipt; 9,052 bytes measured |
| `PQ402-Content-Type` | both | original media type of a sealed body |
| `PQ402-Probe` | client → server | `1` on a sealing client's body-less first attempt |

Sizes measured by `packages/client/test/roundtrip.test.ts` for a `pq-erc20`
payment with sealing. A server SHOULD accept request headers of at least
16 KB.
