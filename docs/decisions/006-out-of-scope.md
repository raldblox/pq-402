# 006. What version 1 does not do

- Status: accepted
- Date: 2026-11-15

PQ-402 v1 is deliberately small. These are out of scope, each for a reason:

- **Batched or cumulative settlement.** Every payment is settled by its own
  transaction with its own `pqcVerify`. Cumulative vouchers (only the latest
  needs verifying) are the right design for high-frequency payments and the
  natural next scheme.
- **Receipt anchoring.** Receipts are ML-DSA-87 signed and verified by the
  client, but not batched into a Merkle root on chain.
- **Hybrid (ML-KEM-1024 + X25519) sealing** and QoreSeal recipient cards; see
  [004](004-sealing.md).
- **The Native-lane "exact" variant** (a hybrid-signed fUSD transfer per
  request with the request hash in its memo).
- **Signature carried in the body** for proxies with small header limits; see
  [005](005-header-size.md).
- **Browser clients.** The KEM registry is read over REST, which has no CORS
  headers, and the QoreX wallet cannot sign arbitrary bytes for a page today.
  The client targets Node.
- **Sealing headers, URLs and timing.** Only bodies are sealed. Method, path,
  query, sizes, amounts and addresses stay visible to whoever can see the
  connection, and on chain.
- **Refunds and disputes.** A settled payment is final; a server that takes
  payment and serves garbage is a business problem, not one this protocol
  solves. The signed receipt is the evidence a payer can show.
- **Persistent replay cache.** The server's in-flight nonce set is in memory
  ([002](002-signed-payment-message.md)).
- **Mainnet.** The PQC precompiles and the KEM registry are testnet features
  today.
- **Publishing.** The packages are set up to publish under the `@pq-402` npm
  scope; nothing is published yet.
