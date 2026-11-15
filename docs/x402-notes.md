# x402 notes

What PQ-402 takes from x402, read on 15 November 2026 from
<https://github.com/x402-foundation/x402> (`specs/x402-specification-v2.md`,
`specs/transports-v2/http.md`, `specs/schemes/exact/`) and from the type
declarations of `@x402/core` 2.31.0. x402 is Apache-2.0.

## Protocol version 2 in one paragraph

A resource server answers an unpaid request with HTTP `402` and a
`PAYMENT-REQUIRED` header: base64 of a JSON `PaymentRequired`
(`x402Version: 2`, `resource`, `accepts[]`, optional `extensions`). Each entry
of `accepts` is a `PaymentRequirements`: `scheme`, `network` (CAIP-2),
`amount` (atomic units, string), `asset`, `payTo`, `maxTimeoutSeconds` and a
scheme-specific `extra`. The client picks one, builds a `PaymentPayload`
(`x402Version`, `accepted`, scheme-specific `payload`, echoed `extensions`)
and retries with base64 of it in `PAYMENT-SIGNATURE`. The server verifies,
serves, settles and returns `PAYMENT-RESPONSE`: base64 of a `SettleResponse`
(`success`, `transaction`, `network`, `payer`, optional `extensions`).

## Points that shape PQ-402

- **Extensions.** `PaymentRequired.extensions[key] = { info, schema }`. The
  client must echo at least the `info` it received and may add to it. This is
  where the sealing parameters travel.
- **Payment flows.** The default `authorization` flow is
  verify → resource → settle. PQ-402 uses it.
- **Error codes.** `invalidReason` / `errorReason` are stable strings; the
  message text is not. PQ-402 adds its own `invalid_pq402_*` codes in the
  style of `invalid_exact_evm_*`.
- **Plugins.** `@x402/core` exposes `SchemeNetworkClient`
  (`createPaymentPayload`), `SchemeNetworkServer` (`parsePrice`,
  `enhancePaymentRequirements`) and `SchemeNetworkFacilitator` (`verify`,
  `settle`, `getSigners`), registered per CAIP-2 network on `x402Client`,
  `x402ResourceServer` and `x402Facilitator`. PQ-402 implements all three for
  `eip155:9800`.
- **The scheme does not see the HTTP request.** `createPaymentPayload` gets the
  requirements only, and `verify` / `settle` get the payload and requirements
  only. Binding a payment to the request body therefore happens in the HTTP
  layer (see the decision records).
- **Header codecs.** `@x402/core/http` exports `encodePaymentRequiredHeader`,
  `decodePaymentSignatureHeader`, `encodePaymentResponseHeader` and their
  inverses; PQ-402 uses them unchanged.
- **Browsers.** None of the three headers is CORS-safelisted; a server meant
  for browsers must expose `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` and allow
  `PAYMENT-SIGNATURE`.
