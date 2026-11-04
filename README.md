# treasury-sdk

TypeScript client for the Stellar Treasury contract: create a treasury, propose a payment, approve, execute, and list proposals. ESM and CJS, fully typed.

```
npm install treasury-sdk @stellar/stellar-sdk
```

## Quick start

```ts
import { Networks } from "@stellar/stellar-sdk";
import { TreasuryClient, keypairSigner } from "treasury-sdk";

const treasury = new TreasuryClient({
  contractId: "C...",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  signer: keypairSigner(process.env.OWNER_SECRET!),
});

// Owner 1 proposes. Their approval counts.
const { value: id } = await treasury.propose({
  asset: "C...",            // token contract id
  to: "G...",
  amount: 5_000_000n,       // smallest unit
  ttlSeconds: 3 * 24 * 3600,
});

// Owner 2 approves (a client with owner 2's signer), then anyone who is an owner executes.
await treasury.approve(id);
await treasury.execute(id);

const proposals = await treasury.listProposals({ limit: 20 }); // newest first
```

Read calls (`getConfig`, `getProposal`, `proposalCount`, `listProposals`, `getSpendLimit`, `getPolicyAssets`, `getSpent`) only simulate and need no signer.

### Create a treasury

```ts
const treasury = await TreasuryClient.create({
  wasmHash: "<hex hash of the uploaded contract wasm>",
  signer,
  owners: ["G...", "G...", "G..."],
  threshold: 2,
  // An asset can only be spent once it has a limit, so set the starting limits here.
  limits: [{ asset: "C...", limit: 50_000_000_000n, periodSeconds: 24 * 3600 }],
  rpcUrl,
  networkPassphrase: Networks.TESTNET,
});
```

This deploys the contract in one transaction. The owners, threshold and limits go to the contract's constructor, so setup happens at deployment and nobody can initialize the treasury before you. Limits are set at creation because changing them later needs several owners to authorize one call (see below).

### Mainnet

Use your mainnet RPC URL and `Networks.PUBLIC` as `networkPassphrase`. Nothing else changes.

## Signers

A signer is `{ publicKey, signTransaction(xdr, { networkPassphrase }) }`. `keypairSigner` is for scripts and servers. For a browser wallet, wrap the wallet's sign call in the same shape.

## Errors

Everything extends `StellarTreasuryError`. Contract errors extend `ContractError` and carry the contract's `code`:

```ts
import { OverLimitError, NotOwnerError } from "treasury-sdk";

try {
  await treasury.execute(id);
} catch (e) {
  if (e instanceof OverLimitError) console.log("Spending limit reached for this period");
  else throw e;
}
```

Other errors: `InvalidInputError` (bad input, nothing sent), `ConfigError` (for example a write call without a signer), `SimulationError`, `SignerError`, `TransactionFailedError`, `TransactionTimeoutError` (has `hash`; the transaction may still land).

Write calls simulate first, so contract errors are thrown before the user is asked to sign. `treasury.simulate(method, args)` is public if you want to check a call yourself.

## Limits of this version

- `setSpendLimit` and `removeSpendLimit` change limits after creation. They need authorization from `threshold` owners in one call, and the client only attaches the signer's own authorization, so they work when the signer alone meets the threshold. Collecting other owners' signatures is not built yet. Set the limits you need when you create the treasury.
- Contract bindings are written by hand, not generated.

Network errors on reads, polling and account lookups are retried (`retries`, default 3). Sending a transaction is not retried.

## Develop

```
npm install
npm test
npm run build
```

### Try it on testnet

`scripts/e2e-testnet.mjs` deploys the contract with two throwaway accounts and runs the whole flow (2 of 2 approval, spending limit, errors) through this SDK.
