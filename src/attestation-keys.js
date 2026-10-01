'use strict';

// 发布凭证签名密钥环：Ed25519，本机持久化。
//
// 存储：<ATTESTATION_KEY_DIR>/keys.json（默认目录为数据库所在目录下的 signing-keys/）。
// 私钥文件权限 0600；轮换只新增密钥、把旧密钥标记为 retired，永不删除旧公钥——
// 旧凭证必须永远能用签发时的旧公钥验证。
//
// 离线环境只需 /api/attestation/keyring 导出的公开密钥（或 keys.json 中
// 各密钥的 publicKeyPem），私钥永不出本机、永不经 HTTP 返回。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALG = 'EdDSA'; // Ed25519 (RFC 8032)
const KEY_MAGIC = 'exhibit-attestation-keyring-v1';

function defaultKeyDir() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
  return process.env.ATTESTATION_KEY_DIR || path.join(path.dirname(dbPath), 'signing-keys');
}

class KeyringError extends Error {}

function kidFor(version, publicDer) {
  const fp = crypto.createHash('sha256').update(publicDer).digest('hex');
  return `attest-v${version}-${fp.slice(0, 12)}`;
}

function pemPublic(keyObject) {
  return keyObject.export({ type: 'spki', format: 'pem' });
}

function pemPrivate(keyObject) {
  return keyObject.export({ type: 'pkcs8', format: 'pem' });
}

function importPublic(pem) {
  return crypto.createPublicKey({ key: pem, format: 'pem' });
}

function fingerprintPem(pem) {
  const der = crypto.createPublicKey({ key: pem, format: 'pem' }).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function loadStore(keyDir) {
  const file = path.join(keyDir, 'keys.json');
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new KeyringError(`签名密钥环文件损坏且无法解析（${file}）：${e.message}。为避免误用未知私钥，拒绝启动；请从备份恢复或由管理员处置。`);
  }
  if (!parsed || parsed.magic !== KEY_MAGIC || !Array.isArray(parsed.keys) || !parsed.keys.length) {
    throw new KeyringError(`签名密钥环文件格式无法识别（${file}），拒绝使用。`);
  }
  return parsed;
}

function persistStore(keyDir, store) {
  fs.mkdirSync(keyDir, { recursive: true });
  const file = path.join(keyDir, 'keys.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 等平台忽略 */ }
}

function publicKeyInfo(entry, currentVersion) {
  return {
    kid: entry.kid,
    version: entry.version,
    alg: ALG,
    current: entry.version === currentVersion,
    retired: !!entry.retiredAt,
    publicKeyPem: entry.publicKeyPem,
    fingerprintSha256: entry.fingerprintSha256,
    createdAt: entry.createdAt,
    retiredAt: entry.retiredAt || null,
  };
}

class Keyring {
  constructor(keyDir) {
    this.keyDir = keyDir;
    this.store = loadStore(keyDir);
  }

  ensure() {
    if (this.store) return this.store;
    this.store = { magic: KEY_MAGIC, currentVersion: 0, keys: [] };
    this._generate('首次启动自动生成');
    persistStore(this.keyDir, this.store);
    return this.store;
  }

  _generate(note) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const version = Math.max(0, ...this.store.keys.map((k) => k.version)) + 1;
    const pubPem = pemPublic(publicKey);
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const now = new Date().toISOString();
    const entry = {
      version,
      kid: kidFor(version, der),
      publicKeyPem: pubPem,
      privateKeyPem: pemPrivate(privateKey),
      fingerprintSha256: crypto.createHash('sha256').update(der).digest('hex'),
      createdAt: now,
      retiredAt: null,
      note: note || '',
    };
    this.store.keys.push(entry);
    this.store.currentVersion = version;
    return entry;
  }

  // 轮换：新增一把当前密钥，旧密钥保留公钥并标记 retired（旧凭证仍可验）
  rotate(note) {
    this.ensure();
    const previous = this.store.keys.find((k) => k.version === this.store.currentVersion);
    const entry = this._generate(note || `第 ${this.store.currentVersion} 次轮换`);
    if (previous) previous.retiredAt = new Date().toISOString();
    persistStore(this.keyDir, this.store);
    return { rotatedTo: publicKeyInfo(entry, this.store.currentVersion), keyring: this.publicInfo() };
  }

  // 返回当前签名私钥（发布时同事务内调用；私钥对象不离开本进程）
  currentSigner() {
    this.ensure();
    const entry = this.store.keys.find((k) => k.version === this.store.currentVersion);
    if (!entry) throw new KeyringError('密钥环中找不到当前签名密钥');
    return {
      kid: entry.kid,
      version: entry.version,
      alg: ALG,
      privateKey: crypto.createPrivateKey({ key: entry.privateKeyPem, format: 'pem' }),
    };
  }

  // 按 kid 找公钥（含已轮换的旧密钥）；找不到返回 null
  findPublicKey(kid) {
    this.ensure();
    const entry = this.store.keys.find((k) => k.kid === kid);
    return entry ? importPublic(entry.publicKeyPem) : null;
  }

  publicInfo() {
    this.ensure();
    return {
      magic: KEY_MAGIC,
      alg: ALG,
      currentVersion: this.store.currentVersion,
      currentKid: this.store.keys.find((k) => k.version === this.store.currentVersion).kid,
      keys: this.store.keys
        .slice()
        .sort((a, b) => a.version - b.version)
        .map((k) => publicKeyInfo(k, this.store.currentVersion)),
    };
  }

  // 供离线审计人员导出的纯公开密钥文件（不包含任何私钥材料）
  exportPublicKeyringFile() {
    const info = this.publicInfo();
    return {
      format: 'exhibit-attestation-public-keyring-v1',
      exportedAt: new Date().toISOString(),
      ...info,
    };
  }
}

let singleton;
function getKeyring() {
  if (!singleton) singleton = new Keyring(defaultKeyDir());
  return singleton;
}

module.exports = {
  ALG,
  KEY_MAGIC,
  Keyring,
  KeyringError,
  getKeyring,
  defaultKeyDir,
  fingerprintPem,
  importPublic,
};
