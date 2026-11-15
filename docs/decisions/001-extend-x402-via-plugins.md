# 001. Extend x402 through its plugin interfaces

- Status: accepted
- Date: 2026-11-15

## Context

x402 v2 already defines the round trip PQ-402 needs: `402` with
`PAYMENT-REQUIRED`, a retry with `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`
on success. Its reference SDK, `@x402/core`, lets a project register a payment
scheme per CAIP-2 network (`SchemeNetworkClient`, `SchemeNetworkServer`,
`SchemeNetworkFacilitator`) and carries optional features as named
`extensions`. What PQ-402 adds is a different signature (ML-DSA-87 instead of
EIP-712), a different settlement path (an escrow contract that checks that
signature on chain) and sealed request and response bodies (ML-KEM-1024).

Two things the plugin interfaces cannot do on their own:

1. A scheme never sees the HTTP request, so it cannot bind a payment to the
   request it pays for.
2. Nothing in the server lifecycle rewrites the request body before the
   handler runs or the response body after it, which sealing needs.

## Decision

- **No fork.** PQ-402 depends on `@x402/core` 2.31 and implements its
  interfaces:
  - `PqErc20ClientScheme` (`SchemeNetworkClient`) builds and signs the
    payload;
  - `PqErc20ServerScheme` (`SchemeNetworkServer`) turns a price into
    requirements;
  - `PqErc20Facilitator` (`SchemeNetworkFacilitator`) verifies and settles.
  All three are registered for the network `eip155:9800` (CAIP-2 of the
  QoreChain testnet's EVM chain id).
- **Scheme name `pq-erc20`** (first named `pq-escrow`, renamed by [007](007-two-schemes.md)). A new identifier, so a stock x402 client that
  only knows `exact` skips the entry instead of building a payment it cannot
  sign. It still parses the whole `402`: the headers and JSON shapes are
  unchanged x402 v2.
- **Wire format.** Unchanged x402 v2 headers and objects. Scheme-specific data
  lives where x402 puts it: `accepts[].extra` (`escrow`, `version`) and
  `PaymentPayload.payload` (`payer`, `nonce`, `validAfter`, `validBefore`,
  `requestHash`, `signature`). Sealing is an x402 extension under the key
  `pq402-sealing`, with `info` and a JSON `schema` as x402 requires.
- **Versioning.** `x402Version` stays `2`. The PQ-402 message format has its
  own version: `extra.version = "1"`, and the version is also inside every
  signed domain tag (`"PQ-402/v1 payment"`, …), so a v2 message can never be
  mistaken for a v1 one. A server that sees an unknown `extra.version` answers
  `invalid_pq402_version`.
- **Request binding and sealing live in the HTTP layer.** The client wrapper
  computes `requestHash` from the bytes it is about to send and hands it to
  the scheme client for that one request. The server middleware recomputes it
  from the bytes it received before asking the facilitator to verify, opens a
  sealed request body before the handler, and seals the response after it.
  This is a thin layer over `@x402/core`'s header codecs, not a replacement
  for them.

## Packages

| Package | Contents | Network access |
|---|---|---|
| `@pq-402/core` | types, canonical encoding, ML-DSA-87 signing and verification, ML-KEM-1024 sealing, receipts | none |
| `@pq-402/scheme-qorechain` | the three x402 scheme plugins, the network and asset constants, chain adapters (EVM RPC and REST, plus an in-memory one for tests and the local example) | through injected adapters |
| `@pq-402/server` | framework-agnostic payment gate, a `node:http` adapter, the sealing extension | through the facilitator |
| `@pq-402/client` | a `fetch` wrapper that pays, seals, retries and opens | through a key directory |

The project plan named the packages `scheme-qorechain`, `sealing` and
`facilitator`. Sealing is pure and is needed by both sides, so it sits in
`core`; the facilitator is the facilitator half of `scheme-qorechain`. The
server and client packages hold what an application imports.

**Adapter: `node:http`.** It has no dependency, every Node framework (Express,
Fastify, Koa) runs on top of its request and response objects, and it is the
server whose header limits were measured ([005](005-header-size.md)). Other
frameworks can call the framework-agnostic `PaymentGate` directly.

## Consequences

- A plain x402 client sees a valid `402` it cannot pay. That is the intended
  compatibility.
- The request binding is not visible to a generic x402 facilitator: one that
  only implements `verify`/`settle` checks the signature over whatever
  `requestHash` the payload carries; only the PQ-402 middleware checks that the
  hash matches the request. This is stated in the threat model.
