# ISOBMFF Box Inspector

Chrome DevTools panel that captures media segments downloaded by media players (dash.js, hls.js, ...) and shows their ISOBMFF box structure: box tree, decoded fields, and a hex view.

Parsing is done with [`@svta/cml-iso-bmff`](https://github.com/streaming-video-technology-alliance/common-media-library) from the SVTA Common Media Library. Segments are detected by content sniffing (valid top-level box header), so wrong MIME types or missing file extensions don't matter.

Codec-independent: any codec packaged in ISOBMFF/CMAF works (AVC, HEVC, VP9, AV1, AAC, ...). WebM/Matroska is a different container (EBML) and is not supported.

## Build

```bash
npm install
npm run build
```

## Install in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

## Use

1. Open DevTools on a page that plays media (e.g. the [dash.js reference player](https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/))
2. Switch to the **ISOBMFF** panel
3. Play the stream — init and media segments appear as they are downloaded, grouped by URL template

The header filter matches URL substrings and the keywords `track:N`, `init`, `media`, `gap`, `overlap`, `warn` (structural warnings), `enc` (encrypted) and handler codes (`vide`, `soun`, …). Segment groups show the codec string of their init (`avc1.64001F`, `hvc1.2.4.L93.B0`, `mp4a.40.2`, …); segments with warnings (mdat size vs. `trun` sample sizes, missing `tfdt`, parse errors, sample entries without a derivable codec string) carry a `!` with the details in the tooltip.

The timeline at the bottom shows one lane per track with a seconds ruler, a playhead and markers for gaps/overlaps between segments and between the `moof`s inside one segment (CMAF chunks), video segments that do not start on a sync sample (`no sync`), and `emsg` events (click one to open the box). When zoomed in, sync samples are drawn as ticks inside the bars. The summary shows the A/V offset (first video `tfdt` minus first audio `tfdt`). Hover a bar for details including sample/sync counts and, if present, the `prft` wall-clock time vs. capture time; click to select, ⇧click to open its `tfdt`. `⌥`+wheel zooms, drag pans, double-click resets, `[` / `]` step through issues.

In the fields pane, hovering a row highlights its bytes in the hex view and clicking a byte selects the field that covers it (for boxes with a field map: `ftyp`/`styp`, `mvhd`, `tkhd`, `mdhd`, `hdlr`, `trex`, `elst`, `mfhd`, `tfhd`, `tfdt`, `trun`, `sidx`, `emsg`). Besides the library's readers, the panel decodes `senc` (IV size inferred), `saiz`, `saio`, `avcC`, `hvcC`, `av1C`, `vpcC`, `esds` (incl. AudioSpecificConfig) and `dOps`. `pssh` boxes are named by DRM system (Widevine, PlayReady, FairPlay, ClearKey, Marlin) and list their key IDs (v1 list, Widevine and PlayReady payloads); `tenc` shows the default KID as a UUID. With an init segment selected, the tree header offers a **diff with…** select to compare its decoded fields with another init. A selected `trun` shows sample statistics (Σ duration, bytes, bitrate, fps, sync count, frame types) and per-sample `dts`/`pts`/type; the frame type is read from `mdat` where possible (AVC slice type I/P/B, HEVC `IRAP` vs. undecided, AV1 `KEY`/`INTER`/`INTRA`/`SWITCH` frames and `EXISTING` for `show_existing_frame`); otherwise, and for encrypted tracks, it is the class implied by the sample flags (I / P / B-disposable). Selecting another segment re-opens the same box type.

Not covered: edit-list (`elst`) correction of the A/V offset, `dac3`/`dec3` decoding, hex field maps for the added boxes, and MPD/m3u8-aware init linking (inits are linked to media segments by longest common URL prefix).

Only requests made while DevTools is open are captured (a limitation of the `chrome.devtools.network` API). The panel keeps the last 200 segments.

## Development

```bash
npm run dev    # rebuild on change; reload the extension + DevTools to pick it up
npm run icons  # regenerate public/icons/*.png from scripts/icons.mjs
npm test       # unit tests (sniffer, readers, codecs, checks, continuity, timeline/list/field models, diff, zip)
```
