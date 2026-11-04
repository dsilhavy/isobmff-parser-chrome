# Changelog

All notable changes to this project are documented here. Versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-04

First release.

### Segments

- Captures ISOBMFF/CMAF init and media segments by content sniffing, grouped by URL template, with codec strings per group
- Box tree, decoded fields and hex view with field ↔ byte highlighting; extra decoders for `senc`, `saiz`, `saio`, `avcC`, `hvcC`, `av1C`, `vpcC`, `esds`, `dOps`, and `pssh` / `tenc` with DRM system names and KIDs
- Structural and timing checks: mdat vs. `trun` sizes, missing `tfdt`, gaps and overlaps, CMAF chunk continuity, segments not starting on a sync sample
- Timeline with one lane per track, `emsg` markers, sync ticks, A/V offset and `prft` wall-clock time
- `trun` sample statistics and frame types read from `mdat` (AVC, HEVC, AV1)
- Init segment diff and **Save all** as a zip

### DRM / EME

- **Reload & capture EME** injects a hook that records every EME call, result and event
- Decodes init data (`cenc`, `keyids`, `webm`, `skd`), Widevine license requests, licenses and service certificates, PlayReady challenges and XMR licenses, ClearKey requests and JWK licenses, and FairPlay SPC headers
- Matches license messages to their network POST, with URL, status, headers and bodies
- Overview of granted configurations, sessions, key statuses (with Widevine track labels and security levels) and all KIDs with where they were seen; clicking a KID opens the segment box
- Checks for rejected calls, failed license requests, SOAP faults, non-usable key statuses, missing `update()`, `waitingforkey` without a usable key, missing robustness and segment KIDs without a key
- Sequence diagram (App · Browser/CDM · License server)
- `eme/eme-log.json` in **Save all**, limited to matched license exchanges with credential headers redacted

[1.0.0]: https://github.com/dsilhavy/isobmff-parser-chrome/releases/tag/v1.0.0
