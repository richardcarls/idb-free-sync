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

## Synchronizing a Store

Records use string primary keys and should include a `modified` date. A local
key such as `abc` maps to the remote file `abc.json`.

```ts
import { syncStore } from './src/SyncOrchestrator';

await syncStore(db, transport, 'notes');
```

The default resolver compares local and remote modified timestamps. A custom
resolver can return `keep-local`, `keep-remote`, `delete`, or `ignore`.

## Available Transports

- `OPFSTransport`: browser Origin Private File System
- `NullTransport`: no-op sync provider

## Implementing a Transport

Custom transports must implement every `SyncTransport` method, return
`undefined` when `get` cannot find a value, and treat values as
JSON-serializable data.

## License

[MIT](./LICENSE)
