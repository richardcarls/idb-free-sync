import { Dropbox } from 'dropbox';

export function createDropboxClient(): Dropbox {
  const token = localStorage.getItem('dropboxAccessToken') ?? '';
  return new Dropbox({ accessToken: token });
}
