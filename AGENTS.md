# Agent Guidance

## Repository Purpose

`idb-free-sync` is a browser-oriented TypeScript library that synchronizes `idb`
object stores with JSON-file storage providers. Keep changes focused on the
library's transport contract and sync behavior.

## Project Map

- `src/index.ts`: public package exports
- `src/SyncTransport.ts`: shared transport interface and file metadata
- `src/SyncOrchestrator.ts`: IndexedDB-to-transport synchronization logic
- `src/*Transport.ts`: provider implementations
- `vite.config.ts`: library build and declaration generation
- `dist/`: generated build output; do not edit by hand

## Tooling

- Package manager: Yarn 4 Plug'n'Play
- Language: strict TypeScript targeting ES2020 and browser DOM APIs
- Build: Vite library mode with `vite-plugin-dts`
- External peer dependency: `idb`

Use these validation commands:

```sh
yarn check
```

Vitest tests use fake IndexedDB, MSW, and private provider adapters. Keep tests
deterministic, credential-free, and safe for fork pull requests. See
`TESTING.md` for commands and coverage policy.

## Engineering Conventions

- Preserve the existing ESM TypeScript style and explicit type-only imports.
- Keep provider-specific authentication and API behavior inside its transport.
- Implement every `SyncTransport` method for new transports.
- Return `undefined` from `get` when a record is absent.
- Treat transport values as JSON-serializable data.
- Keep `SyncFileInfo.syncKey` equal to the provider file name.
- Keep public exports in `src/index.ts` aligned with public modules.
- Do not edit generated files in `dist/`; run `yarn build` to regenerate them.
- Keep test files outside `src/` so they do not enter published declarations.
- Test provider behavior through private adapters and MSW request contracts.
- Avoid unrelated formatting or refactoring.
- Use Conventional Commit subjects; the `commit-msg` hook enforces them.

## Sync Invariants

- `syncStore` assumes object-store primary keys are strings.
- A local key becomes `<key>.json`; changes to this mapping are compatibility
  changes.
- The default resolver uses local record `modified` values and remote metadata.
- Remote records that do not match a local key are downloaded.
- Local records that do not match a remote key are uploaded.
- Queue work runs concurrently, and current queue-level errors are logged.
- Soft deletes must remain consistent between transport metadata, stored JSON,
  and `SyncOptions.softDeleteField`.

Changes to conflict resolution, deletion, key mapping, or error propagation have
a broad behavioral impact. Document them in `README.md` and validate every
built-in transport they affect.

## Provider Notes

- OPFS depends on `navigator.storage.getDirectory()`.
- Google Drive depends on host-provided `google` and `gapi` globals and stores
  data in `appDataFolder`.
- OneDrive uses MSAL and Microsoft Graph's application folder.
- Dropbox reads `dropboxAccessToken` from `localStorage` and uses
  `/Apps/RecipeTome`.
- WebDAV uses `/RecipeTome`.
- `NullTransport` is intentionally a no-op.

Do not silently rename provider storage roots or local-storage keys; applications
may already depend on them.

## Documentation

Keep `README.md` examples synchronized with the public API. Do not claim support
for server runtimes: built-in transports rely on browser APIs, globals, or
browser-oriented SDKs.
