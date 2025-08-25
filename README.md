# idb-free-sync

`idb-free-sync` wraps the [idb](https://github.com/jakearchibald/idb) library and implements a naive sync orchestration layer, keeping a user's local data stored in IndexedDB syncs with their personal cloud storage via simple JSON files. No server required.

## Installation

This project is not yet published. Build and include in your project locally for now.

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

- `NullTransport`: no-op sync provider (default transport)
- `OPFSTransport`: sync to browser Origin Private File System (OPFS)
- `GoogleDriveTransport`: sync to Google Drive (application data folder)
- `OneDriveTransport`: sync to Microsoft OneDrive (application folder)

## Implementing a Transport

Custom transports must implement every `SyncTransport` method, return
`undefined` when `get` cannot find a value, and treat values as
JSON-serializable data.

More bundled transports for popular cloud storage providers are planned.

## License

[MIT](./LICENSE)
