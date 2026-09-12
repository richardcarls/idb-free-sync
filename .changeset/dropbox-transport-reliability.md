---
'@rcarls/idb-free-sync': patch
---

Fix Dropbox sync reliability: bind fetch to avoid an illegal-invocation
error, stop doubling the app-folder path for App-folder-scoped access
tokens, and back off automatically on rate-limit (429) responses instead
of failing outright.
