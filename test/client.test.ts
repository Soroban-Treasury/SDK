import { Account, Keypair, Networks, StrKey, Transaction, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  ConfigError,
  InvalidInputError,
  NotOwnerError,
  OverLimitError,
  SimulationError,
  StellarTreasuryError,
  TransactionFailedError,
  TransactionTimeoutError,
  TreasuryClient,
  keypairSigner,
  parseContractError,
  type RpcLike,
} from "../src/index.js";

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 1));
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 2));
const alice = Keypair.random();
const bob = Keypair.random();
const carol = Keypair.random();

function retvalOf(value: unknown, type?: string): xdr.ScVal {
  return nativeToScVal(value as never, (type ? { type } : undefined) as never);
}

type FakeServer = RpcLike & {
  getAccount: Mock;
  simulateTransaction: Mock;
  prepareTransaction: Mock;
  sendTransaction: Mock;
  pollTransaction: Mock;
};

function fakeServer(overrides: Partial<Record<keyof RpcLike, unknown>> = {}): FakeServer {
  return {
    getAccount: vi.fn(async (id: string) => new Account(id, "100")),
    simulateTransaction: vi.fn(async () => ({ result: { retval: xdr.ScVal.scvVoid() } })),
    prepareTransaction: vi.fn(async (tx: Transaction) => tx),
    sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "abc123" })),
    pollTransaction: vi.fn(async () => ({ status: "SUCCESS", returnValue: xdr.ScVal.scvVoid() })),
    ...overrides,
  } as unknown as FakeServer;
}

function client(server: RpcLike, withSigner = true) {
  return new TreasuryClient({
    contractId: CONTRACT,
    networkPassphrase: Networks.TESTNET,
    server,
    signer: withSigner ? keypairSigner(alice) : undefined,
  });
}

/** Name and argument count of the contract call inside a transaction. */
function callOf(tx: Transaction) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const op = tx.operations[0] as any;
  const invoke = op.func.invokeContract as { functionName: { toString(): string }; args: xdr.ScVal[] };
  return { name: invoke.functionName.toString(), args: invoke.args };
}

describe("construction", () => {
  it("needs rpcUrl or server", () => {
    expect(() => new TreasuryClient({ contractId: CONTRACT, networkPassphrase: Networks.TESTNET })).toThrow(
      ConfigError,
    );
  });

  it("rejects a bad contract id", () => {
    expect(() => client({} as RpcLike).contractId).not.toThrow();
    expect(
      () => new TreasuryClient({ contractId: "nope", networkPassphrase: Networks.TESTNET, server: fakeServer() }),
    ).toThrow(InvalidInputError);
  });
});

describe("read calls", () => {
  it("getConfig converts owners and threshold", async () => {
    const server = fakeServer({
      simulateTransaction: vi.fn(async () => ({
        result: {
          retval: retvalOf({ owners: [alice.publicKey(), bob.publicKey()], threshold: 2 }),
        },
      })),
    });
    // Contract structs come back as maps with symbol keys; nativeToScVal builds the same shape.
    const config = await client(server, false).getConfig();
    expect(config.threshold).toBe(2);
    expect(config.owners).toHaveLength(2);
  });

  it("getProposal returns a typed proposal", async () => {
    const raw = {
      id: retvalOf(7n, "u64"),
    };
    expect(raw.id).toBeDefined();
    const server = fakeServer({
      simulateTransaction: vi.fn(async () => ({
        result: {
          retval: xdr.ScVal.scvMap(
            [
              ["amount", nativeToScVal(500n, { type: "i128" })],
              ["approvals", xdr.ScVal.scvVec([nativeToScVal(alice.publicKey(), { type: "address" })])],
              ["asset", nativeToScVal(ASSET, { type: "address" })],
              ["executed", xdr.ScVal.scvBool(false)],
              ["expires_at", nativeToScVal(2000n, { type: "u64" })],
              ["id", nativeToScVal(7n, { type: "u64" })],
              ["proposer", nativeToScVal(alice.publicKey(), { type: "address" })],
              ["to", nativeToScVal(bob.publicKey(), { type: "address" })],
            ].map(
              ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k as string), val: v as xdr.ScVal }),
            ),
          ),
        },
      })),
    });
    const proposal = await client(server, false).getProposal(7);
    expect(proposal).toEqual({
      id: 7n,
      proposer: alice.publicKey(),
      asset: ASSET,
      to: bob.publicKey(),
      amount: 500n,
      approvals: [alice.publicKey()],
      executed: false,
      expiresAt: 2000n,
    });
    const tx = server.simulateTransaction.mock.calls[0]![0] as Transaction;
    expect(callOf(tx).name).toBe("get_proposal");
  });

  it("maps a contract error from simulation", async () => {
    const server = fakeServer({
      simulateTransaction: vi.fn(async () => ({ error: "HostError: Error(Contract, #6)\nEvent log" })),
    });
    await expect(client(server, false).getConfig()).rejects.toBeInstanceOf(NotOwnerError);
  });

  it("wraps other simulation errors", async () => {
    const server = fakeServer({ simulateTransaction: vi.fn(async () => ({ error: "boom" })) });
    await expect(client(server, false).getConfig()).rejects.toBeInstanceOf(SimulationError);
  });

  it("listProposals returns newest first and respects offset and limit", async () => {
    const calls: bigint[] = [];
    const server = fakeServer({
      simulateTransaction: vi.fn(async (tx: Transaction) => {
        const { name, args } = callOf(tx);
        if (name === "proposal_count") return { result: { retval: nativeToScVal(5n, { type: "u64" }) } };
        calls.push(scValToNative(args[0]!));
        return { result: { retval: xdr.ScVal.scvVoid() } };
      }),
    });
    const c = client(server, false);
    // get_proposal returns void here, so conversion fails; we only care which ids were asked for.
    await c.listProposals({ limit: 2 }).catch(() => undefined);
    expect(calls.sort()).toEqual([3n, 4n]);
    calls.length = 0;
    await c.listProposals({ offset: 3, limit: 10 }).catch(() => undefined);
    expect(calls.sort()).toEqual([0n, 1n]);
  });

  it("listProposals is empty for an empty treasury", async () => {
    const server = fakeServer({
      simulateTransaction: vi.fn(async () => ({ result: { retval: nativeToScVal(0n, { type: "u64" }) } })),
    });
    expect(await client(server, false).listProposals()).toEqual([]);
  });
});

describe("write calls", () => {
  it("propose sends the right call and returns the id", async () => {
    const server = fakeServer({
      pollTransaction: vi.fn(async () => ({
        status: "SUCCESS",
        returnValue: nativeToScVal(3n, { type: "u64" }),
      })),
    });
    const result = await client(server).propose({ asset: ASSET, to: bob.publicKey(), amount: 250n });
    expect(result).toEqual({ hash: "abc123", value: 3n });

    const sent = server.sendTransaction.mock.calls[0]![0] as Transaction;
    const { name, args } = callOf(sent);
    expect(name).toBe("propose");
    expect(args).toHaveLength(5);
    expect(sent.signatures).toHaveLength(1);
    // Default lifetime is 7 days.
    expect(scValToNative(args[4]!)).toBe(7n * 24n * 3600n);
  });

  it("approve and execute pass the signer and id", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.approve(4);
    await c.execute("4");
    const names = server.sendTransaction.mock.calls.map((call) => callOf(call[0] as unknown as Transaction));
    expect(names.map((n) => n.name)).toEqual(["approve", "execute"]);
    expect(scValToNative(names[0]!.args[1]!)).toBe(4n);
  });

  it("needs a signer", async () => {
    const c = client(fakeServer(), false);
    await expect(c.approve(1)).rejects.toBeInstanceOf(ConfigError);
    await expect(c.execute(1)).rejects.toBeInstanceOf(ConfigError);
    await expect(c.propose({ asset: ASSET, to: bob.publicKey(), amount: 1 })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("maps a contract error raised while preparing", async () => {
    const server = fakeServer({
      prepareTransaction: vi.fn(async () => {
        throw new Error("Simulation failed: Error(Contract, #10)");
      }),
    });
    const err = await client(server)
      .execute(1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OverLimitError);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("reports a rejected submission", async () => {
    const server = fakeServer({ sendTransaction: vi.fn(async () => ({ status: "ERROR", hash: "h" })) });
    await expect(client(server).execute(1)).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it("reports a failed transaction", async () => {
    const server = fakeServer({ pollTransaction: vi.fn(async () => ({ status: "FAILED" })) });
    await expect(client(server).execute(1)).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it("reports a timeout with the hash", async () => {
    const server = fakeServer({ pollTransaction: vi.fn(async () => ({ status: "NOT_FOUND" })) });
    const err = (await client(server)
      .execute(1)
      .catch((e: unknown) => e)) as TransactionTimeoutError;
    expect(err).toBeInstanceOf(TransactionTimeoutError);
    expect(err.hash).toBe("abc123");
  });

  it("wraps a failing signer", async () => {
    const c = new TreasuryClient({
      contractId: CONTRACT,
      networkPassphrase: Networks.TESTNET,
      server: fakeServer(),
      signer: {
        publicKey: alice.publicKey(),
        signTransaction: async () => {
          throw new Error("user rejected");
        },
      },
    });
    await expect(c.execute(1)).rejects.toMatchObject({ name: "SignerError" });
  });
});

describe("network retries", () => {
  const withRetries = (server: RpcLike, extra = {}) =>
    new TreasuryClient({
      contractId: CONTRACT,
      networkPassphrase: Networks.TESTNET,
      server,
      signer: keypairSigner(alice),
      retryDelayMs: 1,
      ...extra,
    });

  it("retries polling after a network error", async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ status: "SUCCESS", returnValue: xdr.ScVal.scvVoid() });
    const result = await withRetries(fakeServer({ pollTransaction: poll })).execute(1);
    expect(result.hash).toBe("abc123");
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("retries a read after a network error", async () => {
    const sim = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ result: { retval: nativeToScVal(4n, { type: "u64" }) } });
    expect(await withRetries(fakeServer({ simulateTransaction: sim })).proposalCount()).toBe(4n);
  });

  it("gives up after the retries", async () => {
    const sim = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(withRetries(fakeServer({ simulateTransaction: sim }), { retries: 2 }).proposalCount()).rejects.toThrow(
      "fetch failed",
    );
    expect(sim).toHaveBeenCalledTimes(3);
  });

  it("does not retry a contract error", async () => {
    const sim = vi.fn(async () => ({ error: "Error(Contract, #6)" }));
    await expect(withRetries(fakeServer({ simulateTransaction: sim })).proposalCount()).rejects.toBeInstanceOf(
      NotOwnerError,
    );
    expect(sim).toHaveBeenCalledTimes(1);
  });
});

describe("input validation", () => {
  it("rejects bad amounts before touching the network", async () => {
    const server = fakeServer();
    const c = client(server);
    for (const amount of [0, -1, 1.5, "abc"]) {
      await expect(c.propose({ asset: ASSET, to: bob.publicKey(), amount })).rejects.toBeInstanceOf(
        InvalidInputError,
      );
    }
    expect(server.getAccount).not.toHaveBeenCalled();
  });

  it("rejects bad addresses", async () => {
    await expect(
      client(fakeServer()).propose({ asset: "x", to: bob.publicKey(), amount: 1 }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects a bad threshold", async () => {
    const c = client(fakeServer());
    await expect(c.initialize([alice.publicKey()], 2)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(c.initialize([], 1)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("create rejects a bad wasm hash", async () => {
    await expect(
      TreasuryClient.create({
        wasmHash: "zz",
        signer: keypairSigner(alice),
        owners: [alice.publicKey(), bob.publicKey(), carol.publicKey()],
        threshold: 2,
        networkPassphrase: Networks.TESTNET,
        server: fakeServer(),
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("initialize", () => {
  it("sends owners, threshold and limits", async () => {
    const server = fakeServer();
    await client(server).initialize([alice.publicKey(), bob.publicKey()], 2, [
      { asset: ASSET, limit: 1000n, periodSeconds: 86400 },
    ]);
    const sent = server.sendTransaction.mock.calls[0]![0] as Transaction;
    const { name, args } = callOf(sent);
    expect(name).toBe("initialize");
    expect(args).toHaveLength(3);
    expect(scValToNative(args[1]!)).toBe(2);
    expect(scValToNative(args[2]!)).toEqual([{ asset: ASSET, limit: 1000n, period: 86400n }]);
  });

  it("defaults to no limits", async () => {
    const server = fakeServer();
    await client(server).initialize([alice.publicKey()], 1);
    const sent = server.sendTransaction.mock.calls[0]![0] as Transaction;
    expect(scValToNative(callOf(sent).args[2]!)).toEqual([]);
  });

  it("rejects a bad limit before sending", async () => {
    const server = fakeServer();
    await expect(
      client(server).initialize([alice.publicKey()], 1, [{ asset: ASSET, limit: 0, periodSeconds: 60 }]),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  it("parses contract error codes", () => {
    expect(parseContractError("Error(Contract, #10)")).toBeInstanceOf(OverLimitError);
    expect(parseContractError("Error(Contract, #10)")?.code).toBe(10);
    expect(parseContractError("Error(Contract, #999)")).toBeUndefined();
    expect(parseContractError("nothing here")).toBeUndefined();
  });

  it("all errors share a base class and keep their names", () => {
    const err = new OverLimitError();
    expect(err).toBeInstanceOf(StellarTreasuryError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OverLimitError");
  });
});
