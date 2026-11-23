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

## Measured with PQ-402's own code (15–16 November 2026)

`pnpm testnet precompiles` signs with the payer key from `.env` and asks the
real `pqcVerify` through `eth_call` (free, no key registration needed):

| Call | Result |
|---|---|
| a `pq-erc20` payment message signed by the client code | `true` |
| the same with one bit of the signature flipped | `false` |
| the same signature over the message with the amount changed | `false` |
| the known-answer vector in `packages/core/test/vectors/v1.json` | `true` |

So the exact bytes and signature form PQ-402 uses verify on chain. The
Perennial spend message was not checked this way (it is checked against the
vault's encoding in `contracts/test/Vectors.t.sol`).

`pnpm testnet deploy` (dry run, `--skip-simulation`) passes the escrow's
precompile checks through `vm.rpc("eth_call")` and simulates the deployment
from a fresh, unfunded account.

## Pitfalls

- **Address case.** viem refuses `0x…0A01` / `0x…0A02` as a bad EIP-55
  checksum (`InvalidAddressError`); write the precompile addresses in lower
  case. Solidity refuses the same literals at compile time.
- **Forge and `.env`.** `forge script --root contracts` run from the
  repository root does not load the root `.env`; `pnpm testnet deploy` passes
  the environment explicitly.

## The KEM key registration carries an ML-DSA-87 signature

Read on 23 November 2026 from REST `/cosmos/tx/v1beta1/txs/{hash}` for
`D4E53C1B0164FC76656D07CB76611134E7EE0C8300CC6110961EAAB096DAD5EC`: one
`/qorechain.pqc.v1.MsgRegisterKEMKey` (sender `qor1sfwz…lyg`, algorithm 2,
1,568-byte key), with a `/qorechain.pqc.v1.PQCHybridSignature` extension
holding a 4,627-byte ML-DSA-87 signature next to the classical one.

## Gas for a Perennial spend varies

A budget-mode spend that has to redeem principal from the vault's yield
source ran out of gas at a fixed 350,000 limit
(`0xbacd85244ff115139ef555e01ab93fa42e09ffc2cf8c1bc497453c53eca75d26`,
reverted), while one paid from the buffer used 324,172. The relayer now
estimates every call.

Run on 23 November 2026 with the 0.2.1 settler, from the workspace, on the
no-yield budget-mode vault `0x76DAC5461fF361f911e5F39810c9455a6180C180`
(its yield source pays nothing, so the buffer stays empty and every spend
draws on principal). The owner account opened position 4 with 0.02 fUSD,
itself as beneficiary, a budget of 0.002 fUSD an hour and `ownerCanClose`,
made one paid, sealed call through `pq-perennial`, then closed the position:

| Step | Transaction | Gas used / limit |
|---|---|---|
| Open EVM window (scoped to the vault and fUSD, 4 txs) | `016A6694336627F56CB128EE267F75E96126EB4C3D9CDED8CCC78C7810FB2A29` (native) | |
| Approve exactly 20,000 fUSD units to the vault | `0x37d24bb8e18e402ffd7499b5a205cd2a98cc3675328af079e419f9bfed4d2880` | 46,318 / 55,581 |
| Open position 4 (budget mode, 20,000 units) | `0x115c1fb6d22be3e25129142d3640c14d58202af28d4e47ffcb7966107a1ece1f` | 315,302 / 413,911 |
| `spend` of 2,000 units, relayed by `EvmSettler` | `0x93ba69d01248ca5f400fad0474fa950969f6d0c1d3aa9927011f267d1a781d41` | 337,253 / 434,547 |
| Close position 4 (owner, ML-DSA-87 signed) | `0x944cec9bbda587134dc0ea4aea82afe2686be10eb8a4d02a0c3ffdde438162a2` | 248,322 / 332,756 |
| Close EVM window | `858230FDBF909879E96596E8C1F5869E0CFC07D0E070318144435AEB789ADDFE` (native) | |

The approval was sent in an earlier window (`78ECB8B7…8CE3`, opened and
closed by a run that stopped on a script error before `open`); the second
run reused that exact allowance. Position 4 read principal 20,000 and buffer
0 before the spend, and principal 18,000, buffer 0 and `windowSpent` 2,000
after it; the spend's receipt holds a `PrincipalDrawn(4, 2000)` event. The
settler's limit of 434,547 is its estimate plus 20%, so the estimate was
about 362,100, above the old fixed 350,000. Closing returned the rest; the
owner's fUSD balance read 219.090933 before and after (the spend paid the
same account), the vault allowance read 0 afterwards, and QOR went from
12.620268 to 12.124601 across both windows.

## Agent authenticators

Read on 16 November 2026 from the `@qorechain/sdk` 0.14.0 type declarations
(`executeEvmMsg`, `linkAuthenticatorMsgs`): an owner links an ed25519 or
secp256k1 key to an account with spending rules; the linked key signs and a
relayer submits `MsgExecuteEVM` / `MsgExecuteCosmos` and pays the fee, with no
EVM window. The linked key's classical signature is the authorisation; there
is no ML-DSA co-signature. PQ-402 does not use them
([decision 008](decisions/008-relayer-pays-gas.md)).

## Measured on the testnet run (16 November 2026)

From the transactions listed in the README (`PQ402Escrow` at
`0xb7384fe171670fba5af74fc8f5aa99ef084025cd`):

| Call | Gas used |
|---|---|
| deploy `PQ402Escrow` (`eth_estimateGas` said 1,479,436) | 1,479,436 |
| `approve` fUSD | 46,318 |
| `deposit` | 83,910 |
| `settle` (one `pqcKeyStatus`, one `pqcVerify` of a 4627-byte signature) | 253,160 and 253,388 |
| `requestWithdrawal` (also one `pqcVerify`) | 271,183 |
| `withdraw` | 65,000 |

- The effective gas price was 112.5 gwei; the base fee read 100 gwei.
- **Window budget includes the fee cap.** A window's value limit is charged
  `gas limit × maxFeePerGas` per transaction. With viem's default cap
  (255 gwei, twice the base fee plus tip) a 450,000-gas `settle` reserved
  about 0.115 QOR, and a window sized at 150 gwei refused the following
  transaction with "Missing or invalid parameters" from
  `eth_sendRawTransaction`. Set the fee cap explicitly and size the window
  from the same number.
- **Scoped windows refuse contract creation** (documented on
  `allowedTargets` in `@qorechain/sdk` 0.14.0); a deployment needs its own
  window.
- Native transactions sent by the scripts cost a fixed 0.1 QOR fee each
  (800,000 gas, 100,000 uqor). The whole run cost 1.3535 QOR, most of it in
  window open and close messages.
- Twice, a request made right after a long wait (a settlement, then the
  120-second withdrawal delay) failed with a bare `fetch failed` from Node's
  `fetch`. It did not reproduce with a 6-second simulated settlement locally;
  the cause is not established. Retrying the call worked.
- A window that has run out of blocks reports "not usable" but still exists
  until it is closed.

## The deployed Perennial vaults (17 November 2026)

`pnpm testnet perennial-check <vault>` (free `eth_call`s) against the
vaults the Perennial project deployed on 16 and 17 November 2026:

| Vault | `ACTION_DOMAIN` | `actionMessage` vs local encoding | `ASSET` |
|---|---|---|---|
| `0x76DAC5461fF361f911e5F39810c9455a6180C180` (no yield, budget mode) | `keccak256("Perennial.Action")`, equal | equal, 256 bytes | fUSD |
| `0x496AAa4D585B97c8a26095D97Af4bBfAd473798c` (accelerated demo rate) | equal | equal, 256 bytes | fUSD |
| `0x78075C631D41AF72c69e34120d5C33cDC7A66A71` (simulated 4.29% a year; checked 17 November) | equal | equal, 256 bytes | fUSD |

PQ-402 reads the vault address from configuration (`PERENNIAL_VAULT`), never
from code.

## The recorded `pnpm demo` run (22 November 2026)

| Call | Gas used |
|---|---|
| `PQ402Escrow.settle` | 253,160 |
| Perennial vault `spend` (budget-mode position, harvest first, one `pqcVerify`) | 324,172 |
| `withdraw` | 65,000 |

The whole run (two native window messages, approve, deposit, two
settlements, a signed withdrawal request and its payout) cost 0.305408 QOR.
Several projects shared one account; only one EVM window exists per account,
so runs were taken in turn.
