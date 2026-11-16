# @pq402/core

Message encoding, ML-DSA-87 signing and verification, ML-KEM-1024 sealing and opening (QoreSeal), and receipts for [PQ-402](https://github.com/raldblox/pq-402). Pure: no network access.

```ts
import { mldsaKeyPair, requestHash, sealRequest } from "@pq402/core";
```

Part of [PQ-402](https://github.com/raldblox/pq-402): x402 payments signed
with ML-DSA-87 and settled on QoreChain, with request and response bodies
sealed with ML-KEM-1024. See the repository README for a working example,
[docs/spec.md](https://github.com/raldblox/pq-402/blob/main/docs/spec.md) for
the protocol, and what has and has not been run on the testnet.

The QoreChain PQC precompiles and KEM key registry this relies on are
testnet features today.

MIT
