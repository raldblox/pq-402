// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IQorePQC
/// @notice The QoreChain post-quantum precompiles, as documented at
///         https://docs.qorechain.io/developer-guide/evm-precompiles
/// @dev `pqcVerify` lives at 0x…0A01 and `pqcKeyStatus` at 0x…0A02. On a chain where they are
///      not active a call returns success with empty data, so never trust a call that does not
///      return the full ABI-encoded result.
interface IQorePQC {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool);

    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}
