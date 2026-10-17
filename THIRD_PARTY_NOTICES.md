# License and dependency review

Copyright 2026 Lanjunyee. Project code and documentation are licensed under
Apache-2.0; see LICENSE. No warranty or support commitment is provided.

No third-party implementation is vendored or bundled in this source snapshot or
npm archive. Runtime dependencies are installed separately by npm and retain their
own licenses; they are not relicensed as Apache-2.0. Review of the locked runtime
closure:

| Package | Version | License | Result |
| --- | --- | --- | --- |
| proper-lockfile | 4.1.2 | MIT | Upstream LICENSE contains copyright and full permission/disclaimer; retained by dependency installation |
| graceful-fs | 4.2.11 | ISC | Upstream LICENSE contains copyright and full permission/disclaimer; retained by dependency installation |
| retry | 0.12.0 | MIT | Upstream License contains copyright and full permission/disclaimer; retained by dependency installation |
| signal-exit | 3.0.7 | ISC | Upstream LICENSE.txt contains copyright and full permission/disclaimer; retained by dependency installation |
| yaml | 2.9.1 | ISC | Upstream LICENSE contains copyright and full permission/disclaimer; retained by dependency installation |

The host Pi package is supplied by the user, not redistributed in this archive.
Development dependencies are not included in the runtime archive. The lockfile
records their individual license metadata. Tests use synthetic fixtures and host
APIs; no host implementation is copied. No additional upstream NOTICE requirement
was found in the distributed project files or the above runtime dependency
licenses. If vendoring or bundling is introduced, repeat the review and include
all applicable upstream copyright, permission, and notice texts in that artifact.
