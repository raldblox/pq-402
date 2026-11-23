/**
 * One complete PQ-402 run on the QoreChain testnet, recorded step by step.
 *
 *   pnpm demo
 *
 * A server charges 0.002 fUSD per call to POST /v1/chat/completions (a
 * stand-in model). A client pays twice with its ML-DSA-87 key: once from its
 * PQ402Escrow deposit (pq-erc20), once as a spend from its Perennial position
 * (pq-perennial). Each request body is sealed to the gateway's registered
 * ML-KEM-1024 key; each answer comes back sealed to the payer's, and the
 * client opens it after checking the gateway's signed receipt.
 *
 * Environment (.env, see .env.example): GATEWAY_MNEMONIC and PAYER_MNEMONIC,
 * or QORE_MNEMONIC alone to let one account play both roles; ESCROW_ADDRESS;
 * PERENNIAL_VAULT and PERENNIAL_POSITION (the payer must be the position's
 * beneficiary). Both accounts need registered ML-DSA-87 and ML-KEM-1024 keys
 * (pnpm testnet register / register-kem), the gateway some QOR for fees and
 * the payer fUSD as an ERC-20.
 *
 * Every EVM transaction runs inside an EVM window scoped to the escrow, the
 * vault and fUSD, closed at the end even on failure. Whatever is left in the
 * escrow is withdrawn at the end. The public transcript (no keys) is written to
 * site/run.json.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StargateClient } from "@cosmjs/stargate";
import { createPq402Fetch, type Pq402Response } from "@pq402/client";
import { ORIGINAL_CONTENT_TYPE_HEADER, mldsaSign, toHex, withdrawalMessage, type Hex } from "@pq402/core";
import {
  EvmChainReader,
  EvmSettler,
  erc20Abi,
  pq402EscrowAbi,
  qorechainTestnet,
  viemChainOf,
} from "@pq402/scheme-qorechain";
import { evmWindowCost } from "@qorechain/evm";
import { fetchMlkemPublicKey } from "@qorechain/qoreseal/network";
import {
  EthNativeSigner,
  closeEvmWindowMsg,
  deriveUnifiedAccount,
  getNetwork,
  openEvmWindowMsg,
} from "@qorechain/sdk";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { requireEnv, testnetParties, type Party } from "./identities.js";
import { startServer } from "./server.js";

const net = getNetwork("testnet");
const REST = qorechainTestnet.rest;
const FUSD = qorechainTestnet.defaultAsset.address;
const chain = viemChainOf(qorechainTestnet);
const reader = createPublicClient({ chain, transport: http() }) as PublicClient;
const evm = new EvmChainReader({ network: qorechainTestnet, publicClient: reader });

const MAX_FEE = 150_000_000_000n; // 150 gwei; the base fee read 100 gwei on 16 November
const PRIORITY_FEE = 1_000_000_000n;
const QOR_FLOOR = 3_000_000n; // uqor: stop rather than let an account drop below 3 QOR
const DEPOSIT = BigInt(process.env.DEMO_DEPOSIT ?? "10000"); // 0.01 fUSD into the escrow
// spend is the cap for both relayed calls; a spend that draws principal can exceed 350,000.
const GAS = { approve: 70_000n, deposit: 130_000n, spend: 600_000n, request: 350_000n, withdraw: 130_000n };

interface Step {
  title: string;
  detail: Record<string, unknown>;
}
const steps: Step[] = [];
const transactions: { what: string; hash: string; lane: "native" | "evm" }[] = [];
const record = (title: string, detail: Record<string, unknown>) => {
  steps.push({ title, detail });
  console.log(`\n## ${title}`);
  for (const [k, v] of Object.entries(detail))
    console.log(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const tx = (what: string, hash: string, lane: "native" | "evm") => {
  transactions.push({ what, hash, lane });
  console.log(`  tx ${what}: ${hash}`);
};

async function uqor(qor: string): Promise<bigint> {
  const res = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${qor}`);
  const body = (await res.json()) as { balances?: { denom: string; amount: string }[] };
  return BigInt(body.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
}

async function balances(party: Party) {
  const fusd = await reader.readContract({
    address: FUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [party.address],
  });
  return { qor: (Number(await uqor(party.qor)) / 1e6).toFixed(6), fusd: (Number(fusd) / 1e6).toFixed(6) };
}

/** Retries a call that failed on a transport error or a moved nonce (another sender on the same account). */
async function retrying<T>(label: string, f: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await f();
    } catch (err) {
      const m =
        err instanceof Error
          ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}`
          : String(err);
      if (attempt < 4 && /fetch failed|ECONNRESET|socket|other side closed|sequence|nonce too low/i.test(m)) {
        console.log(`  ${label}: retrying (${attempt}) after: ${m.split("\n")[0]?.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
}

async function broadcast(
  party: Party,
  messages: Parameters<EthNativeSigner["sign"]>[0]["messages"],
): Promise<string> {
  const acc = await deriveUnifiedAccount(party.mnemonic!, 0);
  return retrying("native transaction", async () => {
    const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${acc.cosmos}`);
    const body = (await res.json()) as { account?: Record<string, unknown> };
    const a = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
    const signer = new EthNativeSigner(acc, { signMode: "hybrid", rest: REST });
    const transport = await StargateClient.connect(net.endpoints.rpc);
    try {
      const out = await signer.signAndBroadcast(transport, {
        chainId: net.chainId,
        accountNumber: BigInt(a.account_number ?? "0"),
        sequence: BigInt(a.sequence ?? "0"),
        fee: { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" },
        messages,
      });
      return out.transactionHash;
    } finally {
      transport.disconnect();
    }
  });
}

/** A fetch that keeps what crossed the wire, for the transcript. */
function recordingFetch(
  log: {
    headers: Record<string, string>;
    body: Uint8Array;
    status?: number;
    resHeaders?: Record<string, string>;
    resBody?: Uint8Array;
  }[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const entry: (typeof log)[number] = {
      headers,
      body: init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array(),
    };
    log.push(entry);
    const res = await fetch(input, init);
    const resBody = new Uint8Array(await res.arrayBuffer());
    entry.status = res.status;
    entry.resHeaders = {};
    res.headers.forEach((v, k) => (entry.resHeaders![k] = v));
    entry.resBody = resBody;
    return new Response(res.status === 204 ? null : resBody, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

const hexPreview = (b: Uint8Array, n = 48) => `${toHex(b.slice(0, n))}… (${b.length} bytes)`;

async function paidCall(label: string, origin: string, payer: Party, perennial: bigint | undefined) {
  const wire: Parameters<typeof recordingFetch>[0] = [];
  const pay = createPq402Fetch({
    payer: payer.address,
    mldsaSecretKey: payer.mldsa.secretKey,
    sealKeys: payer.seal,
    keys: evm,
    chainId: qorechainTestnet.chainId,
    maxAmount: 5_000n,
    fetch: recordingFetch(wire),
    ...(perennial !== undefined ? { perennial: { positionId: perennial } } : {}),
  });
  const question = `What is 6 x 7? (${label})`;
  const body = JSON.stringify({ model: "stand-in", messages: [{ role: "user", content: question }] });
  const res: Pq402Response = await retrying(label, () =>
    pay(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  const answer = await res.text();

  const probe = wire[0]!;
  const offer = decodePaymentRequiredHeader(probe.resHeaders!["payment-required"]!);
  const paid = wire[wire.length - 1]!;
  const payload = decodePaymentSignatureHeader(paid.headers["payment-signature"]!);
  const p = payload.payload as Record<string, string>;
  record(`${label}: 402 offer`, {
    status: probe.status,
    accepts: offer.accepts.map(
      (a) => `${a.scheme} ${Number(a.amount) / 1e6} fUSD to ${a.payTo} via ${JSON.stringify(a.extra)}`,
    ),
    sealing: offer.extensions?.["pq402-sealing"],
  });
  record(`${label}: signed payment`, {
    scheme: payload.accepted.scheme,
    payer: p.payer,
    requestHash: p.requestHash ?? p.ref,
    ...(p.positionId
      ? { positionId: p.positionId, nonce: p.nonce, deadline: p.deadline }
      : { nonce: p.nonce, validBefore: p.validBefore }),
    signature: `ML-DSA-87, ${Buffer.from(p.signature!, "base64").length} bytes, ${Buffer.from(p.signature!, "base64").subarray(0, 24).toString("hex")}…`,
    "PAYMENT-SIGNATURE header": `${paid.headers["payment-signature"]!.length} bytes`,
  });
  record(`${label}: sealed request`, {
    "content-type": paid.headers["content-type"],
    [ORIGINAL_CONTENT_TYPE_HEADER]: paid.headers[ORIGINAL_CONTENT_TYPE_HEADER.toLowerCase()],
    plaintext: body,
    "on the wire (QoreSeal envelope, ML-KEM-1024)": hexPreview(paid.body),
    "plaintext visible on the wire": Buffer.from(paid.body).includes(Buffer.from(question)),
  });
  const settle = res.payment?.settlement;
  tx(`${label} settlement (${payload.accepted.scheme})`, settle?.transaction ?? "", "evm");
  record(`${label}: settlement`, {
    transaction: settle?.transaction,
    network: settle?.network,
    amount: settle?.amount,
  });
  record(`${label}: sealed answer and receipt`, {
    status: res.status,
    "on the wire": hexPreview(paid.resBody!),
    receipt: res.payment?.receipt,
    "receipt checked against": "the gateway's ML-DSA-87 key read from pqcKeyStatus",
  });
  record(`${label}: opened answer`, { "content-type": res.headers.get("content-type"), answer });
  return settle?.transaction;
}

async function main() {
  const { gateway, payer } = await testnetParties();
  const same = gateway.address === payer.address;
  const escrow = requireEnv("ESCROW_ADDRESS") as Hex;
  const vault = requireEnv("PERENNIAL_VAULT") as Hex;
  const positionId = BigInt(requireEnv("PERENNIAL_POSITION"));

  const before = { gateway: await balances(gateway), payer: await balances(payer) };
  record("accounts", {
    gateway: `${gateway.address} (${gateway.qor})`,
    payer: `${payer.address} (${payer.qor})${same ? ", the same account" : ""}`,
    balancesBefore: before,
  });
  for (const [name, party] of [
    ["gateway", gateway],
    ["payer", payer],
  ] as const) {
    const key = await evm.keyStatus(party.address);
    const kem = await fetchMlkemPublicKey({ rest: REST, address: party.qor });
    if (!key.registered || !key.possessionProven) throw new Error(`${name} has no proven ML-DSA-87 key`);
    if (toHex(kem) !== toHex(party.seal.mlkemPublicKey))
      throw new Error(`${name}'s registered KEM key is not this phrase's`);
  }
  const position = await evm.perennialPosition(vault, positionId);
  if (position.beneficiary.toLowerCase() !== payer.address.toLowerCase())
    throw new Error("the payer is not the position's beneficiary");
  record("keys and position", {
    "ML-DSA-87 (pqcKeyStatus)": "registered, possession proven, for both accounts",
    "ML-KEM-1024 (KEM key registry)": "registered for both accounts",
    perennialPosition: {
      vault,
      positionId: positionId.toString(),
      budgetMode: position.budgetMode,
      buffer: position.buffer.toString(),
      pendingYield: position.pendingYield.toString(),
      budgetRemaining: position.budgetRemaining.toString(),
    },
  });

  // The relayer sends settle and spend with one gas limit (GAS.spend), so count it twice.
  const totalGas = GAS.approve + GAS.deposit + 2n * GAS.spend + GAS.request + GAS.withdraw;
  const maxValue = evmWindowCost({ gas: totalGas, maxFeePerGas: MAX_FEE });
  for (const party of same ? [gateway] : [gateway, payer]) {
    const have = await uqor(party.qor);
    if (have - maxValue - 300_000n < QOR_FLOOR)
      throw new Error(`stopping: ${party.address} would drop below 3 QOR`);
  }

  // One window per account, scoped to the escrow, the vault and fUSD; contract creation is refused.
  const targets = same ? [escrow, vault, FUSD] : null;
  const windows: Party[] = [];
  const open = async (party: Party, allowedTargets: string[], maxTxs: bigint) => {
    const hash = await broadcast(party, [
      openEvmWindowMsg({ sender: party.qor, blocks: 600n, maxTxs, maxValue, allowedTargets }),
    ]);
    windows.push(party);
    tx(
      `open EVM window for ${party.address} (${maxTxs} txs, scoped to ${allowedTargets.join(", ")})`,
      hash,
      "native",
    );
  };
  try {
    if (targets) await open(gateway, targets, 6n);
    else {
      await open(payer, [escrow, FUSD], 4n);
      await open(gateway, [escrow, vault], 2n);
    }

    const payerWallet = createWalletClient({ account: payer.evm!, chain, transport: http() });
    const send = async (what: string, req: Record<string, unknown>) => {
      const hash = await retrying(what, () =>
        payerWallet.writeContract({
          ...req,
          maxFeePerGas: MAX_FEE,
          maxPriorityFeePerGas: PRIORITY_FEE,
        } as never),
      );
      const receipt = await retrying(what, () => reader.waitForTransactionReceipt({ hash }));
      if (receipt.status !== "success") throw new Error(`${what} reverted: ${hash}`);
      tx(what, hash, "evm");
    };

    const escrowed = await reader.readContract({
      address: escrow,
      abi: pq402EscrowAbi,
      functionName: "balanceOf",
      args: [payer.address],
    });
    if (escrowed < 2_000n) {
      await send(`approve exactly ${DEPOSIT} fUSD units to the escrow`, {
        address: FUSD,
        abi: erc20Abi,
        functionName: "approve",
        args: [escrow, DEPOSIT],
        gas: GAS.approve,
      });
      await send(`deposit ${DEPOSIT} fUSD units into the escrow`, {
        address: escrow,
        abi: pq402EscrowAbi,
        functionName: "deposit",
        args: [DEPOSIT],
        gas: GAS.deposit,
      });
    }

    const gatewayWallet = createWalletClient({ account: gateway.evm!, chain, transport: http() });
    const settler = new EvmSettler({
      publicClient: reader,
      walletClient: gatewayWallet,
      // Each call is estimated; GAS.spend caps it, and the window is sized for that cap.
      maxGas: GAS.spend,
      maxFeePerGas: MAX_FEE,
      maxPriorityFeePerGas: PRIORITY_FEE,
    });
    const { server, origin } = await startServer({ chain: evm, settler, gateway, escrow, vault }, 0);
    try {
      await paidCall("call 1, paid from the escrow", origin, payer, undefined);
      await paidCall("call 2, paid from an on-chain agent budget", origin, payer, positionId);
    } finally {
      server.close();
    }

    // Return what is left in the escrow: an ML-DSA-87 signed request, the delay, the payout.
    const left = await reader.readContract({
      address: escrow,
      abi: pq402EscrowAbi,
      functionName: "balanceOf",
      args: [payer.address],
    });
    if (left > 0n) {
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const deadline = (await reader.getBlock()).timestamp + 600n;
      const sig = mldsaSign(
        payer.mldsa.secretKey,
        withdrawalMessage({ chainId: 9800n, escrow, payer: payer.address, amount: left, nonce, deadline }),
      );
      await send(`request withdrawal of ${left} fUSD units (ML-DSA-87 signed)`, {
        address: escrow,
        abi: pq402EscrowAbi,
        functionName: "requestWithdrawal",
        args: [payer.address, left, nonce, deadline, toHex(sig)],
        gas: GAS.request,
      });
      const delay = await reader.readContract({
        address: escrow,
        abi: pq402EscrowAbi,
        functionName: "WITHDRAWAL_DELAY",
      });
      console.log(`  waiting ${delay} s for the withdrawal delay`);
      await new Promise((r) => setTimeout(r, (Number(delay) + 15) * 1000));
      await send(`withdraw ${left} fUSD units back to the payer`, {
        address: escrow,
        abi: pq402EscrowAbi,
        functionName: "withdraw",
        args: [payer.address],
        gas: GAS.withdraw,
      });
    }
  } finally {
    for (const party of windows) {
      tx(
        `close EVM window for ${party.address}`,
        await broadcast(party, [closeEvmWindowMsg(party.qor)]),
        "native",
      );
    }
    const after = { gateway: await balances(gateway), payer: await balances(payer) };
    record("balances after", after);
    const out = fileURLToPath(new URL("../site/run.json", import.meta.url));
    writeFileSync(
      out,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), network: "qorechain-diana (EVM 9800)", escrow: process.env.ESCROW_ADDRESS, vault: process.env.PERENNIAL_VAULT, steps, transactions }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
    );
    console.log(`\ntranscript written to ${out}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message.split("\n").slice(0, 6).join("\n") : String(err));
  process.exitCode = 1;
});
