import {
  createVisualSampleEntryReader,
  defaultReaderConfig,
  type IsoBoxReadView,
  type IsoBoxReadViewConfig,
  type SampleAuxiliaryInformationOffsetsBox,
  type SampleAuxiliaryInformationSizesBox,
  type SampleEncryptionBox,
} from '@svta/cml-iso-bmff';

type Body<T> = Omit<T, 'type'>;
type Aux<T> = Omit<Body<T>, 'auxInfoType'> & { auxInfoType?: string }; // library types it as number; the fourcc reads better
const fourcc = (view: IsoBoxReadView) => view.readString(4);

/** Sample Encryption Box (ISO/IEC 23001-7 7.2). IV size is not in the box; the first of 8/16/0 that consumes it exactly wins. */
// ponytail: IV size guessed by exact fit; wire tenc.defaultIvSize through if a stream defeats the heuristic
function readSenc(view: IsoBoxReadView): Body<SampleEncryptionBox> & { ivSize: number } {
  const { version, flags } = view.readFullBox();
  const sampleCount = view.readUint(4);
  const data = view.readData(view.bytesRemaining);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const attempt = (ivSize: number) => {
    let pos = 0;
    const samples: SampleEncryptionBox['samples'] = [];
    for (let i = 0; i < sampleCount; i++) {
      if (pos + ivSize > data.byteLength) return null;
      const sample: SampleEncryptionBox['samples'][number] = { initializationVector: data.slice(pos, pos + ivSize) };
      pos += ivSize;
      if (flags & 2) {
        if (pos + 2 > data.byteLength) return null;
        const n = dv.getUint16(pos);
        pos += 2;
        if (pos + n * 6 > data.byteLength) return null;
        sample.subsampleEncryption = [];
        for (let k = 0; k < n; k++, pos += 6) {
          sample.subsampleEncryption.push({ bytesOfClearData: dv.getUint16(pos), bytesOfProtectedData: dv.getUint32(pos + 2) });
        }
      }
      samples.push(sample);
    }
    return pos === data.byteLength ? samples : null;
  };
  for (const ivSize of [8, 16, 0]) {
    const samples = attempt(ivSize);
    if (samples) return { version, flags, sampleCount, ivSize, samples };
  }
  return { version, flags, sampleCount, ivSize: NaN, samples: [] };
}

function readSaiz(view: IsoBoxReadView): Aux<SampleAuxiliaryInformationSizesBox> {
  const { version, flags } = view.readFullBox();
  const aux = flags & 1 ? { auxInfoType: fourcc(view), auxInfoTypeParameter: view.readUint(4) } : {};
  const defaultSampleInfoSize = view.readUint(1);
  const sampleCount = view.readUint(4);
  const sizes = defaultSampleInfoSize === 0 ? { sampleInfoSize: [...view.readData(sampleCount)] } : {};
  return { version, flags, ...aux, defaultSampleInfoSize, sampleCount, ...sizes };
}

function readSaio(view: IsoBoxReadView): Aux<SampleAuxiliaryInformationOffsetsBox> {
  const { version, flags } = view.readFullBox();
  const aux = flags & 1 ? { auxInfoType: fourcc(view), auxInfoTypeParameter: view.readUint(4) } : {};
  const entryCount = view.readUint(4);
  const offset: number[] = [];
  for (let i = 0; i < entryCount; i++) offset.push(view.readUint(version === 1 ? 8 : 4));
  return { version, flags, ...aux, entryCount, offset };
}

// ---------- codec configuration records ----------

const nalus = (view: IsoBoxReadView, count: number): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) out.push(view.readData(view.readUint(2)));
  return out;
};

/** ISO/IEC 14496-15 5.3.3.1 AVCDecoderConfigurationRecord */
function readAvcC(view: IsoBoxReadView) {
  const configurationVersion = view.readUint(1);
  const avcProfileIndication = view.readUint(1);
  const profileCompatibility = view.readUint(1);
  const avcLevelIndication = view.readUint(1);
  const lengthSizeMinusOne = view.readUint(1) & 3;
  const sps = nalus(view, view.readUint(1) & 31);
  const pps = nalus(view, view.readUint(1));
  const ext =
    [100, 110, 122, 144].includes(avcProfileIndication) && view.bytesRemaining >= 4
      ? { chromaFormat: view.readUint(1) & 3, bitDepthLuma: (view.readUint(1) & 7) + 8, bitDepthChroma: (view.readUint(1) & 7) + 8 }
      : {};
  return { configurationVersion, avcProfileIndication, profileCompatibility, avcLevelIndication, lengthSizeMinusOne, sps, pps, ...ext };
}

/** ISO/IEC 14496-15 8.3.3.1 HEVCDecoderConfigurationRecord */
function readHvcC(view: IsoBoxReadView) {
  const configurationVersion = view.readUint(1);
  const b1 = view.readUint(1);
  const generalProfileCompatibilityFlags = view.readUint(4);
  const generalConstraintIndicatorFlags = view.readData(6);
  const generalLevelIdc = view.readUint(1);
  const minSpatialSegmentationIdc = view.readUint(2) & 0x0fff;
  const parallelismType = view.readUint(1) & 3;
  const chromaFormatIdc = view.readUint(1) & 3;
  const bitDepthLumaMinus8 = view.readUint(1) & 7;
  const bitDepthChromaMinus8 = view.readUint(1) & 7;
  const avgFrameRate = view.readUint(2);
  const b21 = view.readUint(1);
  const numOfArrays = view.readUint(1);
  const arrays: { nalUnitType: number; nalus: Uint8Array[] }[] = [];
  for (let i = 0; i < numOfArrays; i++) {
    const nalUnitType = view.readUint(1) & 63;
    arrays.push({ nalUnitType, nalus: nalus(view, view.readUint(2)) });
  }
  return {
    configurationVersion,
    generalProfileSpace: b1 >> 6,
    generalTierFlag: (b1 >> 5) & 1,
    generalProfileIdc: b1 & 31,
    generalProfileCompatibilityFlags,
    generalConstraintIndicatorFlags,
    generalLevelIdc,
    minSpatialSegmentationIdc,
    parallelismType,
    chromaFormatIdc,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
    avgFrameRate,
    constantFrameRate: b21 >> 6,
    numTemporalLayers: (b21 >> 3) & 7,
    temporalIdNested: (b21 >> 2) & 1,
    lengthSizeMinusOne: b21 & 3,
    arrays,
  };
}

/** AV1 ISOBMFF binding 2.3 AV1CodecConfigurationRecord */
function readAv1C(view: IsoBoxReadView) {
  const b0 = view.readUint(1);
  const b1 = view.readUint(1);
  const b2 = view.readUint(1);
  const b3 = view.readUint(1);
  return {
    marker: b0 >> 7,
    version: b0 & 127,
    seqProfile: b1 >> 5,
    seqLevelIdx0: b1 & 31,
    seqTier0: b2 >> 7,
    highBitdepth: (b2 >> 6) & 1,
    twelveBit: (b2 >> 5) & 1,
    monochrome: (b2 >> 4) & 1,
    chromaSubsamplingX: (b2 >> 3) & 1,
    chromaSubsamplingY: (b2 >> 2) & 1,
    chromaSamplePosition: b2 & 3,
    initialPresentationDelayPresent: (b3 >> 4) & 1,
    initialPresentationDelayMinusOne: b3 & 15,
    configOBUs: view.readData(view.bytesRemaining),
  };
}

/** VP Codec ISO Media File Format Binding: VPCodecConfigurationRecord */
function readVpcC(view: IsoBoxReadView) {
  const { version, flags } = view.readFullBox();
  const profile = view.readUint(1);
  const level = view.readUint(1);
  const b = view.readUint(1);
  return {
    version,
    flags,
    profile,
    level,
    bitDepth: b >> 4,
    chromaSubsampling: (b >> 1) & 7,
    videoFullRangeFlag: b & 1,
    colourPrimaries: view.readUint(1),
    transferCharacteristics: view.readUint(1),
    matrixCoefficients: view.readUint(1),
    codecInitializationData: view.readData(view.readUint(2)),
  };
}

/** ISO/IEC 14496-1 ES_Descriptor with DecoderConfigDescriptor and AudioSpecificConfig (14496-3 1.6.2.1). */
function readEsds(view: IsoBoxReadView) {
  const { version, flags } = view.readFullBox();
  const out: Record<string, number> = { version, flags };
  const size = () => {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const b = view.readUint(1);
      n = (n << 7) | (b & 127);
      if (!(b & 128)) break;
    }
    return n;
  };
  while (view.bytesRemaining >= 2) {
    const tag = view.readUint(1);
    const len = size();
    const end = view.cursor + len;
    if (tag === 0x03) {
      out.esId = view.readUint(2);
      const f = view.readUint(1);
      if (f & 0x80) view.jump(2); // dependsOn_ES_ID
      if (f & 0x40) view.jump(view.readUint(1)); // URL
      if (f & 0x20) view.jump(2); // OCR_ES_Id
      continue; // children follow inline
    }
    if (tag === 0x04) {
      out.objectTypeIndication = view.readUint(1);
      out.streamType = view.readUint(1) >> 2;
      out.bufferSizeDB = view.readUint(3);
      out.maxBitrate = view.readUint(4);
      out.avgBitrate = view.readUint(4);
      continue;
    }
    if (tag === 0x05 && len >= 2) {
      const b0 = view.readUint(1);
      const b1 = view.readUint(1);
      let aot = b0 >> 3;
      let sfi = ((b0 & 7) << 1) | (b1 >> 7);
      let chan = (b1 >> 3) & 15;
      if (aot === 31 && len >= 3) {
        const b2 = view.readUint(1);
        aot = 32 + (((b0 & 7) << 3) | (b1 >> 5));
        sfi = (b1 >> 1) & 15;
        chan = ((b1 & 1) << 3) | (b2 >> 5);
      }
      out.audioObjectType = aot;
      out.samplingFrequencyIndex = sfi;
      out.channelConfiguration = chan;
    }
    view.jump(Math.max(0, end - view.cursor)); // rest of this descriptor (or an unknown one)
  }
  return out;
}

/** Opus in ISOBMFF: OpusSpecificBox */
function readDOps(view: IsoBoxReadView) {
  return {
    version: view.readUint(1),
    outputChannelCount: view.readUint(1),
    preSkip: view.readUint(2),
    inputSampleRate: view.readUint(4),
    outputGain: view.readInt(2),
    channelMappingFamily: view.readUint(1),
  };
}

/** Library defaults plus readers it lacks: VP9/AV1 sample entries, CENC sample boxes, codec configuration records. */
export const readerConfig: IsoBoxReadViewConfig = {
  readers: {
    ...defaultReaderConfig().readers,
    vp09: createVisualSampleEntryReader('vp09'),
    av01: createVisualSampleEntryReader('av01'),
    senc: readSenc,
    saiz: readSaiz,
    saio: readSaio,
    avcC: readAvcC,
    hvcC: readHvcC,
    av1C: readAv1C,
    vpcC: readVpcC,
    esds: readEsds,
    dOps: readDOps,
  },
};
