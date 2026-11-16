# @pq402/scheme-qorechain

The PQ-402 x402 schemes for QoreChain, `pq-erc20` and `pq-perennial`: client, resource-server and facilitator plugins for `@x402/core`, and chain adapters (`EvmChainReader`, `EvmSettler`, and `MemoryChain` for tests).

```ts
import { PqErc20Facilitator, PqPerennialFacilitator, EvmChainReader, qorechainTestnet } from "@pq402/scheme-qorechain";
```

Part of [PQ-402](https://github.com/raldblox/pq-402): x402 payments signed
with ML-DSA-87 and settled on QoreChain, with request and response bodies
sealed with ML-KEM-1024. See the repository README for a working example,
[docs/spec.md](https://github.com/raldblox/pq-402/blob/main/docs/spec.md) for
the protocol, and what has and has not been run on the testnet.

The QoreChain PQC precompiles and KEM key registry this relies on are
testnet features today.

MIT
