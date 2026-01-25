/// <reference types="gapi" />
/// <reference types="gapi.client.drive-v3" />
/// <reference types="google.accounts" />

export function getGoogleClient(
  clientId: string,
  scopes: readonly string[],
): Promise<typeof gapi.client> {
  if (globalThis.gapi?.client) {
    return Promise.resolve(globalThis.gapi.client);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!globalThis.google || !globalThis.gapi) {
        return;
      }

      clearTimeout(timeout);
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: scopes.join(' '),
        prompt: '',
        login_hint: window.localStorage.getItem('syncUserId') ?? undefined,
        callback: (tokenResponse: google.accounts.oauth2.TokenResponse) => {
          gapi.load('client', async () => {
            await gapi.client.init({
              discoveryDocs: [
                'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
              ],
            });

            if (tokenResponse?.access_token) {
              gapi.auth.setToken(tokenResponse);
            }

            resolve(gapi.client);
          });
        },
      });

      tokenClient.requestAccessToken();
    }, 1000);
  });
}
