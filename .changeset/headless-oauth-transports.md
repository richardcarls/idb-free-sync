---
'@rcarls/idb-free-sync': minor
---

Use host-provided token callbacks for Google Drive, OneDrive, and Dropbox
transports. This pre-1.0 breaking change removes built-in interactive OAuth.
Google Drive and OneDrive now call their REST APIs directly and advertise only
the data scopes each transport requires.
