#!/usr/bin/env node
'use strict';

// 发布凭证离线校验程序（CLI，零第三方依赖，可直接拷入脱机环境）。
//
// 用法：
//   node src/attestation-verify.js --credential <凭证.json> --keyring <公开密钥环.json>
//   cat credential.json | node src/attestation-verify.js --keyring public-keyring.json
//   node src/attestation-verify.js --dir <凭证目录> --keyring public-keyring.json
//
// 选项：
//   --credential, -c <file>   凭证文件（省略时从 stdin 读取）
//   --keyring,   -k <file>   公开密钥环文件（/api/attestation/keyring 的导出 JSON）
//   --dir,       -d <dir>    批量校验目录下所有 *.json 凭证（每个文件须是独立凭证信封）
//   --text,      -t          人类可读输出（默认输出机器可读 JSON）
//   --help,      -h          帮助
//
// 退出码：全部凭证有效 0；任一无效/被篡改/无法核验 1；用法错误 2。

const fs = require('fs');
const path = require('path');
const { verifyAttestation } = require('./attestation-verify-lib');

function parseArgs(argv) {
  const opts = { credential: null, keyring: null, dir: null, text: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-c': case '--credential': opts.credential = argv[++i]; break;
      case '-k': case '--keyring': opts.keyring = argv[++i]; break;
      case '-d': case '--dir': opts.dir = argv[++i]; break;
      case '-t': case '--text': opts.text = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function loadJson(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`无法读取${label}：${file}（${e.message}）`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label}不是合法 JSON：${file}（${e.message}）`);
  }
}

function renderText(name, r) {
  const lines = [];
  lines.push(`凭证：${name}`);
  lines.push(`  展览包：#${r.packageId === null ? '?' : r.packageId}${r.packageName ? ` ${r.packageName}` : ''}`
    + `  快照：#${r.snapshotId === null ? '?' : r.snapshotId}  依据版本：${r.basisVersion === null ? '?' : r.basisVersion}`
    + `  封存时间：${r.sealedAt || '?'}`);
  const sig = r.signature.valid ? '✓ 有效' : '✗ 无效';
  lines.push(`  签名：${sig}（kid=${r.signature.kid || '?'}，${r.signature.message || ''}）`);
  if (r.manifest) {
    lines.push(`  清单：${r.manifest.itemCount} 件入展品 / ${r.manifest.rootCount} 根，`
      + `来源子图 ${r.manifest.nodeCount} 节点、${r.manifest.edgeCount} 边，`
      + `授权条款 ${r.manifest.termCount} 份，采用关系 ${r.manifest.adoptionCount} 条`);
  }
  for (const s of r.stops) {
    lines.push(`  第 ${s.position === null ? '?' : s.position + 1} 站「${s.name || ''}」`
      + ` ${s.medium || '?'} / ${s.region || '?'} / ${s.useFrom || '?'}~${s.useTo || '?'}`
      + `：${s.eligible ? '✓ 整段覆盖（来源链全部节点）' : `✗ ${s.failReasons.length} 项问题`}`);
    for (const f of s.failReasons) lines.push(`      - [${f.code}] ${f.message}`);
  }
  if (r.globalFailReasons.length) {
    lines.push('  全局问题：');
    for (const f of r.globalFailReasons) lines.push(`      - [${f.code}] ${f.message}`);
  }
  lines.push(`  总结论：${r.ok ? '✓ 凭证有效：签名、来源子图与逐站整段覆盖全部复算通过' : '✗ 凭证无效或已被篡改'}`);
  return lines.join('\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).join('\n').replace(/^\/\/ ?/gm, ''));
    process.exit(0);
  }

  let keyring = null;
  if (opts.keyring) {
    try {
      keyring = loadJson(opts.keyring, '公开密钥环文件');
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(2);
    }
  }

  const jobs = []; // {name, envelope}
  try {
    if (opts.dir) {
      const files = fs.readdirSync(opts.dir).filter((f) => f.endsWith('.json')).sort();
      if (!files.length) throw new Error(`目录 ${opts.dir} 下没有 *.json 凭证文件`);
      for (const f of files) {
        const full = path.join(opts.dir, f);
        jobs.push({ name: full, envelope: loadJson(full, '凭证文件') });
      }
    } else if (opts.credential) {
      jobs.push({ name: opts.credential, envelope: loadJson(opts.credential, '凭证文件') });
    } else if (!process.stdin.isTTY) {
      const raw = await readStdin();
      try {
        jobs.push({ name: '<stdin>', envelope: JSON.parse(raw) });
      } catch (e) {
        throw new Error('stdin 内容不是合法凭证 JSON：' + e.message);
      }
    } else {
      console.error('缺少凭证：用 --credential 指定文件，或通过管道从 stdin 传入；--help 查看用法');
      process.exit(2);
    }
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }

  const reports = jobs.map((j) => ({ name: j.name, result: verifyAttestation(j.envelope, keyring) }));
  const allOk = reports.every((r) => r.result.ok);

  if (opts.text) {
    for (const r of reports) console.log(renderText(r.name, r.result) + '\n');
    console.log(allOk ? `全部 ${reports.length} 份凭证有效。` : `${reports.filter((r) => !r.result.ok).length}/${reports.length} 份凭证无效。`);
  } else {
    const out = reports.length === 1
      ? { credential: reports[0].name, ...reports[0].result }
      : {
          ok: allOk,
          total: reports.length,
          valid: reports.filter((r) => r.result.ok).length,
          invalid: reports.filter((r) => !r.result.ok).length,
          reports: reports.map((r) => ({ credential: r.name, ...r.result })),
        };
    console.log(JSON.stringify(out, null, 2));
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('校验程序异常：' + (e && e.message ? e.message : e));
  process.exit(2);
});
