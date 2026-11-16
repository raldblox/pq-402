# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-11-16

### Changed

- The packages are named `@pq402/core`,
  `@pq402/scheme-qorechain`, `@pq402/server` and
  `@pq402/client`, and are published to npm
  ([decision 009](docs/decisions/009-npm-scope.md)).

### Added

- A README for each package.
- `EvmSettler` options `maxFeePerGas` and `maxPriorityFeePerGas`; its default
  gas limit is now 350,000 (settlement measured at about 253,000 gas).
- The testnet deployment and its transactions in the README.

## [0.1.1] - 2026-11-16

### Fixed

- `pnpm build` failed on Linux and macOS: the shell expanded the unquoted
  workspace filter.

## [0.1.0] - 2026-11-16

### Added

- `pq-erc20` x402 scheme: ML-DSA-87 signed payments settled by
  `PQ402Escrow`, which verifies them with QoreChain's `pqcVerify` and
  `pqcKeyStatus` precompiles and fails closed when they are inactive.
- `pq-perennial` x402 scheme: payments made as Perennial vault `spend`
  actions, relayed by the facilitator and confirmed by the `Spent` event.
- `pq402-sealing` extension: request and response bodies sealed with
  ML-KEM-1024 (QoreSeal) to keys from the KEM key registry, and receipts
  signed by the gateway's ML-DSA-87 key.
- `@pq-402/core`, `@pq-402/scheme-qorechain`, `@pq-402/server` (payment gate
  and `node:http` adapter) and `@pq-402/client` (paying `fetch`).
- Known-answer vectors checked in TypeScript and Solidity.
- Examples: a paid endpoint, a client that pays per inference call, and a
  testnet setup script.
- Specification, decision records and threat model.

[Unreleased]: https://github.com/raldblox/pq-402/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/raldblox/pq-402/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/raldblox/pq-402/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/raldblox/pq-402/releases/tag/v0.1.0
