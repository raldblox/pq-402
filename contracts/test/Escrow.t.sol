// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PQ402Escrow} from "../src/PQ402Escrow.sol";
import {PQ402Messages} from "../src/libraries/PQ402Messages.sol";
import {PQCAuth} from "../src/libraries/PQCAuth.sol";
import {EscrowFixture} from "./EscrowFixture.sol";
import {FeeOnTransferToken} from "./mocks/Tokens.sol";

contract EscrowTest is EscrowFixture {
    bytes32 internal constant NONCE = keccak256("nonce 1");

    // ------------------------------------------------------------ deployment

    function test_constructor_recordsParameters() public view {
        assertEq(address(escrow.ASSET()), address(usd));
        assertEq(escrow.PQC_VERIFY(), PQC_VERIFY);
        assertEq(escrow.PQC_KEY_STATUS(), PQC_KEY_STATUS);
        assertEq(escrow.WITHDRAWAL_DELAY(), DELAY);
    }

    function test_constructor_refusesChainWithoutPrecompiles() public {
        vm.etch(PQC_KEY_STATUS, "");
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCUnavailable.selector, PQC_KEY_STATUS));
        new PQ402Escrow(IERC20(address(usd)), PQC_VERIFY, PQC_KEY_STATUS, DELAY);

        installPqc();
        vm.etch(PQC_VERIFY, "");
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCUnavailable.selector, PQC_VERIFY));
        new PQ402Escrow(IERC20(address(usd)), PQC_VERIFY, PQC_KEY_STATUS, DELAY);
    }

    function test_constructor_refusesZeroAsset() public {
        vm.expectRevert(PQ402Escrow.ZeroAddress.selector);
        new PQ402Escrow(IERC20(address(0)), PQC_VERIFY, PQC_KEY_STATUS, DELAY);
    }

    // ------------------------------------------------------------ deposits

    function test_deposit_creditsPayer() public view {
        assertEq(escrow.balanceOf(payer), DEPOSIT);
        assertEq(usd.balanceOf(address(escrow)), DEPOSIT);
    }

    function test_depositFor_creditsAnotherAccount() public {
        address sponsor = makeAddr("sponsor");
        usd.mint(sponsor, 5e6);
        vm.startPrank(sponsor);
        usd.approve(address(escrow), 5e6);
        vm.expectEmit(address(escrow));
        emit PQ402Escrow.Deposited(payer, sponsor, 5e6);
        escrow.depositFor(payer, 5e6);
        vm.stopPrank();
        assertEq(escrow.balanceOf(payer), DEPOSIT + 5e6);
    }

    function test_deposit_refusesZero() public {
        vm.prank(payer);
        vm.expectRevert(PQ402Escrow.ZeroAmount.selector);
        escrow.deposit(0);
    }

    function test_deposit_refusesFeeOnTransferToken() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        PQ402Escrow feeEscrow =
            new PQ402Escrow(IERC20(address(fee)), PQC_VERIFY, PQC_KEY_STATUS, DELAY);
        fee.mint(payer, 100e6);
        vm.startPrank(payer);
        fee.approve(address(feeEscrow), 100e6);
        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.FeeOnTransfer.selector, 100e6, 99e6));
        feeEscrow.deposit(100e6);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ settlement

    function test_settle_paysPayeeOnce() public {
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(payerSecret, p);

        vm.expectEmit(address(escrow));
        emit PQ402Escrow.Settled(payer, payee, NONCE, 10_000, p.requestHash);
        vm.prank(relayer);
        escrow.settle(p, sig);

        assertEq(usd.balanceOf(payee), 10_000);
        assertEq(escrow.balanceOf(payer), DEPOSIT - 10_000);
        assertTrue(escrow.nonceUsed(payer, NONCE));
        assertEq(usd.balanceOf(relayer), 0);

        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.NonceAlreadyUsed.selector, payer, NONCE));
        escrow.settle(p, sig);
    }

    function test_settle_refusesForgedSignature() public {
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(keccak256("someone else"), p);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, sig);
    }

    function test_settle_refusesSignatureOfAnotherRegisteredAccount() public {
        address mallory = makeAddr("mallory");
        bytes32 mallorySecret = keccak256("mallory");
        pqc.register(mallory, mallorySecret, true);
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(mallorySecret, p);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, sig);
    }

    function test_settle_refusesSignatureOfWrongLength() public {
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, new bytes(4626));
    }

    function test_settle_refusesUnregisteredPayer() public {
        address stranger = makeAddr("stranger");
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        p.payer = stranger;
        fund(stranger, 1e6);
        bytes memory sig = sign(payerSecret, p);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCKeyNotRegistered.selector, stranger));
        escrow.settle(p, sig);
    }

    function test_settle_refusesKeyWithoutProofOfPossession() public {
        pqc.register(payer, payerSecret, false);
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(payerSecret, p);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCKeyNotProven.selector, payer));
        escrow.settle(p, sig);
    }

    function test_settle_refusesOtherAlgorithm() public {
        pqc.setRecord(payer, true, 2, pqc.publicKey(payerSecret), true);
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(payerSecret, p);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCKeyUnsupported.selector, payer));
        escrow.settle(p, sig);
    }

    function test_settle_refusesWrongKeyLength() public {
        pqc.setRecord(payer, true, 1, new bytes(1312), true);
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(payerSecret, p);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCKeyUnsupported.selector, payer));
        escrow.settle(p, sig);
    }

    function test_settle_failsClosedWhenPrecompilesGoInactive() public {
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(payerSecret, p);

        vm.etch(PQC_VERIFY, "");
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCUnavailable.selector, PQC_VERIFY));
        escrow.settle(p, sig);

        vm.etch(PQC_KEY_STATUS, "");
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCUnavailable.selector, PQC_KEY_STATUS));
        escrow.settle(p, sig);

        assertEq(usd.balanceOf(payee), 0);
    }

    function test_settle_refusesChangedFields() public {
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(payerSecret, p);

        PQ402Messages.Payment memory q = p;
        q.amount = 10_001;
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(q, sig);

        q = payment(10_000, NONCE);
        q.payTo = relayer;
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(q, sig);

        q = payment(10_000, NONCE);
        q.requestHash = keccak256("GET /paid/other");
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(q, sig);

        q = payment(10_000, NONCE);
        q.validBefore += 1;
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(q, sig);
    }

    function test_settle_refusesSignatureForAnotherEscrow() public {
        PQ402Escrow other = new PQ402Escrow(IERC20(address(usd)), PQC_VERIFY, PQC_KEY_STATUS, DELAY);
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sigForOther = pqc.sign(payerSecret, other.paymentMessage(p));
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, sigForOther);
    }

    function test_settle_refusesSignatureForAnotherChain() public {
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(payerSecret, p);
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, sig);
    }

    function test_settle_refusesWithdrawalSignature() public {
        // The same nonce and amount, signed as a withdrawal, must not settle a payment.
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = signWithdrawal(payerSecret, 10_000, NONCE, p.validBefore);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, sig);
    }

    function test_settle_respectsTimeWindow() public {
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory sig = sign(payerSecret, p);

        vm.warp(p.validAfter - 1);
        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.NotYetValid.selector, p.validAfter));
        escrow.settle(p, sig);

        vm.warp(p.validBefore);
        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.Expired.selector, p.validBefore));
        escrow.settle(p, sig);

        vm.warp(p.validBefore - 1);
        escrow.settle(p, sig);
    }

    function test_settle_refusesMoreThanTheBalance() public {
        PQ402Messages.Payment memory p = payment(DEPOSIT + 1, NONCE);
        bytes memory sig = sign(payerSecret, p);
        vm.expectRevert(
            abi.encodeWithSelector(PQ402Escrow.InsufficientBalance.selector, DEPOSIT, DEPOSIT + 1)
        );
        escrow.settle(p, sig);
    }

    function test_settle_refusesZeroAmountAndBadPayee() public {
        PQ402Messages.Payment memory p = payment(0, NONCE);
        bytes memory sig = sign(payerSecret, p);
        vm.expectRevert(PQ402Escrow.ZeroAmount.selector);
        escrow.settle(p, sig);

        p = payment(1, NONCE);
        p.payTo = address(escrow);
        sig = sign(payerSecret, p);
        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.InvalidPayee.selector, address(escrow)));
        escrow.settle(p, sig);
    }

    function test_settle_followsKeyRotation() public {
        PQ402Messages.Payment memory p = payment(10_000, NONCE);
        bytes memory oldSig = sign(payerSecret, p);
        bytes32 rotated = keccak256("rotated secret");
        pqc.register(payer, rotated, true);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, oldSig);
        escrow.settle(p, sign(rotated, p));
    }

    // ------------------------------------------------------------ withdrawals

    function test_withdrawal_needsSignatureAndDelay() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 nonce = keccak256("w1");

        // The classical key alone (a plain call from the payer) is not enough.
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.requestWithdrawal(payer, 400e6, nonce, deadline, new bytes(4627));

        escrow.requestWithdrawal(
            payer, 400e6, nonce, deadline, signWithdrawal(payerSecret, 400e6, nonce, deadline)
        );
        (uint256 amount, uint64 readyAt) = escrow.pendingWithdrawal(payer);
        assertEq(amount, 400e6);
        assertEq(readyAt, block.timestamp + DELAY);

        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.WithdrawalNotReady.selector, readyAt));
        escrow.withdraw(payer);

        vm.warp(readyAt);
        vm.prank(relayer);
        assertEq(escrow.withdraw(payer), 400e6);
        assertEq(usd.balanceOf(payer), 400e6);
        assertEq(usd.balanceOf(relayer), 0);
        assertEq(escrow.balanceOf(payer), DEPOSIT - 400e6);

        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.NoPendingWithdrawal.selector, payer));
        escrow.withdraw(payer);
    }

    function test_withdrawal_requestCannotBeReplayed() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 nonce = keccak256("w1");
        bytes memory sig = signWithdrawal(payerSecret, 1e6, nonce, deadline);
        escrow.requestWithdrawal(payer, 1e6, nonce, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.NonceAlreadyUsed.selector, payer, nonce));
        escrow.requestWithdrawal(payer, 1e6, nonce, deadline, sig);
    }

    function test_withdrawal_refusesExpiredRequestAndPaymentSignature() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 nonce = keccak256("w1");
        bytes memory sig = signWithdrawal(payerSecret, 1e6, nonce, deadline);
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.Expired.selector, deadline));
        escrow.requestWithdrawal(payer, 1e6, nonce, deadline, sig);

        vm.warp(deadline - 1);
        PQ402Messages.Payment memory p = payment(1e6, nonce);
        sig = sign(payerSecret, p);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.requestWithdrawal(payer, 1e6, nonce, deadline, sig);
    }

    function test_withdrawal_settlementStillDrawsDuringDelay() public {
        uint64 deadline = uint64(block.timestamp + 600);
        escrow.requestWithdrawal(
            payer,
            DEPOSIT,
            keccak256("w1"),
            deadline,
            signWithdrawal(payerSecret, DEPOSIT, keccak256("w1"), deadline)
        );
        PQ402Messages.Payment memory p = payment(300e6, NONCE);
        escrow.settle(p, sign(payerSecret, p));

        vm.warp(block.timestamp + DELAY);
        assertEq(escrow.withdraw(payer), DEPOSIT - 300e6);
        assertEq(usd.balanceOf(payee), 300e6);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }
}
