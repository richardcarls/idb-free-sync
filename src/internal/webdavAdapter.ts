import { createClient, type WebDAVClient } from 'webdav';

import type { WebDAVConfig } from '../WebDAVTransport';

export function createWebDAVClient(config: WebDAVConfig): WebDAVClient {
  return createClient(config.url, {
    username: config.username,
    password: config.password,
    token: config.token
      ? { token_type: 'Bearer', access_token: config.token }
      : undefined,
  });
}
