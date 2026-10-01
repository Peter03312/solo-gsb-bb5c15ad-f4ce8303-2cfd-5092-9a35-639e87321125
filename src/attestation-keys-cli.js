#!/usr/bin/env node
'use strict';

// 发布凭证签名密钥的本机管理工具（不经过 HTTP，直接操作密钥环文件）。
//
// 用法：
//   node src/attestation-keys-cli.js keyring [--public]
//       查看密钥环；--public 只输出可公开导出的公钥环（审计用，无任何私钥材料）
//   node src/attestation-keys-cli.js rotate [备注]
//       轮换当前签名密钥：旧密钥保留公钥并标记 retired，旧凭证继续可验
//
// 环境变量 DB_PATH / ATTESTATION_KEY_DIR 决定密钥文件位置（与服务端一致）。

const { getKeyring, defaultKeyDir } = require('./attestation-keys');

const [cmd, ...rest] = process.argv.slice(2);
const publicOnly = rest.includes('--public');
const note = rest.filter((a) => !a.startsWith('--')).join(' ') || undefined;

function main() {
  const kr = getKeyring();
  if (cmd === 'keyring') {
    if (publicOnly) {
      console.log(JSON.stringify(kr.exportPublicKeyringFile(), null, 2));
    } else {
      // 本机管理视图：显示存在私钥的事实，但不打印私钥内容
      const info = kr.publicInfo();
      console.log(JSON.stringify({
        keyDir: defaultKeyDir(),
        currentVersion: info.currentVersion,
        currentKid: info.currentKid,
        keys: info.keys.map((k) => ({ ...k, hasPrivateKey: true })),
      }, null, 2));
    }
    return;
  }
  if (cmd === 'rotate') {
    const out = kr.rotate(note);
    console.error(`密钥已轮换：新当前密钥 ${out.rotatedTo.kid}（version ${out.rotatedTo.version}）；旧公钥已全部保留。`);
    console.log(JSON.stringify(kr.exportPublicKeyringFile(), null, 2));
    return;
  }
  console.error('用法：attestation-keys-cli.js keyring [--public] | rotate [备注]');
  process.exit(2);
}

try {
  main();
} catch (e) {
  console.error('密钥管理失败：' + (e && e.message ? e.message : e));
  process.exit(1);
}
