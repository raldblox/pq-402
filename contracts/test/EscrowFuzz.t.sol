// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PQ402Escrow} from "../src/PQ402Escrow.sol";
import {PQ402Messages} from "../src/libraries/PQ402Messages.sol";
import {PQCAuth} from "../src/libraries/PQCAuth.sol";
import {EscrowFixture} from "./EscrowFixture.sol";

contract EscrowFuzzTest is EscrowFixture {
    function testFuzz_settle_succeedsOnceThenRefusesReplay(uint256 amount, bytes32 nonce) public {
        amount = bound(amount, 1, DEPOSIT);
        PQ402Messages.Payment memory p = payment(amount, nonce);
        bytes memory sig = sign(payerSecret, p);
        escrow.settle(p, sig);
        assertEq(usd.balanceOf(payee), amount);

        vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.NonceAlreadyUsed.selector, payer, nonce));
        escrow.settle(p, sig);
        assertEq(usd.balanceOf(payee), amount);
    }

    function testFuzz_settle_refusesAnyChangedAmountOrPayee(
        uint256 amount,
        uint256 otherAmount,
        address otherPayee
    ) public {
        amount = bound(amount, 1, DEPOSIT);
        otherAmount = bound(otherAmount, 1, DEPOSIT);
        vm.assume(otherAmount != amount);
        vm.assume(otherPayee != payee && otherPayee != address(0) && otherPayee != address(escrow));

        PQ402Messages.Payment memory p = payment(amount, keccak256("n"));
        bytes memory sig = sign(payerSecret, p);

        PQ402Messages.Payment memory q = p;
        q.amount = otherAmount;
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(q, sig);

        q = payment(amount, keccak256("n"));
        q.payTo = otherPayee;
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(q, sig);
    }

    function testFuzz_settle_refusesOtherRequestHash(bytes32 otherHash) public {
        PQ402Messages.Payment memory p = payment(1e6, keccak256("n"));
        vm.assume(otherHash != p.requestHash);
        bytes memory sig = sign(payerSecret, p);
        p.requestHash = otherHash;
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, sig);
    }

    function testFuzz_settle_refusesWrongSigner(bytes32 secret) public {
        vm.assume(secret != payerSecret && secret != bytes32(0));
        PQ402Messages.Payment memory p = payment(1e6, keccak256("n"));
        bytes memory sig = sign(secret, p);
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, sig);
    }

    function testFuzz_settle_onlyInsideTimeWindow(uint64 at) public {
        PQ402Messages.Payment memory p = payment(1e6, keccak256("n"));
        bytes memory sig = sign(payerSecret, p);
        at = uint64(bound(at, 1, type(uint64).max - 1));
        vm.warp(at);
        if (at < p.validAfter) {
            vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.NotYetValid.selector, p.validAfter));
        } else if (at >= p.validBefore) {
            vm.expectRevert(abi.encodeWithSelector(PQ402Escrow.Expired.selector, p.validBefore));
        }
        escrow.settle(p, sig);
    }

    function testFuzz_settle_neverMoreThanBalance(uint256 amount) public {
        amount = bound(amount, DEPOSIT + 1, type(uint128).max);
        PQ402Messages.Payment memory p = payment(amount, keccak256("n"));
        bytes memory sig = sign(payerSecret, p);
        vm.expectRevert(
            abi.encodeWithSelector(PQ402Escrow.InsufficientBalance.selector, DEPOSIT, amount)
        );
        escrow.settle(p, sig);
    }

    function testFuzz_settle_garbageSignatureNeverPays(bytes memory garbage) public {
        PQ402Messages.Payment memory p = payment(1e6, keccak256("n"));
        vm.expectRevert(abi.encodeWithSelector(PQCAuth.PQCSignatureInvalid.selector, payer));
        escrow.settle(p, garbage);
        assertEq(usd.balanceOf(payee), 0);
    }
}
