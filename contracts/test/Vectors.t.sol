// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PQ402Messages} from "../src/libraries/PQ402Messages.sol";

/// @notice The contract builds the same signed bytes as the TypeScript client: both are checked
///         against packages/core/test/vectors/v1.json.
contract VectorsTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile("../packages/core/test/vectors/v1.json");
    }

    function _uint(string memory key) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, key));
    }

    function test_paymentMessageMatchesVector() public view {
        string memory f = ".payment.fields";
        PQ402Messages.Payment memory p = PQ402Messages.Payment({
            payer: vm.parseJsonAddress(json, string.concat(f, ".payer")),
            payTo: vm.parseJsonAddress(json, string.concat(f, ".payTo")),
            amount: _uint(string.concat(f, ".amount")),
            nonce: vm.parseJsonBytes32(json, string.concat(f, ".nonce")),
            validAfter: uint64(_uint(string.concat(f, ".validAfter"))),
            validBefore: uint64(_uint(string.concat(f, ".validBefore"))),
            requestHash: vm.parseJsonBytes32(json, string.concat(f, ".requestHash"))
        });
        bytes memory message = PQ402Messages.payment(
            _uint(string.concat(f, ".chainId")),
            vm.parseJsonAddress(json, string.concat(f, ".escrow")),
            vm.parseJsonAddress(json, string.concat(f, ".asset")),
            p
        );
        assertEq(message.length, 352);
        assertEq(message, vm.parseJsonBytes(json, ".payment.message"));
    }

    function test_withdrawalMessageMatchesVector() public view {
        string memory f = ".withdrawal.fields";
        bytes memory message = PQ402Messages.withdrawal(
            _uint(string.concat(f, ".chainId")),
            vm.parseJsonAddress(json, string.concat(f, ".escrow")),
            vm.parseJsonAddress(json, string.concat(f, ".payer")),
            _uint(string.concat(f, ".amount")),
            vm.parseJsonBytes32(json, string.concat(f, ".nonce")),
            uint64(_uint(string.concat(f, ".deadline")))
        );
        assertEq(message, vm.parseJsonBytes(json, ".withdrawal.message"));
    }

    function test_requestHashMatchesVector() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("PQ-402/v1 request"),
                keccak256(bytes(vm.parseJsonString(json, ".request.method"))),
                keccak256(bytes(vm.parseJsonString(json, ".request.target"))),
                keccak256(bytes(vm.parseJsonString(json, ".request.bodyUtf8")))
            )
        );
        assertEq(expected, vm.parseJsonBytes32(json, ".request.requestHash"));
    }

    /// @dev The encoding of `PerennialVault.actionMessage` (Perennial vault, `Action.Spend = 4`,
    ///      `paramsHash = keccak256(abi.encode(to, amount, ref))`), written out here because the
    ///      vault lives in its own repository. The `pq-perennial` client signs these bytes.
    function test_perennialSpendMessageMatchesVector() public view {
        string memory f = ".perennialSpend.fields";
        bytes32 paramsHash = keccak256(
            abi.encode(
                vm.parseJsonAddress(json, string.concat(f, ".to")),
                _uint(string.concat(f, ".amount")),
                vm.parseJsonBytes32(json, string.concat(f, ".ref"))
            )
        );
        bytes memory message = abi.encode(
            keccak256("Perennial.Action.v1"),
            _uint(string.concat(f, ".chainId")),
            vm.parseJsonAddress(json, string.concat(f, ".vault")),
            _uint(string.concat(f, ".positionId")),
            uint8(4),
            _uint(string.concat(f, ".nonce")),
            _uint(string.concat(f, ".deadline")),
            paramsHash
        );
        assertEq(message, vm.parseJsonBytes(json, ".perennialSpend.message"));
    }
}
