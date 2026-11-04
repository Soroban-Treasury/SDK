import {
  Account,
  Address,
  Contract,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import {
  ConfigError,
  InvalidInputError,
  SignerError,
  SimulationError,
  StellarTreasuryError,
  TransactionFailedError,
  TransactionTimeoutError,
  parseContractError,
} from "./errors.js";
import type { Signer } from "./signer.js";
import type {
  Amount,
  Config,
  LimitInit,
  ListProposalsParams,
  Proposal,
  ProposeParams,
  RemoveSpendLimitParams,
  SetSpendLimitParams,
  SpendLimit,
  TxResult,
} from "./types.js";

/** The parts of `rpc.Server` this SDK uses. Tests can pass a fake. */
export interface RpcLike {
  getAccount(address: string): Promise<{ accountId(): string; sequenceNumber(): string; incrementSequenceNumber(): void }>;
  simulateTransaction(tx: Transaction): Promise<unknown>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
  sendTransaction(tx: Transaction): Promise<{ status: string; hash: string; errorResult?: unknown }>;
  pollTransaction(
    hash: string,
    opts?: { attempts?: number; sleepStrategy?: (iter: number) => number },
  ): Promise<{ status: string; returnValue?: xdr.ScVal; resultXdr?: unknown }>;
}

export interface TreasuryClientOptions {
  /** The treasury contract id (`C...`). */
  contractId: string;
  /** e.g. `Networks.TESTNET`. */
  networkPassphrase: string;
  /** Soroban RPC URL. Needed unless you pass `server`. */
  rpcUrl?: string;
  /** Needed for write calls. Read calls work without it. */
  signer?: Signer;
  /** Use your own RPC client instead of creating one from `rpcUrl`. */
  server?: RpcLike;
  /** Fee per operation in stroops. Default 100. */
  fee?: string;
  /** Transaction validity window in seconds. Default 60. */
  timeoutSeconds?: number;
  /** How many times to poll for confirmation. Default 30. */
  pollAttempts?: number;
  /** Allow `http://` RPC URLs (local dev). Default false. */
  allowHttp?: boolean;
  /** Extra tries for RPC calls that fail on the network (reads and polling). Default 3. */
  retries?: number;
  /** Wait before the first retry in ms, doubled each time. Default 300. */
  retryDelayMs?: number;
}

export interface CreateTreasuryOptions extends Omit<TreasuryClientOptions, "contractId" | "signer"> {
  /** Hex hash of the uploaded treasury contract WASM. */
  wasmHash: string;
  signer: Signer;
  owners: string[];
  threshold: number;
  /** Starting spending limits. Assets without a limit cannot be spent. */
  limits?: LimitInit[];
}

const DEFAULT_PROPOSAL_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A valid account that is only used as the source of read-only simulations. */
const READ_ONLY_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const address = (value: string): xdr.ScVal => {
  try {
    return new Address(value).toScVal();
  } catch (cause) {
    throw new InvalidInputError(`Not a valid Stellar address: ${value}`, { cause });
  }
};

const toBigInt = (value: Amount, name: string): bigint => {
  try {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("not a safe integer");
    return BigInt(value);
  } catch (cause) {
    throw new InvalidInputError(`${name} must be a whole number.`, { cause });
  }
};

const i128 = (value: Amount, name: string): xdr.ScVal => {
  const n = toBigInt(value, name);
  if (n <= 0n) throw new InvalidInputError(`${name} must be greater than zero.`);
  return nativeToScVal(n, { type: "i128" });
};

const u64 = (value: Amount, name: string): xdr.ScVal => {
  const n = toBigInt(value, name);
  if (n < 0n) throw new InvalidInputError(`${name} must not be negative.`);
  return nativeToScVal(n, { type: "u64" });
};

/** A `LimitInit` struct: a map with symbol keys in alphabetical order, as Soroban requires. */
const limitInit = (init: LimitInit): xdr.ScVal => {
  const entries: [string, xdr.ScVal][] = [
    ["asset", address(init.asset)],
    ["limit", i128(init.limit, "limit")],
    ["period", u64(init.periodSeconds, "periodSeconds")],
  ];
  return xdr.ScVal.scvMap(
    entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
};

const addressVec = (values: string[]): xdr.ScVal => xdr.ScVal.scvVec(values.map(address));

const isSimulationError = (sim: unknown): sim is { error: string } =>
  typeof sim === "object" && sim !== null && "error" in sim && typeof (sim as { error: unknown }).error === "string";

function toProposal(raw: Record<string, unknown>): Proposal {
  return {
    id: BigInt(raw.id as bigint),
    proposer: String(raw.proposer),
    asset: String(raw.asset),
    to: String(raw.to),
    amount: BigInt(raw.amount as bigint),
    approvals: (raw.approvals as unknown[]).map(String),
    executed: Boolean(raw.executed),
    expiresAt: BigInt(raw.expires_at as bigint),
  };
}

/**
 * Typed client for one treasury contract.
 *
 * Read calls (`getConfig`, `getProposal`, `listProposals`, ...) only simulate.
 * Write calls (`propose`, `approve`, `execute`, ...) simulate first, then sign and submit.
 */
export class TreasuryClient {
  readonly contractId: string;
  readonly networkPassphrase: string;
  private readonly server: RpcLike;
  private readonly signer?: Signer;
  private readonly contract: Contract;
  private readonly fee: string;
  private readonly timeoutSeconds: number;
  private readonly pollAttempts: number;
  private readonly retry: RetryOptions;

  constructor(options: TreasuryClientOptions) {
    this.contractId = options.contractId;
    this.networkPassphrase = options.networkPassphrase;
    this.server = resolveServer(options);
    this.signer = options.signer;
    this.fee = options.fee ?? BASE_FEE;
    this.timeoutSeconds = options.timeoutSeconds ?? 60;
    this.pollAttempts = options.pollAttempts ?? 30;
    this.retry = { retries: options.retries, retryDelayMs: options.retryDelayMs };
    try {
      this.contract = new Contract(options.contractId);
    } catch (cause) {
      throw new InvalidInputError(`Not a valid contract id: ${options.contractId}`, { cause });
    }
  }

  /**
   * Deploy a new treasury from an uploaded WASM. The owners, threshold and starting limits go to the
   * contract's constructor, so setup happens in the same transaction as deployment and nobody can
   * initialize it first. Returns a client for the new contract.
   */
  static async create(options: CreateTreasuryOptions): Promise<TreasuryClient> {
    if (!/^[0-9a-fA-F]{64}$/.test(options.wasmHash)) {
      throw new InvalidInputError("wasmHash must be 64 hex characters.");
    }
    if (options.owners.length === 0) throw new InvalidInputError("At least one owner is required.");
    if (!Number.isInteger(options.threshold) || options.threshold < 1 || options.threshold > options.owners.length) {
      throw new InvalidInputError("threshold must be between 1 and the number of owners.");
    }
    const constructorArgs = [
      addressVec(options.owners),
      nativeToScVal(options.threshold, { type: "u32" }),
      xdr.ScVal.scvVec((options.limits ?? []).map(limitInit)),
    ];
    const server = resolveServer(options);
    const deploy = Operation.createCustomContract({
      address: new Address(options.signer.publicKey),
      wasmHash: Buffer.from(options.wasmHash, "hex"),
      salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
      constructorArgs,
    });
    const { returnValue } = await submit(server, options, options.signer, deploy);
    if (!returnValue) throw new TransactionFailedError("Deploy returned no contract address.");
    const contractId = Address.fromScVal(returnValue).toString();
    return new TreasuryClient({ ...options, contractId, server });
  }

  /** Propose a payment. The signer must be an owner. Returns the new proposal id. */
  async propose(params: ProposeParams): Promise<TxResult<bigint>> {
    const signer = this.requireSigner();
    const ttl = params.ttlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS;
    const result = await this.write<bigint>("propose", [
      address(signer.publicKey),
      address(params.asset),
      address(params.to),
      i128(params.amount, "amount"),
      u64(ttl, "ttlSeconds"),
    ]);
    return { hash: result.hash, value: BigInt(result.value) };
  }

  /** Approve a proposal as the signer (must be an owner). */
  async approve(id: Amount): Promise<TxResult> {
    const signer = this.requireSigner();
    return this.write("approve", [address(signer.publicKey), u64(id, "id")]);
  }

  /** Execute an approved proposal as the signer (must be an owner). */
  async execute(id: Amount): Promise<TxResult> {
    const signer = this.requireSigner();
    return this.write("execute", [address(signer.publicKey), u64(id, "id")]);
  }

  /** Set a spending limit. The signer's authorization is attached for every approver it controls. */
  async setSpendLimit(params: SetSpendLimitParams): Promise<TxResult> {
    return this.write("set_spend_limit", [
      addressVec(params.approvers),
      address(params.asset),
      i128(params.limit, "limit"),
      u64(params.periodSeconds, "periodSeconds"),
    ]);
  }

  async removeSpendLimit(params: RemoveSpendLimitParams): Promise<TxResult> {
    return this.write("remove_spend_limit", [addressVec(params.approvers), address(params.asset)]);
  }

  async getConfig(): Promise<Config> {
    const raw = (await this.read("get_config")) as { owners: unknown[]; threshold: number };
    return { owners: raw.owners.map(String), threshold: Number(raw.threshold) };
  }

  async getProposal(id: Amount): Promise<Proposal> {
    return toProposal((await this.read("get_proposal", [u64(id, "id")])) as Record<string, unknown>);
  }

  async proposalCount(): Promise<bigint> {
    return BigInt((await this.read("proposal_count")) as bigint);
  }

  async getSpendLimit(asset: string): Promise<SpendLimit> {
    const raw = (await this.read("get_spend_limit", [address(asset)])) as { limit: bigint; period: bigint };
    return { limit: BigInt(raw.limit), period: BigInt(raw.period) };
  }

  /** Assets that have a spending limit. */
  async getPolicyAssets(): Promise<string[]> {
    return ((await this.read("get_policy_assets")) as unknown[]).map(String);
  }

  /** Amount of `asset` spent in the current period. */
  async getSpent(asset: string): Promise<bigint> {
    return BigInt((await this.read("get_spent", [address(asset)])) as bigint);
  }

  /** List proposals, newest first. */
  async listProposals(params: ListProposalsParams = {}): Promise<Proposal[]> {
    const offset = BigInt(params.offset ?? 0);
    const limit = BigInt(params.limit ?? 50);
    if (offset < 0n || limit < 0n) throw new InvalidInputError("offset and limit must not be negative.");

    const count = await this.proposalCount();
    const newest = count - offset; // exclusive upper bound
    if (newest <= 0n || limit === 0n) return [];
    const oldest = newest - limit > 0n ? newest - limit : 0n;

    const ids: bigint[] = [];
    for (let id = newest - 1n; id >= oldest; id--) ids.push(id);
    return Promise.all(ids.map((id) => this.getProposal(id)));
  }

  /**
   * Simulate a call without sending it. Throws the same errors a real call would, such as
   * {@link OverLimitError}, so you can check before asking the user to sign.
   */
  async simulate(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
    const source = new Account(this.signer?.publicKey ?? READ_ONLY_SOURCE, "0");
    const tx = this.buildTx(source, this.contract.call(method, ...args));
    const sim = await withRetry(this.retry, () => this.server.simulateTransaction(tx));
    if (isSimulationError(sim)) throw simulationFailure(sim.error);
    const retval = (sim as { result?: { retval?: xdr.ScVal } }).result?.retval;
    return retval ? scValToNative(retval) : undefined;
  }

  private read(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
    return this.simulate(method, args);
  }

  private async write<T = undefined>(method: string, args: xdr.ScVal[]): Promise<TxResult<T>> {
    const signer = this.requireSigner();
    const { hash, returnValue } = await submit(
      this.server,
      {
        networkPassphrase: this.networkPassphrase,
        fee: this.fee,
        timeoutSeconds: this.timeoutSeconds,
        pollAttempts: this.pollAttempts,
        ...this.retry,
      },
      signer,
      this.contract.call(method, ...args),
    );
    return { hash, value: (returnValue ? scValToNative(returnValue) : undefined) as T };
  }

  private requireSigner(): Signer {
    if (!this.signer) throw new ConfigError("This call needs a signer. Pass `signer` when creating the client.");
    return this.signer;
  }

  private buildTx(source: Account, op: xdr.Operation): Transaction {
    return new TransactionBuilder(source, { fee: this.fee, networkPassphrase: this.networkPassphrase })
      .addOperation(op)
      .setTimeout(this.timeoutSeconds)
      .build();
  }
}

interface RetryOptions {
  retries?: number;
  retryDelayMs?: number;
}

/** Run an idempotent RPC call again if it throws, for network blips. */
async function withRetry<T>(options: RetryOptions, fn: () => Promise<T>): Promise<T> {
  const retries = options.retries ?? 3;
  const delay = options.retryDelayMs ?? 300;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay * 2 ** attempt));
    }
  }
}

function resolveServer(options: { server?: RpcLike; rpcUrl?: string; allowHttp?: boolean }): RpcLike {
  if (options.server) return options.server;
  if (!options.rpcUrl) throw new ConfigError("Pass either `rpcUrl` or `server`.");
  return new rpc.Server(options.rpcUrl, { allowHttp: options.allowHttp ?? false }) as unknown as RpcLike;
}

function simulationFailure(message: string): StellarTreasuryError {
  return parseContractError(message) ?? new SimulationError(message);
}

interface SubmitContext extends RetryOptions {
  networkPassphrase: string;
  fee?: string;
  timeoutSeconds?: number;
  pollAttempts?: number;
}

/** Simulate and assemble, sign, send, and wait for confirmation. */
async function submit(
  server: RpcLike,
  ctx: SubmitContext,
  signer: Signer,
  op: xdr.Operation,
): Promise<{ hash: string; returnValue?: xdr.ScVal }> {
  const account = await withRetry(ctx, () => server.getAccount(signer.publicKey));
  const tx = new TransactionBuilder(account as unknown as Account, {
    fee: ctx.fee ?? BASE_FEE,
    networkPassphrase: ctx.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(ctx.timeoutSeconds ?? 60)
    .build();

  let prepared: Transaction;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw simulationFailure(message);
  }

  let signedXdr: string;
  try {
    signedXdr = await signer.signTransaction(prepared.toXDR(), { networkPassphrase: ctx.networkPassphrase });
  } catch (cause) {
    if (cause instanceof StellarTreasuryError) throw cause;
    throw new SignerError("The signer did not sign the transaction.", { cause });
  }
  const signed = TransactionBuilder.fromXDR(signedXdr, ctx.networkPassphrase) as Transaction;

  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR" || sent.status === "DUPLICATE" || sent.status === "TRY_AGAIN_LATER") {
    throw new TransactionFailedError(`The network rejected the transaction (${sent.status}).`, sent.hash);
  }

  const done = await withRetry(ctx, () => server.pollTransaction(sent.hash, { attempts: ctx.pollAttempts ?? 30 }));
  if (done.status === "SUCCESS") return { hash: sent.hash, returnValue: done.returnValue };
  if (done.status === "NOT_FOUND") {
    throw new TransactionTimeoutError("The transaction was not confirmed in time.", sent.hash);
  }
  throw new TransactionFailedError("The transaction failed on the network.", sent.hash);
}
