import { PublicClientApplication } from '@azure/msal-browser';

export function createMsalClient(clientId: string): PublicClientApplication {
  return new PublicClientApplication({
    auth: {
      clientId,
      authority: 'https://login.microsoftonline.com/common',
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'localStorage' },
  });
}
