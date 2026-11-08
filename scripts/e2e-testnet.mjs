// End-to-end check against Stellar testnet. Uses throwaway funded accounts.
//
//   npm run build
//   (cd ../contract && stellar contract build)
//   node scripts/e2e-testnet.mjs
//
// Deploys the treasury contract, then runs the whole flow through the SDK.
import { readFileSync } from "node:fs";
import {
  Asset,
  BASE_FEE,
  Contract,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  NotEnoughApprovalsError,
  OverLimitError,
  TreasuryClient,
  keypairSigner,
  transactionDeadline,
} from "../dist/index.js";

const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const WASM = process.env.WASM ?? new URL("../../contract/target/wasm32v1-none/release/treasury_contract.wasm", import.meta.url);
const XLM = 10_000_000n; // stroops

const server = new rpc.Server(RPC_URL);
const step = (msg) => console.log(`\n== ${msg}`);

async function fund(keypair) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot failed: ${res.status} ${await res.text()}`);
}

async function send(keypair, operation) {
  const account = await server.getAccount(keypair.publicKey());
  // Expire 60 s after the network's latest ledger, so a wrong local clock does not matter.
  const maxTime = await transactionDeadline(server, 60);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime },
  })
    .addOperation(operation)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ended as ${done.status}`);
  return done;
}

const alice = Keypair.random();
const bob = Keypair.random();

step("Fund two throwaway accounts");
await Promise.all([fund(alice), fund(bob)]);
console.log("alice", alice.publicKey());
console.log("bob  ", bob.publicKey());

step("Upload contract wasm");
const uploaded = await send(alice, Operation.uploadContractWasm({ wasm: readFileSync(WASM) }));
const wasmHash = Buffer.from(scValToNative(uploaded.returnValue)).toString("hex");
console.log("wasm hash", wasmHash);

step("Create treasury (owners: alice, bob; threshold 2; limit 50 XLM per hour)");
const common = { rpcUrl: RPC_URL, networkPassphrase: Networks.TESTNET };
const xlm = Asset.native().contractId(Networks.TESTNET);
const treasury = await TreasuryClient.create({
  ...common,
  wasmHash,
  signer: keypairSigner(alice),
  owners: [alice.publicKey(), bob.publicKey()],
  threshold: 2,
  limits: [{ asset: xlm, limit: 50n * XLM, periodSeconds: 3600 }],
});
console.log("treasury", treasury.contractId);
console.log("config  ", await treasury.getConfig());

step("Fund the treasury with 100 XLM");
await send(
  alice,
  new Contract(xlm).call(
    "transfer",
    new Address(alice.publicKey()).toScVal(),
    new Address(treasury.contractId).toScVal(),
    nativeToScVal(100n * XLM, { type: "i128" }),
  ),
);

step("Check the starting limit");
console.log("limit   ", await treasury.getSpendLimit(xlm));
console.log("assets  ", await treasury.getPolicyAssets());

step("Propose 10 XLM to bob as alice, approve as bob, execute as alice (2 of 2)");
const { value: id } = await treasury.propose({ asset: xlm, to: bob.publicKey(), amount: 10n * XLM, ttlSeconds: 3600 });
console.log("proposal id", id);

try {
  await treasury.execute(id);
  throw new Error("expected NotEnoughApprovalsError");
} catch (error) {
  if (!(error instanceof NotEnoughApprovalsError)) throw error;
  console.log("1 of 2 approvals, execute refused:", error.message);
}

const asBob = new TreasuryClient({ ...common, contractId: treasury.contractId, signer: keypairSigner(bob) });
await asBob.approve(id);
console.log("approvals ", (await treasury.getProposal(id)).approvals.length);
await treasury.execute(id);

const executed = await treasury.getProposal(id);
if (!executed.executed) throw new Error("proposal should be executed");
const spent = await treasury.getSpent(xlm);
if (spent !== 10n * XLM) throw new Error(`expected 10 XLM spent, got ${spent}`);
console.log("spent this period (stroops)", spent);

step("Over the limit is refused before signing");
try {
  await treasury.propose({ asset: xlm, to: bob.publicKey(), amount: 60n * XLM });
  throw new Error("expected OverLimitError");
} catch (error) {
  if (!(error instanceof OverLimitError)) throw error;
  console.log("OverLimitError:", error.message);
}

step("List proposals");
const list = await treasury.listProposals();
console.log(list.map((p) => ({ id: p.id, amount: p.amount, executed: p.executed })));

console.log("\nAll good.");
console.log(`TREASURY_IDS=${treasury.contractId}`);
