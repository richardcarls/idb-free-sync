# idb-free-sync

`idb-free-sync` is a browser-focused TypeScript library for synchronizing IndexedDB
object stores with cloud-backed JSON files.

It provides:

- A small `SyncTransport` interface for storage providers
- A `syncStore` orchestrator for syncing an `idb` object store
- Built-in transports for Google Drive, OneDrive, Dropbox, and WebDAV
- `NullTransport` for disabling sync without special-case application logic
- Custom conflict resolution and soft-delete support
- `blobFields` for syncing binary assets alongside records
- `OPFSBlobStore` for local OPFS-backed blob storage

## Installation

```sh
yarn add idb-free-sync idb
```

`idb` is a peer dependency. Cloud provider SDKs are bundled dependencies.

## Quick Start

Records must use string primary keys. By default, records should also have a
`modified` date so `syncStore` can decide whether the local or remote copy is
newer. If your schema stores the timestamp under a different name, set
`modifiedField` (see [Conflict Resolution](#conflict-resolution)).

```ts
import { openDB } from 'idb';
import { syncStore, type SyncTransport } from 'idb-free-sync';

type Note = {
  id: string;
  title: string;
  modified: Date;
};

const db = await openDB('notes-app', 1, {
  upgrade(database) {
    database.createObjectStore('notes', { keyPath: 'id' });
  },
});

// Configure one of the built-in cloud transports for your provider.
declare const transport: SyncTransport;

await syncStore<Note>(db, transport, 'notes');
```

For a record with the primary key `abc`, the transport stores a file named
`abc.json` inside the `notes` store directory.

## Conflict Resolution

The default resolver compares `local.modified` with the remote file's modified
timestamp:

- Remote soft deletion deletes the local record.
- If only one side has a modified timestamp, that side wins.
- The newer side wins.
- Equal timestamps are ignored.

If your schema stores the modification timestamp under a different key, set
`modifiedField` instead of writing a full custom resolver:

```ts
await syncStore(db, transport, 'notes', {
  modifiedField: 'updatedAt',
});
```

Provide a custom resolver when your data needs different behavior:

```ts
await syncStore(db, transport, 'notes', {
  resolve(local, remote) {
    if (remote.deleted) return 'delete';
    return local.pinned ? 'keep-local' : 'keep-remote';
  },
});
```

A resolver returns one of:

```ts
type ConflictResolution = 'keep-local' | 'keep-remote' | 'delete' | 'ignore';
```

`syncStore` uploads local-only records and downloads remote-only records. Queue
operations run in parallel. Individual queue failures are logged rather than
causing `syncStore` to reject.

## Soft Deletes

Cloud transports support soft deletion by rewriting a remote JSON object with
`deleted: true`. To avoid restoring a downloaded soft-deleted value locally,
identify the corresponding record field:

```ts
await syncStore(db, transport, 'notes', {
  softDeleteField: 'deleted',
});
```

The default resolver recognizes soft deletion only when the transport exposes
it through `SyncFileInfo.deleted`. Currently, Google Drive exposes that metadata
during listing; other built-in cloud transports store the marker in file
content.

## Transports

### Google Drive

```ts
const transport = new GoogleDriveTransport(googleOAuthClientId);
```

The host page must load Google Identity Services and the Google API client so
the global `google` and `gapi` objects are available. Files are stored in the
Google Drive application data folder. An optional `syncUserId` value in
`localStorage` is used as the OAuth login hint.

Required scopes are available from `transport.scopes`.

### OneDrive

```ts
const transport = new OneDriveTransport(microsoftApplicationClientId);
```

Uses MSAL browser authentication and Microsoft Graph. Configure the application
redirect URI to match `window.location.origin`. Files are stored in the
application folder.

### Dropbox

```ts
localStorage.setItem('dropboxAccessToken', accessToken);
const transport = new DropboxTransport();
```

Uses the access token from `localStorage.dropboxAccessToken`. Files are stored
under `/Apps/RecipeTome`.

### WebDAV

```ts
const transport = new WebDAVTransport({
  url: 'https://cloud.example.com/remote.php/dav/files/user',
  username: 'user',
  password: 'app-password',
});
```

Bearer token authentication is also supported:

```ts
const transport = new WebDAVTransport({ url, token });
```

Files are stored under `/RecipeTome`.

### No Sync

```ts
const transport = new NullTransport();
```

`NullTransport` implements the interface without persisting anything.

## Blob Fields

When records reference binary assets — images captured by the app, attachments,
audio clips — `blobFields` lets you sync those binaries alongside the JSON
records using the same transport.

### Local storage: OPFSBlobStore

`OPFSBlobStore` stores blobs in the Origin Private File System, keyed by a
stable identifier (typically a content hash). A Service Worker can intercept
URL requests and serve blobs from OPFS, making them usable as `<img src>` or
`<audio src>` values.

```ts
import { OPFSBlobStore } from 'idb-free-sync';

const imageStore = new OPFSBlobStore('recipe-images');

// Store a captured blob
await imageStore.put('sha256-abc123', capturedBlob);

// Check existence
const exists = await imageStore.has('sha256-abc123');
```

### Service Worker integration (app-side)

```ts
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/_cache/')) {
    const key = url.pathname.slice('/_cache/'.length);

    event.respondWith(
      navigator.storage
        .getDirectory()
        .then((root) => root.getDirectoryHandle('recipe-images'))
        .then((dir) => dir.getFileHandle(key))
        .then((fh) => fh.getFile())
        .then((file) => new Response(file))
        .catch(() => new Response('Not found', { status: 404 })),
    );
  }
});
```

### Syncing blobs with records

Configure `blobFields` in `syncStore` to sync blobs alongside JSON records. The
transport must implement `BlobSyncTransport` — all built-in transports do.

Remote JSON stores the raw blob key; `keyFromValue` and `valueFromKey` map
between that key and the local field value (such as a `/_cache/` URL). This
keeps remote files transport-agnostic.

Blobs are stored in a sibling directory named `<storeName>-blobs/` so they do
not appear in the record listing.

```ts
import { OPFSBlobStore, syncStore } from 'idb-free-sync';

type Recipe = {
  id: string;
  name: string;
  imageUrl?: string; // '/_cache/<hash>' locally, '<hash>' in remote JSON
  modified: Date;
};

const imageStore = new OPFSBlobStore('recipe-images');

await syncStore<Recipe>(db, transport, 'recipes', {
  modifiedField: 'modified',
  softDeleteField: 'deleted',
  blobFields: {
    imageUrl: {
      blobStore: imageStore,
      keyFromValue: (url) => url.replace('/_cache/', ''), // '/_cache/abc' → 'abc'
      valueFromKey: (key) => `/_cache/${key}`, // 'abc' → '/_cache/abc'
      contentType: 'image/jpeg',
    },
  },
});
```

**Upload path:** For each record being uploaded, any blob referenced by a
`blobFields` field is pushed to the transport (skipped if already present
remotely). The record's field value is replaced with the raw key in remote JSON.

**Download path:** For each record being downloaded, any blob key referenced in
a `blobFields` field is fetched from the transport and stored locally (skipped
if already present). The field value is rewritten to the local URL before the
record is written to IDB.

**Conflict resolution:** Blob conflict resolution is implicit — the same key
means the same content, so blobs are never merged. The record's conflict
resolution (keep-local, keep-remote, etc.) determines which blobs move.

### Implementing BlobSyncTransport

To add blob support to a custom transport, implement `BlobSyncTransport`:

```ts
import type { BlobSyncTransport, SyncFileInfo } from 'idb-free-sync';

class CustomTransport implements BlobSyncTransport {
  // ... SyncTransport methods ...

  async putBlob(
    storeName: string,
    blobKey: string,
    blob: Blob,
    contentType?: string,
  ): Promise<SyncFileInfo> {
    // Upload blob to <storeName>-blobs/<blobKey>
  }

  async getBlob(storeName: string, blobKey: string): Promise<Blob | undefined> {
    // Download blob from <storeName>-blobs/<blobKey>
  }

  async listBlobs(storeName: string): Promise<SyncFileInfo[]> {
    // List all blobs in <storeName>-blobs/
  }

  async deleteBlob(storeName: string, blobKey: string): Promise<void> {
    // Delete blob at <storeName>-blobs/<blobKey>
  }
}
```

Use `isBlobSyncTransport(transport)` to check whether a transport supports
blob sync at runtime.

## Roadmap

A user-visible device-folder transport could use the File System Access API,
but it would require the user to select a directory and grant permissions
through an interactive browser flow. It is intentionally treated as a possible
export or local-folder feature rather than transparent synchronization.

## Implementing a Transport

Implement `SyncTransport` to add another provider:

```ts
import type { SyncFileInfo, SyncTransport } from 'idb-free-sync';

class CustomTransport implements SyncTransport {
  readonly provider = 'custom';
  readonly scopes: string[] = [];

  list(storeName: string): Promise<SyncFileInfo[]> {
    throw new Error('Not implemented');
  }

  get<T>(storeName: string, syncKey: string): Promise<T | undefined> {
    throw new Error('Not implemented');
  }

  put<T>(storeName: string, syncKey: string, value: T): Promise<SyncFileInfo> {
    throw new Error('Not implemented');
  }

  delete(storeName: string, syncKey: string, soft?: boolean): Promise<void> {
    throw new Error('Not implemented');
  }

  deleteAll(storeName: string, soft?: boolean): Promise<void> {
    throw new Error('Not implemented');
  }

  count(storeName: string): Promise<number> {
    throw new Error('Not implemented');
  }
}
```

Transport values must be JSON-serializable. `syncKey` values are file names,
normally `<primary-key>.json`.

## Development

This repository uses Yarn 4 with Plug'n'Play.

```sh
yarn install
yarn check
```

`yarn build` creates ESM, CommonJS, source map, and declaration outputs in
`dist/`. See [TESTING.md](./TESTING.md) for test commands, coverage policy, and
cloud-provider testing guidance.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup,
commit conventions, and pull request guidance. Please report security issues
according to [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
