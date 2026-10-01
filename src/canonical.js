'use strict';

// 规范化 JSON（RFC 8785 风格的 JCS）：
// 复合类型仅支持对象 / 数组 / 基本类型；对象键按 UTF-16 码点升序排列；
// 无多余空白。签发端（src/attestation.js）与离线校验端（src/attestation-verify.js）
// 必须逐字节使用同一规则，任何一方都不得另用 JSON.stringify 默认键序。
//
// 本模块零第三方依赖，可直接拷入离线环境使用。

function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return serializeNumber(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  throw new TypeError('规范化序列化不支持的类型：' + typeof value);
}

// 与 ECMAScript Number.prototype.toString 一致的最短往返表示；
// 凭证中的数值均为整数/普通有限数，这里拒绝 NaN/Infinity（JCS 中不可序列化）。
function serializeNumber(n) {
  if (!Number.isFinite(n)) throw new TypeError('凭证中不允许 NaN/Infinity');
  if (Number.isInteger(n)) return String(n);
  return JSON.stringify(n);
}

function canonicalDigest(value) {
  return require('crypto').createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

module.exports = { canonicalize, canonicalDigest };
