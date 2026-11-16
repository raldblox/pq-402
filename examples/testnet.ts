/**
 * Sets up and checks the two example accounts on the QoreChain testnet.
 *
 *   pnpm testnet keys                 write a new .env with two fresh mnemonics (never overwrites)
 *   pnpm testnet status               balances, keys, windows, escrow deposit
 *   pnpm testnet precompiles          free eth_calls: real ML-DSA-87 PQ-402 signatures against pqcVerify
 *   pnpm testnet deploy [--broadcast] deploy PQ402Escrow from the gateway account (dry run by default)
 *   pnpm testnet perennial-check <vault> [positionId]
 *                                     free eth_calls: the vault's ACTION_DOMAIN and actionMessage
 *                                     against PQ-402's own encoding; a position's budget fields
 *   pnpm testnet register <who>       register <who>'s ML-DSA-87 key with proof of possession
 *   pnpm testnet register-kem <who>   register <who>'s ML-KEM-1024 key (hybrid-signed)
 *   pnpm testnet window <who>         open an EVM window scoped to the escrow (and fUSD for the payer);
 *                                     for the gateway before ESCROW_ADDRESS is set, a one-transaction
 *                                     window for the deployment
 *   pnpm testnet deposit <fusd>       payer: approve and deposit fUSD into the escrow
 *   pnpm testnet e2e                  run the paid endpoint and pay it, settling on chain
 *
 * <who> is `gateway` or `payer`. Everything except `keys`, `status` and
 * `precompiles` sends transactions and needs QOR for fees. Secrets stay in the
 * git-ignored .env; this script never prints them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StargateClient } from "@cosmjs/stargate";
import { fromHex, mldsaSign, paymentMessage, requestHash, toHex, utf8, type Hex } from "@pq402/core";
import {
  EvmChainReader,
  erc20Abi,
  perennialVaultAbi,
  pq402EscrowAbi,
  pqcPrecompileAbi,
  qorechainTestnet,
  viemChainOf,
} from "@pq402/scheme-qorechain";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import { fetchMlkemPublicKey } from "@qorechain/qoreseal/network";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchPqcStatus,
  generateMnemonic,
  getNetwork,
  msg,
  openEvmWindowMsg,
  signProofOfPossession,
} from "@qorechain/sdk";
import { createPublicClient, createWalletClient, http, parseUnits, type PublicClient } from "viem";
import { payOnce } from "./client.js";
import { requireEnv, testnetParties, type Party } from "./identities.js";
import { startServer, testnetBackend } from "./server.js";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const net = getNetwork("testnet");
const REST = qorechainTestnet.rest;
const FUSD = qorechainTestnet.defaultAsset.address;
const chain = viemChainOf(qorechainTestnet);
const reader = createPublicClient({ chain, transport: http() }) as PublicClient;

async function keys(): Promise<void> {
  if (existsSync(ENV_PATH)) {
    console.log(".env already exists; not touching it. Delete it first to start over.");
  } else {
    const body = [
      "# Throwaway testnet accounts for the PQ-402 examples. Never reuse them; never commit this file.",
      `GATEWAY_MNEMONIC=${generateMnemonic(256)}`,
      `PAYER_MNEMONIC=${generateMnemonic(256)}`,
      "# Set after deploying the escrow (pnpm testnet deploy --broadcast).",
      "ESCROW_ADDRESS=",
      "",
    ].join("\n");
    writeFileSync(ENV_PATH, body, { mode: 0o600 });
    process.loadEnvFile(ENV_PATH);
    console.log(`wrote ${ENV_PATH}`);
  }
  const { gateway, payer } = await testnetParties();
  console.log(`gateway ${gateway.address}  ${gateway.qor}`);
  console.log(`payer   ${payer.address}  ${payer.qor}`);
}

async function uqorBalance(qor: string): Promise<bigint> {
  const res = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${qor}`);
  if (!res.ok) throw new Error(`balance query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { balances?: { denom: string; amount: string }[] };
  return BigInt(body.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
}

async function describe(name: string, party: Party): Promise<void> {
  console.log(`${name}: ${party.address}  (${party.qor})`);
  console.log(`  QOR:        ${Number(await uqorBalance(party.qor)) / 1e6}`);
  const fusd = await reader.readContract({
    address: FUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [party.address],
  });
  console.log(`  fUSD ERC-20: ${Number(fusd) / 1e6}`);
  const [registered, algorithmId, pubkey, proven] = await reader.readContract({
    address: "0x0000000000000000000000000000000000000a02",
    abi: pqcPrecompileAbi,
    functionName: "pqcKeyStatus",
    args: [party.address],
  });
  const ours = pubkey.toLowerCase() === toHex(party.mldsa.publicKey).toLowerCase();
  console.log(
    `  ML-DSA-87:  ${registered ? `registered (algorithm ${algorithmId}, possession ${proven ? "proven" : "NOT proven"}${ours ? "" : ", NOT this key"})` : "not registered"}`,
  );
  try {
    const kem = await fetchMlkemPublicKey({ rest: REST, address: party.qor });
    const match = toHex(kem) === toHex(party.seal.mlkemPublicKey);
    console.log(`  ML-KEM-1024: registered${match ? "" : ", NOT this key"}`);
  } catch {
    console.log("  ML-KEM-1024: not registered");
  }
  const w = await evmWindowStatus({ rest: REST, address: party.qor });
  console.log(
    `  EVM window: ${w.found ? `${w.live ? "live" : "not usable"}, ${w.remainingTxs} txs, ${w.remainingValue} uqor left` : "none"}`,
  );
  const escrow = process.env.ESCROW_ADDRESS?.trim();
  if (escrow) {
    const deposit = await reader.readContract({
      address: escrow as Hex,
      abi: pq402EscrowAbi,
      functionName: "balanceOf",
      args: [party.address],
    });
    console.log(`  escrowed:   ${Number(deposit) / 1e6} fUSD`);
  }
}

async function status(): Promise<void> {
  const { gateway, payer } = await testnetParties();
  console.log(`escrow: ${process.env.ESCROW_ADDRESS?.trim() || "(not deployed; ESCROW_ADDRESS is empty)"}`);
  await describe("gateway", gateway);
  await describe("payer", payer);
}

/**
 * Free checks against the real precompiles: a PQ-402 payment message, signed
 * with the payer's ML-DSA-87 key exactly as the client signs it, verified by
 * pqcVerify; and refused after one bit is flipped. No funds or registration
 * needed: pqcVerify takes the public key as an argument.
 */
async function precompiles(): Promise<void> {
  const { payer, gateway } = await testnetParties();
  const payment = {
    chainId: 9800n,
    escrow: (process.env.ESCROW_ADDRESS?.trim() || "0x1111111111111111111111111111111111111111") as Hex,
    payer: payer.address,
    payTo: gateway.address,
    asset: FUSD,
    amount: 10_000n,
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    validAfter: BigInt(Math.floor(Date.now() / 1000)),
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 120),
    requestHash: requestHash({ method: "GET", target: "/paid/hello", body: utf8("") }),
  };
  const message = paymentMessage(payment);
  const signature = mldsaSign(payer.mldsa.secretKey, message);
  const verify = (sig: Uint8Array, msgBytes = message) =>
    reader.readContract({
      address: "0x0000000000000000000000000000000000000a01",
      abi: pqcPrecompileAbi,
      functionName: "pqcVerify",
      args: [toHex(payer.mldsa.publicKey), toHex(sig), toHex(msgBytes)],
    });
  console.log(`pqcVerify(payment message, payer signature):        ${await verify(signature)}`);
  const flipped = signature.slice();
  flipped[0]! ^= 1;
  console.log(`pqcVerify(payment message, signature with bit flip): ${await verify(flipped)}`);
  const other = paymentMessage({ ...payment, amount: 10_001n });
  console.log(`pqcVerify(amount changed to 10001, same signature):  ${await verify(signature, other)}`);
  const vectors = await import("../packages/core/test/vectors/v1.json", { with: { type: "json" } });
  const v = vectors.default as { payment: { message: Hex; signature: Hex }; keys: { payerSeed: Hex } };
  const { mldsaKeyPair } = await import("@pq402/core");
  const vk = mldsaKeyPair(fromHex(v.keys.payerSeed));
  const kat = await reader.readContract({
    address: "0x0000000000000000000000000000000000000a01",
    abi: pqcPrecompileAbi,
    functionName: "pqcVerify",
    args: [toHex(vk.publicKey), v.payment.signature, v.payment.message],
  });
  console.log(`pqcVerify(known-answer vector v1.json):             ${kat}`);
  for (const [name, party] of [
    ["gateway", gateway],
    ["payer", payer],
  ] as const) {
    const s = await new EvmChainReader({ network: qorechainTestnet, publicClient: reader }).keyStatus(
      party.address,
    );
    console.log(
      `pqcKeyStatus(${name}): registered=${s.registered} algorithm=${s.algorithmId} proven=${s.possessionProven}`,
    );
  }
}

/** Runs contracts/script/Deploy.s.sol with this process's environment (which holds .env). */
async function deploy(flag?: string): Promise<void> {
  requireEnv("GATEWAY_MNEMONIC");
  const args = [
    "script",
    "script/Deploy.s.sol:Deploy",
    "--rpc-url",
    "qorechain_testnet",
    "--skip-simulation",
  ];
  if (flag === "--broadcast") args.push("--broadcast", "--slow");
  const contracts = fileURLToPath(new URL("../contracts", import.meta.url));
  const res = spawnSync("forge", args, { cwd: contracts, env: process.env, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`forge exited with ${res.status ?? res.error?.message}`);
  if (flag !== "--broadcast")
    console.log("Dry run only. Add --broadcast to deploy, then set ESCROW_ADDRESS in .env.");
}

/** Compares a live Perennial vault's signing bytes with PQ-402's local encoding. No transaction. */
async function perennialCheck(vaultArg?: string): Promise<void> {
  const vault = (vaultArg ?? process.env.PERENNIAL_VAULT?.trim()) as Hex | undefined;
  if (!vault || !/^0x[0-9a-fA-F]{40}$/.test(vault))
    throw new Error("usage: pnpm testnet perennial-check <vault> [positionId]");
  const { PERENNIAL_ACTION_DOMAIN, perennialSpendMessage } = await import("@pq402/core");
  const domain = await reader.readContract({
    address: vault,
    abi: perennialVaultAbi,
    functionName: "ACTION_DOMAIN",
  });
  console.log(
    `ACTION_DOMAIN ${domain} ${domain === PERENNIAL_ACTION_DOMAIN ? "== local" : "!= local " + PERENNIAL_ACTION_DOMAIN}`,
  );
  const asset = await reader.readContract({ address: vault, abi: perennialVaultAbi, functionName: "ASSET" });
  console.log(`ASSET ${asset}`);
  const spend = {
    chainId: 9800n,
    vault,
    positionId: 7n,
    nonce: 3n,
    deadline: 1_763_200_120n,
    to: "0x3333333333333333333333333333333333333333" as Hex,
    amount: 2_000n,
    ref: requestHash({ method: "POST", target: "/v1/chat/completions", body: utf8("{}") }),
  };
  const evm = new EvmChainReader({ network: qorechainTestnet, publicClient: reader });
  const theirs = toHex(await evm.perennialSpendMessage(spend));
  const ours = toHex(perennialSpendMessage(spend));
  console.log(
    `actionMessage(7, Spend, 3, ${spend.deadline}, paramsHash) ${theirs === ours ? "== local encoding" : "!= local encoding"} (${(theirs.length - 2) / 2} bytes)`,
  );
  const id = process.argv[4];
  if (id) {
    const pos = await evm.perennialPosition(vault, BigInt(id));
    console.log(
      `position ${id}: beneficiary ${pos.beneficiary}, nonce ${pos.nonce}, buffer ${pos.buffer}, pendingYield ${pos.pendingYield}, budgetMode ${pos.budgetMode}, budgetRemaining ${pos.budgetRemaining}, principal ${pos.principal}`,
    );
  }
  if (theirs !== ours || domain !== PERENNIAL_ACTION_DOMAIN) process.exitCode = 1;
}

async function nativeAccount(party: Party) {
  return deriveUnifiedAccount(party.mnemonic!, 0);
}

async function accountSequence(address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) throw new Error(`${address} does not exist on chain yet: send it some QOR first`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

async function broadcast(
  party: Party,
  mode: "hybrid" | "classical",
  messages: Parameters<EthNativeSigner["sign"]>[0]["messages"],
) {
  const acc = await nativeAccount(party);
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(net.endpoints.rpc);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: net.chainId,
      accountNumber,
      sequence,
      fee: FEE,
      messages,
    });
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

async function who(arg: string | undefined): Promise<Party> {
  const parties = await testnetParties();
  if (arg !== "gateway" && arg !== "payer") throw new Error("say which account: gateway or payer");
  return parties[arg];
}

async function register(arg?: string): Promise<void> {
  const party = await who(arg);
  const acc = await nativeAccount(party);
  const status = await fetchPqcStatus({ rest: REST, address: acc.cosmos });
  if (status.registered) {
    console.log(`${arg} already has an ML-DSA-87 key`);
    return;
  }
  const proofOfPossession = signProofOfPossession({
    chainId: net.chainId,
    account: acc.cosmos,
    keypair: acc.pqc,
  });
  const m = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
  console.log(`registered ML-DSA-87 key: ${await broadcast(party, "classical", [m])}`);
}

async function registerKem(arg?: string): Promise<void> {
  const party = await who(arg);
  const m = msg.pqc.registerKemKey({
    sender: party.qor,
    algorithmId: 2,
    publicKey: party.seal.mlkemPublicKey,
  });
  console.log(`registered ML-KEM-1024 key: ${await broadcast(party, "hybrid", [m])}`);
}

async function window(arg?: string): Promise<void> {
  const party = await who(arg);
  const escrow = process.env.ESCROW_ADDRESS?.trim();
  const perTx = evmWindowCost({ gas: 600_000n, maxFeePerGas: 250_000_000_000n });
  if (!escrow) {
    if (arg !== "gateway") throw new Error("deploy the escrow and set ESCROW_ADDRESS first");
    // A contract creation has no target to scope to: one transaction, sized for the deployment.
    const deployCost = evmWindowCost({ gas: 2_000_000n, maxFeePerGas: 250_000_000_000n });
    const m = openEvmWindowMsg({
      sender: party.qor,
      blocks: 300n,
      maxTxs: 1n,
      maxValue: deployCost,
      allowedTargets: [],
    });
    console.log(`opened a one-transaction deploy window: ${await broadcast(party, "hybrid", [m])}`);
    return;
  }
  const allowedTargets = arg === "payer" ? [escrow, FUSD] : [escrow];
  const maxTxs = 10n;
  const m = openEvmWindowMsg({
    sender: party.qor,
    blocks: 2_000n,
    maxTxs,
    maxValue: perTx * maxTxs,
    allowedTargets,
  });
  console.log(
    `opened window (${maxTxs} txs, scoped to ${allowedTargets.join(", ")}): ${await broadcast(party, "hybrid", [m])}`,
  );
}

async function deposit(amount?: string): Promise<void> {
  const { payer } = await testnetParties();
  const escrow = requireEnv("ESCROW_ADDRESS") as Hex;
  const value = parseUnits(amount ?? "1", 6);
  const wallet = createWalletClient({ account: payer.evm!, chain, transport: http() });
  for (const [label, request] of [
    [
      "approve",
      { address: FUSD, abi: erc20Abi, functionName: "approve", args: [escrow, value], gas: 80_000n },
    ],
    [
      "deposit",
      { address: escrow, abi: pq402EscrowAbi, functionName: "deposit", args: [value], gas: 150_000n },
    ],
  ] as const) {
    const hash = await wallet.writeContract(request as never);
    const receipt = await reader.waitForTransactionReceipt({ hash });
    console.log(`${label}: ${hash} (${receipt.status}, gas ${receipt.gasUsed})`);
    if (receipt.status !== "success") throw new Error(`${label} reverted`);
  }
}

async function e2e(): Promise<void> {
  const backend = await testnetBackend();
  const { payer } = await testnetParties();
  const { server, origin } = await startServer(backend, 0);
  try {
    await payOnce(origin, payer, new EvmChainReader({ network: qorechainTestnet, publicClient: reader }));
  } finally {
    server.close();
  }
}

const commands: Record<string, (arg?: string) => Promise<void>> = {
  keys,
  status,
  precompiles,
  "perennial-check": perennialCheck,
  deploy,
  register,
  "register-kem": registerKem,
  window,
  deposit,
  e2e,
};
const run = commands[process.argv[2] ?? "status"];
if (!run) {
  console.error(`unknown command; use one of: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
run(process.argv[3]).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
