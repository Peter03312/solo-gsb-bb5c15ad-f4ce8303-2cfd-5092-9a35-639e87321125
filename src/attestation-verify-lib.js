'use strict';

// 发布凭证离线校验器（核心逻辑，零第三方依赖）。
//
// 独立校验程序仅凭：
//   1) 凭证文件（/api/packages/:id/attestation 导出，含 body 与签名）
//   2) 公开密钥环（/api/attestation/keyring 导出，含轮换过的全部公钥）
// 即可复算：签名、清单与完整来源子图的一致性、逐站整段覆盖（含来源链）。
// 全程不连接馆内数据库、不发起任何网络请求。
//
// 同一套规则既被本模块的 CLI（src/attestation-verify.js）使用，
// 也可被 require 后在任意 Node 20 环境调用 verifyAttestation()。

const crypto = require('crypto');
const { canonicalize } = require('./canonical');

const FORMAT = 'exhibit-publish-attestation';
const SUPPORTED_FORMAT_VERSION = 1;
const RULES_VERSION = 'exhibit-verify-rules-v1';
const SUPPORTED_RULES = new Set([RULES_VERSION]);

// ---------- 核验规则 v1（与 src/verify.js 发布闸门一致，离线独立实现） ----------

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function scopeMatches(value, wanted) {
  if (value === '*') return true;
  return String(value == null ? '' : value).trim().toLowerCase()
    === String(wanted == null ? '' : wanted).trim().toLowerCase();
}

// 闭区间覆盖：授权有效期必须独自覆盖整段展期（不拼接）
function termCovers(term, stop) {
  return !term.revoked
    && scopeMatches(term.media, stop.medium)
    && scopeMatches(term.region, stop.region)
    && term.validFrom <= stop.useFrom
    && term.validTo >= stop.useTo;
}

function failCode(code, message, extra) {
  return { code, message, ...(extra || {}) };
}

// ---------- 公开密钥载入 ----------

// publicKeys 支持：
//   - Map<kid, string|PEM|KeyObject>
//   - 导出的公开密钥环对象 {keys:[{kid, publicKeyPem}]}
function resolveKey(publicKeys, kid) {
  if (!publicKeys) return null;
  let raw;
  if (publicKeys instanceof Map) raw = publicKeys.get(kid);
  else if (Array.isArray(publicKeys.keys)) {
    const e = publicKeys.keys.find((k) => k.kid === kid);
    raw = e ? (e.publicKeyPem || e.publicKey) : null;
  }
  if (!raw) return null;
  if (raw && typeof raw === 'object' && raw.type === 'public') return raw;
  try {
    return crypto.createPublicKey({ key: raw, format: 'pem' });
  } catch {
    return null;
  }
}

function verifySignature(envelope) {
  const sig = envelope && typeof envelope === 'object' ? envelope.signature : null;
  const kid = envelope && envelope.kid;
  const alg = envelope && envelope.alg;
  const body = envelope ? envelope.body : null;
  if (body === undefined || body === null || typeof body !== 'object') {
    return { checked: false, valid: false, code: 'SIGNATURE_BODY_MISSING', message: '凭证缺少待签名的 body' };
  }
  if (typeof sig !== 'string' || !sig) {
    return { checked: false, valid: false, code: 'SIGNATURE_MISSING', kid, alg, message: '凭证缺少签名' };
  }
  return { checked: true, valid: null, kid, alg, sig, body };
}

// ---------- 子图复算 ----------

function reachableFromRoots(roots, edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const seen = new Set();
  const stack = roots.slice();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) || []) if (!seen.has(nxt)) stack.push(nxt);
  }
  return { seen, adj };
}

function findCycle(roots, adj, nodeSet) {
  // 返回任意一条闭环（节点 id 数组），无环返回 null；不可达节点不参与
  const color = new Map(); // 0=未访问(默认) 1=在栈上 2=完成
  const stackSet = [];
  let cycle = null;

  const dfs = (u) => {
    if (cycle) return;
    color.set(u, 1);
    stackSet.push(u);
    for (const v of adj.get(u) || []) {
      if (!nodeSet.has(v)) continue;
      const c = color.get(v) || 0;
      if (c === 1) {
        const i = stackSet.indexOf(v);
        cycle = stackSet.slice(i).concat(v);
        return;
      }
      if (c === 0) dfs(v);
      if (cycle) return;
    }
    stackSet.pop();
    color.set(u, 2);
  };

  for (const r of roots) {
    if ((color.get(r) || 0) === 0) dfs(r);
    if (cycle) break;
  }
  return cycle;
}

// ---------- 主入口 ----------

/**
 * 校验一份发布凭证。
 * @param {object} envelope 凭证 JSON（含 body、signature、kid、alg…）
 * @param {object|Map} [publicKeys] 公开密钥环或 kid->key 映射；缺省时仍做全部结构复算，但签名项标记无法核验
 * @returns {object} 结构化结论（含逐站结论与篡改原因）
 */
function verifyAttestation(envelope, publicKeys) {
  const result = {
    ok: false,
    format: null,
    version: null,
    rulesVersion: null,
    packageId: null,
    packageName: null,
    snapshotId: null,
    basisVersion: null,
    sealedAt: null,
    signature: { checked: false, valid: false, kid: null, alg: null, code: null, message: null },
    manifest: null,
    globalFailReasons: [],
    stops: [],
    eligible: false,
  };

  // 1) 信封与签名
  const prepared = verifySignature(envelope);
  result.signature.kid = prepared.kid || null;
  result.signature.alg = prepared.alg || null;
  let body = null;
  let bodyCanonicalHex = null;

  if (prepared.checked) {
    body = prepared.body;
    let canon;
    try {
      canon = canonicalize(body);
      bodyCanonicalHex = crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
    } catch (e) {
      result.signature = {
        checked: false, valid: false, kid: prepared.kid, alg: prepared.alg,
        code: 'ENVELOPE_NOT_CANONICALIZABLE', message: `凭证内容无法规范化序列化：${e.message}`,
      };
      result.globalFailReasons.push(failCode('ENVELOPE_FORMAT', '凭证结构非法，无法进行任何复算'));
      return finalize(result);
    }

    if (envelope.bodyHash && typeof envelope.bodyHash === 'string'
      && envelope.bodyHash.toLowerCase() !== bodyCanonicalHex) {
      result.globalFailReasons.push(failCode('BODY_HASH_MISMATCH',
        '凭证 bodyHash 与 body 规范化哈希不一致（body 或 bodyHash 被改动）',
        { declared: envelope.bodyHash, recomputed: bodyCanonicalHex }));
    }

    const key = resolveKey(publicKeys, prepared.kid);
    if (publicKeys === undefined || publicKeys === null) {
      result.signature = {
        checked: false, valid: false, kid: prepared.kid, alg: prepared.alg,
        code: 'PUBLIC_KEYRING_MISSING',
        message: '未提供公开密钥环，无法核验签名；结构复算仍已执行（其结论不构成对签发方的信任）',
      };
    } else if (!key) {
      result.signature = {
        checked: true, valid: false, kid: prepared.kid, alg: prepared.alg,
        code: 'UNKNOWN_SIGNING_KEY',
        message: `签发密钥 kid=${prepared.kid} 不在公开密钥环中（密钥环缺旧公钥或凭证伪造）`,
      };
      result.globalFailReasons.push(failCode('UNKNOWN_SIGNING_KEY',
        `凭证由未知密钥 ${prepared.kid} 签发，密钥环中无对应公钥（轮换时未保留旧公钥，或凭证伪造）`));
    } else {
      let sigBuf;
      try {
        sigBuf = Buffer.from(prepared.sig, 'base64url');
      } catch {
        sigBuf = null;
      }
      let valid = false;
      if (sigBuf && sigBuf.length > 0) {
        try {
          valid = crypto.verify(null, Buffer.from(canon, 'utf8'), key, sigBuf);
        } catch {
          valid = false;
        }
      }
      result.signature = {
        checked: true, valid, kid: prepared.kid, alg: prepared.alg,
        code: valid ? null : 'SIGNATURE_INVALID',
        message: valid
          ? '签名有效：body 与签发时逐字节一致'
          : '签名校验失败：body 已被篡改，或该签名并非 kid 对应私钥所签',
      };
      if (!valid) {
        result.globalFailReasons.push(failCode('SIGNATURE_INVALID',
          '签名与 body 不匹配——凭证内容在签发后被改动，或签名/密钥被替换'));
      }
    }
  } else {
    result.signature = {
      checked: false, valid: false, kid: prepared.kid || null, alg: prepared.alg || null,
      code: prepared.code, message: prepared.message,
    };
    result.globalFailReasons.push(failCode(prepared.code || 'ENVELOPE_FORMAT', prepared.message || '凭证信封结构非法'));
    return finalize(result);
  }

  // 2) body 结构与版本
  result.format = body.format || null;
  result.version = typeof body.version === 'number' ? body.version : null;
  result.rulesVersion = body.rulesVersion || null;
  result.packageId = body.packageId ?? null;
  result.packageName = body.packageName || null;
  result.snapshotId = body.snapshotId ?? null;
  result.basisVersion = body.basisVersion ?? null;
  result.sealedAt = body.sealedAt || null;

  if (body.format !== FORMAT) {
    result.globalFailReasons.push(failCode('UNSUPPORTED_FORMAT',
      `凭证格式标识不是 ${FORMAT}（实际：${String(body.format)}）`));
  }
  if (body.version !== SUPPORTED_FORMAT_VERSION) {
    result.globalFailReasons.push(failCode('UNSUPPORTED_FORMAT_VERSION',
      `凭证格式版本不受支持（期望 ${SUPPORTED_FORMAT_VERSION}，实际：${String(body.version)}）`));
  }
  if (!SUPPORTED_RULES.has(body.rulesVersion)) {
    result.globalFailReasons.push(failCode('UNSUPPORTED_RULES_VERSION',
      `核验规则版本不受支持（期望 ${RULES_VERSION}，实际：${String(body.rulesVersion)}）`));
  }

  const stopOnStructure = result.globalFailReasons.some((r) =>
    ['UNSUPPORTED_FORMAT', 'UNSUPPORTED_FORMAT_VERSION'].includes(r.code));

  // 3) 清单 / 子图 / 行程 / 条款的结构校验与逐站复算
  if (!stopOnStructure) {
    recomputeBody(body, result);
  } else {
    result.manifest = null;
  }

  return finalize(result);
}

function pushGlobal(result, code, message, extra) {
  if (!result.globalFailReasons.some((r) => r.code === code && r.message === message)) {
    result.globalFailReasons.push(failCode(code, message, extra));
  }
}

function recomputeBody(body, result) {
  const g = result.globalFailReasons;

  // ---- 清单 ----
  const items = Array.isArray(body.manifest && body.manifest.items) ? body.manifest.items : null;
  const roots = [];
  if (items) {
    for (const it of items) {
      if (!it || typeof it.materialId !== 'number' || !Number.isInteger(it.materialId) || it.materialId <= 0) {
        pushGlobal(result, 'MANIFEST_INVALID', '清单中存在非法素材条目（materialId 必须为正整数）');
      } else if (!roots.includes(it.materialId)) {
        roots.push(it.materialId);
      }
    }
  } else {
    pushGlobal(result, 'MANIFEST_INVALID', '凭证缺少清单 manifest.items');
  }
  if (roots.length === 0) pushGlobal(result, 'MANIFEST_EMPTY', '发布凭证的入展清单为空（发布包至少含一件入展素材）');

  // ---- 行程 ----
  const stops = Array.isArray(body.itinerary && body.itinerary.stops) ? body.itinerary.stops : null;
  const multiStop = body.multiStop === true;
  if (!stops || stops.length === 0) {
    pushGlobal(result, 'ITINERARY_INVALID', '凭证缺少逐站行程 itinerary.stops');
  } else {
    if (!multiStop && stops.length !== 1) {
      pushGlobal(result, 'MULTI_STOP_FLAG_INCONSISTENT',
        `multiStop=false 的单站包凭证应恰有 1 站，实际 ${stops.length} 站`);
    }
    if (multiStop && stops.length < 2) {
      pushGlobal(result, 'MULTI_STOP_FLAG_INCONSISTENT',
        `multiStop=true 的多站包凭证应至少 2 站，实际 ${stops.length} 站`);
    }
    for (const s of stops) {
      if (!s || typeof s.position !== 'number') {
        pushGlobal(result, 'ITINERARY_INVALID', '存在缺少 position 的站次');
        continue;
      }
      const missing = [];
      if (!s.medium) missing.push('媒介');
      if (!s.region) missing.push('地区');
      if (!isValidDate(s.useFrom)) missing.push('起始日期');
      if (!isValidDate(s.useTo)) missing.push('截止日期');
      if (missing.length) {
        pushGlobal(result, 'ITINERARY_INVALID',
          `第 ${s.position + 1} 站${s.name ? `「${s.name}」` : ''}字段缺失或非法：${missing.join('、')}`);
      } else if (s.useFrom > s.useTo) {
        pushGlobal(result, 'ITINERARY_INVALID',
          `第 ${s.position + 1} 站「${s.name || ''}」起止日期倒置（${s.useFrom} > ${s.useTo}）`);
      }
    }
    // 站序与站间不重叠（首尾日均占用：后一站.useFrom 必须 > 前一站.useTo）
    const sorted = stops.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].position !== i) {
        pushGlobal(result, 'ITINERARY_INVALID', `站次 position 必须从 0 连续编号（发现 #${sorted[i].position}）`);
        break;
      }
    }
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (isValidDate(prev.useFrom) && isValidDate(prev.useTo) && isValidDate(cur.useFrom) && isValidDate(cur.useTo)
        && cur.useFrom <= prev.useTo) {
        pushGlobal(result, 'STOPS_OVERLAP',
          `第 ${i} 站「${prev.name || ''}」展期至 ${prev.useTo}，与第 ${i + 1} 站「${cur.name || ''}」起始 ${cur.useFrom} 重叠` +
          '（首尾日均占用，后一站须晚于前一站截止日开始；短授权/短行程不可拼接）');
      }
    }
  }

  // ---- 来源子图 ----
  const graphNodes = Array.isArray(body.sourceGraph && body.sourceGraph.nodes) ? body.sourceGraph.nodes : null;
  const graphEdges = Array.isArray(body.sourceGraph && body.sourceGraph.edges) ? body.sourceGraph.edges : null;
  const nodeById = new Map();
  const edgeKeys = new Set();

  if (!graphNodes) pushGlobal(result, 'GRAPH_INVALID', '凭证缺少完整来源子图 sourceGraph.nodes');
  else {
    for (const n of graphNodes) {
      if (!n || typeof n.materialId !== 'number' || !Number.isInteger(n.materialId) || n.materialId <= 0) {
        pushGlobal(result, 'GRAPH_INVALID', '来源子图存在非法节点（materialId 必须为正整数）');
        continue;
      }
      if (nodeById.has(n.materialId)) pushGlobal(result, 'GRAPH_INVALID', `来源子图节点 #${n.materialId} 重复`);
      nodeById.set(n.materialId, n);
    }
  }
  if (!graphEdges) pushGlobal(result, 'GRAPH_INVALID', '凭证缺少完整来源子图 sourceGraph.edges');
  else {
    for (const e of graphEdges) {
      if (!e || typeof e.from !== 'number' || typeof e.to !== 'number') {
        pushGlobal(result, 'GRAPH_INVALID', '来源子图存在非法边（from/to 必须为素材 id）');
        continue;
      }
      if (!nodeById.has(e.from) || !nodeById.has(e.to)) {
        pushGlobal(result, 'GRAPH_ENDPOINT_MISSING',
          `来源边 ${e.from} → ${e.to} 引用了子图中不存在的节点`);
      }
      const key = `${e.from}>${e.to}`;
      if (edgeKeys.has(key)) pushGlobal(result, 'GRAPH_INVALID', `来源边 ${e.from} → ${e.to} 重复`);
      edgeKeys.add(key);
    }
  }

  let adj = new Map();
  let reachable = new Set();
  if (nodeById.size && graphEdges && roots.length) {
    const validEdges = graphEdges.filter((e) => nodeById.has(e.from) && nodeById.has(e.to));
    const r = reachableFromRoots(roots, validEdges);
    adj = r.adj;
    reachable = r.seen;
    for (const id of roots) {
      if (!nodeById.has(id)) pushGlobal(result, 'MANIFEST_NODE_MISSING', `入展素材 #${id} 不在来源子图节点中`);
    }
    // 子图必须恰为“清单 + 其全部上游来源”的闭包：
    // 非根节点从清单根不可达，无论原因是“删了来源边（断链）”还是“凭空塞入节点”，
    // 都说明来源子图不是完整来源闭包；两类再按是否与边相连细分原因码。
    const broken = [];
    for (const id of nodeById.keys()) {
      if (reachable.has(id)) continue;
      if (roots.includes(id)) {
        pushGlobal(result, 'GRAPH_NODE_UNREACHABLE',
          `清单根节点 #${id} 在子图中不可达（清单/子图被改动）`);
      } else {
        broken.push(id);
      }
    }
    for (const id of reachable) {
      if (!nodeById.has(id)) broken.push(id);
    }
    if (broken.length) {
      const ids = [...new Set(broken)].sort((a, b) => a - b);
      pushGlobal(result, 'GRAPH_NODE_MISSING',
        `来源子图不完整：节点 ${ids.join(',')} 无法由入展素材经所存来源边到达或缺失`
        + '（来源边被删除造成断链，或凭证被塞入不属于来源链的节点）',
        { nodeIds: ids });
    }
    const cycle = findCycle(roots, adj, new Set(nodeById.keys()));
    if (cycle) {
      pushGlobal(result, 'GRAPH_CYCLE',
        `来源子图存在闭环：${cycle.join(' → ')}（来源关系不得成环，发布闸门不可能放行）`);
    }
  }

  // ---- 实际采用的未撤销授权条款 ----
  const terms = Array.isArray(body.terms) ? body.terms : null;
  const termById = new Map();
  if (!terms) {
    pushGlobal(result, 'TERMS_INVALID', '凭证缺少授权条款 terms');
  } else {
    for (const t of terms) {
      const probs = [];
      if (!t || typeof t.authorizationId !== 'number') probs.push('authorizationId');
      if (!t || typeof t.materialId !== 'number') probs.push('materialId');
      if (!t || !t.media) probs.push('media');
      if (!t || !t.region) probs.push('region');
      if (!t || !isValidDate(t.validFrom)) probs.push('validFrom');
      if (!t || !isValidDate(t.validTo)) probs.push('validTo');
      if (probs.length) {
        pushGlobal(result, 'TERMS_INVALID', `授权条款记录字段缺失或非法：${probs.join('、')}`);
        continue;
      }
      if (t.validFrom > t.validTo) {
        pushGlobal(result, 'TERMS_INVALID',
          `授权 #${t.authorizationId} 有效期倒置（${t.validFrom} > ${t.validTo}）`);
      }
      if (!nodeById.has(t.materialId)) {
        pushGlobal(result, 'TERMS_NODE_UNKNOWN',
          `授权 #${t.authorizationId} 绑定的素材 #${t.materialId} 不在来源子图中`);
      }
      if (t.revoked === true) {
        pushGlobal(result, 'TERM_REVOKED',
          `列为“实际采用”的授权 #${t.authorizationId} 处于已撤销状态（撤销授权不得作为发布依据）`);
      }
      if (termById.has(t.authorizationId)) {
        pushGlobal(result, 'TERMS_INVALID', `授权 #${t.authorizationId} 在条款中重复出现`);
      }
      termById.set(t.authorizationId, t);
    }
  }

  // ---- 逐站采用关系 ----
  const adoption = Array.isArray(body.adoption) ? body.adoption : null;
  const adoptionKeys = new Set();
  if (!adoption) pushGlobal(result, 'ADOPTION_INVALID', '凭证缺少逐站逐节点采用的授权 adoption');

  const usableStops = (stops || []).filter((s) => s && typeof s.position === 'number'
    && s.medium && s.region && isValidDate(s.useFrom) && isValidDate(s.useTo) && s.useFrom <= s.useTo);
  const usableNodes = [...nodeById.keys()].sort((a, b) => a - b);

  if (adoption) {
    for (const a of adoption) {
      if (!a || typeof a.stopPosition !== 'number' || typeof a.materialId !== 'number'
        || typeof a.authorizationId !== 'number') {
        pushGlobal(result, 'ADOPTION_INVALID', 'adoption 条目必须包含 stopPosition/materialId/authorizationId');
        continue;
      }
      const key = `${a.stopPosition}:${a.materialId}`;
      if (adoptionKeys.has(key)) {
        pushGlobal(result, 'ADOPTION_DUPLICATE',
          `第 ${a.stopPosition + 1} 站节点 #${a.materialId} 存在多条采用授权（同站必须由一份授权独自覆盖，不可拼接）`);
      }
      adoptionKeys.add(key);
      if (!usableStops.some((s) => s.position === a.stopPosition)) {
        pushGlobal(result, 'ADOPTION_STOP_UNKNOWN',
          `adoption 引用了不存在或非法的站次 position=${a.stopPosition}`);
      }
      if (!nodeById.has(a.materialId)) {
        pushGlobal(result, 'ADOPTION_NODE_UNKNOWN',
          `adoption 引用了子图中不存在的节点 #${a.materialId}`);
      }
      const t = termById.get(a.authorizationId);
      if (!t) {
        pushGlobal(result, 'ADOPTION_TERM_MISSING',
          `第 ${a.stopPosition + 1} 站节点 #${a.materialId} 采用的授权 #${a.authorizationId} 不在凭证条款中`);
      } else if (t.materialId !== a.materialId) {
        pushGlobal(result, 'ADOPTION_TERM_MISMATCH',
          `授权 #${a.authorizationId} 属于素材 #${t.materialId}，却被采用为节点 #${a.materialId} 的依据`);
      }
    }
  }

  // ---- 逐站整段覆盖复算 ----
  result.manifest = {
    itemCount: items ? items.length : 0,
    rootCount: roots.length,
    materialIds: roots.slice().sort((a, b) => a - b),
    nodeCount: nodeById.size,
    edgeCount: edgeKeys.size,
    termCount: termById.size,
    adoptionCount: adoptionKeys.size,
  };

  result.stops = (stops || []).map((s) => {
    const stopRes = {
      position: s && typeof s.position === 'number' ? s.position : null,
      name: s ? s.name || null : null,
      medium: s ? s.medium || null : null,
      region: s ? s.region || null : null,
      useFrom: s ? s.useFrom || null : null,
      useTo: s ? s.useTo || null : null,
      eligible: false,
      nodeCount: 0,
      failReasons: [],
    };
    const stopValid = s && typeof s.position === 'number' && s.medium && s.region
      && isValidDate(s.useFrom) && isValidDate(s.useTo) && s.useFrom <= s.useTo;
    if (!stopValid) {
      stopRes.failReasons.push(failCode('STOP_INVALID', '该站参数非法，无法进行覆盖复算'));
      return stopRes;
    }
    stopRes.nodeCount = usableNodes.length;
    for (const mid of usableNodes) {
      const adoptedEntry = adoption
        ? adoption.find((a) => a.stopPosition === s.position && a.materialId === mid)
        : null;
      const node = nodeById.get(mid);
      const label = `第 ${s.position + 1} 站「${s.name || ''}」节点 #${mid}${node && node.title ? `（${node.title}）` : ''}`;

      // 独立复算：从凭证条款中找任何一份能独自覆盖该站整段的未撤销授权
      const covering = [...termById.values()].filter((t) => t.materialId === mid && termCovers(t, s));
      const declaredTerm = adoptedEntry ? termById.get(adoptedEntry.authorizationId) : null;
      if (covering.length === 0) {
        const nodeTerms = [...termById.values()].filter((t) => t.materialId === mid);
        let code = 'NODE_NO_LICENSE';
        let msg = `${label}：凭证条款中没有任何授权覆盖该站整段展期`;
        if (nodeTerms.length > 0) {
          const mediaOk = nodeTerms.some((t) => !t.revoked && scopeMatches(t.media, s.medium));
          const regionOk = nodeTerms.some((t) => !t.revoked && scopeMatches(t.region, s.region));
          const revokedAll = nodeTerms.every((t) => t.revoked);
          if (revokedAll) {
            code = 'NODE_LICENSE_REVOKED';
            msg = `${label}：所采用授权均已撤销`;
          } else if (!mediaOk && !regionOk) {
            code = 'NODE_MEDIA_REGION';
            msg = `${label}：无同时命中该站展示媒介「${s.medium}」与地区「${s.region}」的授权`;
          } else if (!mediaOk) {
            code = 'NODE_MEDIA';
            msg = `${label}：无命中该站展示媒介「${s.medium}」的授权`;
          } else if (!regionOk) {
            code = 'NODE_REGION';
            msg = `${label}：无命中该站展示地区「${s.region}」的授权`;
          } else {
            code = 'NODE_DATE';
            msg = `${label}：没有任何一份授权能独自覆盖该站整段展期 ${s.useFrom} ~ ${s.useTo}（短授权不可拼接）`;
          }
        }
        stopRes.failReasons.push(failCode(code, msg, { materialId: mid }));
      }

      // 凭证声明的“实际采用”授权必须存在、且确实独自覆盖该站（即使凭证里另有覆盖条款，
      // 声明采用的那一份不合格同样是篡改：发布时采用的就是该份）
      if (!adoption) continue;
      if (!adoptedEntry) {
        stopRes.failReasons.push(failCode('ADOPTION_MISSING',
          `${label}：凭证未声明该站该节点实际采用的授权（每站每节点必须有且仅有一份采用授权）`,
          { materialId: mid }));
        continue;
      }
      if (!declaredTerm) {
        stopRes.failReasons.push(failCode('ADOPTION_TERM_MISSING',
          `${label}：声明采用的授权 #${adoptedEntry.authorizationId} 不在凭证条款中`,
          { materialId: mid, authorizationId: adoptedEntry.authorizationId }));
      } else if (declaredTerm.materialId !== mid) {
        stopRes.failReasons.push(failCode('ADOPTION_TERM_MISMATCH',
          `${label}：授权 #${declaredTerm.authorizationId} 属于素材 #${declaredTerm.materialId} 而非本节点`,
          { materialId: mid, authorizationId: declaredTerm.authorizationId }));
      } else if (!termCovers(declaredTerm, s)) {
        stopRes.failReasons.push(failCode('ADOPTION_NOT_COVERING',
          `${label}：声明实际采用的授权 #${declaredTerm.authorizationId} 不能独自覆盖该站整段展期（媒介/地区/有效期不符或已撤销；短授权不可拼接）`,
          { materialId: mid, authorizationId: declaredTerm.authorizationId }));
      }
    }
    stopRes.eligible = stopRes.failReasons.length === 0;
    return stopRes;
  });

  // adoption 覆盖完整性：每站 × 每节点恰好一条
  if (adoption && usableStops.length && usableNodes.length) {
    const expected = new Set();
    for (const s of usableStops) for (const id of usableNodes) expected.add(`${s.position}:${id}`);
    for (const k of adoptionKeys) if (!expected.has(k)) {
      const [p, m] = k.split(':').map(Number);
      pushGlobal(result, 'ADOPTION_EXTRA',
        `adoption 含有不属于“合法站次 × 子图节点”的条目（第 ${p + 1} 站 / 节点 #${m}）`);
    }
  }
}

function finalize(result) {
  const perStopFail = result.stops.reduce((n, s) => n + (s.eligible ? 0 : 1), 0);
  result.eligible = result.signature.valid
    && result.globalFailReasons.length === 0
    && result.stops.length > 0
    && perStopFail === 0;
  result.ok = result.eligible;
  result.tampered = !result.signature.valid
    || result.globalFailReasons.length > 0
    || perStopFail > 0;
  result.failingStopCount = perStopFail;
  return result;
}

module.exports = {
  verifyAttestation,
  canonicalize,
  FORMAT,
  RULES_VERSION,
  SUPPORTED_FORMAT_VERSION,
  isValidDate,
  scopeMatches,
  termCovers,
};
