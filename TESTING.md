# Testing

`@rcarls/idb-free-sync` uses Vitest for deterministic unit and contract tests. Pull requests
and CI do not require provider credentials and must not make real cloud API
requests.

## Local Commands

```sh
yarn test
yarn test:run
yarn test:coverage
yarn test:package
yarn typecheck:test
```

`yarn test` starts watch mode. `yarn check` runs formatting, source and test
typechecking, enforced coverage, the package build, and a smoke test that
imports every declared package export.

Tests use:

- `fake-indexeddb` for synchronization behavior against an IndexedDB-compatible
  implementation
- MSW for exact HTTP request and response contracts
- Private provider adapters for deterministic OAuth and SDK construction tests

Coverage includes runtime source files while excluding the public barrel and
type-only transport contract. Deprecated `OPFSTransport` is also excluded
because CI does not exercise browser filesystem APIs. Per-file thresholds are
80% for statements, lines, and functions and 70% for branches.
`SyncOrchestrator` has stricter 95% statement, line, and function thresholds and
a 90% branch threshold.

## Future Live Provider Smoke Tests

Live tests should remain separate from pull-request checks. Run them only from a
protected maintainer workflow or manually, with isolated provider accounts and
unique test-store prefixes. Always remove records created by a smoke run.

### Google Drive

- Use a separate Google Cloud project and an approved OAuth test user.
- Keep the app in Testing status unless publication is intentionally required.
- Expect Testing-mode authorizations to expire after seven days.
- Limit files to the application's Drive data folder.

### Microsoft OneDrive

- Use a dedicated Microsoft Entra test tenant and separate app registration.
- Do not assume interactive sign-in can be reliably automated.
- Restrict storage to the application's OneDrive folder.

### Dropbox

- Use a dedicated Dropbox app and test account.
- Use short-lived or generated development tokens.
- Never reuse a personal production account for destructive smoke tests.

### WebDAV

- Prefer a disposable local WebDAV server or dedicated test account.
- Never point destructive tests at an existing user directory.

Provider secrets must never be available to fork pull-request workflows.
