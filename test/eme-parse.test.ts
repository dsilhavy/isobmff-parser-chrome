import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kidsIn, type PNode } from '../src/eme/types';
import { decodeProto } from '../src/eme/parse/protobuf';
import { parseWidevine } from '../src/eme/parse/widevine';
import { parsePlayReadyMessage, parsePlayReadyResponse, parsePro, wrmHeaderKids } from '../src/eme/parse/playready';
import { parseClearKeyRequest, parseClearKeyResponse } from '../src/eme/parse/clearkey';
import { parseSpc } from '../src/eme/parse/fairplay';
import { parseInitData } from '../src/eme/parse/initdata';
import { parsePayload, sniffKeySystem } from '../src/eme/parse';
import { guidToUuid, swapUuid } from '../src/eme/bytes';

// ---------- fixtures ----------

const KID = '01234567-89ab-cdef-0123-456789abcdef';
const KID2 = 'fedcba98-7654-3210-fedc-ba9876543210';
const uuidBytes = (u: string) => Uint8Array.from(u.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)));
const guidBytes = (u: string) => {
  const g = uuidBytes(u);
  return Uint8Array.from([g[3], g[2], g[1], g[0], g[5], g[4], g[7], g[6], ...g.slice(8)]);
};
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const cat = (...parts: ArrayLike<number>[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));

/** Minimal protobuf encoder: numbers → varint, strings/bytes → length-delimited. */
function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
function pb(fields: [number, number | string | Uint8Array][]): Uint8Array {
  const out: number[] = [];
  for (const [no, v] of fields) {
    if (typeof v === 'number') out.push(...varint(no * 8), ...varint(v));
    else {
      const b = typeof v === 'string' ? new TextEncoder().encode(v) : v;
      out.push(...varint(no * 8 + 2), ...varint(b.length), ...b);
    }
  }
  return Uint8Array.from(out);
}

const find = (nodes: PNode[], path: string[]): PNode | undefined => {
  let cur: PNode | undefined;
  let list = nodes;
  for (const p of path) {
    cur = list.find((n) => n.label === p);
    if (!cur) return undefined;
    list = cur.children ?? [];
  }
  return cur;
};

// ---------- protobuf ----------

test('decodeProto: varint, length-delimited, fixed32/64; rejects garbage', () => {
  const f = decodeProto(Uint8Array.from([0x08, 0x96, 0x01, 0x12, 0x02, 0x61, 0x62, 0x1d, 1, 0, 0, 0, 0x21, 2, 0, 0, 0, 0, 0, 0, 0]))!;
  assert.deepEqual(
    f.map((x) => [x.no, x.wire]),
    [
      [1, 0],
      [2, 2],
      [3, 5],
      [4, 1],
    ],
  );
  assert.equal(f[0].value, 150);
  assert.equal(f[2].value, 1);
  assert.equal(f[3].value, 2);
  assert.equal(decodeProto(Uint8Array.from([0x12, 0x10, 1])), undefined); // length past the end
  assert.equal(decodeProto(Uint8Array.from([0x0b])), undefined); // wire type 3
});

// ---------- Widevine ----------

const psshData = pb([
  [1, 1],
  [2, uuidBytes(KID)],
  [3, 'widevine_test'],
  [4, 'content-1'],
]);

test('Widevine LICENSE_REQUEST: content id pssh, request type, encrypted client id', () => {
  const req = pb([
    [2, pb([[1, pb([[1, psshData], [2, 1]])]])],
    [3, 1],
    [4, 1700000000],
    [6, 21],
    [8, pb([[1, 'widevine_test']])],
  ]);
  const r = parseWidevine(pb([[1, 1], [2, req], [3, new Uint8Array(256)]]))!;
  assert.match(r.title, /LICENSE_REQUEST · client ID encrypted/);
  assert.equal(find(r.nodes, ['msg', 'type'])?.value, 'NEW (1)');
  assert.equal(find(r.nodes, ['msg', 'protocol_version'])?.value, 'VERSION_2_1 (21)');
  assert.match(find(r.nodes, ['msg', 'request_time'])!.value!, /^2023-11-14T/);
  assert.equal(find(r.nodes, ['msg', 'encrypted_client_id', 'provider_id'])?.value, '"widevine_test"');
  assert.equal(find(r.nodes, ['signature'])?.value, '256 B');
  assert.deepEqual(kidsIn(r.nodes), [KID]);
});

test('Widevine LICENSE: key containers, policy, content key count', () => {
  const content = pb([[1, uuidBytes(KID)], [4, 2], [5, 1], [6, pb([[1, 4]])], [12, 'SD']]);
  const signing = pb([[1, new Uint8Array(8)], [4, 1]]);
  const lic = pb([[1, pb([[4, 1]])], [2, pb([[1, 1], [5, 0], [6, 3600]])], [3, content], [3, signing]]);
  const r = parseWidevine(pb([[1, 2], [2, lic]]))!;
  assert.equal(r.title, 'Widevine LICENSE · 1 content key');
  assert.deepEqual(r.warnings, []);
  const key0 = find(r.nodes, ['msg', 'key[0]'])!;
  assert.equal(key0.value, `CONTENT · SD · ${KID}`);
  assert.equal(find(key0.children!, ['required_protection'])?.value, 'HDCP_V2_2 (4)');
  assert.equal(find(r.nodes, ['msg', 'policy', 'playback_duration_seconds'])?.value, '0 (unlimited)');
  assert.equal(find(r.nodes, ['msg', 'policy', 'license_duration_seconds'])?.value, '3600 s (1h 0m)');
  assert.deepEqual(kidsIn(r.nodes), [KID]);
});

test('Widevine ERROR_RESPONSE and service certificate', () => {
  const err = parseWidevine(pb([[1, 3], [2, pb([[1, 3]])]]))!;
  assert.match(err.warnings[0], /ERROR_RESPONSE: SERVICE_UNAVAILABLE/);
  const cert = parseWidevine(pb([[1, pb([[1, 3], [2, Uint8Array.of(0xab)], [7, 'license.widevine.com']])], [2, new Uint8Array(32)]]))!;
  assert.equal(cert.title, 'Widevine service certificate');
  assert.equal(find(cert.nodes, ['drm_certificate', 'provider_id'])?.value, '"license.widevine.com"');
  assert.equal(find(cert.nodes, ['drm_certificate', 'type'])?.value, 'SERVICE (3)');
});

// ---------- PlayReady ----------

const wrm = `<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.0.0.0"><DATA><PROTECTINFO><KEYLEN>16</KEYLEN><ALGID>AESCTR</ALGID></PROTECTINFO><KID>${b64(guidBytes(KID))}</KID><LA_URL>https://pr.example/rightsmanager.asmx</LA_URL><CUSTOMATTRIBUTES><IIS_DRM_VERSION>8</IIS_DRM_VERSION></CUSTOMATTRIBUTES></DATA></WRMHEADER>`;

test('PlayReady WRMHEADER and PRO', () => {
  assert.deepEqual(wrmHeaderKids(wrm), [KID]);
  const xml = new Uint8Array(Buffer.from(wrm, 'utf16le'));
  const pro = new Uint8Array(10 + xml.length);
  const dv = new DataView(pro.buffer);
  dv.setUint32(0, pro.length, true);
  dv.setUint16(4, 1, true);
  dv.setUint16(6, 1, true);
  dv.setUint16(8, xml.length, true);
  pro.set(xml, 10);
  const nodes = parsePro(pro)!;
  const header = find(nodes, ['WRMHEADER'])!;
  assert.equal(find(header.children!, ['version'])?.value, '4.0.0.0');
  assert.equal(find(header.children!, ['LA_URL'])?.value, 'https://pr.example/rightsmanager.asmx');
  assert.equal(find(header.children!, ['ALGID'])?.value, 'AESCTR');
  assert.deepEqual(kidsIn(nodes), [KID]);
});

test('PlayReady key message: headers, SOAP challenge, WRMHEADER inside', () => {
  const soap = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><AcquireLicense xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols"><challenge><Challenge><LA xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols" Id="SignedData"><Version>1</Version><ContentHeader>${wrm}</ContentHeader><CLIENTINFO><CLIENTVERSION>10.0.16384.10011</CLIENTVERSION></CLIENTINFO><LicenseNonce>abc=</LicenseNonce><ClientTime>1700000000</ClientTime><EncryptedData/></LA></Challenge></challenge></AcquireLicense></soap:Body></soap:Envelope>`;
  const msg = `<PlayReadyKeyMessage type="LicenseAcquisition"><LicenseAcquisition Version="1"><Challenge encoding="base64encoded">${Buffer.from(soap).toString('base64')}</Challenge><HttpHeaders><HttpHeader><name>Content-Type</name><value>text/xml; charset=utf-8</value></HttpHeader><HttpHeader><name>SOAPAction</name><value>"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"</value></HttpHeader></HttpHeaders></LicenseAcquisition></PlayReadyKeyMessage>`;
  const r = parsePlayReadyMessage(new Uint8Array(Buffer.from(msg, 'utf16le')))!;
  assert.equal(r.title, 'PlayReady LicenseAcquisition challenge');
  assert.equal(find(r.nodes, ['HTTP headers', 'Content-Type'])?.value, 'text/xml; charset=utf-8');
  assert.equal(find(r.nodes, ['challenge', 'operation'])?.value, 'AcquireLicense');
  assert.equal(find(r.nodes, ['challenge', 'CLIENTVERSION'])?.value, '10.0.16384.10011');
  assert.match(find(r.nodes, ['challenge', 'ClientTime'])!.value!, /^2023-11-14T/);
  assert.ok(find(r.nodes, ['challenge', 'EncryptedData']));
  assert.deepEqual(kidsIn(r.nodes), [KID]);
  assert.ok(r.text?.includes('<LA '));
});

/** XMR object: flags, type, length (incl. 8-byte header), body; big-endian. */
function xmrObj(type: number, body: Uint8Array, container = false): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, container ? 2 : 1);
  dv.setUint16(2, type);
  dv.setUint32(4, out.length);
  out.set(body, 8);
  return out;
}
const u16be = (n: number) => [n >> 8, n & 255];
const u32be = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

test('PlayReady license response: XMR content key, security level, expiration; SOAP fault', () => {
  const ck = xmrObj(0x000a, cat(guidBytes(KID), u16be(1), u16be(3), u16be(128), new Uint8Array(128)));
  const policy = xmrObj(0x0002, cat(xmrObj(0x0034, Uint8Array.from(u16be(2000))), xmrObj(0x0012, cat(u32be(0), u32be(1800000000)))), true);
  const outer = xmrObj(0x0001, cat(policy, xmrObj(0x0009, ck, true)), true);
  const xmr = cat([0x58, 0x4d, 0x52, 0], u32be(3), guidBytes(KID2), outer);
  const soap = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><AcquireLicenseResponse><AcquireLicenseResult><Response><LicenseResponse><Version>1</Version><Licenses><License>${b64(xmr)}</License></Licenses></LicenseResponse></Response></AcquireLicenseResult></AcquireLicenseResponse></soap:Body></soap:Envelope>`;
  const r = parsePlayReadyResponse(new TextEncoder().encode(soap))!;
  assert.equal(r.title, 'PlayReady license response · 1 license');
  const lic = find(r.nodes, ['License[0]'])!.children!;
  assert.equal(find(lic, ['rights ID'])?.value, KID2);
  assert.equal(find(lic, ['OuterContainer', 'GlobalPolicyContainer', 'SecurityLevel'])?.value, 'SL2000 (software/TEE)');
  assert.match(find(lic, ['OuterContainer', 'GlobalPolicyContainer', 'Expiration', 'end'])!.value!, /^2027-01-15T/);
  const key = find(lic, ['OuterContainer', 'KeyMaterialContainer', 'ContentKey'])!;
  assert.equal(key.kid, KID);
  assert.equal(find(key.children!, ['cipher'])?.value, 'AES-128-CTR (1)');
  assert.equal(find(key.children!, ['key encryption'])?.value, 'ECC-256 (3)');

  const fault = parsePlayReadyResponse(
    new TextEncoder().encode(
      '<soap:Envelope xmlns:soap="x"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>System.Web.Services.Protocols.SoapException: Unable to acquire license</faultstring><detail><Exception><StatusCode>0x8004C600</StatusCode></Exception></detail></soap:Fault></soap:Body></soap:Envelope>',
    ),
  )!;
  assert.equal(fault.title, 'PlayReady SOAP fault');
  assert.match(fault.warnings[0], /0x8004C600: System\.Web/);
});

// ---------- ClearKey / FairPlay ----------

test('ClearKey request and JWK license', () => {
  const req = parseClearKeyRequest(new TextEncoder().encode(JSON.stringify({ kids: [b64url(uuidBytes(KID))], type: 'temporary' })))!;
  assert.deepEqual(kidsIn(req.nodes), [KID]);
  const res = parseClearKeyResponse(new TextEncoder().encode(JSON.stringify({ keys: [{ kty: 'oct', kid: b64url(uuidBytes(KID)), k: b64url(uuidBytes(KID2)) }], type: 'temporary' })))!;
  assert.equal(res.title, 'ClearKey license · 1 key');
  assert.equal(find(res.nodes, ['keys[0]', 'k'])?.value, KID2.replace(/-/g, ''));
  assert.deepEqual(kidsIn(res.nodes), [KID]);
});

test('FairPlay SPC header', () => {
  const spc = new Uint8Array(176 + 10);
  const dv = new DataView(spc.buffer);
  dv.setUint32(0, 1);
  dv.setUint32(172, 10);
  const r = parseSpc(spc);
  assert.equal(r.title, 'FairPlay SPC · v1');
  assert.deepEqual(r.warnings, []);
  assert.equal(parseSpc(new Uint8Array(200)).warnings.length, 1);
});

// ---------- init data + dispatch ----------

function psshBox(systemId: string, data: Uint8Array): Uint8Array {
  const size = 32 + data.length;
  return cat(u32be(size), [0x70, 0x73, 0x73, 0x68], [0, 0, 0, 0], uuidBytes(systemId), u32be(data.length), data);
}

test('cenc init data: pssh boxes by system with Widevine pssh data decoded', () => {
  const init = cat(psshBox('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', psshData), psshBox('1077efec-c0b2-4d02-ace3-3c1e52e2fb4b', new Uint8Array()));
  const r = parseInitData('cenc', init);
  assert.equal(r.title, 'cenc init data · 2 pssh (Widevine, ClearKey)');
  assert.equal(find(r.nodes, ['pssh · Widevine', 'data', 'provider'])?.value, '"widevine_test"');
  assert.deepEqual(kidsIn(r.nodes), [KID]);
});

test('keyids / webm init data', () => {
  assert.deepEqual(kidsIn(parseInitData('keyids', new TextEncoder().encode(JSON.stringify({ kids: [b64url(uuidBytes(KID))] }))).nodes), [KID]);
  assert.deepEqual(kidsIn(parseInitData('webm', uuidBytes(KID)).nodes), [KID]);
});

test('parsePayload sniffs the key system when unknown and never throws', () => {
  assert.equal(sniffKeySystem(new TextEncoder().encode('{"kids":[]}')), 'ClearKey');
  assert.equal(sniffKeySystem(new TextEncoder().encode('<soap:Envelope/>')), 'PlayReady');
  assert.equal(sniffKeySystem(pb([[1, 1], [2, pb([[3, 1]])]])), 'Widevine');
  assert.equal(parsePayload('message', undefined, pb([[1, 4], [3, 'x']])).title, 'Widevine SERVICE_CERTIFICATE_REQUEST');
  assert.equal(parsePayload('update', 'Widevine', Uint8Array.of(0xff, 0xff)).warnings[0], 'not a Widevine SignedMessage');
});

test('GUID byte order helpers', () => {
  assert.equal(guidToUuid(guidBytes(KID)), KID);
  assert.equal(swapUuid(swapUuid(KID)), KID);
  assert.equal(swapUuid(KID), '67452301-ab89-efcd-0123-456789abcdef');
});
