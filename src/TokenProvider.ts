/**
 * Returns a valid bearer access token for a cloud provider's API, obtaining
 * or refreshing it as needed. Implemented entirely by the host app — this
 * library never drives interactive OAuth (popups, redirects, PKCE) itself,
 * so each cloud transport calls this before an API operation and has no
 * knowledge of how the token was obtained.
 */
export type TokenProvider = () => Promise<string>;
