# Contributing

Thanks for helping. This is the TypeScript SDK of Stellar Treasury.

> Open pull requests here. Maintainers also work on this code in the `sdk/` folder of the Soroban-Treasury monorepo, and the two are kept in sync automatically: changes merged here are pulled into the monorepo, and changes made there arrive here.

## Setup

```
npm install
npm run typecheck
npm test
npm run build
```

## Rules

- Every public function has JSDoc and a test.
- Errors are typed subclasses of `StellarTreasuryError`; do not throw bare `Error`.
- Validate input before touching the network (throw `InvalidInputError`).
- Keep the package ESM + CJS; no Node-only APIs in code the browser uses.
- Folders do not import each other by relative path; use declared dependencies.

## Open tasks

Marked in the code as `TODO(wave: ...)` or listed in the README under "Not built yet":

| Marker | Task |
|---|---|
| `sdk-1` | Wallet-adapter support (more wallets than a raw signer) |
| trivial | Usage examples |
| medium | Simulate-before-submit helper |

## Pull requests

Describe what changed and why, list the tests you added, and keep a pull request to one change.

## Conduct

Be kind and be specific. See the [Code of Conduct](CODE_OF_CONDUCT.md).
