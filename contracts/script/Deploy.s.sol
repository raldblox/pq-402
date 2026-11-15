// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PQ402Escrow} from "../src/PQ402Escrow.sol";

/// @notice Deploys a PQ402Escrow on the QoreChain testnet.
/// @dev The sender needs a registered ML-DSA-87 key and a live EVM window first
///      (`pnpm testnet register gateway`; deployment needs a window too).
///
///      Environment (`pnpm testnet deploy` passes the repository .env):
///        GATEWAY_MNEMONIC   BIP-39 phrase of the deploying account (m/44'/60'/0'/0/0)
///        ESCROW_ASSET       token to hold (default: testnet fUSD)
///        WITHDRAWAL_DELAY   seconds a withdrawal waits (default: 3600)
///
///      Run with --skip-simulation: Foundry's own EVM has no PQC precompiles, so its on-chain
///      simulation of the constructor would fail; the node estimates gas instead.
contract Deploy is Script {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    address internal constant TESTNET_FUSD = 0x97143B771D34ddb9130b807b135Ae675A5a963CA;

    function run() external returns (PQ402Escrow escrow) {
        uint256 deployerKey = vm.deriveKey(vm.envString("GATEWAY_MNEMONIC"), 0);
        IERC20 asset = IERC20(vm.envOr("ESCROW_ASSET", TESTNET_FUSD));
        uint64 delay = uint64(vm.envOr("WITHDRAWAL_DELAY", uint256(3600)));

        _requirePrecompiles();
        _standInForLocalRun();

        vm.startBroadcast(deployerKey);
        escrow = new PQ402Escrow(asset, PQC_VERIFY, PQC_KEY_STATUS, delay);
        vm.stopBroadcast();

        console.log("deployer:", vm.addr(deployerKey));
        console.log("PQ402Escrow:", address(escrow));
        console.log("asset:", address(asset));
        console.log("withdrawal delay (s):", delay);
    }

    /// @dev An inactive precompile answers with empty data. Ask the node itself (Foundry's local
    ///      EVM has none) and stop before deploying an escrow that could never settle.
    function _requirePrecompiles() internal {
        bytes memory callData = abi.encodeWithSignature("pqcKeyStatus(address)", address(1));
        string memory params = string.concat(
            '[{"to":"',
            vm.toString(PQC_KEY_STATUS),
            '","data":"',
            vm.toString(callData),
            '"},"latest"]'
        );
        bytes memory ret = vm.rpc("eth_call", params);
        require(ret.length >= 160, "pqcKeyStatus precompile is not active on this chain");

        callData = abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", "", "", "");
        params = string.concat(
            '[{"to":"', vm.toString(PQC_VERIFY), '","data":"', vm.toString(callData), '"},"latest"]'
        );
        ret = vm.rpc("eth_call", params);
        require(ret.length == 32, "pqcVerify precompile is not active on this chain");
    }

    /// @dev Foundry first runs the script on its own copy of the chain, without the precompiles,
    ///      where the constructor's availability check would fail. For that local run only,
    ///      answer the way the chain does for an unknown account. `_requirePrecompiles` has
    ///      already confirmed the real ones; the broadcast transaction runs against those.
    function _standInForLocalRun() internal {
        if (PQC_KEY_STATUS.code.length == 0) {
            vm.etch(PQC_KEY_STATUS, type(KeyStatusStandIn).runtimeCode);
        }
        if (PQC_VERIFY.code.length == 0) vm.etch(PQC_VERIFY, type(VerifyStandIn).runtimeCode);
    }
}

/// @dev Local-run stand-in: an account with no registered key.
contract KeyStatusStandIn {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(false, uint8(0), bytes(""), false);
    }
}

/// @dev Local-run stand-in: nothing verifies.
contract VerifyStandIn {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(false);
    }
}
