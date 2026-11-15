# 005. Carry the ML-DSA-87 signature in the standard x402 headers

- Status: accepted
- Date: 2026-11-15

## Context

An ML-DSA-87 signature is 4627 bytes. x402 carries the payment payload as
base64 of JSON in the `PAYMENT-SIGNATURE` request header, and the settlement
result in the `PAYMENT-RESPONSE` response header. Header size limits vary:
Node's `http.maxHeaderSize` is 16,384 bytes for all request headers together
(read from `require("http").maxHeaderSize` on Node 24.13.0), and nginx's
default `large_client_header_buffers 4 8k` refuses a single header line over
8 KB according to its documentation.

Measured on 15 November 2026 with `encodePaymentSignatureHeader` from
`@x402/core` 2.31.0, for a realistic `pq-escrow` payload with the sealing
extension echoed:

| Signature encoding inside the JSON | `PAYMENT-SIGNATURE` value |
|---|---|
| hex (`0x…`) | 13,408 bytes |
| base64 | 9,296 bytes |

## Decision

- Signatures inside PQ-402 JSON objects are **base64** (standard alphabet,
  with padding). This keeps the header at about 9.3 KB.
- The payload stays in the standard `PAYMENT-SIGNATURE` header, unchanged
  x402. It fits Node's default; the repository's tests send real payments
  through a `node:http` server with default settings.
- The receipt in `PAYMENT-RESPONSE` carries one signature too, so that header
  is of the same size; Node's `fetch` reads it with default settings in the
  same tests.
- Deployments behind nginx must raise `large_client_header_buffers`
  (for example `4 16k`); this is documented in the README. It was not tested
  against nginx or a CDN here: neither was available on the machine this was
  built on.

## Alternatives not taken

- **Signature in the body, hash in the header.** Fits every proxy, but the
  body then carries protocol data, which breaks request sealing and every
  stock x402 server. Kept as the fallback if a deployment cannot raise its
  limits; not implemented.
- **Signature by reference** (the client uploads it first and sends an id):
  an extra round trip and server state for every request.
