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
3. Play the stream — init and media segments appear as they are downloaded

Only requests made while DevTools is open are captured (a limitation of the `chrome.devtools.network` API). The panel keeps the last 200 segments.

## Development

```bash
npm run dev    # rebuild on change; reload the extension + DevTools to pick it up
npm test       # sniffer unit tests
```
