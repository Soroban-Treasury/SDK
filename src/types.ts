import type { ContractError, SimulationError } from "./errors.js";

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

/** A spending limit to set when the treasury is created. */
export interface LimitInit {
  /** Token contract id. */
  asset: string;
  /** Most that can be spent per period, in the asset's smallest unit. */
  limit: Amount;
  /** Period length in seconds. */
  periodSeconds: number;
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

/** Options when previewing a write call without signing or sending it. */
export interface PreviewOptions {
  /**
   * Stellar account (`G...`) to preview the call as. Defaults to the client's `signer.publicKey`
   * when a signer is configured. Pass this on a read-only client to preview on behalf of an owner.
   */
  caller?: string;
}

/**
 * Outcome of previewing a write call via {@link TreasuryClient.preview} without signing or sending.
 *
 * - `ok: true`: the simulation succeeded; `value` is what the contract call would return and `fee`
 *   is the estimated total transaction fee in stroops (`baseFee + resourceFee`).
 * - `ok: false`: the simulation failed; `error` is the typed {@link ContractError} (such as
 *   {@link OverLimitError}) or {@link SimulationError}, and `fee` is the estimated fee reported so far.
 *
 * Bad input ({@link InvalidInputError}) and missing caller/signer configuration ({@link ConfigError})
 * are still thrown before touching the network.
 */
export type PreviewResult<T = undefined> =
  | {
      ok: true;
      /** What the contract call would return (`bigint` proposal id for `propose`, `undefined` for others). */
      value: T;
      /** Estimated total transaction fee in stroops (`baseFee + resourceFee`). */
      fee: bigint;
      /** Soroban resource fee in stroops reported by `simulateTransaction`. */
      resourceFee: bigint;
    }
  | {
      ok: false;
      /** Typed contract or simulation error explaining why the call would fail. */
      error: ContractError | SimulationError;
      /** Estimated transaction fee in stroops (`baseFee + resourceFee` if reported, otherwise `baseFee`). */
      fee: bigint;
      /** Soroban resource fee in stroops if reported by `simulateTransaction`, otherwise `0n`. */
      resourceFee: bigint;
    };

/**
 * Typed previews for every write call on {@link TreasuryClient}.
 *
 * Each method simulates the call on Soroban RPC without requesting a signature or submitting a
 * transaction, returning either the expected result or a typed {@link ContractError} alongside the
 * estimated fee in stroops.
 */
export interface TreasuryPreview {
  /**
   * Preview proposing a payment without signing or sending.
   * Returns `{ ok: true, value: id, fee, resourceFee }` or `{ ok: false, error, fee, resourceFee }`.
   */
  propose(params: ProposeParams, options?: PreviewOptions): Promise<PreviewResult<bigint>>;
  /**
   * Preview approving a proposal without signing or sending.
   * Returns `{ ok: true, value: undefined, fee, resourceFee }` or `{ ok: false, error, fee, resourceFee }`.
   */
  approve(id: Amount, options?: PreviewOptions): Promise<PreviewResult>;
  /**
   * Preview executing an approved proposal without signing or sending.
   * Returns `{ ok: true, value: undefined, fee, resourceFee }` or `{ ok: false, error, fee, resourceFee }`.
   */
  execute(id: Amount, options?: PreviewOptions): Promise<PreviewResult>;
  /**
   * Preview setting a spending limit without signing or sending.
   * Returns `{ ok: true, value: undefined, fee, resourceFee }` or `{ ok: false, error, fee, resourceFee }`.
   */
  setSpendLimit(params: SetSpendLimitParams, options?: PreviewOptions): Promise<PreviewResult>;
  /**
   * Preview removing a spending limit without signing or sending.
   * Returns `{ ok: true, value: undefined, fee, resourceFee }` or `{ ok: false, error, fee, resourceFee }`.
   */
  removeSpendLimit(params: RemoveSpendLimitParams, options?: PreviewOptions): Promise<PreviewResult>;
}
