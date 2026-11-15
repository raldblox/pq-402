import { parseAbi } from "viem";

/** The parts of `PQ402Escrow` (contracts/src/PQ402Escrow.sol) the TypeScript side calls. */
export const pq402EscrowAbi = parseAbi([
  "struct Payment { address payer; address payTo; uint256 amount; bytes32 nonce; uint64 validAfter; uint64 validBefore; bytes32 requestHash; }",
  "function ASSET() view returns (address)",
  "function WITHDRAWAL_DELAY() view returns (uint64)",
  "function balanceOf(address payer) view returns (uint256)",
  "function nonceUsed(address payer, bytes32 nonce) view returns (bool)",
  "function paymentMessage(Payment p) view returns (bytes)",
  "function deposit(uint256 amount)",
  "function depositFor(address payer, uint256 amount)",
  "function settle(Payment p, bytes signature)",
  "function requestWithdrawal(address payer, uint256 amount, bytes32 nonce, uint64 deadline, bytes signature)",
  "function withdraw(address payer) returns (uint256)",
  "event Settled(address indexed payer, address indexed payTo, bytes32 indexed nonce, uint256 amount, bytes32 requestHash)",
  "error PQCUnavailable(address precompile)",
  "error PQCKeyNotRegistered(address account)",
  "error PQCKeyUnsupported(address account)",
  "error PQCKeyNotProven(address account)",
  "error PQCSignatureInvalid(address account)",
  "error NonceAlreadyUsed(address payer, bytes32 nonce)",
  "error NotYetValid(uint64 validAfter)",
  "error Expired(uint64 validBefore)",
  "error InsufficientBalance(uint256 available, uint256 required)",
]);

/** The QoreChain PQC precompiles. */
export const pqcPrecompileAbi = parseAbi([
  "function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)",
  "function pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);
