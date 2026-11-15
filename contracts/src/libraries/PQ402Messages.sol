// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PQ402Messages
/// @notice The exact bytes a payer signs with ML-DSA-87 (docs/spec.md, section 5).
/// @dev Each message is `abi.encode` of fixed-size words, the first being a domain tag that names
///      the protocol version and the message kind. The TypeScript package (packages/core) builds
///      the same bytes; the known-answer vectors in packages/core/test/vectors pin both.
library PQ402Messages {
    bytes32 internal constant PAYMENT_DOMAIN = keccak256("PQ-402/v1 payment");
    bytes32 internal constant WITHDRAWAL_DOMAIN = keccak256("PQ-402/v1 withdrawal");

    /// @notice One payment from a payer's escrow balance to a payee.
    struct Payment {
        address payer;
        address payTo;
        uint256 amount;
        bytes32 nonce;
        uint64 validAfter;
        uint64 validBefore;
        bytes32 requestHash;
    }

    function payment(uint256 chainId, address escrow, address asset, Payment memory p)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            PAYMENT_DOMAIN,
            chainId,
            escrow,
            p.payer,
            p.payTo,
            asset,
            p.amount,
            p.nonce,
            p.validAfter,
            p.validBefore,
            p.requestHash
        );
    }

    function withdrawal(
        uint256 chainId,
        address escrow,
        address payer,
        uint256 amount,
        bytes32 nonce,
        uint64 deadline
    ) internal pure returns (bytes memory) {
        return abi.encode(WITHDRAWAL_DOMAIN, chainId, escrow, payer, amount, nonce, deadline);
    }
}
