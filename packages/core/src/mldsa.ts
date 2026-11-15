import { mldsa87 } from "@qorechain/pqc";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SECRET_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH,
} from "./constants.js";

export interface MlDsaKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * An ML-DSA-87 key pair. With a 32-byte `seed` the pair is deterministic
 * (FIPS 204 ML-DSA.KeyGen_internal); without one it is random.
 */
export function mldsaKeyPair(seed?: Uint8Array): MlDsaKeyPair {
  if (seed !== undefined && seed.length !== 32) throw new RangeError("seed must be 32 bytes");
  return mldsa87.keygen(seed);
}

/** ML-DSA-87 signature over raw `message` bytes, deterministic, empty context (ADR 002). */
export function mldsaSign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  if (secretKey.length !== ML_DSA_87_SECRET_KEY_LENGTH) throw new RangeError("not an ML-DSA-87 secret key");
  return mldsa87.sign(secretKey, message);
}

/** Never throws: a malformed key or signature is `false`. */
export function mldsaVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== ML_DSA_87_PUBLIC_KEY_LENGTH) return false;
  if (signature.length !== ML_DSA_87_SIGNATURE_LENGTH) return false;
  return mldsa87.verify(publicKey, message, signature);
}
