# @pq402/server

A framework-agnostic PQ-402 payment gate: answers `402`, checks the request binding and replay, verifies through any x402 facilitator, opens sealed requests, seals responses to the payer's registered ML-KEM-1024 key, settles and signs a receipt. Includes a `node:http` adapter.

```ts
import { PaymentGate, nodeListener } from "@pq402/server";
```

Part of [PQ-402](https://github.com/raldblox/pq-402): x402 payments signed
with ML-DSA-87 and settled on QoreChain, with request and response bodies
sealed with ML-KEM-1024. See the repository README for a working example,
[docs/spec.md](https://github.com/raldblox/pq-402/blob/main/docs/spec.md) for
the protocol, and what has and has not been run on the testnet.

The QoreChain PQC precompiles and KEM key registry this relies on are
testnet features today.

MIT
