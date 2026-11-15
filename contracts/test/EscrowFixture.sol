// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PQ402Escrow} from "../src/PQ402Escrow.sol";
import {PQ402Messages} from "../src/libraries/PQ402Messages.sol";
import {MockPQC, MockPQCVerifier} from "./mocks/MockPQC.sol";
import {MockUSD} from "./mocks/Tokens.sol";

/// @dev Shared setup: the PQC stand-in at the precompile addresses, a 6-decimal token, an escrow
///      with a one-hour withdrawal delay, and a payer with a proven key and 1,000 tokens escrowed.
abstract contract EscrowFixture is Test {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    uint64 internal constant DELAY = 1 hours;

    MockPQC internal pqc;
    MockUSD internal usd;
    PQ402Escrow internal escrow;

    address internal payer = makeAddr("payer");
    bytes32 internal payerSecret = keccak256("payer secret");
    address internal payee = makeAddr("payee");
    address internal relayer = makeAddr("relayer");
    uint256 internal constant DEPOSIT = 1_000e6;

    function setUp() public virtual {
        vm.warp(1_763_200_000);
        installPqc();
        usd = new MockUSD();
        escrow = new PQ402Escrow(IERC20(address(usd)), PQC_VERIFY, PQC_KEY_STATUS, DELAY);
        pqc.register(payer, payerSecret, true);
        fund(payer, DEPOSIT);
    }

    function installPqc() internal {
        vm.etch(PQC_KEY_STATUS, type(MockPQC).runtimeCode);
        vm.etch(PQC_VERIFY, type(MockPQCVerifier).runtimeCode);
        pqc = MockPQC(PQC_KEY_STATUS);
    }

    function fund(address who, uint256 amount) internal {
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(escrow), amount);
        escrow.deposit(amount);
        vm.stopPrank();
    }

    function payment(uint256 amount, bytes32 nonce)
        internal
        view
        returns (PQ402Messages.Payment memory)
    {
        return PQ402Messages.Payment({
            payer: payer,
            payTo: payee,
            amount: amount,
            nonce: nonce,
            validAfter: uint64(block.timestamp - 30),
            validBefore: uint64(block.timestamp + 120),
            requestHash: keccak256("GET /paid/hello")
        });
    }

    function sign(bytes32 secret, PQ402Messages.Payment memory p)
        internal
        view
        returns (bytes memory)
    {
        return pqc.sign(secret, escrow.paymentMessage(p));
    }

    function signWithdrawal(bytes32 secret, uint256 amount, bytes32 nonce, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        return pqc.sign(secret, escrow.withdrawalMessage(payer, amount, nonce, deadline));
    }
}
