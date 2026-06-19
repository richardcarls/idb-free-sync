import { Dropbox } from 'dropbox';

export function createDropboxClient(): Dropbox {
  const token = localStorage.getItem('dropboxAccessToken') ?? '';

  // Pass globalThis.fetch explicitly so the SDK never uses node-fetch
  return new Dropbox({ accessToken: token, fetch: globalThis.fetch });
}
