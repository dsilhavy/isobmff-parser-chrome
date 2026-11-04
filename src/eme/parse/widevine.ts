import { hexUuid, toHex } from '../bytes';
import type { ParseResult, PNode } from '../types';
import { childValue, decodeProto, decodeWith, type Schema } from './protobuf';

// Field numbers follow Widevine's license_protocol.proto / widevine_pssh.proto (as published with the CDM interface and Shaka packager).

const MESSAGE_TYPE: Record<number, string> = {
  1: 'LICENSE_REQUEST',
  2: 'LICENSE',
  3: 'ERROR_RESPONSE',
  4: 'SERVICE_CERTIFICATE_REQUEST',
  5: 'SERVICE_CERTIFICATE',
  6: 'SUB_LICENSE',
  7: 'CAS_LICENSE_REQUEST',
  8: 'CAS_LICENSE',
  9: 'EXTERNAL_LICENSE_REQUEST',
  10: 'EXTERNAL_LICENSE',
};
const LICENSE_TYPE = { 1: 'STREAMING', 2: 'OFFLINE', 3: 'AUTOMATIC' };
const REQUEST_TYPE = { 1: 'NEW', 2: 'RENEWAL', 3: 'RELEASE' };
const PROTOCOL_VERSION = { 20: 'VERSION_2_0', 21: 'VERSION_2_1', 22: 'VERSION_2_2' };
const TOKEN_TYPE = { 0: 'KEYBOX', 1: 'DRM_DEVICE_CERTIFICATE', 2: 'REMOTE_ATTESTATION_CERTIFICATE', 3: 'OEM_DEVICE_CERTIFICATE' };
const HDCP = { 0: 'HDCP_NONE', 1: 'HDCP_V1', 2: 'HDCP_V2', 3: 'HDCP_V2_1', 4: 'HDCP_V2_2', 5: 'HDCP_V2_3', 255: 'HDCP_NO_DIGITAL_OUTPUT' };
const KEY_TYPE = { 1: 'SIGNING', 2: 'CONTENT', 3: 'KEY_CONTROL', 4: 'OPERATOR_SESSION', 5: 'ENTITLEMENT', 6: 'OEM_CONTENT' };
const SECURITY_LEVEL = { 1: 'SW_SECURE_CRYPTO', 2: 'SW_SECURE_DECODE', 3: 'HW_SECURE_CRYPTO', 4: 'HW_SECURE_DECODE', 5: 'HW_SECURE_ALL' };
const CGMS = { 0: 'COPY_FREE', 2: 'COPY_ONCE', 3: 'COPY_NEVER', 42: 'CGMS_NONE' };
const INIT_DATA_TYPE = { 1: 'CENC', 2: 'WEBM' };
const LICENSE_ERROR = { 1: 'INVALID_DRM_DEVICE_CERTIFICATE', 2: 'REVOKED_DRM_DEVICE_CERTIFICATE', 3: 'SERVICE_UNAVAILABLE' };
const CERT_TYPE = { 0: 'ROOT', 1: 'DEVICE_MODEL', 2: 'DEVICE', 3: 'SERVICE', 4: 'PROVISIONER' };
const PLATFORM_STATUS = {
  0: 'PLATFORM_UNVERIFIED',
  1: 'PLATFORM_TAMPERED',
  2: 'PLATFORM_SOFTWARE_VERIFIED',
  3: 'PLATFORM_HARDWARE_VERIFIED',
  4: 'PLATFORM_NO_VERIFICATION',
  5: 'PLATFORM_SECURE_STORAGE_SOFTWARE_VERIFIED',
};
const CERT_KEY_TYPE = { 0: 'RSA_2048', 1: 'RSA_3072', 2: 'ECC_SECP256R1', 3: 'ECC_SECP384R1', 4: 'ECC_SECP521R1' };
const ANALOG_OUTPUT = { 0: 'ANALOG_OUTPUT_UNKNOWN', 1: 'ANALOG_OUTPUT_NONE', 2: 'ANALOG_OUTPUT_SUPPORTED', 3: 'ANALOG_OUTPUT_SUPPORTS_CGMS_A' };
const PSSH_ALGORITHM = { 0: 'UNENCRYPTED', 1: 'AESCTR' };
const PSSH_TYPE = { 0: 'SINGLE', 1: 'ENTITLEMENT', 2: 'ENTITLED_KEY' };
const SESSION_KEY_TYPE = { 0: 'UNDEFINED', 1: 'WRAPPED_AES_KEY', 2: 'EPHEMERAL_ECC_PUBLIC_KEY' };

/** WidevinePsshData: the `data` of a Widevine pssh box. */
export const PSSH_DATA: Schema = {
  1: { name: 'algorithm', kind: 'enum', values: PSSH_ALGORITHM },
  2: { name: 'key_id', kind: 'kid' },
  3: { name: 'provider', kind: 'string' },
  4: { name: 'content_id' },
  5: { name: 'track_type', kind: 'string' },
  6: { name: 'policy', kind: 'string' },
  7: { name: 'crypto_period_index' },
  8: { name: 'grouped_license' },
  9: { name: 'protection_scheme', kind: 'fourcc' },
  10: { name: 'crypto_period_seconds' },
  11: { name: 'type', kind: 'enum', values: PSSH_TYPE },
  12: { name: 'key_sequence' },
  13: { name: 'group_id' },
  15: { name: 'video_feature', kind: 'string' },
};

export const parsePsshData = (b: Uint8Array): PNode[] | undefined => decodeWith(b, PSSH_DATA);

/** Either a whole pssh box or bare WidevinePsshData (the CDM puts either into content_id). */
function psshOrData(b: Uint8Array): PNode[] | undefined {
  if (b.length >= 32 && String.fromCharCode(b[4], b[5], b[6], b[7]) === 'pssh') {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const version = b[8];
    let pos = 28;
    const nodes: PNode[] = [{ label: 'systemId', value: hexUuid(b.subarray(12, 28)) }];
    if (version > 0 && pos + 4 <= b.length) {
      const n = dv.getUint32(pos);
      pos += 4;
      for (let i = 0; i < n && pos + 16 <= b.length; i++, pos += 16) nodes.push({ label: 'kid', value: hexUuid(b.subarray(pos, pos + 16)), kid: hexUuid(b.subarray(pos, pos + 16)) });
    }
    if (pos + 4 > b.length) return nodes;
    const size = dv.getUint32(pos);
    const data = b.subarray(pos + 4, pos + 4 + size);
    nodes.push({ label: 'data', children: parsePsshData(data) ?? [{ label: 'raw', value: toHex(data) }] });
    return [{ label: `pssh v${version}`, children: nodes }];
  }
  return parsePsshData(b);
}

const NAME_VALUE: Schema = { 1: { name: 'name', kind: 'string' }, 2: { name: 'value', kind: 'string' } };
const nameValue = (c: PNode[]) => `${JSON.parse(childValue(c, 'name') ?? '""')} = ${childValue(c, 'value') ?? ''}`;

const CLIENT_CAPABILITIES: Schema = {
  1: { name: 'client_token', kind: 'bool' },
  2: { name: 'session_token', kind: 'bool' },
  3: { name: 'video_resolution_constraints', kind: 'bool' },
  4: { name: 'max_hdcp_version', kind: 'enum', values: HDCP },
  5: { name: 'oem_crypto_api_version' },
  6: { name: 'anti_rollback_usage_table', kind: 'bool' },
  7: { name: 'srm_version' },
  8: { name: 'can_update_srm', kind: 'bool' },
  9: { name: 'supported_certificate_key_type', kind: 'enum', values: CERT_KEY_TYPE },
  10: { name: 'analog_output_capabilities', kind: 'enum', values: ANALOG_OUTPUT },
  11: { name: 'can_disable_analog_output', kind: 'bool' },
  12: { name: 'resource_rating_tier' },
};

const CLIENT_ID: Schema = {
  1: { name: 'type', kind: 'enum', values: TOKEN_TYPE },
  2: { name: 'token', kind: 'size' },
  3: { name: 'client_info', msg: () => NAME_VALUE, summary: nameValue },
  4: { name: 'provider_client_token', kind: 'size' },
  5: { name: 'license_counter' },
  6: { name: 'client_capabilities', msg: () => CLIENT_CAPABILITIES },
  7: { name: 'vmp_data', kind: 'size' },
};

const ENCRYPTED_CLIENT_ID: Schema = {
  1: { name: 'provider_id', kind: 'string' },
  2: { name: 'service_certificate_serial_number', kind: 'hex' },
  3: { name: 'encrypted_client_id', kind: 'size' },
  4: { name: 'encrypted_client_id_iv', kind: 'hex' },
  5: { name: 'encrypted_privacy_key', kind: 'size' },
};

const LICENSE_ID: Schema = {
  1: { name: 'request_id' },
  2: { name: 'session_id' },
  3: { name: 'purchase_id' },
  4: { name: 'type', kind: 'enum', values: LICENSE_TYPE },
  5: { name: 'version' },
  6: { name: 'provider_session_token' },
  7: { name: 'original_rental_duration_seconds', kind: 'duration' },
  8: { name: 'original_playback_duration_seconds', kind: 'duration' },
  9: { name: 'original_start_time_seconds', kind: 'time' },
};

const CONTENT_ID: Schema = {
  1: {
    name: 'widevine_pssh_data',
    msg: () => ({ 1: { name: 'pssh_data', parse: psshOrData }, 2: { name: 'license_type', kind: 'enum', values: LICENSE_TYPE }, 3: { name: 'request_id' } }),
  },
  2: {
    name: 'webm_key_id',
    msg: () => ({ 1: { name: 'header', kind: 'kid' }, 2: { name: 'license_type', kind: 'enum', values: LICENSE_TYPE }, 3: { name: 'request_id' } }),
  },
  3: {
    name: 'existing_license',
    msg: () => ({
      1: { name: 'license_id', msg: () => LICENSE_ID },
      2: { name: 'seconds_since_started' },
      3: { name: 'seconds_since_last_played' },
      4: { name: 'session_usage_table_entry', kind: 'size' },
    }),
  },
  4: {
    name: 'init_data',
    msg: () => ({
      1: { name: 'init_data_type', kind: 'enum', values: INIT_DATA_TYPE },
      2: { name: 'init_data', parse: psshOrData },
      3: { name: 'license_type', kind: 'enum', values: LICENSE_TYPE },
      4: { name: 'request_id' },
    }),
  },
};

const LICENSE_REQUEST: Schema = {
  1: { name: 'client_id', msg: () => CLIENT_ID },
  2: { name: 'content_id', msg: () => CONTENT_ID },
  3: { name: 'type', kind: 'enum', values: REQUEST_TYPE },
  4: { name: 'request_time', kind: 'time' },
  5: { name: 'key_control_nonce_deprecated', kind: 'hex' },
  6: { name: 'protocol_version', kind: 'enum', values: PROTOCOL_VERSION },
  7: { name: 'key_control_nonce' },
  8: { name: 'encrypted_client_id', msg: () => ENCRYPTED_CLIENT_ID },
};

const POLICY: Schema = {
  1: { name: 'can_play', kind: 'bool' },
  2: { name: 'can_persist', kind: 'bool' },
  3: { name: 'can_renew', kind: 'bool' },
  4: { name: 'rental_duration_seconds', kind: 'duration' },
  5: { name: 'playback_duration_seconds', kind: 'duration' },
  6: { name: 'license_duration_seconds', kind: 'duration' },
  7: { name: 'renewal_recovery_duration_seconds', kind: 'duration' },
  8: { name: 'renewal_server_url', kind: 'string' },
  9: { name: 'renewal_delay_seconds', kind: 'duration' },
  10: { name: 'renewal_retry_interval_seconds', kind: 'duration' },
  11: { name: 'renew_with_usage', kind: 'bool' },
  12: { name: 'always_include_client_id', kind: 'bool' },
  13: { name: 'play_start_grace_period_seconds', kind: 'duration' },
  14: { name: 'soft_enforce_playback_duration', kind: 'bool' },
  15: { name: 'soft_enforce_rental_duration', kind: 'bool' },
};

const OUTPUT_PROTECTION: Schema = {
  1: { name: 'hdcp', kind: 'enum', values: HDCP },
  2: { name: 'cgms_flags', kind: 'enum', values: CGMS },
  3: { name: 'hdcp_srm_rule', kind: 'enum', values: { 0: 'HDCP_SRM_RULE_NONE', 1: 'CURRENT_SRM' } },
  4: { name: 'disable_analog_output', kind: 'bool' },
  5: { name: 'disable_digital_output', kind: 'bool' },
};
const hdcpSummary = (c: PNode[]) => childValue(c, 'hdcp');

const KEY_CONTAINER: Schema = {
  1: { name: 'id', kind: 'kid' },
  2: { name: 'iv', kind: 'hex' },
  3: { name: 'key', kind: 'size' }, // encrypted with the session key
  4: { name: 'type', kind: 'enum', values: KEY_TYPE },
  5: { name: 'level', kind: 'enum', values: SECURITY_LEVEL },
  6: { name: 'required_protection', msg: () => OUTPUT_PROTECTION, summary: hdcpSummary },
  7: { name: 'requested_protection', msg: () => OUTPUT_PROTECTION, summary: hdcpSummary },
  8: { name: 'key_control', msg: () => ({ 1: { name: 'key_control_block', kind: 'hex' }, 2: { name: 'iv', kind: 'hex' } }) },
  9: {
    name: 'operator_session_key_permissions',
    msg: () => ({ 1: { name: 'allow_encrypt', kind: 'bool' }, 2: { name: 'allow_decrypt', kind: 'bool' }, 3: { name: 'allow_sign', kind: 'bool' }, 4: { name: 'allow_signature_verify', kind: 'bool' } }),
  },
  10: {
    name: 'video_resolution_constraints',
    msg: () => ({ 1: { name: 'min_resolution_pixels' }, 2: { name: 'max_resolution_pixels' }, 3: { name: 'required_protection', msg: () => OUTPUT_PROTECTION, summary: hdcpSummary } }),
  },
  11: { name: 'anti_rollback_usage_table', kind: 'bool' },
  12: { name: 'track_label', kind: 'string' },
};
const keySummary = (c: PNode[]) => {
  const type = childValue(c, 'type')?.split(' ')[0];
  const label = childValue(c, 'track_label');
  const id = c.find((n) => n.label === 'id');
  return [type, label && JSON.parse(label), id?.kid].filter(Boolean).join(' · ') || undefined;
};

const LICENSE: Schema = {
  1: { name: 'id', msg: () => LICENSE_ID },
  2: { name: 'policy', msg: () => POLICY },
  3: { name: 'key', msg: () => KEY_CONTAINER, summary: keySummary },
  4: { name: 'license_start_time', kind: 'time' },
  5: { name: 'remote_attestation_verified', kind: 'bool' },
  6: { name: 'provider_client_token', kind: 'size' },
  7: { name: 'protection_scheme', kind: 'fourcc' },
  8: { name: 'srm_requirement', kind: 'size' },
  9: { name: 'srm_update', kind: 'size' },
  10: { name: 'platform_verification_status', kind: 'enum', values: PLATFORM_STATUS },
  11: { name: 'group_ids' },
};

const DRM_CERTIFICATE: Schema = {
  1: { name: 'type', kind: 'enum', values: CERT_TYPE },
  2: { name: 'serial_number', kind: 'hex' },
  3: { name: 'creation_time_seconds', kind: 'time' },
  4: { name: 'public_key', kind: 'size' },
  5: { name: 'system_id' },
  6: { name: 'test_device_deprecated', kind: 'bool' },
  7: { name: 'provider_id', kind: 'string' },
};

const SIGNED_DRM_CERTIFICATE: Schema = {
  1: { name: 'drm_certificate', msg: () => DRM_CERTIFICATE },
  2: { name: 'signature', kind: 'size' },
  3: { name: 'signer', msg: () => SIGNED_DRM_CERTIFICATE },
  4: { name: 'hash_algorithm', kind: 'enum', values: { 0: 'HASH_ALGORITHM_UNSPECIFIED', 1: 'SHA1', 2: 'SHA256', 3: 'SHA384' } },
};

const BODY: Record<number, Schema> = { 1: LICENSE_REQUEST, 2: LICENSE, 3: { 1: { name: 'error_code', kind: 'enum', values: LICENSE_ERROR } }, 5: SIGNED_DRM_CERTIFICATE };

function signedMessage(type: number): Schema {
  const body = BODY[type];
  return {
    1: { name: 'type', kind: 'enum', values: MESSAGE_TYPE },
    2: body ? { name: 'msg', msg: () => body } : { name: 'msg' },
    3: { name: 'signature', kind: 'size' },
    4: { name: 'session_key', kind: 'size' },
    5: { name: 'remote_attestation', kind: 'size' },
    6: { name: 'metric_data', msg: () => ({ 1: { name: 'stage_name', kind: 'string' }, 2: { name: 'metric_type', kind: 'enum', values: { 1: 'LATENCY', 2: 'TIMESTAMP' } }, 3: { name: 'value' } }) },
    7: { name: 'service_version_info', msg: () => ({ 1: { name: 'license_sdk_version', kind: 'string' }, 2: { name: 'license_service_version', kind: 'string' } }) },
    8: { name: 'session_key_type', kind: 'enum', values: SESSION_KEY_TYPE },
    9: { name: 'oemcrypto_core_message', kind: 'size' },
  };
}

const find = (nodes: PNode[] | undefined, label: string) => nodes?.find((n) => n.label === label);

/** A Widevine SignedMessage (license request/response, certificate request) or a bare SignedDrmCertificate. */
export function parseWidevine(bytes: Uint8Array): ParseResult | undefined {
  const fields = decodeProto(bytes);
  if (!fields?.length) return undefined;
  const type = fields.find((f) => f.no === 1 && f.wire === 0)?.value as number | undefined;
  if (type === undefined || !MESSAGE_TYPE[type]) {
    // setServerCertificate takes a SignedDrmCertificate directly
    const cert = decodeWith(bytes, SIGNED_DRM_CERTIFICATE);
    if (cert && find(cert, 'drm_certificate')?.children) return { title: 'Widevine service certificate', nodes: cert, warnings: [] };
    return undefined;
  }
  const nodes = decodeWith(bytes, signedMessage(type))!;
  const msg = find(nodes, 'msg')?.children;
  const warnings: string[] = [];
  let title = `Widevine ${MESSAGE_TYPE[type]}`;
  if (type === 1) {
    if (find(msg, 'encrypted_client_id')) title += ' · client ID encrypted (privacy mode)';
    else if (find(msg, 'client_id')) title += ' · client ID in the clear';
  }
  if (type === 2) {
    const keys = (msg ?? []).filter((n) => n.label.startsWith('key'));
    const content = keys.filter((k) => childValue(k.children ?? [], 'type')?.startsWith('CONTENT')).length;
    title += ` · ${content} content key${content === 1 ? '' : 's'}`;
    if (!content) warnings.push('license carries no CONTENT keys');
  }
  if (type === 3) warnings.push(`license server returned ERROR_RESPONSE: ${childValue(msg ?? [], 'error_code') ?? 'no error code'}`);
  return { title, nodes, warnings };
}

/** True when the bytes decode as a SignedMessage of a known type (used to sniff the key system). */
export const isWidevineMessage = (b: Uint8Array): boolean => {
  const f = decodeProto(b);
  const t = f?.find((x) => x.no === 1 && x.wire === 0)?.value as number | undefined;
  return !!f && t !== undefined && !!MESSAGE_TYPE[t] && f.some((x) => x.no === 2 || x.no === 3);
};
