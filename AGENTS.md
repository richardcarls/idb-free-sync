# Agent Guidance

## Repository Purpose

`@rcarls/idb-free-sync` is a browser-oriented TypeScript library that synchronizes `idb`
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
- Google Drive, OneDrive, and Dropbox are OAuth transports: each takes a
  `TokenProvider` (`() => Promise<string>`) in its constructor rather than
  driving sign-in itself. This library never touches `google`/`gapi` globals,
  MSAL's `PublicClientApplication`, or Dropbox's `DropboxAuth`. Obtaining and
  refreshing the token is entirely the host app's job, using each provider's
  own official client library. Google Drive talks to the Drive v3 REST API
  over `fetch` and stores data in `appDataFolder`; OneDrive talks to
  Microsoft Graph's application folder over `fetch`; Dropbox still uses the
  `dropbox` SDK's `Dropbox` class (not `DropboxAuth`) for data operations and
  stores files under `/Apps/RecipeTome`.
- WebDAV uses `/RecipeTome` and is not an OAuth transport: it takes
  connection config (URL, username/password, or bearer token) directly, since
  there's no "OAuth app" concept for an arbitrary self-hosted server.
- `NullTransport` is intentionally a no-op.

Do not silently rename provider storage roots or local-storage keys; applications
may already depend on them.

## Documentation

Keep `README.md` examples synchronized with the public API. Do not claim support
for server runtimes: built-in transports rely on browser APIs, globals, or
browser-oriented SDKs.

## Release Workflow

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning and
changelog generation, following GitFlow.

### Adding a changeset during feature work

After code changes on a `feature/*` or directly on `develop`, add an intent file:

```sh
yarn changeset
```

Select the bump type (`major` / `minor` / `patch`) and describe the change. Commit the
generated `.changeset/*.md` file alongside the code. Changesets accumulate on `develop`
until a release is cut.

### Cutting a release

```sh
# 1. Create a release branch from develop
git checkout -b release/vX.Y.Z develop

# 2. Apply all pending changesets: bumps package.json and writes CHANGELOG.md
yarn version:packages

# 3. Commit the version bump
git add .
git commit -m "chore(release): bump to vX.Y.Z"

# 4. Merge to main (no-ff), tag, and back-merge to develop
git checkout main
git merge --no-ff release/vX.Y.Z -m "chore(release): merge branch release/vX.Y.Z"
git tag vX.Y.Z
git checkout develop
git merge --no-ff main -m "chore(release): back-merge branch release/vX.Y.Z"
git branch -d release/vX.Y.Z

# 5. Push: the pushed tag triggers the release.yml publish workflow
git push origin main develop --tags
```

### First-time npm setup (one-time prerequisites)

Before the automated workflow can publish, complete these steps once:

1. **Initial publish**: if the package does not yet exist on npm, publish manually:

   ```sh
   yarn build
   npm publish --access=public
   ```

1. **Create the `npm` GitHub environment**: in repo Settings → Environments → New environment
   named `npm`. Optionally add required reviewers for a manual approval gate.

1. **Register npm Trusted Publishing**: on the package's npm settings page
   (`https://www.npmjs.com/package/@rcarls/idb-free-sync/access`), add a Trusted Publisher:
   GitHub Actions, this repository, workflow file `release.yml`, environment `npm`. No npm
   token is stored in GitHub; the workflow's `id-token: write` permission lets npm exchange
   its OIDC token for a short-lived publish credential at publish time.

   > `yarn npm publish` cannot perform this OIDC exchange: Yarn 4 only knows classic token
   > auth. `scripts/publish-package.mjs` has Yarn pack the tarball (so `workspace:*`-style
   > ranges resolve) but has the `npm` CLI (>=11.5.1) publish it, since only `npm publish`
   > performs the Trusted Publishing exchange and attaches provenance automatically.

### How publish works

Pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which:

1. Runs `yarn validate:release`: confirms HEAD carries an exact stable tag contained in
   `origin/main`, that `package.json`'s version matches the tag, and that no changesets remain
   pending.
1. Runs `yarn check`: builds the package and runs the full test suite.
1. Runs `yarn publish:package` (`scripts/publish-package.mjs`), which packs the tarball with
   Yarn, publishes it with `npm publish` under npm Trusted Publishing (OIDC; no stored token),
   and polls the registry until the published version's SLSA provenance attestation is
   visible. A version already published and verified is skipped rather than re-published.
