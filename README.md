# PQ-402

**Pay per HTTP request with post-quantum signatures, and keep the request and
the answer sealed.** PQ-402 extends [x402](https://github.com/x402-foundation/x402)
(HTTP `402 Payment Required` → signed payment → retry) so that each payment is
signed with ML-DSA-87 and settled on QoreChain, and each request and response
body is encrypted with ML-KEM-1024 to keys registered on chain.

## What it is for

An AI agent calls a model API and pays for every call, by itself, with no
account and no card. Each call costs 0.002 fUSD. The agent's money sits in a
Perennial position whose yield fills a small buffer; every call is a signed
`spend` from that buffer. At 5% a year, a 500 fUSD deposit with Perennial's
1.15 safety margin leaves about 21.7 fUSD a year to spend, roughly 0.0025 fUSD
an hour: about one call an hour, indefinitely, without touching the deposit.

What makes it post-quantum:

- **The payment.** The agent's authorisation is an ML-DSA-87 signature,
  verified on chain by the contract that moves the money. A stolen classical
  key cannot pay. Recorded traffic does not help a future quantum attacker
  forge payments.
- **The conversation.** The prompt is encrypted to the server's ML-KEM-1024
  key and the answer to the agent's, both read from QoreChain's key registry,
  not from the other side's word. Recording the traffic today does not reveal
  it after Q-Day.
- **The receipt.** Each answer comes with a receipt signed by the server's
  ML-DSA-87 key, binding the payment, the request and the exact response
  bytes.

The agent needs no QOR and sends no transaction: the server's facilitator
relays the payment and pays the gas.

## How it works

```
agent (client)                                  server (gateway + facilitator)
   │  POST /v1/chat/completions   (no body; PQ402-Probe: 1)   │
   │ ───────────────────────────────────────────────────────▶ │
   │  402  PAYMENT-REQUIRED: accepts pq-perennial, pq-erc20;  │
   │       pq402-sealing: gateway 0x…                         │
   │ ◀─────────────────────────────────────────────────────── │
   │  read gateway's ML-KEM-1024 key from the chain           │
   │  seal the body; sign a payment bound to                  │
   │  hash(method, path, sealed body) with ML-DSA-87          │
   │  POST  PAYMENT-SIGNATURE: …   body: envelope             │
   │ ───────────────────────────────────────────────────────▶ │  check request hash, replay
   │                                                          │  verify: payer key via pqcKeyStatus,
   │                                                          │          signature, nonce, funds
   │                                                          │  open the request, run the handler
   │                                                          │  seal the answer to the payer's key
   │                                                          │  settle on chain (relayer pays gas)
   │  200  PAYMENT-RESPONSE: tx + signed receipt              │  sign the receipt
   │       body: sealed answer                                │
   │ ◀─────────────────────────────────────────────────────── │
   │  check receipt against gateway's on-chain key; open      │
```

Two ways to pay, on the same wire format ([decision 007](docs/decisions/007-two-schemes.md)):

| Scheme | Paid from | Settled by |
|---|---|---|
| `pq-perennial` | a Perennial v2 position's buffer of yield | the vault's `spend`, signed by the position's beneficiary |
| `pq-erc20` | the payer's fUSD deposit in `PQ402Escrow` | `PQ402Escrow.settle`, which checks the signature with `pqcVerify` |

Everything else is standard x402 v2: the same headers and JSON objects, so a
stock x402 client reads the `402` (and skips schemes it cannot pay). The
normative description is [`docs/spec.md`](docs/spec.md); the reasoning is in
[`docs/decisions/`](docs/decisions/); what is and is not defended is in
[`docs/threat-model.md`](docs/threat-model.md).

## Quickstart

Node 22 or later, pnpm 10, and [Foundry](https://getfoundry.sh) for the
contracts.

```bash
git clone --recurse-submodules https://github.com/raldblox/pq-402.git
cd pq-402
pnpm install
pnpm build
pnpm test                 # TypeScript: real ML-DSA-87 and ML-KEM-1024
pnpm contracts:test       # Solidity: escrow unit, fuzz, invariant, vectors

# terminal 1: a paid endpoint on an in-memory chain
pnpm example:server
# terminal 2: an agent pays three inference calls from its Perennial
# position, then two calls from its escrow, and opens the sealed answers
pnpm example:client
```

The examples run locally against an in-memory model of the chain (keys,
escrow, Perennial vault) with real cryptography. The answers come from a
stand-in model that only reports how many characters it received.

## Use it

```ts
import { createPq402Fetch } from "@pq-402/client";
import { EvmChainReader, qorechainTestnet } from "@pq-402/scheme-qorechain";

const pay = createPq402Fetch({
  payer, mldsaSecretKey, sealKeys,               // the agent's account and keys
  keys: new EvmChainReader({ network: qorechainTestnet }),
  chainId: "qorechain-diana",
  maxAmount: 5_000n,                             // never more than 0.005 fUSD a call
  perennial: { positionId: 1n },                 // pay from this position when offered
});
const res = await pay("https://api.example/v1/chat/completions", { method: "POST", body });
```

On the server, `PaymentGate` from `@pq-402/server` takes the routes and their
prices, an x402 facilitator (`x402Facilitator` from `@x402/core` with
`PqPerennialFacilitator` and `PqErc20Facilitator` registered) and the
gateway's keys; `nodeListener` mounts it on `node:http`. See
[`examples/server.ts`](examples/server.ts).

| Package | What it holds |
|---|---|
| [`@pq-402/core`](packages/core) | message encoding, ML-DSA-87 signing, ML-KEM-1024 sealing, receipts; no network |
| [`@pq-402/scheme-qorechain`](packages/scheme-qorechain) | the x402 client, server and facilitator plugins for both schemes; chain adapters |
| [`@pq-402/server`](packages/server) | the payment gate and a `node:http` adapter |
| [`@pq-402/client`](packages/client) | the paying `fetch` |
| [`contracts/`](contracts) | `PQ402Escrow` (Foundry) |

Nothing is published to npm yet.

## Status

What has been run, and where. "In-memory" means the TypeScript model of the
chain; "stand-in" means the Solidity mock of the PQC precompiles, which models
their interface, not their cryptography.

| Part | Tested | On the testnet |
|---|---|---|
| Message encoding, ML-DSA-87, ML-KEM-1024 sealing | unit tests, known-answer vectors, cross-checked in Solidity | the client's payment signature verified by the real `pqcVerify` (`eth_call`), and refused with a flipped bit or changed amount |
| `PQ402Escrow` | 28 unit, 7 fuzz (512 runs), 4 invariant (8,192 calls) tests against the stand-in | deploy dry run only; **not deployed** |
| `pq-erc20` end to end | over real HTTP against the in-memory chain | **not run**: needs funded accounts |
| `pq-perennial` end to end | over real HTTP against an in-memory model of the vault's `spend` | **not run**: needs a deployed Perennial v2 vault |
| Header sizes | `PAYMENT-SIGNATURE` 9,396 B and `PAYMENT-RESPONSE` 9,052 B through Node's default 16 KiB limit | – |

On the testnet the PQC precompiles and the KEM key registry exist today; they
are not on QoreChain mainnet. Behind nginx, raise
`large_client_header_buffers` (for example `4 16k`): its default 8 KB line
limit is below the payment header ([decision 005](docs/decisions/005-header-size.md)).

### Running it on the testnet

`examples/testnet.ts` does the chain side with two throwaway accounts kept in
a git-ignored `.env` (see [`.env.example`](.env.example)):

```bash
pnpm testnet keys          # writes .env with two fresh phrases; prints addresses
pnpm testnet precompiles   # free eth_calls against pqcVerify / pqcKeyStatus
pnpm testnet deploy        # dry run of the escrow deployment
```

After the accounts hold QOR (fees) and the payer holds fUSD as an ERC-20:
`register` and `register-kem` for each account; `window gateway` (a
one-transaction deploy window) and `deploy --broadcast`; set `ESCROW_ADDRESS`
in `.env`; `window gateway` again (now scoped to the escrow), `window payer`,
`deposit 1`; then `pnpm testnet e2e`. None of these funded steps has been run
yet. Compiler settings for the deployment are in
[`contracts/foundry.toml`](contracts/foundry.toml) (solc 0.8.28, optimizer on,
200 runs), since the explorer has no source verification.

## Credits

- [x402](https://github.com/x402-foundation/x402) (Apache-2.0): the protocol
  this extends, and `@x402/core`, whose types, header codecs and plugin
  interfaces PQ-402 uses unchanged.
- QoreChain kits (Apache-2.0): `@qorechain/pqc` (ML-DSA-87),
  `@qorechain/qoreseal` (ML-KEM-1024 envelopes, KEM registry),
  `@qorechain/sdk` and `@qorechain/evm` (accounts, key registration, EVM
  windows).
- [viem](https://viem.sh) (MIT), [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts)
  and [forge-std](https://github.com/foundry-rs/forge-std) (MIT).

## License

[MIT](LICENSE)
