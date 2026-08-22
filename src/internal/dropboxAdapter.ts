import { Dropbox } from 'dropbox';

export function createDropboxClient(accessToken: string): Dropbox {
  // Pass globalThis.fetch explicitly so the SDK never uses node-fetch
  return new Dropbox({ accessToken, fetch: globalThis.fetch });
}
