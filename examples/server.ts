/**
 * A paid PQ-402 endpoint on node:http.
 *
 *   pnpm example:server              local: in-memory chain
 *   pnpm example:server --testnet    QoreChain testnet, from .env
 *
 * Routes:
 *   GET  /paid/hello   $0.01, answers a greeting
 *   POST /paid/echo    $0.01, request body must be sealed, echoes it back
 *   GET  /health       free
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EvmChainReader,
  EvmSettler,
  MemoryChain,
  PqEscrowFacilitator,
  qorechainTestnet,
  viemChainOf,
  type ChainReader,
  type Settler,
} from "@pq-402/scheme-qorechain";
import { nodeListener, PaymentGate, type Handler } from "@pq-402/server";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { demo, requireEnv, testnetParties, type Party } from "./identities.js";

export const PORT = Number(process.env.PORT ?? 4021);

const handler: Handler = async (req) => {
  const text = (s: string) => ({ status: 200, contentType: "text/plain", body: new TextEncoder().encode(s) });
  const path = req.target.split("?")[0];
  if (path === "/health") return text("ok");
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
  escrow: Hex;
}

/** The in-memory chain with the demo parties registered and the payer's escrow funded. */
export function localBackend(): Backend & { memory: MemoryChain } {
  const memory = new MemoryChain(demo.escrow);
  for (const party of [demo.gateway, demo.payer]) {
    memory.registerKey(party.address, party.mldsa.publicKey);
    memory.registerKemKey(party.address, party.seal.mlkemPublicKey);
  }
  memory.deposit(demo.payer.address, 5_000_000n); // 5 fUSD
  return {
    chain: memory,
    memory,
    settler: memory.settler(demo.gateway.address),
    gateway: demo.gateway,
    escrow: demo.escrow,
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
  };
}

export async function startServer(
  backend: Backend,
  port = PORT,
): Promise<{ server: Server; origin: string }> {
  const gate = new PaymentGate({
    network: qorechainTestnet,
    escrow: backend.escrow,
    facilitator: new PqEscrowFacilitator({
      networks: [qorechainTestnet.network],
      reader: backend.chain,
      settler: backend.settler,
    }),
    kemKeys: backend.chain,
    gateway: {
      address: backend.gateway.address,
      mldsaSecretKey: backend.gateway.mldsa.secretKey,
      sealKeys: backend.gateway.seal,
    },
    routes: {
      "GET /paid/hello": {
        price: "$0.01",
        payTo: backend.gateway.address,
        description: "A paid, sealed greeting",
      },
      "POST /paid/echo": { price: "$0.01", payTo: backend.gateway.address, requestSealing: "required" },
    },
  });
  const server = createServer(nodeListener(gate, handler));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/server.ts");
if (isMain) {
  const testnet = process.argv.includes("--testnet");
  const backend = testnet ? await testnetBackend() : localBackend();
  const { origin } = await startServer(backend);
  console.log(`PQ-402 ${testnet ? "testnet" : "local"} endpoint on ${origin}`);
  console.log(`  gateway ${backend.gateway.address}, escrow ${backend.escrow}`);
  console.log("  GET /paid/hello and POST /paid/echo cost $0.01 each");
}
