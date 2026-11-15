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
import { demo, testnetParties, type Party } from "./identities.js";
import { PORT } from "./server.js";

/** Local mode: the registry the server's in-memory chain holds, rebuilt from the public demo identities. */
function localKeys(): KeyDirectory {
  const registry = new MemoryChain(demo.escrow);
  for (const party of [demo.gateway, demo.payer]) {
    registry.registerKey(party.address, party.mldsa.publicKey);
    registry.registerKemKey(party.address, party.seal.mlkemPublicKey);
  }
  return registry;
}

export async function payOnce(origin: string, payer: Party, keys: KeyDirectory, log = console.log) {
  const pay = createPq402Fetch({
    payer: payer.address,
    mldsaSecretKey: payer.mldsa.secretKey,
    sealKeys: payer.seal,
    keys,
    chainId: qorechainTestnet.chainId,
    maxAmount: 20_000n, // never pay more than 0.02 fUSD per call
  });

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
  return { hello, helloText, echo, echoText, question };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/client.ts");
if (isMain) {
  const testnet = process.argv.includes("--testnet");
  const origin = process.argv.find((a) => a.startsWith("http")) ?? `http://127.0.0.1:${PORT}`;
  if (testnet) {
    const { payer } = await testnetParties();
    await payOnce(origin, payer, new EvmChainReader({ network: qorechainTestnet }));
  } else {
    await payOnce(origin, demo.payer, localKeys());
  }
}
