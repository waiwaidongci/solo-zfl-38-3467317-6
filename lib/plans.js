// 校准图谱计划版本的纯领域逻辑：快照固化、两侧差异、三方合并、校验。
// 该模块不触碰文件系统和网络，便于单元测试。

// 索位行参与合并比较的字段（dependsOn 作为集合单独比较）
export const LINE_FIELDS = ["currentTension", "targetTension", "status"];

export function normalizeLine(line = {}) {
  const raw = Array.isArray(line.dependsOn)
    ? line.dependsOn
    : String(line.dependsOn ?? "").split(/[，,]/);
  return {
    position: String(line.position ?? "").trim(),
    currentTension: String(line.currentTension ?? ""),
    targetTension: String(line.targetTension ?? ""),
    status: String(line.status ?? ""),
    dependsOn: [...new Set(raw.map(d => String(d).trim()).filter(Boolean))].sort()
  };
}

export function normalizeSnapshot(snapshot = {}) {
  return {
    status: String(snapshot.status ?? ""),
    lines: (snapshot.lines || []).map(normalizeLine)
  };
}

// 把模型当前状态（帆索任务、校准状态）固化为计划快照
export function snapshotFromItem(item) {
  return normalizeSnapshot({
    status: item.status || "",
    lines: (item.tasks || []).map(t => ({
      position: t.position,
      currentTension: t.tension,
      targetTension: t.tension,
      status: t.status,
      dependsOn: []
    }))
  });
}

function toMap(snapshot) {
  const map = new Map();
  for (const line of normalizeSnapshot(snapshot).lines) map.set(line.position, line);
  return map;
}

export function linesEqual(a, b) {
  return LINE_FIELDS.every(f => a[f] === b[f]) &&
    JSON.stringify(a.dependsOn) === JSON.stringify(b.dependsOn);
}

function stateEqual(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return linesEqual(a, b);
}

// 一侧相对基点的差异：新增 / 删除 / 逐字段修改
export function diffSnapshots(base, side) {
  const baseSnap = normalizeSnapshot(base);
  const sideSnap = normalizeSnapshot(side);
  const b = toMap(baseSnap);
  const s = toMap(sideSnap);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [position, line] of s) {
    const baseLine = b.get(position);
    if (!baseLine) { added.push(line); continue; }
    if (linesEqual(baseLine, line)) continue;
    const fields = {};
    for (const f of LINE_FIELDS) {
      if (baseLine[f] !== line[f]) fields[f] = { base: baseLine[f], side: line[f] };
    }
    if (JSON.stringify(baseLine.dependsOn) !== JSON.stringify(line.dependsOn)) {
      fields.dependsOn = { base: baseLine.dependsOn, side: line.dependsOn };
    }
    changed.push({ position, fields });
  }
  for (const position of b.keys()) {
    if (!s.has(position)) removed.push(position);
  }
  return {
    added,
    removed,
    changed,
    statusChanged: baseSnap.status !== sideSnap.status,
    status: { base: baseSnap.status, side: sideSnap.status }
  };
}

function mergeFields(position, baseLine, ourLine, theirLine) {
  const line = { position, currentTension: "", targetTension: "", status: "", dependsOn: [] };
  const fieldConflicts = [];
  for (const f of LINE_FIELDS) {
    const bv = baseLine ? baseLine[f] : "";
    if (ourLine[f] === theirLine[f]) line[f] = ourLine[f];
    else if (bv === ourLine[f]) line[f] = theirLine[f];
    else if (bv === theirLine[f]) line[f] = ourLine[f];
    else {
      fieldConflicts.push({ field: f, base: bv, ours: ourLine[f], theirs: theirLine[f] });
      line[f] = theirLine[f]; // 暂定值，合并会因此被拒绝
    }
  }
  const bd = baseLine ? baseLine.dependsOn : [];
  const od = JSON.stringify(ourLine.dependsOn);
  const td = JSON.stringify(theirLine.dependsOn);
  const bdStr = JSON.stringify(bd);
  if (od === td) line.dependsOn = ourLine.dependsOn;
  else if (bdStr === od) line.dependsOn = theirLine.dependsOn;
  else if (bdStr === td) line.dependsOn = ourLine.dependsOn;
  else {
    fieldConflicts.push({ field: "dependsOn", base: bd, ours: ourLine.dependsOn, theirs: theirLine.dependsOn });
    line.dependsOn = theirLine.dependsOn;
  }
  return { line, fieldConflicts };
}

// 三方合并：base=分支基点版本，ours=目标版本，theirs=分支草稿。
// 返回 { merged, conflicts }；有任何冲突时调用方必须拒绝落库。
export function threeWayMerge(base, ours, theirs) {
  const b = toMap(base);
  const o = toMap(ours);
  const t = toMap(theirs);
  const positions = new Set([...b.keys(), ...o.keys(), ...t.keys()]);
  const lines = [];
  const conflicts = [];

  for (const position of positions) {
    const bl = b.has(position) ? b.get(position) : null;
    const ol = o.has(position) ? o.get(position) : null;
    const tl = t.has(position) ? t.get(position) : null;
    const oSame = stateEqual(bl, ol);
    const tSame = stateEqual(bl, tl);
    if (oSame && tSame) { if (bl) lines.push(bl); continue; }
    if (oSame) { if (tl) lines.push(tl); continue; }
    if (tSame) { if (ol) lines.push(ol); continue; }
    // 两侧都相对基点发生了变化
    if (stateEqual(ol, tl)) { if (ol) lines.push(ol); continue; } // 两侧改得一样
    if (ol && tl) {
      const { line, fieldConflicts } = mergeFields(position, bl, ol, tl);
      if (fieldConflicts.length) {
        conflicts.push({ position, type: "field_conflict", fields: fieldConflicts });
      }
      lines.push(line);
      continue;
    }
    // 一侧删除、另一侧修改 → 冲突，暂定保留修改侧
    const kept = ol || tl;
    conflicts.push({
      position,
      type: "delete_edit",
      deletedSide: ol ? "theirs" : "ours",
      kept
    });
    lines.push(kept);
  }

  // 校准状态标量的三方合并
  const baseStatus = normalizeSnapshot(base).status;
  const ourStatus = normalizeSnapshot(ours).status;
  const theirStatus = normalizeSnapshot(theirs).status;
  let status = baseStatus;
  if (ourStatus === theirStatus) status = ourStatus;
  else if (baseStatus === ourStatus) status = theirStatus;
  else if (baseStatus === theirStatus) status = ourStatus;
  else {
    conflicts.push({ position: null, type: "status_conflict", base: baseStatus, ours: ourStatus, theirs: theirStatus });
    status = theirStatus;
  }

  return { merged: { status, lines }, conflicts };
}

// 在依赖图中寻找循环，返回构成环的索位路径（含首尾重复），无环返回 null
export function findCycle(lines) {
  const normalized = (lines || []).map(normalizeLine);
  const positions = new Set(normalized.map(l => l.position));
  const graph = new Map(normalized.map(l => [l.position, l.dependsOn]));
  const state = new Map(); // 1=在栈中 2=已完成
  const stack = [];
  function dfs(node) {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (!positions.has(next)) continue; // 缺失索位由 missing_line 报告
      const s = state.get(next) || 0;
      if (s === 1) return stack.slice(stack.indexOf(next)).concat(next);
      if (s === 0) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  }
  for (const p of positions) {
    if (!state.get(p)) {
      const found = dfs(p);
      if (found) return found;
    }
  }
  return null;
}

// 快照结构校验：空索位、重复索位、缺失索位、循环依赖
export function validateSnapshot(snapshot) {
  const snap = normalizeSnapshot(snapshot);
  const errors = [];
  const positions = new Set();
  for (const line of snap.lines) {
    if (!line.position) errors.push({ code: "empty_position", message: "存在未命名索位" });
    if (positions.has(line.position)) {
      errors.push({ code: "duplicate_position", position: line.position, message: "索位重复：" + line.position });
    }
    positions.add(line.position);
  }
  for (const line of snap.lines) {
    for (const dep of line.dependsOn) {
      if (!positions.has(dep)) {
        errors.push({ code: "missing_line", position: line.position, missing: dep, message: "索位 " + line.position + " 依赖了不存在的索位 " + dep });
      }
    }
  }
  const cycle = findCycle(snap.lines);
  if (cycle) {
    errors.push({ code: "cyclic_dependency", cycle, message: "依赖关系存在循环：" + cycle.join(" → ") });
  }
  return errors;
}
