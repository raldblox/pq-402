# How AI was used to build PQ-402

PQ-402 was built with an AI coding agent: Claude (Anthropic), running in Claude
Code with access to this repository, a shell, the QoreChain testnet RPC and
the package registries. This file records what the agent did, what the owner
did, and how the agent's work was checked.

## Division of work

**The owner** set the goal and the constraints: build on x402 rather than
replace it, use QoreChain's own kits for post-quantum cryptography, keep a
clean history, never commit secrets, and make no claim without evidence. The
owner chose the design direction (two payment schemes, one of them paying from
a Perennial position), approved every action outside the machine (spending
testnet funds, publishing to npm, deploying the demo page) and performed the
steps only a person can: passkey approvals for npm, and funding accounts.

**The agent** read the x402 specification and the type declarations of
`@x402/core`, `@qorechain/pqc`, `@qorechain/qoreseal` and `@qorechain/sdk`,
wrote the decision records, the specification and the threat model, wrote the
code, the Solidity contract and all tests, ran the testnet transactions within
limits the owner set, and wrote this documentation. Most lines in this
repository were written by the agent. Commits it made carry a
`Co-Authored-By` trailer.

## How the work was checked

- **Tests before claims.** Every behaviour described in the README and
  [docs/threat-model.md](docs/threat-model.md) points to a test or a
  transaction hash. Known-answer vectors pin the signed bytes in TypeScript and
  Solidity alike.
- **Against the real chain.** The message format was checked against the real
  `pqcVerify` precompile and the deployed Perennial vaults with free
  `eth_call`s before any funds moved; settlements are listed with their hashes.
- **Every commit on its own.** Each commit was checked out separately and
  installed, built, type-checked, linted and tested.
- **Review.** A second agent session reviewed the branch and relayed the
  owner's feedback before anything was pushed or published.

## What the agent got wrong, and how it was found

Recorded so the process can be assessed honestly:

- It wrote the precompile addresses with upper-case hex, which viem rejects as
  a bad checksum. Every key read against the real chain would have failed
  closed. Found by running the testnet script; fixed with a regression test.
- The root build script used an unquoted glob that POSIX shells expand, so
  `pnpm build` failed on Linux while passing on the Windows machine it was
  written on. Found by CI after the first release; fixed in 0.1.1.
- It sized an EVM window for one fee cap while the relayer used the wallet's
  higher default, so the window ran out mid-run. Found on the testnet; the
  relayer now takes explicit fee caps.
- It once sourced a `.env` file in a shell, which printed two words of a
  throwaway, unfunded phrase into its own log. The keys were discarded and
  regenerated; scripts now load environment files only through Node.
- Twice a network call after a long wait failed with a bare `fetch failed`;
  the cause was not established. The scripts retry such calls, and the notes
  say the cause is unknown.

## What was not delegated

Decisions to spend funds, to publish and to deploy; the passkey approvals; the
choice of npm organisation; and the review of this repository before release.
