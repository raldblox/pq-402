# 004. Seal requests and responses with QoreSeal to registered keys

- Status: accepted
- Date: 2026-11-15

## Context

PQ-402 seals the request body to the server and the response body to the
payer, so that neither travels in plaintext beyond the two ends, even through
TLS-terminating proxies, and so that a recorded exchange stays confidential
after Q-Day. The keys must come from the chain, not from the other party's
headers, or a man in the middle could substitute its own.

`@qorechain/qoreseal` 0.1.0 already provides an envelope format over
ML-KEM-1024 (FIPS 203) with HKDF-SHA-256 key derivation bound to a chain id
and a purpose, an AEAD over the payload with caller-supplied associated data,
and readers for the chain's KEM key registry (`fetchMlkemPublicKey`).

## Decision

**Use QoreSeal envelopes, mode `mlkem`, one recipient, no hand-built
construction.**

- **Keys.** Both the gateway and the payer register an ML-KEM-1024
  encapsulation key in the KEM key registry
  (`/qorechain.pqc.v1.MsgRegisterKEMKey`, built with
  `buildRegisterKemKeyMessage`). Registration is a hybrid-signed transaction,
  so the account's ML-DSA-87 key, the same one `pqcKeyStatus` reports and
  payments are verified against, vouches for the KEM key. Senders read the
  recipient's key from the registry by address; the `402` names the gateway's
  address, never its key.
- **Mode.** `mlkem` (ML-KEM-1024 only). QoreSeal's default `hybrid` mode adds
  X25519 and needs the recipient's signed recipient card, which would add a
  second key distribution path; ML-KEM-1024 alone is what the protocol
  promises. Hybrid mode is future work.
- **Request.** The client seals the body to the gateway:
  `seal({ chainId: "qorechain-diana", purpose: "pq402-request", mode: "mlkem",
  recipients: [gatewayKey], plaintext: body, aad })` with
  `aad = utf8(method + " " + target + "\n" + contentType)`. It sends the
  binary envelope with `Content-Type: application/vnd.pq402.sealed` and the
  original type in `PQ402-Content-Type`. The payment's `requestHash` covers
  the envelope.
- **Response.** The server seals the handler's body to the payer's registered
  key with `purpose: "pq402-response"` and
  `aad = requestHash (32 bytes) || utf8(contentType)`, so a response cannot
  be replayed against another request or relabelled. The original type
  travels in `PQ402-Content-Type`.
- **Purposes** feed QoreSeal's KDF (`"qorechain-kem-v1|" + chainId + "|" +
  purpose`), so a request envelope can never be opened as a response.
- **What is authenticated.** QoreSeal's AEAD authenticates the envelope header
  and the associated data above. QoreSeal envelopes are not signed (its README
  says so): sealing gives confidentiality and integrity against anyone without
  the recipient's secret key, not proof of who sealed. Origin comes from the
  signatures: the payment signature binds the sealed request to the payer, and
  the receipt binds the sealed response to the gateway.
- **Receipt.** After settlement the gateway signs the receipt message of
  [002](002-signed-payment-message.md) with its own registered ML-DSA-87 key,
  with `responseHash = keccak256(sealed response bytes)`, and returns it in
  `PAYMENT-RESPONSE` under `extensions["pq402-sealing"].receipt`. The client
  checks it against the gateway's key from `pqcKeyStatus` and against the
  bytes it received, and rejects the response if it does not match.

## Consequences

- Both parties need a registered KEM key before they can use sealing. A route
  can declare `request: "optional"` so a payer may send plaintext; response
  sealing is on whenever the extension is declared.
- The KEM key registry is read over REST, which sends no CORS headers; a
  browser client needs a proxy for it. The Node client reads it directly.
- Envelope overhead in `mlkem` mode: 56 bytes + 1632 per recipient
  (QoreSeal's `envelopeSize`), so about 1.7 KB per sealed body.
- Receipts are signed but not anchored on chain; batching them into an
  on-chain Merkle root is future work ([006](006-out-of-scope.md)).
