# @pq402/client

A `fetch` that pays PQ-402 `402`s: signs with ML-DSA-87, seals the request body to the server's registered ML-KEM-1024 key, retries, verifies the signed receipt and opens the sealed response.

```ts
import { createPq402Fetch } from "@pq402/client";
```

Part of [PQ-402](https://github.com/raldblox/pq-402): x402 payments signed
with ML-DSA-87 and settled on QoreChain, with request and response bodies
sealed with ML-KEM-1024. See the repository README for a working example,
[docs/spec.md](https://github.com/raldblox/pq-402/blob/main/docs/spec.md) for
the protocol, and what has and has not been run on the testnet.

The QoreChain PQC precompiles and KEM key registry this relies on are
testnet features today.

MIT
