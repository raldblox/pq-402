# 009. Publish under the `@pq402` npm scope

- Status: accepted
- Date: 2026-11-16
- Supersedes the package names in [001](001-extend-x402-via-plugins.md) and
  the publishing note in [006](006-out-of-scope.md).

## Context

The packages were named under an `@pq-402` scope that did not exist on npm.
The project's npm organisation is `pq402`, without the hyphen.

## Decision

| Package | Contents |
|---|---|
| `@pq402/core` | message encoding, ML-DSA-87 signing, ML-KEM-1024 sealing, receipts; no network |
| `@pq402/scheme-qorechain` | the x402 client, server and facilitator plugins for `pq-erc20` and `pq-perennial`; chain adapters |
| `@pq402/server` | the payment gate and the `node:http` adapter |
| `@pq402/client` | the paying `fetch` |

Versions move together; the first published version is 0.1.2. The protocol
identifiers (`pq-erc20`, `pq-perennial`, `pq402-sealing`) are unchanged:
they are wire names, not package names.

## Consequences

Code that imported `@pq-402/*` from this repository's workspace imports
`@pq402/*`. Nothing had been published under the old names.
