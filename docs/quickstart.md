# Quickstart: one paid, sealed API call, end to end

A server charges 0.002 fUSD for each call to `POST /v1/chat/completions`. A
client pays with its ML-DSA-87 key, its question travels sealed to the
server's registered ML-KEM-1024 key, and the answer comes back sealed to the
client's. The model behind the endpoint is a stand-in that returns a fixed
sentence: what this shows is the payment, the settlement and the sealing.

There are two ways to run it.

## 1. Locally, with nothing to fund

An in-memory model of the chain (keys, escrow, Perennial vault) with real
ML-DSA-87 and ML-KEM-1024. Node 22 or later and pnpm 10.

```bash
git clone --recurse-submodules https://github.com/raldblox/pq-402.git
cd pq-402
pnpm install
pnpm build
pnpm example:server     # terminal 1: the paid endpoint
pnpm example:client     # terminal 2: pays three calls from a Perennial position, two from an escrow
```

The client prints each answer, the scheme it paid with and the settlement
"transaction" (a hash the in-memory chain makes up). `pnpm test` runs the same
flow, and the attacks against it, as tests.

## 2. On the QoreChain testnet

`pnpm demo` (`examples/demo.ts`) runs the whole flow against the real chain and
records it:

1. Reads both accounts' ML-DSA-87 keys (`pqcKeyStatus`) and ML-KEM-1024 keys
   (KEM key registry) and the Perennial position, and stops if any is missing.
2. Opens an EVM window scoped to the escrow, the vault and fUSD
   (a hybrid-signed native transaction).
3. Deposits 0.01 fUSD into `PQ402Escrow` (exact approval).
4. Starts the paid endpoint and makes two calls through `@pq402/client`:
   - **call 1** pays with `pq-erc20`: the relayer submits `escrow.settle`, which
     checks the payer's signature with `pqcVerify`;
   - **call 2** pays with `pq-perennial`: the relayer submits `vault.spend` for
     the payer's Perennial position.
   For each call it records the `402` offer, the signed payment, the sealed
   request on the wire, the settlement transaction, the sealed answer with the
   gateway's signed receipt, and the opened answer.
5. Withdraws what is left in the escrow (an ML-DSA-87 signed request, the
   escrow's delay, the payout) and closes the window, also on failure.
6. Writes the public transcript to `site/run.json` (no keys).

### What you need

- `.env` from [`.env.example`](../.env.example): `GATEWAY_MNEMONIC` and
  `PAYER_MNEMONIC`, or `QORE_MNEMONIC` alone to let one account play both
  roles; `ESCROW_ADDRESS`; `PERENNIAL_VAULT` and `PERENNIAL_POSITION`, where
  the payer is the position's beneficiary.
- Each account: some QOR for fees, a registered ML-DSA-87 key with proof of
  possession and a registered ML-KEM-1024 key:
  ```bash
  pnpm testnet register gateway
  pnpm testnet register-kem gateway
  pnpm testnet register payer
  pnpm testnet register-kem payer
  ```
- The payer: a little fUSD as an ERC-20 (the faucet pays it as a native coin
  that has to be converted first; see [qorechain-notes](qorechain-notes.md)).
- An escrow: `pnpm testnet window gateway`, `pnpm testnet deploy --broadcast`,
  then set `ESCROW_ADDRESS`.

Before signing with the deployed vaults you can check, for free, that they sign
the same bytes PQ-402 does:

```bash
pnpm testnet perennial-check 0x496AAa4D585B97c8a26095D97Af4bBfAd473798c 1
```

### A recorded run

The run on the README's "Deployment" section and on the demo page was made
with this script; its transcript is [`site/run.json`](../site/run.json).
