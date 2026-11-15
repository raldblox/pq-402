/**
 * A paid PQ-402 endpoint on node:http.
 *
 *   pnpm example:server              local: in-memory chain
 *   pnpm example:server --testnet    QoreChain testnet, from .env
 *
 * Routes:
 *   POST /v1/chat/completions  0.002 fUSD per call, sealed both ways. A stand-in
 *                              model: it answers with a fixed sentence, no LLM.
 *   GET  /paid/hello           $0.01, answers a greeting
 *   POST /paid/echo            $0.01, request body must be sealed, echoes it back
 *   GET  /health               free
 *
 * Payments are accepted from a Perennial position (pq-perennial) when the
 * backend has a vault, and from the escrow (pq-erc20).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EvmChainReader,
  EvmSettler,
  MemoryChain,
  PqErc20Facilitator,
  PqPerennialFacilitator,
  qorechainTestnet,
  viemChainOf,
  type ChainReader,
  type Settler,
} from "@pq-402/scheme-qorechain";
import { nodeListener, PaymentGate, type Handler } from "@pq-402/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { demo, requireEnv, testnetParties, type Party } from "./identities.js";

export const PORT = Number(process.env.PORT ?? 4021);

/** Local mode only: read-only view of the in-memory chain, standing in for an RPC node. */
function localChainView(memory: MemoryChain): Handler {
  return async (req) => {
    const m = /^\/local-chain\/position\/(0x[0-9a-fA-F]{40})\/([0-9]+)$/.exec(req.target);
    if (!m) return handler(req);
    const pos = await memory.perennialPosition(m[1] as Hex, BigInt(m[2]!));
    const body = JSON.stringify({
      ...pos,
      nonce: pos.nonce.toString(),
      buffer: pos.buffer.toString(),
      pendingYield: "0",
    });
    return { status: 200, contentType: "application/json", body: new TextEncoder().encode(body) };
  };
}

const handler: Handler = async (req) => {
  const text = (s: string) => ({ status: 200, contentType: "text/plain", body: new TextEncoder().encode(s) });
  const path = req.target.split("?")[0];
  if (path === "/health") return text("ok");
  if (path === "/v1/chat/completions") {
    // Stand-in for a model: the point here is the payment and the sealing, not the answer.
    const prompt = new TextDecoder().decode(req.body);
    const answer = {
      model: "stand-in",
      choices: [
        { message: { role: "assistant", content: `(${prompt.length} characters received, sealed)` } },
      ],
    };
    return {
      status: 200,
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify(answer)),
    };
  }
  if (path === "/paid/hello") return text(`hello ${req.payer}, this answer was paid for and sealed to you`);
  if (path === "/paid/echo") {
    return { status: 200, contentType: req.contentType ?? "application/octet-stream", body: req.body };
  }
  return { status: 404, contentType: "text/plain", body: new TextEncoder().encode("not found") };
};

export interface Backend {
  chain: ChainReader;
  settler: Settler;
  gateway: Party;
  escrow?: Hex;
  vault?: Hex;
}

/** The in-memory chain with the demo parties registered and the payer's escrow funded. */
export function localBackend(): Backend & { memory: MemoryChain } {
  const memory = new MemoryChain(demo.escrow);
  for (const party of [demo.gateway, demo.payer]) {
    memory.registerKey(party.address, party.mldsa.publicKey);
    memory.registerKemKey(party.address, party.seal.mlkemPublicKey);
  }
  memory.deposit(demo.payer.address, 5_000_000n); // 5 fUSD in the escrow
  // The agent's Perennial position, with 0.01 fUSD of yield already in its buffer: five calls.
  memory.openPosition(demo.vault, demo.positionId, demo.payer.address, 10_000n);
  return {
    chain: memory,
    memory,
    settler: memory.settler(demo.gateway.address),
    gateway: demo.gateway,
    escrow: demo.escrow,
    vault: demo.vault,
  };
}

export async function testnetBackend(): Promise<Backend> {
  const { gateway } = await testnetParties();
  const chain = viemChainOf(qorechainTestnet);
  const publicClient = createPublicClient({ chain, transport: http() }) as PublicClient;
  const walletClient = createWalletClient({ account: gateway.evm!, chain, transport: http() });
  return {
    chain: new EvmChainReader({ network: qorechainTestnet, publicClient }),
    settler: new EvmSettler({ publicClient, walletClient }),
    gateway,
    escrow: requireEnv("ESCROW_ADDRESS") as Hex,
    ...(process.env.PERENNIAL_VAULT?.trim() ? { vault: process.env.PERENNIAL_VAULT.trim() as Hex } : {}),
  };
}

export async function startServer(
  backend: Backend,
  port = PORT,
): Promise<{ server: Server; origin: string }> {
  const networks = [qorechainTestnet.network];
  const { chain: reader, settler } = backend;
  const facilitator = new x402Facilitator()
    .register(qorechainTestnet.network, new PqErc20Facilitator({ networks, reader, settler }))
    .register(qorechainTestnet.network, new PqPerennialFacilitator({ networks, reader, settler }));
  const gate = new PaymentGate({
    network: qorechainTestnet,
    ...(backend.escrow ? { escrow: backend.escrow } : {}),
    ...(backend.vault ? { vault: backend.vault } : {}),
    facilitator,
    kemKeys: backend.chain,
    gateway: {
      address: backend.gateway.address,
      mldsaSecretKey: backend.gateway.mldsa.secretKey,
      sealKeys: backend.gateway.seal,
    },
    routes: {
      "POST /v1/chat/completions": {
        price: "0.002 fUSD",
        payTo: backend.gateway.address,
        description: "One inference call",
        requestSealing: "required",
      },
      "GET /paid/hello": {
        price: "$0.01",
        payTo: backend.gateway.address,
        description: "A paid, sealed greeting",
      },
      "POST /paid/echo": { price: "$0.01", payTo: backend.gateway.address, requestSealing: "required" },
    },
  });
  const memory = (backend as Partial<{ memory: MemoryChain }>).memory;
  const server = createServer(nodeListener(gate, memory ? localChainView(memory) : handler));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/server.ts");
if (isMain) {
  const testnet = process.argv.includes("--testnet");
  const backend = testnet ? await testnetBackend() : localBackend();
  const { origin } = await startServer(backend);
  console.log(`PQ-402 ${testnet ? "testnet" : "local"} endpoint on ${origin}`);
  console.log(`  gateway ${backend.gateway.address}`);
  console.log(`  escrow ${backend.escrow ?? "-"}, Perennial vault ${backend.vault ?? "-"}`);
  console.log("  POST /v1/chat/completions costs 0.002 fUSD; GET /paid/hello and POST /paid/echo cost $0.01");
}
