// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQorePQC} from "../interfaces/IQorePQC.sol";

/// @title PQCAuth
/// @notice Checks that an account signed a message with the ML-DSA-87 key registered for it.
/// @dev Fails closed on every path: a precompile that is missing or inactive answers with empty
///      data, which is reported as `PQCUnavailable`, never read as a valid result.
library PQCAuth {
    /// @dev Algorithm id `pqcKeyStatus` reports for ML-DSA-87.
    uint8 internal constant ML_DSA_87 = 1;
    uint256 internal constant ML_DSA_87_PUBLIC_KEY_LENGTH = 2592;
    uint256 internal constant ML_DSA_87_SIGNATURE_LENGTH = 4627;

    /// @dev ABI size of (bool, uint8, bytes, bool) with an empty `bytes`: four head words, a
    ///      length word.
    uint256 private constant MIN_KEY_STATUS_RETURN = 160;

    error PQCUnavailable(address precompile);
    error PQCKeyNotRegistered(address account);
    error PQCKeyUnsupported(address account);
    error PQCKeyNotProven(address account);
    error PQCSignatureInvalid(address account);

    /// @notice Revert unless both precompiles answer with well-formed results.
    function requireAvailable(address verifier, address keyStatus) internal view {
        (bool ok, bytes memory ret) =
            keyStatus.staticcall(abi.encodeCall(IQorePQC.pqcKeyStatus, (address(0))));
        if (!ok || ret.length < MIN_KEY_STATUS_RETURN) revert PQCUnavailable(keyStatus);

        (ok, ret) = verifier.staticcall(abi.encodeCall(IQorePQC.pqcVerify, ("", "", "")));
        if (!ok || ret.length != 32) revert PQCUnavailable(verifier);
    }

    /// @notice The account's ML-DSA-87 public key, which must be registered with a proven
    ///         possession.
    function provenKey(address keyStatus, address account)
        internal
        view
        returns (bytes memory pubkey)
    {
        (bool ok, bytes memory ret) =
            keyStatus.staticcall(abi.encodeCall(IQorePQC.pqcKeyStatus, (account)));
        if (!ok || ret.length < MIN_KEY_STATUS_RETURN) revert PQCUnavailable(keyStatus);

        bool registered;
        uint8 algorithmId;
        bool possessionProven;
        (registered, algorithmId, pubkey, possessionProven) =
            abi.decode(ret, (bool, uint8, bytes, bool));

        if (!registered) revert PQCKeyNotRegistered(account);
        if (algorithmId != ML_DSA_87 || pubkey.length != ML_DSA_87_PUBLIC_KEY_LENGTH) {
            revert PQCKeyUnsupported(account);
        }
        if (!possessionProven) revert PQCKeyNotProven(account);
    }

    /// @notice Revert unless `signature` is `account`'s ML-DSA-87 signature over `message`.
    /// @dev The key is read at call time, so a key rotated on chain is followed.
    function requireSignature(
        address verifier,
        address keyStatus,
        address account,
        bytes memory message,
        bytes calldata signature
    ) internal view {
        if (signature.length != ML_DSA_87_SIGNATURE_LENGTH) revert PQCSignatureInvalid(account);
        bytes memory pubkey = provenKey(keyStatus, account);

        (bool ok, bytes memory ret) =
            verifier.staticcall(abi.encodeCall(IQorePQC.pqcVerify, (pubkey, signature, message)));
        if (!ok || ret.length != 32) revert PQCUnavailable(verifier);
        if (!abi.decode(ret, (bool))) revert PQCSignatureInvalid(account);
    }
}
