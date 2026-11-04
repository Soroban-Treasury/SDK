/** Amounts are in the asset's smallest unit (stroops for XLM). */
export type Amount = bigint | number | string;

export interface Config {
  owners: string[];
  threshold: number;
}

export interface SpendLimit {
  /** Most that can be spent per period. */
  limit: bigint;
  /** Period length in seconds. */
  period: bigint;
}

export interface Proposal {
  id: bigint;
  proposer: string;
  asset: string;
  to: string;
  amount: bigint;
  /** Owners who approved so far, including the proposer. */
  approvals: string[];
  executed: boolean;
  /** Unix time in seconds after which the proposal can no longer be approved or executed. */
  expiresAt: bigint;
}

/** Result of a write call. */
export interface TxResult<T = undefined> {
  /** Transaction hash. */
  hash: string;
  /** The contract's return value, if it has one. */
  value: T;
}

export interface ProposeParams {
  asset: string;
  to: string;
  amount: Amount;
  /** How long the proposal stays open, in seconds. Default 7 days. Max 30 days. */
  ttlSeconds?: number;
}

export interface ListProposalsParams {
  /** Skip this many proposals, newest first. Default 0. */
  offset?: number;
  /** Maximum proposals to return. Default 50. */
  limit?: number;
}

export interface SetSpendLimitParams {
  /** Owners who authorize this change. At least the treasury's threshold. */
  approvers: string[];
  asset: string;
  limit: Amount;
  /** Period length in seconds. */
  periodSeconds: number;
}

export interface RemoveSpendLimitParams {
  approvers: string[];
  asset: string;
}
