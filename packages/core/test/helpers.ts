import { sealWithEntropy } from "@qorechain/qoreseal/testing";
import type { Hex } from "viem";
import { fromHex, openRequest, requestAad, sealKeysFromSeed, utf8, REQUEST_PURPOSE } from "../src/index.js";

interface SealVector {
  keys: { sealSeed: Hex };
  request: { method: string; target: string; bodyUtf8: string };
  sealedRequest: { chainId: string; contentType: string; entropy: Hex; envelope: Hex };
}

/** Re-seals the vector's request with its fixed entropy, then opens the pinned envelope. */
export function openWithEntropyCheck(v: SealVector): { envelope: Uint8Array; plaintext: Uint8Array } {
  const keys = sealKeysFromSeed(fromHex(v.keys.sealSeed));
  const { method, target, bodyUtf8 } = v.request;
  const { chainId, contentType } = v.sealedRequest;
  const envelope = sealWithEntropy(
    {
      chainId,
      purpose: REQUEST_PURPOSE,
      mode: "mlkem",
      recipients: [{ mlkemPublicKey: keys.mlkemPublicKey }],
      plaintext: utf8(bodyUtf8),
      aad: requestAad(method, target, contentType),
    },
    fromHex(v.sealedRequest.entropy),
  );
  const plaintext = openRequest({
    chainId,
    keys,
    method,
    target,
    contentType,
    envelope: fromHex(v.sealedRequest.envelope),
  });
  return { envelope, plaintext };
}
