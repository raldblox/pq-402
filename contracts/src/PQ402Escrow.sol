// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PQCAuth} from "./libraries/PQCAuth.sol";
import {PQ402Messages} from "./libraries/PQ402Messages.sol";

/// @title PQ402Escrow
/// @notice Holds payers' deposits of one ERC-20 and pays them out on ML-DSA-87 signed payments.
/// @dev Settlement of the PQ-402 `pq-erc20` scheme (docs/spec.md, section 7). A payment is valid
///      only with a signature by the payer's ML-DSA-87 key as `pqcKeyStatus` reports it, checked
///      with `pqcVerify`. Anyone may submit it; funds go only to the payee the payer signed.
///      Withdrawals need an ML-DSA-87 signature too and wait `WITHDRAWAL_DELAY`, so that a payment
///      a server has already verified cannot be pre-empted. No owner, no pause, no upgrade.
contract PQ402Escrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct PendingWithdrawal {
        uint256 amount;
        uint64 readyAt;
    }

    /// @notice The token this escrow holds.
    IERC20 public immutable ASSET;
    /// @notice The `pqcVerify` precompile.
    address public immutable PQC_VERIFY;
    /// @notice The `pqcKeyStatus` precompile.
    address public immutable PQC_KEY_STATUS;
    /// @notice Seconds between a withdrawal request and the moment it can be paid out.
    uint64 public immutable WITHDRAWAL_DELAY;

    /// @notice Escrowed amount per payer.
    mapping(address payer => uint256) public balanceOf;
    /// @notice Nonces already consumed per payer, by payments and withdrawal requests alike.
    mapping(address payer => mapping(bytes32 nonce => bool)) public nonceUsed;
    /// @notice The open withdrawal request of a payer, if any.
    mapping(address payer => PendingWithdrawal) public pendingWithdrawal;

    event Deposited(address indexed payer, address indexed from, uint256 amount);
    event Settled(
        address indexed payer,
        address indexed payTo,
        bytes32 indexed nonce,
        uint256 amount,
        bytes32 requestHash
    );
    event WithdrawalRequested(
        address indexed payer, bytes32 indexed nonce, uint256 amount, uint64 readyAt
    );
    event Withdrawn(address indexed payer, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidPayee(address payTo);
    error NonceAlreadyUsed(address payer, bytes32 nonce);
    error NotYetValid(uint64 validAfter);
    error Expired(uint64 validBefore);
    error InsufficientBalance(uint256 available, uint256 required);
    error FeeOnTransfer(uint256 expected, uint256 received);
    error NoPendingWithdrawal(address payer);
    error WithdrawalNotReady(uint64 readyAt);

    /// @param asset The ERC-20 to hold. Tokens that deliver less than the amount sent are refused.
    /// @param pqcVerify Address of the `pqcVerify` precompile (0x…0A01 on QoreChain).
    /// @param pqcKeyStatus Address of the `pqcKeyStatus` precompile (0x…0A02 on QoreChain).
    /// @param withdrawalDelay Seconds a withdrawal waits after it is requested.
    constructor(IERC20 asset, address pqcVerify, address pqcKeyStatus, uint64 withdrawalDelay) {
        if (address(asset) == address(0)) revert ZeroAddress();
        // An escrow on a chain without these precompiles could never settle anything.
        PQCAuth.requireAvailable(pqcVerify, pqcKeyStatus);
        ASSET = asset;
        PQC_VERIFY = pqcVerify;
        PQC_KEY_STATUS = pqcKeyStatus;
        WITHDRAWAL_DELAY = withdrawalDelay;
    }

    // ---------------------------------------------------------------- deposits

    /// @notice Escrow `amount` for the caller. Needs a prior `approve`.
    function deposit(uint256 amount) external {
        depositFor(msg.sender, amount);
    }

    /// @notice Escrow `amount` from the caller for `payer`.
    function depositFor(address payer, uint256 amount) public nonReentrant {
        if (payer == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 before = ASSET.balanceOf(address(this));
        ASSET.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = ASSET.balanceOf(address(this)) - before;
        if (received != amount) revert FeeOnTransfer(amount, received);
        balanceOf[payer] += amount;
        emit Deposited(payer, msg.sender, amount);
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Pay `p.amount` from `p.payer`'s balance to `p.payTo`, once, if `p.payer` signed it.
    /// @param signature The payer's 4627-byte ML-DSA-87 signature over `paymentMessage(p)`.
    function settle(PQ402Messages.Payment calldata p, bytes calldata signature)
        external
        nonReentrant
    {
        if (p.amount == 0) revert ZeroAmount();
        if (p.payTo == address(0) || p.payTo == address(this)) revert InvalidPayee(p.payTo);
        if (nonceUsed[p.payer][p.nonce]) revert NonceAlreadyUsed(p.payer, p.nonce);
        if (block.timestamp < p.validAfter) revert NotYetValid(p.validAfter);
        if (block.timestamp >= p.validBefore) revert Expired(p.validBefore);
        uint256 available = balanceOf[p.payer];
        if (available < p.amount) revert InsufficientBalance(available, p.amount);

        PQCAuth.requireSignature(PQC_VERIFY, PQC_KEY_STATUS, p.payer, paymentMessage(p), signature);

        nonceUsed[p.payer][p.nonce] = true;
        balanceOf[p.payer] = available - p.amount;
        emit Settled(p.payer, p.payTo, p.nonce, p.amount, p.requestHash);
        ASSET.safeTransfer(p.payTo, p.amount);
    }

    // ---------------------------------------------------------------- withdrawals

    /// @notice Start withdrawing `amount` for `payer`. Replaces any earlier open request.
    /// @dev Anyone may submit the payer's signed request; the funds can only ever go to `payer`.
    function requestWithdrawal(
        address payer,
        uint256 amount,
        bytes32 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (nonceUsed[payer][nonce]) revert NonceAlreadyUsed(payer, nonce);
        if (block.timestamp >= deadline) revert Expired(deadline);

        PQCAuth.requireSignature(
            PQC_VERIFY,
            PQC_KEY_STATUS,
            payer,
            withdrawalMessage(payer, amount, nonce, deadline),
            signature
        );

        nonceUsed[payer][nonce] = true;
        uint64 readyAt = uint64(block.timestamp) + WITHDRAWAL_DELAY;
        pendingWithdrawal[payer] = PendingWithdrawal(amount, readyAt);
        emit WithdrawalRequested(payer, nonce, amount, readyAt);
    }

    /// @notice Pay out `payer`'s open withdrawal once its delay has passed. Callable by anyone.
    /// @dev Settlements may have spent part of the balance meanwhile; what is left is paid.
    function withdraw(address payer) external nonReentrant returns (uint256 amount) {
        PendingWithdrawal memory w = pendingWithdrawal[payer];
        if (w.amount == 0) revert NoPendingWithdrawal(payer);
        if (block.timestamp < w.readyAt) revert WithdrawalNotReady(w.readyAt);

        delete pendingWithdrawal[payer];
        uint256 balance = balanceOf[payer];
        amount = w.amount < balance ? w.amount : balance;
        balanceOf[payer] = balance - amount;
        emit Withdrawn(payer, amount);
        if (amount != 0) ASSET.safeTransfer(payer, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice The bytes the payer signs for `p` with this escrow on this chain.
    function paymentMessage(PQ402Messages.Payment calldata p) public view returns (bytes memory) {
        return PQ402Messages.payment(block.chainid, address(this), address(ASSET), p);
    }

    /// @notice The bytes the payer signs to request a withdrawal.
    function withdrawalMessage(address payer, uint256 amount, bytes32 nonce, uint64 deadline)
        public
        view
        returns (bytes memory)
    {
        return
            PQ402Messages.withdrawal(block.chainid, address(this), payer, amount, nonce, deadline);
    }
}
