# QoreChain notes

What PQ-402 relies on from the chain, with sources and the date each fact was
read or measured. The testnet upgrades often; re-check a detail before relying
on it. Commands below were run on 15 November 2026 against `qorechain-diana`.

## Network

| | Testnet |
|---|---|
| Chain id | `qorechain-diana` |
| EVM chain id | `9800` (`eth_chainId` returned `0x2648`) |
| CAIP-2 id used by PQ-402 | `eip155:9800` |
| EVM RPC | `https://evm-testnet.qore.host` |
| REST | `https://api-testnet.qore.host` |
| RPC | `https://rpc-testnet.qore.host` |

Source: <https://docs.qorechain.io/getting-started>

## PQC precompiles

| Precompile | Address |
|---|---|
| `pqcVerify(bytes pubkey, bytes signature, bytes message) → bool` | `0x0000000000000000000000000000000000000A01` |
| `pqcKeyStatus(address) → (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)` | `0x0000000000000000000000000000000000000A02` |

Measured:

- `active_static_precompiles` in
  `https://api-testnet.qore.host/cosmos/evm/vm/v1/params` listed `0x…0901`,
  `0x…0C01`, `0x…0a01` and `0x…0a02`.
- A key pair made with `mldsa.keygen(seed)` from `@qorechain/pqc` 0.2.3 and a
  signature from `mldsa.sign(secretKey, message)` over raw bytes: `pqcVerify`
  through `eth_call` returned `true`; with one bit of the signature flipped it
  returned `false`. No key registration is needed for this: the precompile
  takes the public key as an argument.
- `pqcKeyStatus` for an address with no key returned `(false, 0, 0x, false)`.
- A call with an unknown selector to `0x…0a02` is an RPC error
  (`unknown method selector`), not empty data.
- ML-DSA-87 public keys are 2592 bytes and signatures 4627 bytes;
  `algorithmId` is `1`.
- An inactive precompile address answers with success and empty data
  (recorded in the Perennial notes on the same date). Every caller in this
  repository checks the length of the return data and fails closed.
- Foundry's local EVM has no such precompiles, so Solidity unit tests have to
  install a stand-in at both addresses.

Source: <https://docs.qorechain.io/developer-guide/evm-precompiles>

## KEM key registry

- An account publishes one ML-KEM-1024 encapsulation key (1568 bytes,
  algorithm id `2`) with `/qorechain.pqc.v1.MsgRegisterKEMKey`.
  `@qorechain/qoreseal` builds it: `buildRegisterKemKeyMessage`.
  Registering again replaces the key.
- It is read over REST at `/qorechain/pqc/v1/kem/{address}`
  (`fetchKemKey` / `fetchMlkemPublicKey` in `@qorechain/qoreseal/network`).
  Measured: an address with no key returns `{ registered: false }`.
- There is no EVM precompile for the KEM registry, so a contract cannot read
  it, and the REST API sends no CORS headers, so a web page on another origin
  cannot read it without a proxy.

## fUSD

`0x97143B771D34ddb9130b807b135Ae675A5a963CA`: `decimals()` returned `6`,
`symbol()` returned `fUSD`. The faucet pays it as a bank coin; it has to be
converted to an ERC-20 balance (`MsgConvertCoin`) before a contract can see it
(see the Perennial project's notes for the message).

## EVM authorisation window

Every EVM transaction, a deployment included, needs an open EVM window opened
by a hybrid-signed Native message (`openEvmWindowMsg` in `@qorechain/sdk`).
A window can be scoped to `allowedTargets`. The EVM lane bills at least half of
a transaction's gas limit. For PQ-402 this means:

- the payer needs a window to `approve` and `deposit` (once, not per request);
- the relayer that calls `settle` needs a window scoped to the escrow.

Source: <https://docs.qorechain.io/developer-guide/evm-window-reference>
