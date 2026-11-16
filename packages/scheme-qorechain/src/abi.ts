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

/**
 * The parts of the Perennial vault the `pq-perennial` scheme uses. The
 * `spend` signature, the `Spent` event and `Action.Spend = 4` are fixed by the
 * Perennial project; this fragment is copied from its compiled ABI.
 */
export const perennialVaultAbi = parseAbi([
  "struct Position { address owner; address beneficiary; bool ownerCanClose; bool succeeded; bool closed; uint64 payoutInterval; uint64 checkInPeriod; uint64 gracePeriod; uint64 lastCheckIn; uint64 lastPayout; uint256 payoutAmount; uint256 principal; uint256 shares; uint256 buffer; uint256 nonce; uint256 bufferCap; }",
  "function ASSET() view returns (address)",
  "function ACTION_DOMAIN() view returns (bytes32)",
  "function position(uint256 positionId) view returns (Position)",
  "function pendingYield(uint256 positionId) view returns (uint256)",
  "function actionMessage(uint256 positionId, uint8 action, uint256 nonce, uint256 deadline, bytes32 paramsHash) view returns (bytes)",
  "function spend(uint256 positionId, address to, uint256 amount, bytes32 ref, uint256 deadline, bytes signature)",
  "event Spent(uint256 indexed positionId, address indexed to, uint256 amount, bytes32 indexed ref)",
  "error InsufficientBuffer(uint256 positionId, uint256 available)",
  "error PositionClosed(uint256 positionId)",
  "error PositionSucceeded(uint256 positionId)",
  "error SignatureExpired(uint256 deadline)",
  "error UnknownPosition(uint256 positionId)",
  "error PQCSignatureInvalid(address account)",
  "error PQCKeyNotProven(address account)",
  "error PQCKeyNotRegistered(address account)",
  "error PQCUnavailable(address precompile)",
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
