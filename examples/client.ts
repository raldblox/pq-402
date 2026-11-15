/**
 * Pays the example endpoint end to end and opens the sealed answers.
 *
 *   pnpm example:client              local: in-memory key registry
 *   pnpm example:client --testnet    QoreChain testnet, from .env
 *
 * Start the server first (examples/server.ts) in the same mode.
 */
import { createPq402Fetch, type KeyDirectory } from "@pq-402/client";
import { MemoryChain, EvmChainReader, qorechainTestnet } from "@pq-402/scheme-qorechain";
import type { Hex } from "viem";
import { demo, testnetParties, type Party } from "./identities.js";
import { PORT } from "./server.js";

/**
 * Local mode: the keys the server's in-memory chain holds, rebuilt from the
 * public demo identities, and the Perennial position read from the server's
 * `/local-chain` view (on the testnet this is an `eth_call` to the vault).
 */
function localKeys(origin: string): KeyDirectory {
  const registry = new MemoryChain(demo.escrow);
  for (const party of [demo.gateway, demo.payer]) {
    registry.registerKey(party.address, party.mldsa.publicKey);
    registry.registerKemKey(party.address, party.seal.mlkemPublicKey);
  }
  return {
    keyStatus: (a) => registry.keyStatus(a),
    kemKey: (a) => registry.kemKey(a),
    perennialPosition: async (vault, id) => {
      const res = await fetch(`${origin}/local-chain/position/${vault}/${id}`);
      const p = (await res.json()) as Record<string, string | boolean>;
      return {
        beneficiary: p.beneficiary as Hex,
        nonce: BigInt(p.nonce as string),
        buffer: BigInt(p.buffer as string),
        pendingYield: 0n,
        closed: p.closed as boolean,
        succeeded: p.succeeded as boolean,
      };
    },
  };
}

export async function payOnce(
  origin: string,
  payer: Party,
  keys: KeyDirectory,
  log = console.log,
  positionId?: bigint,
) {
  const options = {
    payer: payer.address,
    mldsaSecretKey: payer.mldsa.secretKey,
    sealKeys: payer.seal,
    keys,
    chainId: qorechainTestnet.chainId,
    maxAmount: 20_000n, // never pay more than 0.02 fUSD per call
  };
  const pay = createPq402Fetch(options);

  const inferences: string[] = [];
  if (positionId !== undefined) {
    // The use case: an agent pays for each inference call from its Perennial position's yield.
    const agent = createPq402Fetch({ ...options, perennial: { positionId } });
    for (const n of [1, 2, 3]) {
      log(`POST ${origin}/v1/chat/completions (call ${n}, paid from Perennial position ${positionId})`);
      const res = await agent(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: `question ${n}` }] }),
      });
      const text = await res.text();
      inferences.push(text);
      log(`  ${res.status}: ${text}`);
      log(
        `  scheme ${res.payment?.requirements.scheme}, ${Number(res.payment?.requirements.amount) / 1e6} fUSD, tx ${res.payment?.settlement.transaction}`,
      );
    }
  }

  log(`GET ${origin}/paid/hello`);
  const hello = await pay(`${origin}/paid/hello`);
  const helloText = await hello.text();
  log(`  ${hello.status}: ${helloText}`);
  log(`  paid ${hello.payment?.requirements.amount} to ${hello.payment?.requirements.payTo}`);
  log(`  settlement ${hello.payment?.settlement.transaction}`);
  log(`  receipt signed by ${hello.payment?.receipt?.gateway}, verified against its on-chain key`);

  const question = JSON.stringify({ question: "Is this request readable on the wire?" });
  log(`POST ${origin}/paid/echo (body sealed with ML-KEM-1024)`);
  const echo = await pay(`${origin}/paid/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: question,
  });
  const echoText = await echo.text();
  log(`  ${echo.status}: ${echoText}`);
  log(`  request sealed: ${echo.payment?.requestSealed}, settlement ${echo.payment?.settlement.transaction}`);
  return { hello, helloText, echo, echoText, question, inferences };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/client.ts");
if (isMain) {
  const testnet = process.argv.includes("--testnet");
  const origin = process.argv.find((a) => a.startsWith("http")) ?? `http://127.0.0.1:${PORT}`;
  if (testnet) {
    const { payer } = await testnetParties();
    const position = process.env.PERENNIAL_POSITION?.trim();
    await payOnce(
      origin,
      payer,
      new EvmChainReader({ network: qorechainTestnet }),
      console.log,
      position ? BigInt(position) : undefined,
    );
  } else {
    await payOnce(origin, demo.payer, localKeys(origin), console.log, demo.positionId);
  }
}
