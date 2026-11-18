# Media Stream Inspector

Chrome DevTools panel for debugging media streams. It captures what a media player (dash.js, hls.js, ...) downloads and shows the DASH MPDs, the ISOBMFF box structure of the segments (box tree, decoded fields, hex view) and the DRM (EME) workflow. Formerly "ISOBMFF Box Inspector".

Parsing is done with [`@svta/cml-iso-bmff`](https://github.com/streaming-video-technology-alliance/common-media-library) from the SVTA Common Media Library. Segments are detected by content sniffing (valid top-level box header), so wrong MIME types or missing file extensions don't matter.

Codec-independent: any codec packaged in ISOBMFF/CMAF works (AVC, HEVC, VP9, AV1, AAC, ...). WebM/Matroska is a different container (EBML) and is not supported.

Three views in one panel:

- **Segments**: box tree, decoded fields, hex view, per-track timeline, structural and timing checks, init diff and frame types
- **Manifest**: captured DASH MPDs with their refresh history, an element outline and the source with line numbers
- **DRM**: the EME call/event flow with decoded Widevine, PlayReady, ClearKey and FairPlay payloads, matched license requests, key statuses and KID cross-checks against the segments

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Install from a release

1. Download `media-stream-inspector-<version>.zip` from the [latest release](https://github.com/dsilhavy/isobmff-parser-chrome/releases/latest) and unzip it
2. Open `chrome://extensions` and enable **Developer mode**
3. **Load unpacked** → select the unzipped folder

## Build

```bash
npm install
npm run build
```

## Install a local build

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

## Use

1. Open DevTools on a page that plays media (e.g. the [dash.js reference player](https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/))
2. Switch to the **Media Stream** panel
3. Play the stream — init and media segments appear as they are downloaded, grouped by URL template

The header filter matches URL substrings and the keywords `track:N`, `init`, `media`, `gap`, `overlap`, `warn` (structural warnings), `dash` (DASH segment-format warnings), `lmsg` (last segment brand), `enc` (encrypted) and handler codes (`vide`, `soun`, …). Segment groups show the codec string of their init (`avc1.64001F`, `hvc1.2.4.L93.B0`, `mp4a.40.2`, …); segments with warnings (mdat size vs. `trun` sample sizes, missing `tfdt`, parse errors, sample entries without a derivable codec string) carry a `!` with the details in the tooltip.

The timeline at the bottom shows one lane per track with a seconds ruler, a playhead and markers for gaps/overlaps between segments and between the `moof`s inside one segment (CMAF chunks), video segments that do not start on a sync sample (`no sync`), and `emsg` events (click one to open the box). When zoomed in, sync samples are drawn as ticks inside the bars. The summary shows the A/V offset (first video `tfdt` minus first audio `tfdt`). Hover a bar for details including sample/sync counts and, if present, the `prft` wall-clock time vs. capture time; click to select, ⇧click to open its `tfdt`. `⌥`+wheel zooms, drag pans, double-click resets, `[` / `]` step through issues.

In the fields pane, hovering a row highlights its bytes in the hex view and clicking a byte selects the field that covers it (for boxes with a field map: `ftyp`/`styp`, `mvhd`, `tkhd`, `mdhd`, `hdlr`, `trex`, `elst`, `mfhd`, `tfhd`, `tfdt`, `trun`, `sidx`, `emsg`). Besides the library's readers, the panel decodes `senc` (IV size inferred), `saiz`, `saio`, `avcC`, `hvcC`, `av1C`, `vpcC`, `esds` (incl. AudioSpecificConfig) and `dOps`. It also reads the sample entries the library leaves opaque (so their child boxes are decoded too): `ac-3`, `ec-3`, `ac-4`, `Opus`, `fLaC`, MPEG-H (`mha1`/`mhm1`), DTS, PCM, Dolby Vision (`dvh1`/`dvhe`/`dva1`/`dvav`/`dav1`), VVC (`vvc1`/`vvi1`), `stpp` (namespaces, schema locations) and `wvtt`; with the configuration boxes `dac3`, `dec3` (incl. the Dolby Atmos JOC flag), `dac4`, `dfLa` (STREAMINFO), `mhaC`, `dvcC`/`dvvC` and `vvcC`, and the sample entry extensions `btrt`, `pasp`, `clap`, `colr` (nclx code points named after ITU-T H.273, e.g. PQ/HLG), `clli`, `mdcv` and `chnl`. Codec strings are derived for these as well (`ac-4.02.01.03`, `dvh1.05.06`, `mhm1.0x0D`, `opus`, `flac`, …). Sample groups are decoded too: `sgpd` entries for `seig` (CENC key rotation: KID, IV size, pattern, constant IV), `roll`/`prol`, `sap ` (SAP type), `rap `, `tele`, `drap` and `sync`, and `sbgp` runs; the `trun` sample table gets a groups column with each sample's resolved memberships (fragment-local indexes above 0x10000 and indexes into the init's `stbl`, plus the `sgpd` v2 default). Segments warn when an `sbgp` maps a different number of samples than the truns hold or points to a missing fragment-local entry.

Segments are also checked against the ISO BMFF segment formats of ISO/IEC 23009-1 (DASH) 6.3; each warning names its clause:

- **Initialization Segment (6.3.4):** `ftyp` present, `moov` contains `mvex`, and `stts`/`stsc`/`stco`/`co64`/`stsz`/`stz2` are empty
- **Delivery Unit Media Segment (6.3.5.2, 6.3.2.1):** every `moof` has a `traf` and is followed by its `mdat` before the next `moof`; `tfhd` uses default-base-is-moof and no base-data-offset; `trun` carries a data offset
- **Simple format (6.3.5.3):** `styp` first, at most one `prft` (after `styp`), `prft`/`emsg` before the last `mdat`, the first `sidx` before the first `moof` and documenting the whole segment
- **Indexed `msix` (6.3.5.4) and Sub-Indexed `sims` (6.3.5.5), when the brand is present:** a `sidx` before the first `moof`, each `moof` immediately followed by its `mdat`, and an `ssix` directly after a `sidx`

Segments with a parse error, and captures without a `moof` or `moov` (e.g. an on-demand `sidx` byte range), are skipped. A `sidx` that documents more bytes than were captured is not reported, as that is what a byte-range request of an on-demand file looks like. `pssh` boxes are named by DRM system (Widevine, PlayReady, FairPlay, ClearKey, Marlin) and list their key IDs (v1 list, Widevine and PlayReady payloads); `tenc` shows the default KID as a UUID. With an init segment selected, the tree header offers a **diff with…** select to compare its decoded fields with another init. A selected `trun` shows sample statistics (Σ duration, bytes, bitrate, fps, sync count, frame types) and per-sample `dts`/`pts`/type; the frame type is read from `mdat` where possible (AVC slice type I/P/B, HEVC `IRAP` vs. undecided, AV1 `KEY`/`INTER`/`INTRA`/`SWITCH` frames and `EXISTING` for `show_existing_frame`); otherwise, and for encrypted tracks, it is the class implied by the sample flags (I / P / B-disposable). Selecting another segment re-opens the same box type.

### Manifest

The **Manifest** tab lists every DASH MPD the page loads, detected by content (`MPD` root element), so the content type does not matter. Each MPD keeps its last 50 distinct versions; identical consecutive refreshes are folded into one row (`×N`). The newest version is followed until you pick an older one.

The middle pane shows the main MPD attributes (type, profiles, durations in seconds, availability start and publish time) and an outline of the elements; clicking an element marks its lines in the syntax-highlighted source on the right. An MPD that is not well-formed XML is flagged with the line of the error. **Save all** adds the captured versions under `mpd/<host>/`.

Not yet covered: schema and conformance checks of the MPD, linking segments to their Representation, and a diff between refreshes. MPDs delivered on a single line are shown as they are (no pretty-printing), and the source view stops at 20,000 lines.

### DRM / EME

The **DRM** tab shows the EME workflow of the page: every `requestMediaKeySystemAccess`, `createMediaKeys`, `setServerCertificate`, `setMediaKeys`, `createSession`, `generateRequest` / `load` / `update` / `close` / `remove` and `getStatusForPolicy` call with its arguments, result or rejection and duration, plus the `encrypted`, `waitingforkey`, `message`, `keystatuseschange` and `closed` events. Click **Reload & capture EME** first: EME runs in page JavaScript, so the panel reloads the page with a small hook injected before any page script (no extra permissions; the green dot shows the hook is active). Only the top frame is read, so a player inside an iframe shows nothing here. While the hook is active the page can see it: it wraps the EME methods and `EventTarget.prototype.addEventListener` and keeps its log in `window.__emeLog`. A normal reload removes it.

Payloads are decoded per key system:

- **init data**: `cenc` pssh boxes (system, KIDs, Widevine `WidevinePsshData`, PlayReady Object / WRMHEADER), `keyids`, `webm`, FairPlay `skd`
- **Widevine**: SignedMessage with LicenseRequest (content ID / pssh, request and license type, protocol version, client ID in the clear or encrypted), License (key containers with KID, type, security level, required HDCP; policy durations and renewal), service certificates and error responses
- **PlayReady**: the key message (HTTP headers + SOAP challenge with WRMHEADER, client version, nonce, custom data) and the license response (XMR licenses: content keys with KID and cipher, security level, expiration, output protection levels) or SOAP faults
- **ClearKey**: request KIDs and the JWK license, including the keys
- **FairPlay**: SPC header fields, CKC and certificate sizes (the payloads are encrypted end to end)

License messages are matched to the network POST that carried them (by body, else by timing), with URL, status, headers and bodies. The overview lists the granted configurations, sessions with their key statuses, and all key IDs with where they were seen (segment `tenc`/`pssh`, init data, request, license, key status); clicking a KID opens the segment box that names it. Warnings cover rejected calls, non-2xx license responses and SOAP faults, Widevine error responses, non-usable key statuses, license messages without `update()`, `waitingforkey` without a usable key, capabilities without robustness, and segment KIDs that no license or key status covers (PlayReady key IDs reported in GUID byte order are folded onto the KID; KIDs of `seig` sample groups count as segment KIDs). The bottom strip draws the flow as a sequence (App · Browser/CDM · License server). **Save all** adds `eme/eme-log.json` with the raw events and the matched license exchanges (unrelated POSTs are left out; `Cookie`, `Authorization` and other token/key headers are redacted, bodies are kept). Filter keywords: key system names, `error`, `kid:<hex>`, `s:<n>` (session).

Not covered: edit-list (`elst`) correction of the A/V offset, hex field maps for most of the added boxes, the optional constraint/sub-layer parts of VVC codec strings, and MPD/m3u8-aware init linking (inits are linked to media segments by longest common URL prefix).

Only requests made while DevTools is open are captured (a limitation of the `chrome.devtools.network` API). Capture starts when DevTools opens, so segments downloaded before the **Media Stream** tab is first selected are included (up to the last 200). The panel keeps the last 200 segments and clears them when the page navigates or reloads, unless **Preserve log** is ticked.

## Development

```bash
npm run dev    # rebuild on change; reload the extension + DevTools to pick it up
npm run icons  # regenerate public/icons/*.png from scripts/icons.mjs
npm test       # unit tests (sniffer, readers, codecs, checks, continuity, timeline/list/field models, diff, zip, EME parsers, hook + model)
```

## Branching and releases

The project follows [git-flow](https://nvie.com/posts/a-successful-git-branching-model/):

- `main`: released versions only, every merge is tagged `vX.Y.Z`
- `development`: integration branch for the next release
- `feature/<name>`: branched from and merged back into `development`
- `release/X.Y.Z`: branched from `development` for the version bump and release notes, merged into `main` (tagged) and back into `development`
- `hotfix/X.Y.Z`: branched from `main` for urgent fixes, merged into `main` (tagged) and `development`

Versions follow [Semantic Versioning](https://semver.org/). The version lives in both `package.json` and `public/manifest.json`; keep them equal. Each GitHub release attaches the zipped `dist/` build.
