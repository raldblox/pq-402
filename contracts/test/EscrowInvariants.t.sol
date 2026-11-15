// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PQ402Escrow} from "../src/PQ402Escrow.sol";
import {PQ402Messages} from "../src/libraries/PQ402Messages.sol";
import {EscrowFixture} from "./EscrowFixture.sol";
import {MockPQC} from "./mocks/MockPQC.sol";
import {MockUSD} from "./mocks/Tokens.sol";

/// @dev Drives the escrow with random deposits, signed and forged payments, replays and
///      withdrawals, and keeps ghost accounting of what should have happened.
contract EscrowHandler is Test {
    PQ402Escrow internal escrow;
    MockPQC internal pqc;
    MockUSD internal usd;
    address[3] internal payers;
    bytes32[3] internal secrets;
    address internal constant PAYEE = address(0xBEEF);

    bytes32[] internal settledNonces;
    address[] internal settledPayers;
    mapping(address => uint256) public ghostBalance;
    uint256 public ghostPaidOut;
    uint256 public ghostWithdrawn;
    bool public ghostForgedAccepted;
    bool public ghostReplayAccepted;
    uint256 internal counter;

    constructor(PQ402Escrow escrow_, MockPQC pqc_, MockUSD usd_) {
        escrow = escrow_;
        pqc = pqc_;
        usd = usd_;
        for (uint256 i; i < 3; ++i) {
            payers[i] = address(uint160(0x1000 + i));
            secrets[i] = keccak256(abi.encode("secret", i));
            pqc.register(payers[i], secrets[i], true);
        }
    }

    function deposit(uint256 who, uint256 amount) external {
        address payer = payers[who % 3];
        amount = bound(amount, 1, 1_000e6);
        usd.mint(payer, amount);
        vm.startPrank(payer);
        usd.approve(address(escrow), amount);
        escrow.deposit(amount);
        vm.stopPrank();
        ghostBalance[payer] += amount;
    }

    function settle(uint256 who, uint256 amount) external {
        address payer = payers[who % 3];
        uint256 balance = escrow.balanceOf(payer);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        PQ402Messages.Payment memory p = _payment(payer, amount, keccak256(abi.encode(++counter)));
        escrow.settle(p, pqc.sign(secrets[who % 3], escrow.paymentMessage(p)));
        ghostBalance[payer] -= amount;
        ghostPaidOut += amount;
        settledNonces.push(p.nonce);
        settledPayers.push(payer);
    }

    function forge(uint256 who, uint256 amount, bytes32 wrongSecret) external {
        address payer = payers[who % 3];
        if (wrongSecret == secrets[who % 3]) return;
        PQ402Messages.Payment memory p = _payment(payer, bound(amount, 1, 1e6), bytes32(++counter));
        try escrow.settle(p, pqc.sign(wrongSecret, escrow.paymentMessage(p))) {
            ghostForgedAccepted = true;
        } catch {}
    }

    function replay(uint256 index) external {
        if (settledNonces.length == 0) return;
        index = index % settledNonces.length;
        address payer = settledPayers[index];
        uint256 i = payer == payers[0] ? 0 : payer == payers[1] ? 1 : 2;
        // Re-sign the same nonce: even a valid signature must not settle twice.
        PQ402Messages.Payment memory p = _payment(payer, 1, settledNonces[index]);
        try escrow.settle(p, pqc.sign(secrets[i], escrow.paymentMessage(p))) {
            ghostReplayAccepted = true;
        } catch {}
    }

    function requestAndWithdraw(uint256 who, uint256 amount) external {
        address payer = payers[who % 3];
        uint256 balance = escrow.balanceOf(payer);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        bytes32 nonce = keccak256(abi.encode("w", ++counter));
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig =
            pqc.sign(secrets[who % 3], escrow.withdrawalMessage(payer, amount, nonce, deadline));
        escrow.requestWithdrawal(payer, amount, nonce, deadline, sig);
        vm.warp(block.timestamp + escrow.WITHDRAWAL_DELAY());
        uint256 paid = escrow.withdraw(payer);
        ghostBalance[payer] -= paid;
        ghostWithdrawn += paid;
    }

    function _payment(address payer, uint256 amount, bytes32 nonce)
        internal
        view
        returns (PQ402Messages.Payment memory)
    {
        return PQ402Messages.Payment({
            payer: payer,
            payTo: PAYEE,
            amount: amount,
            nonce: nonce,
            validAfter: uint64(block.timestamp),
            validBefore: uint64(block.timestamp + 60),
            requestHash: keccak256(abi.encode(nonce))
        });
    }

    function payerAt(uint256 i) external view returns (address) {
        return payers[i];
    }
}

contract EscrowInvariantTest is EscrowFixture {
    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(escrow, pqc, usd);
        targetContract(address(handler));
    }

    /// @notice The escrow always holds exactly the sum of what it owes (plus the fixture payer).
    function invariant_tokensMatchBalances() public view {
        uint256 owed = escrow.balanceOf(payer);
        for (uint256 i; i < 3; ++i) {
            owed += escrow.balanceOf(handler.payerAt(i));
        }
        assertEq(usd.balanceOf(address(escrow)), owed);
    }

    /// @notice Every payer's balance is what its deposits, payments and withdrawals add up to.
    function invariant_balancesFollowSignedActionsOnly() public view {
        for (uint256 i; i < 3; ++i) {
            address p = handler.payerAt(i);
            assertEq(escrow.balanceOf(p), handler.ghostBalance(p));
        }
        assertEq(usd.balanceOf(address(0xBEEF)), handler.ghostPaidOut());
    }

    function invariant_noForgedPaymentSettles() public view {
        assertFalse(handler.ghostForgedAccepted());
    }

    function invariant_noNonceSettlesTwice() public view {
        assertFalse(handler.ghostReplayAccepted());
    }
}
