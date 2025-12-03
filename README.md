# idb-free-sync

`idb-free-sync` wraps the [idb](https://github.com/jakearchibald/idb)
library with a simple JSON-based sync orchestration layer. It primarily supports personal cloud storage, so an application can offer
remote data persistence and synchronization without operating its own sync server.

> [!WARNING]
> This project is under active development and is not ready for publication or
> production use. Provider setup, storage paths, and public APIs may change.

## Installation

The package is not published. Clone it, install dependencies, and build it
locally:

```sh
yarn install
yarn build
```

During development, import from `src/index.ts` or consume the local build from
`dist`.

## Development

This repository uses Yarn 4 with Plug'n'Play.

```sh
yarn install
yarn format:check
yarn typecheck
yarn build
```

## Basic Usage

Open an IndexedDB database with `idb`, select a transport, and synchronize one
object store at a time:

```ts
import { openDB } from 'idb';

import { OPFSTransport, syncStore } from './src';

const db = await openDB('example', 1, {
  upgrade(database) {
    database.createObjectStore('notes', { keyPath: 'id' });
  },
});

const transport = new OPFSTransport();

await syncStore(db, transport, 'notes');
```

Records must use string primary keys. A local key such as `abc` maps to the
remote file `abc.json`.

Records should also include a `modified` field of type `Date` when using the default conflict
resolver. The resolver keeps the most recently modified copy, honors remote
deletion metadata, and otherwise leaves equal records unchanged.

If a schema stores that timestamp under another key, configure
`modifiedField`:

```ts
await syncStore(db, transport, 'notes', {
  modifiedField: 'updatedAt',
});
```

```ts
await db.put('notes', {
  id: 'abc',
  title: 'Example',
  modified: new Date(),
});
```

### Conflict Resolution

A custom resolver can return `keep-local`, `keep-remote`, `delete`, or
`ignore`:

```ts
await syncStore(db, transport, 'notes', {
  resolve(local, remote) {
    return local.modified && remote.modified && local.modified > remote.modified
      ? 'keep-local'
      : 'keep-remote';
  },
  softDeleteField: 'deleted',
});
```

When `softDeleteField` is set, downloaded records with a truthy value in that
field are not written to IndexedDB. The bundled cloud transports implement soft
deletion by storing `deleted: true` in the remote JSON record.

## Transports

All transports are implemented client-side, only relying on provider OAuth flow and APIs.

### NullTransport

`NullTransport` implements the transport contract without persisting anything.
It is useful when synchronization is disabled while the rest of the
application still expects a transport.

```ts
import { NullTransport } from './src';

const transport = new NullTransport();
```

### Origin Private File System (OPFS)

`OPFSTransport` stores files in the browser's Origin Private File System under
`/<storeName>/<recordKey>.json`.

```ts
import { OPFSTransport } from './src';

const transport = new OPFSTransport();
```

OPFS is local to the browser profile and origin, so it does not provide
cross-device cloud sync. It currently exists primarily for development and
transport testing and will probably be removed in the future. Browser support for
`navigator.storage.getDirectory()` and async directory iteration is required. Its
delete operations are always permanent; it does not currently implement soft
deletion.

### Google Drive

`GoogleDriveTransport` stores records in Google Drive's hidden application-data
space. Each IndexedDB store becomes a folder beneath `appDataFolder`.

```ts
import { GoogleDriveTransport } from './src';

const transport = new GoogleDriveTransport('GOOGLE_OAUTH_CLIENT_ID');
```

The host application must:

- Create a browser OAuth client in Google Cloud and allow the application's
  origin.
- Load Google Identity Services and the Google API client so the global
  `google` and `gapi` objects are available.
- Enable the Google Drive API.

The transport requests `drive.appdata` and `drive.file` scopes lazily. It uses
the optional `syncUserId` local-storage value as a Google login hint.

### Microsoft OneDrive

`OneDriveTransport` stores records in the application's OneDrive app folder,
with one child folder per IndexedDB store.

```ts
import { OneDriveTransport } from './src';

const transport = new OneDriveTransport('MICROSOFT_ENTRA_CLIENT_ID');
```

Register a single-page application in Microsoft Entra, configure the
application origin as a redirect URI, and allow the
`Files.ReadWrite.AppFolder`, `openid`, and `profile` scopes. Authentication is
requested lazily through MSAL. The transport attempts silent authentication
first and falls back to a popup, with authentication state cached in local
storage.

### Dropbox

`DropboxTransport` stores records beneath
`/Apps/RecipeTome/<storeName>/<recordKey>.json`.

```ts
import { DropboxTransport } from './src';

localStorage.setItem('dropboxAccessToken', accessToken);

const transport = new DropboxTransport();
```

The host application is responsible for completing Dropbox OAuth and storing
the current access token in the `dropboxAccessToken` local-storage entry before
using the transport. The transport does not currently refresh expired tokens or
manage Dropbox OAuth scopes.

### WebDAV

`WebDAVTransport` stores records beneath
`/RecipeTome/<storeName>/<recordKey>.json` on a WebDAV server.

```ts
import { WebDAVTransport } from './src';

const transport = new WebDAVTransport({
  url: 'https://dav.example.com',
  username: 'user',
  password: 'password',
});
```

Bearer-token authentication is also supported:

```ts
const transport = new WebDAVTransport({
  url: 'https://dav.example.com',
  token: accessToken,
});
```

The server must allow browser requests from the application's origin. Parent
folders are created recursively when records are written.

## Transport Contract

Storage providers implement `SyncTransport`, which lists, reads, writes,
deletes, and counts JSON files grouped by store name. Each provider returns
`SyncFileInfo` metadata for conflict comparison.

Custom transports must implement every `SyncTransport` method, return
`undefined` when `get` cannot find a value, and treat values as
JSON-serializable data. `list` and `put` should return provider-neutral
`SyncFileInfo` metadata, including a stable `syncKey` and provider modification
date when available.

## License

[MIT](./LICENSE)
