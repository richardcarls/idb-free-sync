# free-sync

`free-sync` is a browser-focused TypeScript library for synchronizing IndexedDB
object stores with local or cloud-backed JSON files.

## Development

This repository uses Yarn 4 with Plug'n'Play.

```sh
yarn install
yarn format:check
yarn typecheck
yarn build
```

## Transport Contract

Storage providers implement `SyncTransport`, which lists, reads, writes,
deletes, and counts JSON files grouped by store name. Each provider returns
`SyncFileInfo` metadata for conflict comparison.

## Implementing a Transport

Custom transports must implement every `SyncTransport` method, return
`undefined` when `get` cannot find a value, and treat values as
JSON-serializable data.

## License

[MIT](./LICENSE)
