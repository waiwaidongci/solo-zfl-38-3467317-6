import http from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  snapshotFromItem,
  normalizeSnapshot,
  normalizeLine,
  diffSnapshots,
  threeWayMerge,
  validateSnapshot
} from "./lib/plans.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = process.env.DB_PATH || join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);
const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "logs": [
            {
              "at": "2026-06-12",
              "note": "已缩短2mm"
            }
          ]
        }
      ],
      "logs": []
    }
  ],
  "plans": {}
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待复核","已交付"];
const statLabels = ["待检查","校准中","待复核","已交付"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];

class HttpError extends Error {
  constructor(status, payload) {
    super(payload.error || "error");
    this.status = status;
    this.payload = payload;
  }
}

let tmpFileSeq = 0;
// 原子写入：先写同目录临时文件再 rename，并发读永远不会拿到写了一半的 JSON
async function atomicWriteJson(file, text) {
  const tmp = join(dirname(file), "." + basename(file) + "." + process.pid + "." + (tmpFileSeq++) + ".tmp");
  await writeFile(tmp, text);
  await rename(tmp, file);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
let idSeq = 0;
// 并发安全编号：36 进制时间戳 + 进程内自增序号 + 随机后缀，同毫秒并行建档也不重复
function newId(prefix = "MR") {
  idSeq = (idSeq + 1) % 46656; // 36^3
  return prefix + "-" + Date.now().toString(36) + idSeq.toString(36).padStart(3, "0") + Math.random().toString(36).slice(2, 4);
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

// ---------- 校准图谱版本 ----------

function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}
function bucketOf(db, item) {
  db.plans ||= {};
  const key = item.id || item.code;
  if (!db.plans[key]) {
    db.plans[key] = { versions: [], branches: [], merges: [], nextVersionSeq: 1, nextBranchSeq: 1, nextMergeSeq: 1 };
  }
  return db.plans[key];
}
function versionSummary(v) {
  return {
    id: v.id,
    seq: v.seq,
    label: v.label,
    createdAt: v.createdAt,
    immutable: v.immutable === true,
    parentIds: v.parentIds || [],
    origin: v.origin || { type: "snapshot" },
    status: v.snapshot.status,
    lineCount: v.snapshot.lines.length
  };
}
function branchSummary(b) {
  return {
    id: b.id,
    name: b.name,
    sourceVersionId: b.sourceVersionId,
    baseVersionId: b.baseVersionId,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    merged: !!b.merged,
    mergedAt: b.mergedAt || null,
    resultVersionId: b.resultVersionId || null,
    status: b.draft.status,
    lineCount: b.draft.lines.length
  };
}
function lineageOf(bucket, version) {
  const byId = new Map(bucket.versions.map(v => [v.id, v]));
  const chain = [];
  const seen = new Set();
  let cur = version;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift({ id: cur.id, label: cur.label, createdAt: cur.createdAt, origin: cur.origin });
    const parent = (cur.parentIds || [])[0];
    cur = parent ? byId.get(parent) : null;
  }
  return chain;
}
// 合并预览：两侧差异、冲突索位、受影响记录、拒绝原因（过期/循环/缺失/已合并）
function buildPreview(item, bucket, branch, targetVersionId) {
  const errors = [];
  const target = bucket.versions.find(v => v.id === targetVersionId);
  if (!target) throw new HttpError(404, { error: "version_not_found" });
  const base = bucket.versions.find(v => v.id === branch.baseVersionId);
  if (!base) throw new HttpError(404, { error: "base_version_not_found" });
  const latest = bucket.versions[bucket.versions.length - 1];
  if (branch.merged) errors.push({ code: "branch_closed", message: "分支已合并，不能再次合并" });
  if (latest && target.id !== latest.id) {
    errors.push({ code: "stale_version", message: "目标版本已过期，最新版本为 " + latest.label, target: target.id, latest: latest.id });
  }
  const ours = diffSnapshots(base.snapshot, target.snapshot);
  const theirs = diffSnapshots(base.snapshot, branch.draft);
  const { merged, conflicts } = threeWayMerge(base.snapshot, target.snapshot, branch.draft);
  errors.push(...validateSnapshot(merged));
  const touched = new Set();
  for (const d of [ours, theirs]) {
    d.added.forEach(l => touched.add(l.position));
    d.removed.forEach(p => touched.add(p));
    d.changed.forEach(c => touched.add(c.position));
  }
  const affected = (item.tasks || [])
    .filter(t => touched.has(t.position))
    .map(t => ({ id: t.id, position: t.position, tension: t.tension, status: t.status, logCount: (t.logs || []).length }));
  return {
    base: versionSummary(base),
    target: versionSummary(target),
    branch: branchSummary(branch),
    ours,
    theirs,
    conflicts,
    affected,
    errors,
    merged,
    canMerge: conflicts.length === 0 && errors.length === 0
  };
}

async function handlePlans(ctx, req, res, url, itemKey, rest, db) {
  const seg = rest.split("/").filter(Boolean);

  if (seg.length === 0 && req.method === "GET") {
    const item = findItem(db, itemKey);
    if (!item) throw new HttpError(404, { error: "item_not_found" });
    const bucket = bucketOf(db, item);
    return send(res, 200, {
      item: { id: item.id || item.code, code: item.code, status: item.status },
      versions: bucket.versions.map(versionSummary),
      branches: bucket.branches.map(branchSummary),
      merges: bucket.merges
    });
  }

  if (seg[0] === "versions" && seg.length === 1 && req.method === "GET") {
    const item = findItem(db, itemKey);
    if (!item) throw new HttpError(404, { error: "item_not_found" });
    const bucket = bucketOf(db, item);
    return send(res, 200, bucket.versions.map(versionSummary));
  }

  // 固化当前帆索/目标松紧/依赖/校准状态为一个不可覆盖的计划版本
  if (seg[0] === "versions" && seg.length === 1 && req.method === "POST") {
    const input = await body(req);
    const version = await ctx.enqueueWrite(async () => {
      const fresh = await ctx.loadDb();
      const item = findItem(fresh, itemKey);
      if (!item) throw new HttpError(404, { error: "item_not_found" });
      const bucket = bucketOf(fresh, item);
      const snapshot = snapshotFromItem(item);
      const bad = validateSnapshot(snapshot).find(e => e.code === "duplicate_position" || e.code === "empty_position");
      if (bad) throw new HttpError(409, { error: bad.code, position: bad.position || null, message: bad.message });
      const seq = bucket.nextVersionSeq++;
      const latest = bucket.versions[bucket.versions.length - 1];
      const v = {
        id: "V-" + seq,
        seq,
        itemId: item.id || item.code,
        label: String(input.label || "").trim() || ("v" + seq),
        createdAt: new Date().toISOString(),
        immutable: true,
        parentIds: latest ? [latest.id] : [],
        origin: { type: "snapshot" },
        snapshot
      };
      bucket.versions.push(v);
      await ctx.saveDb(fresh);
      return v;
    });
    return send(res, 201, version);
  }

  if (seg[0] === "versions" && seg.length === 2 && req.method === "GET") {
    const item = findItem(db, itemKey);
    if (!item) throw new HttpError(404, { error: "item_not_found" });
    const bucket = bucketOf(db, item);
    const v = bucket.versions.find(x => x.id === seg[1]);
    if (!v) throw new HttpError(404, { error: "version_not_found" });
    return send(res, 200, { ...v, lineage: lineageOf(bucket, v) });
  }

  // 从任一版本开分支修改
  if (seg[0] === "versions" && seg.length === 3 && seg[2] === "branch" && req.method === "POST") {
    const input = await body(req);
    const branch = await ctx.enqueueWrite(async () => {
      const fresh = await ctx.loadDb();
      const item = findItem(fresh, itemKey);
      if (!item) throw new HttpError(404, { error: "item_not_found" });
      const bucket = bucketOf(fresh, item);
      const v = bucket.versions.find(x => x.id === seg[1]);
      if (!v) throw new HttpError(404, { error: "version_not_found" });
      const seq = bucket.nextBranchSeq++;
      const now = new Date().toISOString();
      const b = {
        id: "B-" + seq,
        itemId: item.id || item.code,
        name: String(input.name || "").trim() || ("分支-" + seq),
        sourceVersionId: v.id,
        baseVersionId: v.id,
        createdAt: now,
        updatedAt: now,
        merged: false,
        mergedAt: null,
        resultVersionId: null,
        draft: normalizeSnapshot(v.snapshot)
      };
      bucket.branches.push(b);
      await ctx.saveDb(fresh);
      return b;
    });
    return send(res, 201, branch);
  }

  if (seg[0] === "branches" && seg.length === 1 && req.method === "GET") {
    const item = findItem(db, itemKey);
    if (!item) throw new HttpError(404, { error: "item_not_found" });
    const bucket = bucketOf(db, item);
    return send(res, 200, bucket.branches.map(branchSummary));
  }

  if (seg[0] === "branches" && seg.length === 2 && req.method === "GET") {
    const item = findItem(db, itemKey);
    if (!item) throw new HttpError(404, { error: "item_not_found" });
    const bucket = bucketOf(db, item);
    const b = bucket.branches.find(x => x.id === seg[1]);
    if (!b) throw new HttpError(404, { error: "branch_not_found" });
    return send(res, 200, { ...b, warnings: validateSnapshot(b.draft) });
  }

  // 修改分支草稿（仅结构错误即时报错，循环/缺失留待合并校验）
  if (seg[0] === "branches" && seg.length === 2 && req.method === "PATCH") {
    const input = await body(req);
    const branch = await ctx.enqueueWrite(async () => {
      const fresh = await ctx.loadDb();
      const item = findItem(fresh, itemKey);
      if (!item) throw new HttpError(404, { error: "item_not_found" });
      const bucket = bucketOf(fresh, item);
      const b = bucket.branches.find(x => x.id === seg[1]);
      if (!b) throw new HttpError(404, { error: "branch_not_found" });
      if (b.merged) throw new HttpError(409, { error: "branch_closed", message: "分支已合并，不能再修改" });
      if (input.name !== undefined) {
        const name = String(input.name).trim();
        if (name) b.name = name;
      }
      if (input.status !== undefined) b.draft.status = String(input.status);
      if (input.lines !== undefined) {
        if (!Array.isArray(input.lines)) throw new HttpError(400, { error: "invalid_lines" });
        const lines = input.lines.map(normalizeLine);
        const errs = validateSnapshot({ status: b.draft.status, lines })
          .filter(e => e.code === "empty_position" || e.code === "duplicate_position");
        if (errs.length) throw new HttpError(400, { error: errs[0].code, details: errs });
        b.draft.lines = lines;
      }
      b.updatedAt = new Date().toISOString();
      await ctx.saveDb(fresh);
      return b;
    });
    return send(res, 200, { ...branch, warnings: validateSnapshot(branch.draft) });
  }

  // 合并预览：差异、冲突索位、受影响记录、拒绝原因
  if (seg[0] === "branches" && seg.length === 3 && seg[2] === "preview" && req.method === "GET") {
    const item = findItem(db, itemKey);
    if (!item) throw new HttpError(404, { error: "item_not_found" });
    const bucket = bucketOf(db, item);
    const b = bucket.branches.find(x => x.id === seg[1]);
    if (!b) throw new HttpError(404, { error: "branch_not_found" });
    const latest = bucket.versions[bucket.versions.length - 1];
    const targetId = url.searchParams.get("target") || (latest && latest.id);
    if (!targetId) throw new HttpError(404, { error: "version_not_found" });
    return send(res, 200, buildPreview(item, bucket, b, targetId));
  }

  // 执行合并：服务端重新校验，拒绝时不落库、活动任务保持原样
  if (seg[0] === "branches" && seg.length === 3 && seg[2] === "merge" && req.method === "POST") {
    const input = await body(req);
    const result = await ctx.enqueueWrite(async () => {
      const fresh = await ctx.loadDb();
      const item = findItem(fresh, itemKey);
      if (!item) throw new HttpError(404, { error: "item_not_found" });
      const bucket = bucketOf(fresh, item);
      const b = bucket.branches.find(x => x.id === seg[1]);
      if (!b) throw new HttpError(404, { error: "branch_not_found" });
      const latest = bucket.versions[bucket.versions.length - 1];
      const targetId = input.targetVersionId || (latest && latest.id);
      const preview = buildPreview(item, bucket, b, targetId);
      if (!preview.canMerge) {
        throw new HttpError(409, {
          error: "merge_rejected",
          message: "存在并发修改、循环依赖、缺失索位或版本过期，已拒绝合并；活动任务保持原样",
          conflicts: preview.conflicts,
          errors: preview.errors,
          affected: preview.affected
        });
      }
      const versionSeq = bucket.nextVersionSeq++;
      const mergeSeq = bucket.nextMergeSeq++;
      const now = new Date().toISOString();
      const target = bucket.versions.find(v => v.id === targetId);
      const v = {
        id: "V-" + versionSeq,
        seq: versionSeq,
        itemId: item.id || item.code,
        label: "v" + versionSeq,
        createdAt: now,
        immutable: true,
        parentIds: [target.id],
        origin: { type: "merge", branchId: b.id, branchName: b.name, targetVersionId: target.id },
        snapshot: preview.merged
      };
      bucket.versions.push(v);
      b.merged = true;
      b.mergedAt = now;
      b.resultVersionId = v.id;
      b.updatedAt = now;
      const rec = {
        id: "M-" + mergeSeq,
        at: now,
        branchId: b.id,
        branchName: b.name,
        targetVersionId: target.id,
        resultVersionId: v.id,
        affected: preview.affected
      };
      bucket.merges.push(rec);
      await ctx.saveDb(fresh);
      return { version: v, merge: rec, affected: preview.affected };
    });
    return send(res, 201, result);
  }

  throw new HttpError(404, { error: "not_found" });
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .plans-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:10px; }
    .vrow,.brow { border:1px solid var(--line); border-radius:6px; padding:8px; margin-bottom:8px; background:#fbfcfa; }
    .vrow h4,.brow h4 { margin:0 0 4px; font-size:14px; } .vrow.sel,.brow.sel { outline:2px solid var(--accent); }
    button.mini { padding:4px 8px; font-size:12px; font-weight:400; margin-right:6px; }
    table.lines { width:100%; border-collapse:collapse; margin:8px 0; }
    table.lines th,table.lines td { border:1px solid var(--line); padding:4px; font-size:12px; text-align:left; }
    table.lines input { padding:4px; font-size:12px; }
    .conflict { color:var(--warn); font-weight:700; } .ok { color:var(--accent); font-weight:700; } .err { color:var(--warn); }
    .diff-cols { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .diffcol { border:1px solid var(--line); border-radius:6px; padding:8px; } .diffcol h4 { margin:0 0 6px; font-size:13px; }
    #previewOut,#mergeResult,#versionDetail { margin-top:10px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .plans-grid,.diff-cols{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务和校准记录串联</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>创建模型后可拆分帆索任务，逐条记录松紧状态、调整备注和完成时间。</h2><div class="grid" id="cards"></div></div>
      <div class="panel" id="plansPanel" style="margin-top:14px">
        <h2>校准图谱版本</h2>
        <div class="meta">把当前帆索、目标松紧、依赖关系和校准状态固化为计划版本；可从任一版本开分支修改，合并前预览两侧差异、冲突索位和受影响记录。存在并发修改、循环依赖、缺失索位或版本过期时拒绝合并，活动任务保持原样；无冲突合并生成不可覆盖的新版本，旧版本可追溯。</div>
        <div class="toolbar" style="margin-top:10px">
          <select id="planItem"></select>
          <button id="freezeBtn" type="button">固化当前为版本</button>
          <button id="planReload" type="button" class="secondary">刷新图谱</button>
        </div>
        <div id="planMsg" class="meta"></div>
        <div class="plans-grid">
          <div><h3 style="font-size:15px">版本（不可覆盖，可追溯）</h3><div id="versionList"></div></div>
          <div><h3 style="font-size:15px">分支</h3><div class="toolbar"><input id="branchName" placeholder="分支名称（可选）"></div><div id="branchList"></div></div>
        </div>
        <div id="draftPanel" hidden>
          <h3 style="font-size:15px">分支草稿</h3>
          <div id="draftMeta" class="meta"></div>
          <label>校准状态</label><select id="draftStatus"></select>
          <table class="lines"><thead><tr><th>索位</th><th>当前松紧</th><th>目标松紧</th><th>状态</th><th>依赖索位（逗号分隔）</th><th></th></tr></thead><tbody id="draftBody"></tbody></table>
          <button id="addLineBtn" type="button" class="secondary">添加索位</button>
          <button id="saveDraftBtn" type="button">保存草稿</button>
          <span id="draftMsg" class="meta"></span>
        </div>
        <div id="mergePanel" hidden>
          <h3 style="font-size:15px">合并</h3>
          <label>目标版本（必须为最新版本，否则视为版本过期）</label>
          <select id="mergeTarget"></select>
          <div class="toolbar" style="margin-top:8px">
            <button id="previewBtn" type="button" class="secondary">预览差异</button>
            <button id="mergeBtn" type="button" disabled>执行合并</button>
          </div>
          <div id="previewOut"></div>
        </div>
        <div id="mergeResult"></div>
        <div id="versionDetail"></div>
      </div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
  <script>
    (function () {
      var stages = ["待检查", "校准中", "待复核", "已交付"];
      var fieldNames = { currentTension: "当前松紧", targetTension: "目标松紧", status: "状态", dependsOn: "依赖索位" };
      var $ = function (s) { return document.querySelector(s); };
      var versions = [], branches = [], currentBranch = null, preview = null;
      function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      }
      function fmt(v) { return Array.isArray(v) ? v.join("、") : (v === "" || v == null ? "（空）" : String(v)); }
      async function apiV(path, options) {
        var res = await fetch(path, options && options.body ? Object.assign({}, options, { headers: { "Content-Type": "application/json" } }) : options);
        var data = await res.json();
        if (!res.ok) { var err = new Error(data.message || data.error || "请求失败"); err.data = data; throw err; }
        return data;
      }
      function msg(text, isErr) { var el = $("#planMsg"); el.textContent = text || ""; el.className = isErr ? "warn" : "meta"; }
      function itemKey() { return $("#planItem").value; }

      async function loadPlanItems() {
        var items = await apiV("/api/items");
        var sel = $("#planItem");
        var prev = sel.value;
        sel.innerHTML = items.map(function (item) {
          var key = item.id || item.code;
          return '<option value="' + esc(key) + '">' + esc(item.code || item.id) + " · " + esc(item.shipType || "") + "</option>";
        }).join("");
        if (prev && items.some(function (i) { return (i.id || i.code) === prev; })) sel.value = prev;
      }
      async function loadPlans() {
        if (!itemKey()) return;
        var data = await apiV("/api/items/" + encodeURIComponent(itemKey()) + "/plans");
        versions = data.versions; branches = data.branches;
        renderVersions(); renderBranches(); renderMergeTargets();
      }
      function renderVersions() {
        $("#versionList").innerHTML = versions.map(function (v) {
          var origin = v.origin.type === "merge" ? "合并自 " + esc(v.origin.branchName || v.origin.branchId) : "固化";
          var parents = (v.parentIds || []).join(", ") || "无";
          return '<div class="vrow" data-vid="' + esc(v.id) + '"><h4>' + esc(v.label) + ' <span class="pill">' + esc(v.id) + "</span></h4>" +
            '<div class="meta">' + esc(v.createdAt) + " · " + origin + " · 父版本 " + esc(parents) + " · " + v.lineCount + " 个索位 · " + esc(v.status) + "</div>" +
            '<button type="button" class="mini secondary" data-view="' + esc(v.id) + '">查看</button>' +
            '<button type="button" class="mini" data-branch="' + esc(v.id) + '">开分支</button></div>';
        }).join("") || '<div class="meta">暂无版本，点击“固化当前为版本”创建。</div>';
        $("#versionList").querySelectorAll("[data-view]").forEach(function (btn) {
          btn.onclick = function () { showVersion(btn.dataset.view); };
        });
        $("#versionList").querySelectorAll("[data-branch]").forEach(function (btn) {
          btn.onclick = function () { openBranchFrom(btn.dataset.branch); };
        });
      }
      function renderBranches() {
        $("#branchList").innerHTML = branches.map(function (b) {
          var state = b.merged ? "已合并 → " + esc(b.resultVersionId || "") : "编辑中";
          return '<div class="brow" data-bid="' + esc(b.id) + '"><h4>' + esc(b.name) + ' <span class="pill">' + esc(b.id) + "</span></h4>" +
            '<div class="meta">基点 ' + esc(b.baseVersionId) + " · " + state + " · " + b.lineCount + " 个索位</div>" +
            '<button type="button" class="mini secondary" data-edit="' + esc(b.id) + '">' + (b.merged ? "查看草稿" : "编辑草稿") + "</button></div>";
        }).join("") || '<div class="meta">暂无分支。</div>';
        $("#branchList").querySelectorAll("[data-edit]").forEach(function (btn) {
          btn.onclick = function () { editBranch(btn.dataset.edit); };
        });
      }
      function renderMergeTargets() {
        var sel = $("#mergeTarget");
        sel.innerHTML = versions.map(function (v, i) {
          var tag = i === versions.length - 1 ? "（最新）" : "（已过期）";
          return '<option value="' + esc(v.id) + '">' + esc(v.label) + " " + esc(v.id) + " " + tag + "</option>";
        }).join("");
        if (versions.length) sel.value = versions[versions.length - 1].id;
      }
      async function openBranchFrom(versionId) {
        try {
          var name = $("#branchName").value.trim();
          await apiV("/api/items/" + encodeURIComponent(itemKey()) + "/plans/versions/" + encodeURIComponent(versionId) + "/branch", { method: "POST", body: JSON.stringify({ name: name }) });
          $("#branchName").value = "";
          msg("已创建分支");
          await loadPlans();
        } catch (e) { msg(e.message, true); }
      }
      async function editBranch(branchId) {
        try {
          currentBranch = await apiV("/api/items/" + encodeURIComponent(itemKey()) + "/plans/branches/" + encodeURIComponent(branchId));
          preview = null;
          $("#previewOut").innerHTML = ""; $("#mergeResult").innerHTML = "";
          $("#mergeBtn").disabled = true;
          renderDraft();
        } catch (e) { msg(e.message, true); }
      }
      function renderDraft() {
        var b = currentBranch;
        $("#draftPanel").hidden = !b;
        $("#mergePanel").hidden = !b;
        if (!b) return;
        $("#draftMeta").textContent = "分支 " + b.name + "（" + b.id + "，基点版本 " + b.baseVersionId + "）" + (b.merged ? " · 已合并，只读" : "");
        $("#draftStatus").innerHTML = stages.map(function (s) {
          return '<option ' + (s === b.draft.status ? "selected" : "") + ">" + s + "</option>";
        }).join("");
        $("#draftStatus").disabled = !!b.merged;
        $("#draftBody").innerHTML = b.draft.lines.map(function (l, i) {
          var dis = b.merged ? " disabled" : "";
          return "<tr>" +
            '<td><input data-f="position" value="' + esc(l.position) + '"' + dis + "></td>" +
            '<td><input data-f="currentTension" value="' + esc(l.currentTension) + '"' + dis + "></td>" +
            '<td><input data-f="targetTension" value="' + esc(l.targetTension) + '"' + dis + "></td>" +
            '<td><input data-f="status" value="' + esc(l.status) + '"' + dis + "></td>" +
            '<td><input data-f="dependsOn" value="' + esc(l.dependsOn.join("，")) + '"' + dis + "></td>" +
            '<td><button type="button" class="mini secondary" data-del="' + i + '"' + dis + ">删除</button></td></tr>";
        }).join("");
        $("#draftBody").querySelectorAll("[data-del]").forEach(function (btn) {
          btn.onclick = function () {
            currentBranch.draft.lines.splice(Number(btn.dataset.del), 1);
            renderDraft();
          };
        });
        $("#addLineBtn").disabled = !!b.merged;
        $("#saveDraftBtn").disabled = !!b.merged;
        $("#draftMsg").textContent = (b.warnings || []).map(function (w) { return w.message; }).join("；");
      }
      function collectDraft() {
        var lines = [];
        $("#draftBody").querySelectorAll("tr").forEach(function (tr) {
          var line = {};
          tr.querySelectorAll("input").forEach(function (input) {
            var f = input.dataset.f;
            if (f === "dependsOn") line[f] = input.value.split(/[，,]/).map(function (s) { return s.trim(); }).filter(Boolean);
            else line[f] = input.value.trim();
          });
          lines.push(line);
        });
        return { status: $("#draftStatus").value, lines: lines };
      }
      async function saveDraft() {
        if (!currentBranch) return;
        try {
          var payload = collectDraft();
          currentBranch = await apiV("/api/items/" + encodeURIComponent(itemKey()) + "/plans/branches/" + encodeURIComponent(currentBranch.id), { method: "PATCH", body: JSON.stringify(payload) });
          preview = null; $("#previewOut").innerHTML = ""; $("#mergeBtn").disabled = true;
          renderDraft();
          await loadPlans();
          msg("草稿已保存");
        } catch (e) { msg(e.message, true); }
      }
      function diffList(title, d) {
        var parts = [];
        if (d.statusChanged) parts.push("<div>校准状态：" + esc(fmt(d.status.base)) + " → " + esc(fmt(d.status.side)) + "</div>");
        d.added.forEach(function (l) { parts.push("<div>＋新增索位 " + esc(l.position) + "</div>"); });
        d.removed.forEach(function (p) { parts.push("<div>－删除索位 " + esc(p) + "</div>"); });
        d.changed.forEach(function (c) {
          var desc = Object.keys(c.fields).map(function (f) {
            var v = c.fields[f];
            return (fieldNames[f] || f) + " " + esc(fmt(v.base)) + " → " + esc(fmt(v.side));
          }).join("；");
          parts.push("<div>＊" + esc(c.position) + "：" + desc + "</div>");
        });
        return '<div class="diffcol"><h4>' + esc(title) + "</h4>" + (parts.join("") || '<div class="meta">无变化</div>') + "</div>";
      }
      function conflictText(c) {
        if (c.type === "field_conflict") {
          return "索位 " + c.position + "：" + c.fields.map(function (f) {
            return (fieldNames[f.field] || f.field) + " 目标=" + esc(fmt(f.ours)) + " / 分支=" + esc(fmt(f.theirs)) + "（基点 " + esc(fmt(f.base)) + "）";
          }).join("；");
        }
        if (c.type === "delete_edit") return "索位 " + c.position + "：一侧删除、另一侧修改";
        return "校准状态冲突：目标=" + esc(fmt(c.ours)) + " / 分支=" + esc(fmt(c.theirs));
      }
      function renderPreview() {
        var p = preview;
        if (!p) { $("#previewOut").innerHTML = ""; return; }
        var out = "<h4>两侧差异（基点 " + esc(p.base.label) + "）</h4><div class='diff-cols'>" +
          diffList("目标版本 " + p.target.label + " 的变化", p.ours) +
          diffList("分支 " + p.branch.name + " 的变化", p.theirs) + "</div>";
        out += "<h4>冲突索位</h4>" + (p.conflicts.length
          ? p.conflicts.map(function (c) { return '<div class="conflict">' + conflictText(c) + "</div>"; }).join("") +
            '<div class="meta">请回到分支草稿修改冲突索位后重新预览。</div>'
          : '<div class="ok">无冲突</div>');
        out += "<h4>受影响记录</h4>" + (p.affected.length
          ? '<table class="lines"><thead><tr><th>任务</th><th>索位</th><th>松紧</th><th>状态</th><th>记录数</th></tr></thead><tbody>' +
            p.affected.map(function (a) {
              return "<tr><td>" + esc(a.id) + "</td><td>" + esc(a.position) + "</td><td>" + esc(a.tension) + "</td><td>" + esc(a.status) + "</td><td>" + a.logCount + "</td></tr>";
            }).join("") + "</tbody></table>"
          : '<div class="meta">无</div>');
        out += "<h4>合并校验</h4>" + (p.errors.length
          ? p.errors.map(function (e) { return '<div class="err">' + esc(e.message || e.code) + "</div>"; }).join("")
          : '<div class="ok">校验通过，可以合并</div>');
        $("#previewOut").innerHTML = out;
        $("#mergeBtn").disabled = !p.canMerge;
      }
      async function doPreview() {
        if (!currentBranch) return;
        try {
          preview = await apiV("/api/items/" + encodeURIComponent(itemKey()) + "/plans/branches/" + encodeURIComponent(currentBranch.id) + "/preview?target=" + encodeURIComponent($("#mergeTarget").value));
          renderPreview();
          msg(preview.canMerge ? "预览完成：可以合并" : "预览完成：存在冲突或校验错误", !preview.canMerge);
        } catch (e) { msg(e.message, true); }
      }
      async function doMerge() {
        if (!currentBranch) return;
        try {
          var res = await apiV("/api/items/" + encodeURIComponent(itemKey()) + "/plans/branches/" + encodeURIComponent(currentBranch.id) + "/merge", { method: "POST", body: JSON.stringify({ targetVersionId: $("#mergeTarget").value }) });
          $("#mergeResult").innerHTML = '<div class="ok">合并成功：生成不可覆盖的新版本 ' + esc(res.version.label) + "（" + esc(res.version.id) + "），父版本 " + esc((res.version.parentIds || []).join(", ") || "无") + "；旧版本仍可追溯，活动任务保持原样。</div>";
          msg("合并成功");
          currentBranch = null;
          $("#draftPanel").hidden = true; $("#mergePanel").hidden = true;
          $("#previewOut").innerHTML = "";
          await loadPlans();
        } catch (e) {
          var d = e.data || {};
          var parts = ['<div class="warn">合并被拒绝：' + esc(d.message || e.message) + "</div>"];
          (d.conflicts || []).forEach(function (c) { parts.push('<div class="conflict">' + conflictText(c) + "</div>"); });
          (d.errors || []).forEach(function (er) { parts.push('<div class="err">' + esc(er.message || er.code) + "</div>"); });
          $("#mergeResult").innerHTML = parts.join("");
          msg("合并被拒绝", true);
        }
      }
      async function showVersion(versionId) {
        try {
          var v = await apiV("/api/items/" + encodeURIComponent(itemKey()) + "/plans/versions/" + encodeURIComponent(versionId));
          var chain = (v.lineage || []).map(function (n) { return esc(n.label); }).join(" ← ");
          var rows = v.snapshot.lines.map(function (l) {
            return "<tr><td>" + esc(l.position) + "</td><td>" + esc(l.currentTension) + "</td><td>" + esc(l.targetTension) + "</td><td>" + esc(l.status) + "</td><td>" + esc(l.dependsOn.join("、")) + "</td></tr>";
          }).join("");
          $("#versionDetail").innerHTML = "<h4>版本 " + esc(v.label) + "（" + esc(v.id) + "，不可覆盖）</h4>" +
            '<div class="meta">溯源链：' + (chain || "无") + " · 校准状态 " + esc(v.snapshot.status) + "</div>" +
            '<table class="lines"><thead><tr><th>索位</th><th>当前松紧</th><th>目标松紧</th><th>状态</th><th>依赖索位</th></tr></thead><tbody>' + rows + "</tbody></table>";
        } catch (e) { msg(e.message, true); }
      }
      async function freeze() {
        try {
          var v = await apiV("/api/items/" + encodeURIComponent(itemKey()) + "/plans/versions", { method: "POST", body: JSON.stringify({}) });
          msg("已固化版本 " + v.label + "（" + v.id + "）");
          await loadPlans();
        } catch (e) { msg(e.message, true); }
      }
      $("#freezeBtn").onclick = freeze;
      $("#planReload").onclick = async function () { await loadPlanItems(); await loadPlans(); msg("已刷新"); };
      $("#planItem").onchange = async function () {
        currentBranch = null; preview = null;
        $("#draftPanel").hidden = true; $("#mergePanel").hidden = true;
        $("#previewOut").innerHTML = ""; $("#mergeResult").innerHTML = ""; $("#versionDetail").innerHTML = "";
        await loadPlans();
      };
      $("#addLineBtn").onclick = function () {
        if (!currentBranch || currentBranch.merged) return;
        currentBranch.draft.lines.push({ position: "", currentTension: "", targetTension: "", status: "待检查", dependsOn: [] });
        renderDraft();
      };
      $("#saveDraftBtn").onclick = saveDraft;
      $("#previewBtn").onclick = doPreview;
      $("#mergeBtn").onclick = doMerge;
      document.querySelector("#createForm").addEventListener("submit", function () { setTimeout(loadPlanItems, 500); });
      (async function () { await loadPlanItems(); await loadPlans(); })();
    })();
  </script>
</body>
</html>`;
}

async function handler(ctx, req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    const db = await ctx.loadDb();
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = await ctx.enqueueWrite(async () => {
        const fresh = await ctx.loadDb();
        const it = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }] };
        it.tasks = [];
        fresh.items.unshift(it);
        await ctx.saveDb(fresh);
        return it;
      });
      return send(res, 201, item);
    }
    const plans = url.pathname.match(/^\/api\/items\/([^/]+)\/plans(?:\/(.*))?$/);
    if (plans) return await handlePlans(ctx, req, res, url, decodeURIComponent(plans[1]), plans[2] || "", db);
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const input = await body(req);
      const item = await ctx.enqueueWrite(async () => {
        const fresh = await ctx.loadDb();
        const it = fresh.items.find(x => x.id === patch[1] || x.code === patch[1]);
        if (!it) throw new HttpError(404, { error: "item_not_found" });
        Object.assign(it, input);
        it.logs ||= [];
        it.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + it.status });
        await ctx.saveDb(fresh);
        return it;
      });
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const input = await body(req);
      const item = await ctx.enqueueWrite(async () => {
        const fresh = await ctx.loadDb();
        const it = fresh.items.find(x => x.id === log[1] || x.code === log[1]);
        if (!it) throw new HttpError(404, { error: "item_not_found" });
        it.logs ||= [];
        it.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        await ctx.saveDb(fresh);
        return it;
      });
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const input = await body(req);
      const item = await ctx.enqueueWrite(async () => {
        const fresh = await ctx.loadDb();
        const it = fresh.items.find(x => x.id === action[1] || x.code === action[1]);
        if (!it) throw new HttpError(404, { error: "item_not_found" });
        it.logs ||= [];
        it.tasks ||= [];
        it.tasks.push({ id: newId("T"), position: input.position, tension: input.tension, status: "待检查", logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }] });
        it.status = "校准中";
        it.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
        await ctx.saveDb(fresh);
        return it;
      });
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, error.payload);
    send(res, 500, { error: error.message });
  }
}

export function createApp(options = {}) {
  const dbPath = options.dbPath || defaultDbPath;
  async function loadDb() {
    if (!existsSync(dbPath)) {
      await mkdir(dirname(dbPath), { recursive: true });
      await atomicWriteJson(dbPath, JSON.stringify(seed, null, 2));
    }
    const db = JSON.parse(await readFile(dbPath, "utf8"));
    db.items ||= [];
    db.plans ||= {};
    return db;
  }
  async function saveDb(db) { await atomicWriteJson(dbPath, JSON.stringify(db, null, 2)); }
  // 串行化所有写操作：加载→修改→保存作为一个整体排队执行，
  // 避免并发请求互相覆盖（版本过期/并发修改的服务端兜底）。
  let writeQueue = Promise.resolve();
  function enqueueWrite(fn) {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(() => {}, () => {});
    return run;
  }
  const ctx = { dbPath, loadDb, saveDb, enqueueWrite };
  return http.createServer((req, res) => handler(ctx, req, res));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const server = createApp();
  server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + server.address().port));
}
