import { createAudioSampleEntryReader, createVisualSampleEntryReader, type IsoBoxReadView } from '@svta/cml-iso-bmff';

/**
 * Sample entries the library has no reader for (so their child boxes would stay opaque),
 * the generic sample entry extensions of ISO/IEC 14496-12 12.1/12.2, and the codec
 * configuration boxes of Dolby, FLAC, Dolby Vision, VVC and MPEG-H audio.
 */

/** MSB-first bit reader over a byte array. */
export class Bits {
  private pos = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  get left(): number {
    return this.data.length * 8 - this.pos;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) {
      if (this.pos >= this.data.length * 8) throw new RangeError('read past end');
      v = v * 2 + ((this.data[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
    }
    return v;
  }
  skip(n: number): void {
    this.pos += n;
  }
  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }
}

const rest = (view: IsoBoxReadView) => view.readData(view.bytesRemaining);
const bitsOf = (view: IsoBoxReadView) => new Bits(rest(view));
/** NUL-terminated UTF-8 string, or the rest of the box when the terminator is missing. */
const cstr = (view: IsoBoxReadView): string => (view.bytesRemaining > 0 ? (view.readUtf8(-1) as string) : '');

// ---------- sample entries (ISO/IEC 14496-12 8.5.2, 12.x) ----------

const sampleEntryHeader = (view: IsoBoxReadView) => {
  view.jump(6); // reserved
  return { dataReferenceIndex: view.readUint(2) };
};

/** XMLSubtitleSampleEntry ('stpp', 12.6.3): namespaces, schema locations, auxiliary MIME types, then boxes. */
function readStpp(view: IsoBoxReadView) {
  return { ...sampleEntryHeader(view), namespace: cstr(view), schemaLocation: cstr(view), auxiliaryMimeTypes: cstr(view), boxes: view.readBoxes() };
}

/** PlainTextSampleEntry ('wvtt', ISO/IEC 14496-30): only boxes (vttC, vlab, btrt) after the header. */
function readBoxesAfterHeader(view: IsoBoxReadView) {
  return { ...sampleEntryHeader(view), boxes: view.readBoxes() };
}

const AUDIO_ENTRIES = ['ac-3', 'ec-3', 'ac-4', 'Opus', 'fLaC', 'mha1', 'mha2', 'mhm1', 'mhm2', 'dtsc', 'dtse', 'dtsh', 'dtsl', 'dtsx', 'ipcm', 'fpcm', 'alac'];
const VISUAL_ENTRIES = ['vp08', 'vp09', 'av01', 'dvh1', 'dvhe', 'dvav', 'dva1', 'dav1', 'vvc1', 'vvi1', 'avs3', 'mp4v'];

// ---------- 12.1 visual sample entry extensions ----------

/** BitRateBox 'btrt' (8.5.2.2) */
function readBtrt(view: IsoBoxReadView) {
  return { bufferSizeDB: view.readUint(4), maxBitrate: view.readUint(4), avgBitrate: view.readUint(4) };
}

/** PixelAspectRatioBox 'pasp' (12.1.4) */
function readPasp(view: IsoBoxReadView) {
  return { hSpacing: view.readUint(4), vSpacing: view.readUint(4) };
}

/** CleanApertureBox 'clap' (12.1.4) */
function readClap(view: IsoBoxReadView) {
  const r = () => view.readUint(4);
  return {
    cleanApertureWidthN: r(), cleanApertureWidthD: r(), cleanApertureHeightN: r(), cleanApertureHeightD: r(),
    horizOffN: r(), horizOffD: r(), vertOffN: r(), vertOffD: r(),
  };
}

/** ColourInformationBox 'colr' (12.1.5): nclx code points (ITU-T H.273) or an ICC profile. */
function readColr(view: IsoBoxReadView) {
  const colourType = view.readString(4);
  if (colourType === 'nclx' || colourType === 'nclc') {
    const out = { colourType, colourPrimaries: view.readUint(2), transferCharacteristics: view.readUint(2), matrixCoefficients: view.readUint(2) };
    return colourType === 'nclx' && view.bytesRemaining ? { ...out, fullRangeFlag: view.readUint(1) >> 7 } : out;
  }
  return { colourType, iccProfile: rest(view) };
}

/** ContentLightLevelBox 'clli' (12.1.6), cd/m² */
function readClli(view: IsoBoxReadView) {
  return { maxContentLightLevel: view.readUint(2), maxPicAverageLightLevel: view.readUint(2) };
}

/** MasteringDisplayColourVolumeBox 'mdcv' (12.1.7): chromaticities in 0.00002 units, luminance in 0.0001 cd/m². */
function readMdcv(view: IsoBoxReadView) {
  const displayPrimaries: { x: number; y: number }[] = [];
  for (let c = 0; c < 3; c++) displayPrimaries.push({ x: view.readUint(2), y: view.readUint(2) });
  return {
    displayPrimaries,
    whitePointX: view.readUint(2),
    whitePointY: view.readUint(2),
    maxDisplayMasteringLuminance: view.readUint(4),
    minDisplayMasteringLuminance: view.readUint(4),
  };
}

// ---------- 12.2 audio sample entry extensions ----------

/** ChannelLayout 'chnl' (12.2.4). v0 explicit positions need the entry's channel count, so they stay raw. */
function readChnl(view: IsoBoxReadView) {
  const { version, flags } = view.readFullBox();
  const out: Record<string, unknown> = { version, flags };
  const CHANNELS = 1;
  const OBJECTS = 2;
  if (version === 0) {
    const streamStructure = (out.streamStructure = view.readUint(1));
    if (streamStructure & CHANNELS) {
      const definedLayout = (out.definedLayout = view.readUint(1));
      if (definedLayout === 0) out.speakerPositions = rest(view);
      else out.omittedChannelsMap = view.readUint(8);
    }
    if (streamStructure & OBJECTS && view.bytesRemaining) out.objectCount = view.readUint(1);
    return out;
  }
  const b = view.readUint(1);
  const streamStructure = (out.streamStructure = b >> 4);
  out.formatOrdering = b & 15;
  out.baseChannelCount = view.readUint(1);
  if (streamStructure & CHANNELS) {
    const definedLayout = (out.definedLayout = view.readUint(1));
    if (definedLayout === 0) {
      out.layoutChannelCount = view.readUint(1);
      out.speakerPositions = rest(view);
    } else {
      const c = view.readUint(1);
      out.channelOrderDefinition = (c >> 1) & 7;
      if (c & 1) out.omittedChannelsMap = view.readUint(8);
    }
  }
  return out;
}

/** Plain containers: AudioLoudnessBox 'ludt' (12.2.7) holds 'tlou'/'alou'. */
function readContainer(view: IsoBoxReadView) {
  return { boxes: view.readBoxes() };
}

// ---------- codec configuration boxes ----------

/** AC3SpecificBox 'dac3' (ETSI TS 102 366 F.4) */
function readDac3(view: IsoBoxReadView) {
  const b = bitsOf(view);
  return { fscod: b.u(2), bsid: b.u(5), bsmod: b.u(3), acmod: b.u(3), lfeon: b.u(1), bitRateCode: b.u(5) };
}

/** EC3SpecificBox 'dec3' (ETSI TS 102 366 F.6), with the Dolby Atmos (JOC) extension when present. */
function readDec3(view: IsoBoxReadView) {
  const b = bitsOf(view);
  const dataRate = b.u(13);
  const numIndSub = b.u(3) + 1;
  const substreams: Record<string, number>[] = [];
  for (let i = 0; i < numIndSub; i++) {
    const s: Record<string, number> = { fscod: b.u(2), bsid: b.u(5) };
    b.skip(1);
    s.asvc = b.u(1);
    s.bsmod = b.u(3);
    s.acmod = b.u(3);
    s.lfeon = b.u(1);
    b.skip(3);
    s.numDepSub = b.u(4);
    if (s.numDepSub > 0) s.chanLoc = b.u(9);
    else b.skip(1);
    substreams.push(s);
  }
  const out: Record<string, unknown> = { dataRate, numIndSub, substreams };
  if (b.left >= 16) {
    b.skip(7);
    out.flagEc3ExtensionTypeA = b.u(1);
    out.complexityIndexTypeA = b.u(8);
  }
  return out;
}

/**
 * AC4SpecificBox 'dac4' (ETSI TS 103 190-2 E.6): the DSI header and, of the first presentation,
 * the version and `mdcompat` that the codec string needs.
 */
// ponytail: stops after the first presentation's mdcompat; the rest of ac4_presentation_v1_dsi is not walked
function readDac4(view: IsoBoxReadView) {
  const b = bitsOf(view);
  const out: Record<string, unknown> = {
    ac4DsiVersion: b.u(3),
    bitstreamVersion: b.u(7),
    fsIndex: b.u(1),
    frameRateIndex: b.u(4),
    nPresentations: b.u(9),
  };
  try {
    if ((out.bitstreamVersion as number) > 1 && b.u(1)) {
      out.shortProgramId = b.u(16);
      if (b.u(1)) b.skip(128);
    }
    out.bitRateMode = b.u(2);
    out.bitRate = b.u(32);
    out.bitRatePrecision = b.u(32);
    b.align();
    if ((out.nPresentations as number) > 0) {
      out.presentationVersion = b.u(8);
      let presBytes = b.u(8);
      if (presBytes === 255) presBytes += b.u(16);
      const config = b.u(5);
      out.presentationConfig = config;
      if (config !== 0x06) out.mdcompat = b.u(3);
    }
  } catch {
    /* truncated DSI: keep what was read */
  }
  return out;
}

/** FLACSpecificBox 'dfLa' (FLAC in ISOBMFF): metadata blocks, STREAMINFO decoded. */
function readDfLa(view: IsoBoxReadView) {
  const { version, flags } = view.readFullBox();
  const out: Record<string, unknown> = { version, flags };
  const blocks: { type: number; length: number }[] = [];
  while (view.bytesRemaining >= 4) {
    const h = view.readUint(1);
    const length = view.readUint(3);
    const type = h & 127;
    blocks.push({ type, length });
    const data = view.readData(Math.min(length, view.bytesRemaining));
    if (type === 0 && data.length >= 18) {
      const b = new Bits(data);
      out.minBlockSize = b.u(16);
      out.maxBlockSize = b.u(16);
      out.minFrameSize = b.u(24);
      out.maxFrameSize = b.u(24);
      out.sampleRate = b.u(20);
      out.channels = b.u(3) + 1;
      out.bitsPerSample = b.u(5) + 1;
      out.totalSamples = b.u(36);
    }
    if (h & 128) break;
  }
  out.metadataBlocks = blocks;
  return out;
}

/** DOVIDecoderConfigurationRecord 'dvcC' / 'dvvC' / 'dvwC' (Dolby Vision streams within ISOBMFF). */
function readDvcC(view: IsoBoxReadView) {
  const b = bitsOf(view);
  return {
    dvVersionMajor: b.u(8),
    dvVersionMinor: b.u(8),
    dvProfile: b.u(7),
    dvLevel: b.u(6),
    rpuPresentFlag: b.u(1),
    elPresentFlag: b.u(1),
    blPresentFlag: b.u(1),
    dvBlSignalCompatibilityId: b.u(4),
  };
}

/** VvcConfigurationBox 'vvcC' (ISO/IEC 14496-15 11.2.4.2): header and VvcPTLRecord; NAL arrays stay raw. */
function readVvcC(view: IsoBoxReadView) {
  const { version, flags } = view.readFullBox();
  const b = bitsOf(view);
  b.skip(5);
  const out: Record<string, unknown> = { version, flags, lengthSizeMinusOne: b.u(2) };
  const ptlPresent = b.u(1);
  out.ptlPresentFlag = ptlPresent;
  if (!ptlPresent) return out;
  out.olsIdx = b.u(9);
  out.numSublayers = b.u(3);
  out.constantFrameRate = b.u(2);
  out.chromaFormatIdc = b.u(2);
  out.bitDepthMinus8 = b.u(3);
  b.skip(5);
  b.skip(2);
  const numBytesConstraintInfo = b.u(6);
  out.generalProfileIdc = b.u(7);
  out.generalTierFlag = b.u(1);
  out.generalLevelIdc = b.u(8);
  out.ptlFrameOnlyConstraintFlag = b.u(1);
  out.ptlMultilayerEnabledFlag = b.u(1);
  const gci: number[] = [];
  let bitsLeft = numBytesConstraintInfo * 8 - 2;
  while (bitsLeft > 0) {
    const n = Math.min(8, bitsLeft);
    gci.push(b.u(n) << (8 - n));
    bitsLeft -= n;
  }
  out.generalConstraintInfo = new Uint8Array(gci);
  return out;
}

/** MHAConfigurationBox 'mhaC' (ISO/IEC 23008-3 20.5) */
function readMhaC(view: IsoBoxReadView) {
  const configurationVersion = view.readUint(1);
  const mpegh3daProfileLevelIndication = view.readUint(1);
  const referenceChannelLayout = view.readUint(1);
  const len = view.bytesRemaining >= 2 ? view.readUint(2) : 0;
  return { configurationVersion, mpegh3daProfileLevelIndication, referenceChannelLayout, mpegh3daConfig: view.readData(Math.min(len, view.bytesRemaining)) };
}

export const mediaReaders = {
  ...Object.fromEntries(AUDIO_ENTRIES.map((t) => [t, createAudioSampleEntryReader(t)])),
  ...Object.fromEntries(VISUAL_ENTRIES.map((t) => [t, createVisualSampleEntryReader(t)])),
  stpp: readStpp,
  wvtt: readBoxesAfterHeader,
  btrt: readBtrt,
  pasp: readPasp,
  clap: readClap,
  colr: readColr,
  clli: readClli,
  mdcv: readMdcv,
  chnl: readChnl,
  ludt: readContainer,
  dac3: readDac3,
  dec3: readDec3,
  dac4: readDac4,
  dfLa: readDfLa,
  dvcC: readDvcC,
  dvvC: readDvcC,
  dvwC: readDvcC,
  vvcC: readVvcC,
  mhaC: readMhaC,
} as Record<string, (view: IsoBoxReadView) => unknown>;
