/**
 * Errors thrown by the SDK. Everything extends {@link StellarTreasuryError}, so
 * `catch (e) { if (e instanceof StellarTreasuryError) ... }` catches them all.
 */
export class StellarTreasuryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Bad input caught before anything is sent to the network. */
export class InvalidInputError extends StellarTreasuryError {}

/** The client is missing something it needs, such as a signer for a write call. */
export class ConfigError extends StellarTreasuryError {}

/** The RPC server rejected a simulation for a reason other than a contract error. */
export class SimulationError extends StellarTreasuryError {}

/** The transaction was submitted but failed, or was rejected. */
export class TransactionFailedError extends StellarTreasuryError {
  constructor(
    message: string,
    readonly hash?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The transaction was not confirmed in time. It may still land later. */
export class TransactionTimeoutError extends StellarTreasuryError {
  constructor(
    message: string,
    readonly hash?: string,
  ) {
    super(message);
  }
}

/** The signer failed or the user rejected signing. */
export class SignerError extends StellarTreasuryError {}

/** An error returned by the treasury contract. `code` matches the contract's `Error` enum. */
export class ContractError extends StellarTreasuryError {
  constructor(
    readonly code: number,
    readonly contractErrorName: string,
    message: string,
  ) {
    super(message);
  }
}

export class AlreadyInitializedError extends ContractError {
  constructor() {
    super(1, "AlreadyInitialized", "The treasury is already initialized.");
  }
}
export class NotInitializedError extends ContractError {
  constructor() {
    super(2, "NotInitialized", "The treasury is not initialized yet.");
  }
}
export class InvalidThresholdError extends ContractError {
  constructor() {
    super(3, "InvalidThreshold", "Threshold must be between 1 and the number of owners.");
  }
}
export class InvalidOwnersError extends ContractError {
  constructor() {
    super(4, "InvalidOwners", "Owners must be a non-empty list without duplicates.");
  }
}
export class TooManyOwnersError extends ContractError {
  constructor() {
    super(5, "TooManyOwners", "A treasury can have at most 10 owners.");
  }
}
export class NotOwnerError extends ContractError {
  constructor() {
    super(6, "NotOwner", "The account is not an owner of this treasury.");
  }
}
export class NotEnoughApprovalsError extends ContractError {
  constructor() {
    super(7, "NotEnoughApprovals", "Not enough owners have approved.");
  }
}
export class InvalidAmountError extends ContractError {
  constructor() {
    super(8, "InvalidAmount", "The amount must be greater than zero.");
  }
}
export class NoPolicyError extends ContractError {
  constructor() {
    super(9, "NoPolicy", "This asset has no spending limit, so it cannot be spent.");
  }
}
export class OverLimitError extends ContractError {
  constructor() {
    super(10, "OverLimit", "The payment would exceed the spending limit for this period.");
  }
}
export class ProposalNotFoundError extends ContractError {
  constructor() {
    super(11, "ProposalNotFound", "No proposal with this id.");
  }
}
export class AlreadyApprovedError extends ContractError {
  constructor() {
    super(12, "AlreadyApproved", "This owner has already approved the proposal.");
  }
}
export class AlreadyExecutedError extends ContractError {
  constructor() {
    super(13, "AlreadyExecuted", "The proposal was already executed.");
  }
}
export class ProposalExpiredError extends ContractError {
  constructor() {
    super(14, "Expired", "The proposal has expired.");
  }
}
export class InvalidTtlError extends ContractError {
  constructor() {
    super(15, "InvalidTtl", "The proposal lifetime must be between 1 second and 30 days.");
  }
}
export class TooManyPoliciesError extends ContractError {
  constructor() {
    super(16, "TooManyPolicies", "A treasury can have at most 10 spending limits.");
  }
}
export class InvalidPolicyError extends ContractError {
  constructor() {
    super(17, "InvalidPolicy", "The limit and period must be greater than zero.");
  }
}
export class DuplicateApproverError extends ContractError {
  constructor() {
    super(18, "DuplicateApprover", "The same owner was listed more than once.");
  }
}
export class OverflowError extends ContractError {
  constructor() {
    super(19, "Overflow", "A number overflowed.");
  }
}

const CONTRACT_ERRORS: Record<number, () => ContractError> = {
  1: () => new AlreadyInitializedError(),
  2: () => new NotInitializedError(),
  3: () => new InvalidThresholdError(),
  4: () => new InvalidOwnersError(),
  5: () => new TooManyOwnersError(),
  6: () => new NotOwnerError(),
  7: () => new NotEnoughApprovalsError(),
  8: () => new InvalidAmountError(),
  9: () => new NoPolicyError(),
  10: () => new OverLimitError(),
  11: () => new ProposalNotFoundError(),
  12: () => new AlreadyApprovedError(),
  13: () => new AlreadyExecutedError(),
  14: () => new ProposalExpiredError(),
  15: () => new InvalidTtlError(),
  16: () => new TooManyPoliciesError(),
  17: () => new InvalidPolicyError(),
  18: () => new DuplicateApproverError(),
  19: () => new OverflowError(),
};

/** Build the matching error subclass for a contract error code, or `undefined` if unknown. */
export function contractErrorFromCode(code: number): ContractError | undefined {
  return CONTRACT_ERRORS[code]?.();
}

/**
 * Find a contract error in an RPC or host error message such as
 * `HostError: Error(Contract, #10)`.
 */
export function parseContractError(message: string): ContractError | undefined {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
  if (!match?.[1]) return undefined;
  return contractErrorFromCode(Number(match[1]));
}
