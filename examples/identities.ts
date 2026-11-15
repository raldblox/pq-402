/**
 * The two parties of the examples: a gateway (serves the paid endpoint,
 * relays settlements, signs receipts) and a payer.
 *
 * Testnet mode derives them from GATEWAY_MNEMONIC and PAYER_MNEMONIC in the
 * repository's git-ignored .env (create it with `pnpm testnet keys`).
 *
 * Local mode derives them from fixed public labels. Those keys exist only
 * inside the in-memory chain of the examples; they are not secrets and must
 * never hold anything.
 */
import { mldsaKeyPair, sealKeysFromSeed, type Hex, type MlDsaKeyPair, type SealKeyPair } from "@pq-402/core";
import { deriveSealKeys } from "@qorechain/qoreseal";
import { deriveUnifiedAccount, evmToQor } from "@qorechain/sdk";
import { sha256 } from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

export interface Party {
  /** EVM address (`0x`), the same 20 bytes as `qor`. */
  address: Hex;
  qor: string;
  mldsa: MlDsaKeyPair;
  seal: SealKeyPair;
  /** Signs EVM transactions; testnet mode only. */
  evm?: HDAccount;
  mnemonic?: string;
}

const label = (text: string) => sha256(new TextEncoder().encode(text), "bytes");

function demoParty(name: string, address: Hex): Party {
  return {
    address,
    qor: evmToQor(address),
    mldsa: mldsaKeyPair(label(`pq-402 local demo ${name} ml-dsa`)),
    seal: sealKeysFromSeed(label(`pq-402 local demo ${name} ml-kem`)),
  };
}

/** Local-mode parties, identical in every process. */
export const demo = {
  gateway: demoParty("gateway", "0x00000000000000000000000000000000000000a1"),
  payer: demoParty("payer", "0x00000000000000000000000000000000000000b2"),
  escrow: "0x00000000000000000000000000000000000000e5" as Hex,
  vault: "0x00000000000000000000000000000000000000f6" as Hex,
  positionId: 1n,
};

/** A party from a BIP-39 phrase: EVM account m/44'/60'/0'/0/0, its ML-DSA-87 key, QoreSeal keys. */
export async function partyFromMnemonic(mnemonic: string): Promise<Party> {
  const unified = await deriveUnifiedAccount(mnemonic, 0);
  const evm = mnemonicToAccount(mnemonic);
  if (evm.address.toLowerCase() !== unified.evm.toLowerCase()) {
    throw new Error("EVM account and unified account disagree");
  }
  return {
    address: evm.address,
    qor: unified.cosmos,
    mldsa: { publicKey: unified.pqc.publicKey, secretKey: unified.pqc.secretKey },
    seal: deriveSealKeys({ mnemonic }),
    evm,
    mnemonic,
  };
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set: run \`pnpm testnet keys\` and see .env.example`);
  return value;
}

export async function testnetParties(): Promise<{ gateway: Party; payer: Party }> {
  return {
    gateway: await partyFromMnemonic(requireEnv("GATEWAY_MNEMONIC")),
    payer: await partyFromMnemonic(requireEnv("PAYER_MNEMONIC")),
  };
}
