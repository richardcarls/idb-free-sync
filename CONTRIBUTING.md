# Contributing

Thanks for helping improve `@rcarls/idb-free-sync`. Bug reports, provider integrations,
documentation improvements, and focused fixes are welcome.

## Before Opening an Issue

- Search existing issues before creating a new one.
- Include the browser, storage provider, and a minimal reproduction for bugs.
- Do not include access tokens, passwords, client secrets, or private data.
- For security issues, follow [SECURITY.md](./SECURITY.md).

## Development

This project uses Yarn 4 with Plug'n'Play and requires a modern Node.js release.

```sh
yarn install
yarn check
```

Useful individual commands:

```sh
yarn format
yarn format:check
yarn typecheck
yarn typecheck:test
yarn test:run
yarn test:coverage
yarn test:package
yarn build
```

Tests must remain deterministic and must not require cloud-provider credentials
or make real provider requests. See [TESTING.md](./TESTING.md).

## Pull Requests

- Keep changes focused and avoid unrelated refactors.
- Update `README.md` when public API or behavior changes.
- Run `yarn check` before opening the pull request.
- Add or update transport behavior consistently across affected providers.
- Add or update tests for behavior changes and keep coverage thresholds passing.
- Explain compatibility implications for changes to key mapping, conflict
  resolution, deletion, storage roots, or authentication.

## Commit Messages

Use Conventional Commits:

```text
type(optional-scope): concise imperative summary
```

Examples:

```text
feat(transport): add S3 transport
fix(orchestrator): preserve remote deletion metadata
docs: clarify WebDAV authentication
```

Allowed types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
`refactor`, `revert`, `style`, and `test`.

After `yarn install`, local Git hooks check formatting before a commit and
validate the commit message afterward.
