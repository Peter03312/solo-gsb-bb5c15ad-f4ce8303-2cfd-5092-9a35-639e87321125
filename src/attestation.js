'use strict';

// 发布凭证构建与封存。
//
// 成功发布时，在与发布快照【同一个 SQLite 事务】内：
//   1) 按当时的核验结果 + 库内当前行（同一事务内读取，发布前不会再有写入窗口）
//      组装凭证 body：清单、完整来源子图、逐站行程、每站每个节点实际采用的
//      未撤销授权条款、核验规则版本；
//   2) 用本机持久化签名密钥（Ed25519）对 body 的规范化 JSON 签名；
//   3) 凭证信封与快照、包状态在同一事务落库；任一步失败整体回滚——
//      不存在“发布成功但没有凭证”的状态。
//
// 授权随后修改或删除只影响后续重算：凭证行不可变、不重签、不补字段。

const crypto = require('crypto');
const { canonicalize } = require('./canonical');
const { getKeyring } = require('./attestation-keys');
const { RULES_VERSION } = require('./attestation-verify-lib');

const FORMAT = 'exhibit-publish-attestation';
const ENVELOPE_FORMAT = 'exhibit-publish-attestation-envelope';
const FORMAT_VERSION = 1;

class AttestationError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 从发布核验结果中取“该站该节点实际采用”的授权 id。
// 合格发布时每个节点都必有 matchedAuthorization；缺失即逻辑错误（回滚）。
function adoptedAuthId(stopNode) {
  return stopNode && stopNode.matchedAuthorization ? stopNode.matchedAuthorization.id : null;
}

/**
 * 在发布事务内调用。
 * @param {Database} db
 * @param {object} ctx
 * @param {object} ctx.pkg        packages 行
 * @param {number[]} ctx.items    清单 material_id（按 position,id 排序）
 * @param {object} ctx.result     verifyStoredPackage 的完整结果（将作为快照 payload）
 * @param {number} ctx.snapshotId 刚插入的发布快照 id
 * @param {string} ctx.payloadText 快照实际存储的 payload 文本（JSON.stringify(result)）
 * @returns {{envelope: object, bodyHash: string, record: object}}
 */
function buildAndSeal(db, ctx) {
  const { pkg, items, result, snapshotId, payloadText } = ctx;
  if (!result.eligible) {
    throw new AttestationError('只有核验合格的发布才能封存凭证（不应发生：调用方已判失败）');
  }

  const multiStop = result.multiStop === true;

  // ---- 逐站行程（单站包规范化为一站） ----
  let stops;
  if (multiStop) {
    stops = (result.request.stops || []).map((s) => ({
      position: s.position,
      name: s.name,
      medium: s.medium,
      region: s.region,
      useFrom: s.useFrom,
      useTo: s.useTo,
    }));
  } else {
    stops = [{
      position: 0,
      name: pkg.name,
      medium: result.request.medium,
      region: result.request.region,
      useFrom: result.request.useFrom,
      useTo: result.request.useTo,
    }];
  }

  // ---- 节点集合：与核验结果完全一致（根 + 全部上游来源节点） ----
  let nodeInfos;
  if (multiStop) {
    const first = (result.stops || [])[0];
    if (!first) throw new AttestationError('多站核验结果缺少 stops[0]，无法封存凭证');
    nodeInfos = first.nodes.map((n) => ({
      materialId: n.materialId,
      title: n.title,
      kind: n.kind,
      isRoot: !!n.isRoot,
    }));
  } else {
    nodeInfos = result.nodes.map((n) => ({
      materialId: n.materialId,
      title: n.title,
      kind: n.kind,
      isRoot: !!n.isRoot,
    }));
  }
  const nodeIds = new Set(nodeInfos.map((n) => n.materialId));

  // ---- 清单（含落库 position） ----
  // 凭证中的“根节点”严格等于落库的入展清单项（即便某入展品同时出现在另一条
  // 来源路径上，它也是根）；离线校验按清单根做来源闭包。
  const itemRows = db
    .prepare('SELECT material_id, position FROM package_items WHERE package_id=? ORDER BY position, material_id')
    .all(pkg.id);
  const rootIds = new Set(items);
  const titleById = new Map(nodeInfos.map((n) => [n.materialId, n]));
  const manifestItems = itemRows.map((r) => ({
    materialId: r.material_id,
    position: r.position,
    title: titleById.get(r.material_id) ? titleById.get(r.material_id).title : `#${r.material_id}`,
    kind: titleById.get(r.material_id) ? titleById.get(r.material_id).kind : null,
    isRoot: true,
  }));
  for (const id of items) {
    if (!nodeIds.has(id)) {
      throw new AttestationError(`清单素材 #${id} 未出现在核验节点集合中，拒绝封存（凭证与快照不一致）`,
        { code: 'SEAL_MANIFEST_NODE_MISSING', materialId: id });
    }
  }
  if (manifestItems.length !== new Set(items).size) {
    throw new AttestationError('凭证清单条目数与包清单不一致，拒绝封存');
  }
  // 节点上的 isRoot 标记也以清单为准，避免多站结果里共享节点的标记歧义
  for (const n of nodeInfos) n.isRoot = rootIds.has(n.materialId);

  // ---- 完整来源子图：两端均在核验节点集合内的全部边 ----
  const edgeRows = db
    .prepare(
      `SELECT id, material_id, source_material_id, relation, created_at
         FROM source_links
        WHERE material_id IN (SELECT value FROM json_each(?))
           OR source_material_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...nodeIds]), JSON.stringify([...nodeIds]))
    .filter((e) => nodeIds.has(e.material_id) && nodeIds.has(e.source_material_id));
  // 闭包自检：沿这些边从清单根出发必须恰好到达 nodeIds
  assertClosure(items, edgeRows, nodeIds);

  const graphEdges = edgeRows.map((e) => ({
    id: e.id,
    from: e.material_id,
    to: e.source_material_id,
    relation: e.relation,
  }));

  // ---- 逐站 × 每节点实际采用的授权；同事务读全条款并防御性复算 ----
  const adoption = [];
  const authIds = new Set();

  const perStopNodes = multiStop
    ? result.stops.map((s) => ({ position: s.position, nodes: s.nodes }))
    : [{ position: 0, nodes: result.nodes }];

  for (const st of perStopNodes) {
    const stop = stops.find((x) => x.position === st.position);
    if (!stop) throw new AttestationError(`核验结果缺少第 ${st.position + 1} 站行程，拒绝封存`);
    for (const n of st.nodes) {
      const aid = adoptedAuthId(n);
      if (!aid) {
        throw new AttestationError(
          `第 ${st.position + 1} 站节点 #${n.materialId} 在合格结果中缺少实际采用授权，拒绝封存`,
          { code: 'SEAL_NODE_WITHOUT_LICENSE', stopPosition: st.position, materialId: n.materialId },
        );
      }
      authIds.add(aid);
      adoption.push({ stopPosition: st.position, materialId: n.materialId, authorizationId: aid });
    }
  }

  // 同事务读取条款当前行（凭证封存的是“当时实际采用的条款”，非撤销、且确实覆盖）
  const terms = [];
  for (const aid of [...authIds].sort((a, b) => a - b)) {
    const row = db.prepare('SELECT * FROM authorizations WHERE id=?').get(aid);
    if (!row) {
      throw new AttestationError(`实际采用的授权 #${aid} 在封存时已不存在，拒绝封存（请重新核验发布）`,
        { code: 'SEAL_LICENSE_GONE', authorizationId: aid });
    }
    if (row.revoked) {
      throw new AttestationError(`实际采用的授权 #${aid} 在封存时已撤销，拒绝封存`,
        { code: 'SEAL_LICENSE_REVOKED', authorizationId: aid });
    }
    terms.push({
      authorizationId: row.id,
      materialId: row.material_id,
      media: row.media,
      region: row.region,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      revoked: false,
      licensor: row.licensor,
      note: row.note,
      updatedAt: row.updated_at,
    });
  }
  // 防御性复算：每条采用关系都必须独自覆盖对应站整段（规则与发布闸门一致）
  const termById = new Map(terms.map((t) => [t.authorizationId, t]));
  for (const a of adoption) {
    const stop = stops.find((x) => x.position === a.stopPosition);
    const t = termById.get(a.authorizationId);
    if (!stop || !t) {
      throw new AttestationError('凭证封存内部一致性检查失败：采用关系找不到站次或条款',
        { code: 'SEAL_INTERNAL_INCONSISTENT', ...a });
    }
    if (!nodeIds.has(a.materialId) || t.materialId !== a.materialId
      || t.media == null || t.region == null
      || !(t.media === '*' || t.media.trim().toLowerCase() === stop.medium.trim().toLowerCase())
      || !(t.region === '*' || t.region.trim().toLowerCase() === stop.region.trim().toLowerCase())
      || t.validFrom > stop.useFrom || t.validTo < stop.useTo) {
      throw new AttestationError(
        `第 ${a.stopPosition + 1} 站节点 #${a.materialId} 的采用授权 #${a.authorizationId} 复算不覆盖整段，拒绝封存`,
        { code: 'SEAL_COVERAGE_MISMATCH', ...a },
      );
    }
  }

  // ---- 组装 body 并签名 ----
  const sealedAt = new Date().toISOString();
  const body = {
    format: FORMAT,
    version: FORMAT_VERSION,
    rulesVersion: RULES_VERSION,
    packageId: pkg.id,
    packageName: pkg.name,
    snapshotId,
    basisVersion: result.basisVersion,
    multiStop,
    sealedAt,
    snapshotPayloadSha256: sha256Hex(Buffer.from(payloadText, 'utf8')),
    manifest: { items: manifestItems },
    sourceGraph: {
      nodes: nodeInfos.map((n) => ({ materialId: n.materialId, title: n.title, kind: n.kind, isRoot: n.isRoot })),
      edges: graphEdges,
    },
    itinerary: { stops },
    terms,
    adoption: adoption.sort((a, b) =>
      (a.stopPosition - b.stopPosition) || (a.materialId - b.materialId) || (a.authorizationId - b.authorizationId)),
  };

  const canon = canonicalize(body);
  const bodyHash = sha256Hex(Buffer.from(canon, 'utf8'));

  const signer = getKeyring().currentSigner();
  const signature = crypto.sign(null, Buffer.from(canon, 'utf8'), signer.privateKey).toString('base64url');

  const envelope = {
    format: ENVELOPE_FORMAT,
    version: FORMAT_VERSION,
    kid: signer.kid,
    alg: signer.alg,
    sealedAt,
    body,
    bodyHash,
    signature,
  };

  const record = {
    snapshotId,
    packageId: pkg.id,
    kid: signer.kid,
    keyVersion: signer.version,
    alg: signer.alg,
    bodyHash,
    bodyText: JSON.stringify(body),
    signature,
    sealedAt,
  };

  return { envelope, bodyHash, record };
}

// 闭包：从清单根沿凭证边必须恰好到达核验节点集合
function assertClosure(roots, edges, expected) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.material_id)) adj.set(e.material_id, []);
    adj.get(e.material_id).push(e.source_material_id);
  }
  const seen = new Set();
  const stack = [...new Set(roots)];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) || []) if (!seen.has(nxt)) stack.push(nxt);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) {
    throw new AttestationError(`来源子图不完整：节点 ${missing.sort((a, b) => a - b).join(',')} 不可由清单经所存边到达`,
      { code: 'SEAL_GRAPH_INCOMPLETE', missing });
  }
}

// 落库（调用方事务内）
function insertRecord(db, record) {
  const info = db.prepare(
    `INSERT INTO publish_attestations
       (snapshot_id, package_id, kid, key_version, alg, body_hash, body, signature, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    record.snapshotId, record.packageId, record.kid, record.keyVersion, record.alg,
    record.bodyHash, record.bodyText, record.signature, record.sealedAt,
  );
  return info.lastInsertRowid;
}

function rowToEnvelope(row) {
  let body;
  try {
    body = JSON.parse(row.body);
  } catch {
    body = null;
  }
  return {
    format: ENVELOPE_FORMAT,
    version: FORMAT_VERSION,
    attestationId: row.id,
    kid: row.kid,
    alg: row.alg,
    sealedAt: row.created_at,
    body,
    bodyHash: row.body_hash,
    signature: row.signature,
  };
}

// 旧快照（凭证机制上线前封存）缺少哪些凭证必需字段——只分析快照自身，
// 绝不读取当前授权/关系，杜绝“用当前授权拼凑旧凭证”。
function legacyMissingFields(payload) {
  const missing = [];
  const p = payload && typeof payload === 'object' ? payload : null;
  if (!p) return ['payload'];
  if (!p.rulesVersion) missing.push('rulesVersion（核验规则版本）');
  if (!Array.isArray(p.request && p.request.materialIds) || !p.request.materialIds.length) {
    missing.push('request.materialIds（当时清单）');
  }
  const multi = p.multiStop === true;
  if (multi) {
    if (!Array.isArray(p.request.stops) || p.request.stops.length < 2) missing.push('request.stops（冻结逐站行程）');
    if (!Array.isArray(p.stops) || !p.stops.length) {
      missing.push('stops[*].nodes[*].matchedAuthorization（逐站实际采用授权）');
    } else {
      let hasPerStopAdoption = true;
      let hasExplicitEdges = false;
      for (const s of p.stops) {
        if (!Array.isArray(s.nodes) || !s.nodes.length
          || s.nodes.some((n) => !n.matchedAuthorization || !n.matchedAuthorization.id)) {
          hasPerStopAdoption = false;
        }
      }
      if (!hasPerStopAdoption) missing.push('stops[*].nodes[*].matchedAuthorization（逐站实际采用授权）');
      if (!hasExplicitEdges) {
        missing.push('sourceGraph.edges（显式完整来源边集合；旧多站快照只在失格节点上携带路径，无法还原全图）');
      }
    }
  } else if (!Array.isArray(p.nodes) || !p.nodes.length
    || p.nodes.some((n) => !n.matchedAuthorization || !n.matchedAuthorization.id)) {
    missing.push('nodes[*].matchedAuthorization（每节点实际采用授权）');
  }
  // 旧快照条款不含撤销标记快照、授权方与条款更新时间，无法自证“未撤销”
  missing.push('terms[*].revoked/licensor/updatedAt（当时未撤销条款的完整字段，旧快照不保存）');
  missing.push('sealingSignature.kid（发布同事务的本机密钥签名；旧快照从未签名）');
  return missing;
}

module.exports = {
  FORMAT,
  ENVELOPE_FORMAT,
  FORMAT_VERSION,
  AttestationError,
  buildAndSeal,
  insertRecord,
  rowToEnvelope,
  legacyMissingFields,
};
