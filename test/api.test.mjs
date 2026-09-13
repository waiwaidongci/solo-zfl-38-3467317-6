import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const tmp = await mkdtemp(join(tmpdir(), "rigging-test-"));
process.env.DB_PATH = join(tmp, "db.json");

const { createApp } = await import("../server.js");

let server;
let base;

async function api(path, options) {
  const res = await fetch(base + path, options && options.body
    ? { ...options, headers: { "Content-Type": "application/json" } }
    : options);
  const data = await res.json();
  return { status: res.status, data };
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
const patch = (path, body) => api(path, { method: "PATCH", body: JSON.stringify(body || {}) });

async function startServer() {
  server = createApp();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stopServer() {
  if (server) await new Promise(resolve => server.close(resolve));
}

test.before(startServer);
test.after(stopServer);

// 共享状态
let itemId;
let v1, v2, v3, v4;
let branchA, branchB;

test("旧流程：建档、帆索任务、状态更新、备注、统计", async () => {
  const created = await post("/api/items", { code: "MR-100", shipType: "沙船", scale: "1:50", mastCount: 2, riggingMaterial: "棉线", owner: "林舟", dueDate: "2026-07-01", status: "待检查" });
  assert.equal(created.status, 201);
  assert.ok(created.data.id);
  itemId = created.data.id;

  const acted = await post(`/api/items/${itemId}/action`, { position: "主桅升帆索", tension: "偏松", note: "初装" });
  assert.equal(acted.status, 201);
  assert.equal(acted.data.status, "校准中");
  assert.equal(acted.data.tasks.length, 1);
  assert.equal(acted.data.tasks[0].position, "主桅升帆索");

  const patched = await patch(`/api/items/${itemId}`, { status: "校准中" });
  assert.equal(patched.status, 200);

  const logged = await post(`/api/items/${itemId}/logs`, { step: "备注", note: "检查桅杆" });
  assert.equal(logged.status, 201);

  const list = await api("/api/items");
  assert.equal(list.status, 200);
  const mine = list.data.find(i => i.id === itemId);
  assert.ok(mine);
  assert.ok(mine.logCount >= 2);

  const stats = await api("/api/stats");
  assert.equal(stats.status, 200);
  assert.ok(stats.data["校准中"] >= 1);

  // 种子数据仍在
  assert.ok(list.data.some(i => i.code === "MR-001"));
});

test("固化计划版本：生成不可覆盖版本并记录溯源", async () => {
  const r1 = await post(`/api/items/${itemId}/plans/versions`, {});
  assert.equal(r1.status, 201);
  assert.equal(r1.data.immutable, true);
  assert.equal(r1.data.label, "v1");
  assert.deepEqual(r1.data.parentIds, []);
  assert.equal(r1.data.snapshot.status, "校准中");
  assert.equal(r1.data.snapshot.lines.length, 1);
  assert.deepEqual(r1.data.snapshot.lines[0], {
    position: "主桅升帆索", currentTension: "偏松", targetTension: "偏松", status: "待检查", dependsOn: []
  });
  v1 = r1.data;

  const r2 = await post(`/api/items/${itemId}/plans/versions`, {});
  assert.equal(r2.status, 201);
  assert.equal(r2.data.label, "v2");
  assert.deepEqual(r2.data.parentIds, [v1.id]);
  v2 = r2.data;

  const list = await api(`/api/items/${itemId}/plans/versions`);
  assert.equal(list.data.length, 2);

  const detail = await api(`/api/items/${itemId}/plans/versions/${v2.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.lineage.map(n => n.id), [v1.id, v2.id]);
});

test("从任一版本开分支并修改草稿", async () => {
  const b = await post(`/api/items/${itemId}/plans/versions/${v2.id}/branch`, { name: "调索方案A" });
  assert.equal(b.status, 201);
  assert.equal(b.data.baseVersionId, v2.id);
  assert.equal(b.data.merged, false);
  assert.equal(b.data.draft.lines.length, 1);
  branchA = b.data;

  const patched = await patch(`/api/items/${itemId}/plans/branches/${branchA.id}`, {
    status: "校准中",
    lines: [
      { position: "主桅升帆索", currentTension: "偏松", targetTension: "适中", status: "调整中", dependsOn: [] },
      { position: "前桅支索", currentTension: "偏松", targetTension: "偏松", status: "待检查", dependsOn: ["主桅升帆索"] }
    ]
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.draft.lines.length, 2);

  // 重复索位被拒绝
  const dup = await patch(`/api/items/${itemId}/plans/branches/${branchA.id}`, {
    lines: [{ position: "甲" }, { position: "甲" }]
  });
  assert.equal(dup.status, 400);
  assert.equal(dup.data.error, "duplicate_position");
});

test("预览差异：两侧变化、冲突索位、受影响记录齐全", async () => {
  const p = await api(`/api/items/${itemId}/plans/branches/${branchA.id}/preview?target=${v2.id}`);
  assert.equal(p.status, 200);
  assert.equal(p.data.canMerge, true);
  assert.deepEqual(p.data.conflicts, []);
  assert.deepEqual(p.data.errors, []);
  // theirs（分支）侧：改了主桅升帆索、新增前桅支索
  assert.deepEqual(p.data.theirs.added.map(l => l.position), ["前桅支索"]);
  assert.deepEqual(p.data.theirs.changed.map(c => c.position), ["主桅升帆索"]);
  // ours（目标）侧无变化
  assert.equal(p.data.ours.added.length, 0);
  assert.equal(p.data.ours.changed.length, 0);
  // 受影响记录：主桅升帆索对应的帆索任务
  assert.deepEqual(p.data.affected.map(a => a.position), ["主桅升帆索"]);
});

test("无冲突合并：生成不可覆盖新版本，旧版本可追溯，活动任务保持原样", async () => {
  const before = await api("/api/items");
  const tasksBefore = JSON.stringify(before.data.find(i => i.id === itemId).tasks);

  const m = await post(`/api/items/${itemId}/plans/branches/${branchA.id}/merge`, { targetVersionId: v2.id });
  assert.equal(m.status, 201);
  assert.equal(m.data.version.immutable, true);
  assert.equal(m.data.version.origin.type, "merge");
  assert.equal(m.data.version.origin.branchId, branchA.id);
  assert.deepEqual(m.data.version.parentIds, [v2.id]);
  assert.equal(m.data.version.snapshot.lines.length, 2);
  assert.equal(m.data.version.snapshot.lines.find(l => l.position === "主桅升帆索").targetTension, "适中");
  v3 = m.data.version;

  // 分支标记为已合并
  const b = await api(`/api/items/${itemId}/plans/branches/${branchA.id}`);
  assert.equal(b.data.merged, true);
  assert.equal(b.data.resultVersionId, v3.id);

  // 旧版本可追溯
  const detail = await api(`/api/items/${itemId}/plans/versions/${v1.id}`);
  assert.equal(detail.status, 200);
  const detail3 = await api(`/api/items/${itemId}/plans/versions/${v3.id}`);
  assert.deepEqual(detail3.data.lineage.map(n => n.id), [v1.id, v2.id, v3.id]);

  // 活动任务保持原样
  const after = await api("/api/items");
  assert.equal(JSON.stringify(after.data.find(i => i.id === itemId).tasks), tasksBefore);

  // 已合并分支不能再次合并、不能再改
  const again = await post(`/api/items/${itemId}/plans/branches/${branchA.id}/merge`, { targetVersionId: v3.id });
  assert.equal(again.status, 409);
  const editMerged = await patch(`/api/items/${itemId}/plans/branches/${branchA.id}`, { status: "待复核" });
  assert.equal(editMerged.status, 409);
});

test("并发修改：两侧改同一索位同一字段 → 预览冲突并拒绝合并", async () => {
  // 分支B从 v3 开，改主桅升帆索为偏紧，合并成 v4
  const bB = await post(`/api/items/${itemId}/plans/versions/${v3.id}/branch`, { name: "方案B" });
  await patch(`/api/items/${itemId}/plans/branches/${bB.data.id}`, {
    lines: [
      { position: "主桅升帆索", currentTension: "偏紧", targetTension: "适中", status: "调整中", dependsOn: [] },
      { position: "前桅支索", currentTension: "偏松", targetTension: "偏松", status: "待检查", dependsOn: ["主桅升帆索"] }
    ]
  });
  const mB = await post(`/api/items/${itemId}/plans/branches/${bB.data.id}/merge`, { targetVersionId: v3.id });
  assert.equal(mB.status, 201);
  v4 = mB.data.version;

  // 分支C同样从 v3 开（并发），把同一索位改成过松
  const bC = await post(`/api/items/${itemId}/plans/versions/${v3.id}/branch`, { name: "方案C" });
  branchB = bC.data;
  await patch(`/api/items/${itemId}/plans/branches/${branchB.id}`, {
    lines: [
      { position: "主桅升帆索", currentTension: "过松", targetTension: "适中", status: "调整中", dependsOn: [] },
      { position: "前桅支索", currentTension: "偏松", targetTension: "偏松", status: "待检查", dependsOn: ["主桅升帆索"] }
    ]
  });

  const p = await api(`/api/items/${itemId}/plans/branches/${branchB.id}/preview?target=${v4.id}`);
  assert.equal(p.status, 200);
  assert.equal(p.data.canMerge, false);
  assert.equal(p.data.conflicts.length, 1);
  assert.equal(p.data.conflicts[0].position, "主桅升帆索");
  assert.equal(p.data.conflicts[0].fields[0].ours, "偏紧");
  assert.equal(p.data.conflicts[0].fields[0].theirs, "过松");

  const tasksBefore = JSON.stringify((await api("/api/items")).data.find(i => i.id === itemId).tasks);
  const m = await post(`/api/items/${itemId}/plans/branches/${branchB.id}/merge`, { targetVersionId: v4.id });
  assert.equal(m.status, 409);
  assert.equal(m.data.error, "merge_rejected");
  assert.equal(m.data.conflicts.length, 1);

  // 版本数不变、活动任务保持原样
  const versions = await api(`/api/items/${itemId}/plans/versions`);
  assert.equal(versions.data.length, 4);
  const tasksAfter = JSON.stringify((await api("/api/items")).data.find(i => i.id === itemId).tasks);
  assert.equal(tasksAfter, tasksBefore);
});

test("版本过期：目标不是最新版本 → 拒绝合并", async () => {
  const b = await post(`/api/items/${itemId}/plans/versions/${v4.id}/branch`, { name: "过期目标" });
  const p = await api(`/api/items/${itemId}/plans/branches/${b.data.id}/preview?target=${v3.id}`);
  assert.equal(p.status, 200);
  assert.equal(p.data.canMerge, false);
  assert.ok(p.data.errors.some(e => e.code === "stale_version" && e.latest === v4.id));

  const m = await post(`/api/items/${itemId}/plans/branches/${b.data.id}/merge`, { targetVersionId: v3.id });
  assert.equal(m.status, 409);
  assert.ok(m.data.errors.some(e => e.code === "stale_version"));
});

test("循环依赖：合并被拒绝", async () => {
  const b = await post(`/api/items/${itemId}/plans/versions/${v4.id}/branch`, { name: "循环依赖" });
  await patch(`/api/items/${itemId}/plans/branches/${b.data.id}`, {
    lines: [
      { position: "甲索", currentTension: "偏松", targetTension: "偏松", status: "待检查", dependsOn: ["乙索"] },
      { position: "乙索", currentTension: "偏松", targetTension: "偏松", status: "待检查", dependsOn: ["甲索"] }
    ]
  });
  const p = await api(`/api/items/${itemId}/plans/branches/${b.data.id}/preview?target=${v4.id}`);
  assert.equal(p.data.canMerge, false);
  assert.ok(p.data.errors.some(e => e.code === "cyclic_dependency"));

  const m = await post(`/api/items/${itemId}/plans/branches/${b.data.id}/merge`, { targetVersionId: v4.id });
  assert.equal(m.status, 409);
  assert.ok(m.data.errors.some(e => e.code === "cyclic_dependency"));
});

test("缺失索位：依赖不存在的索位 → 合并被拒绝", async () => {
  const b = await post(`/api/items/${itemId}/plans/versions/${v4.id}/branch`, { name: "缺失索位" });
  await patch(`/api/items/${itemId}/plans/branches/${b.data.id}`, {
    lines: [
      { position: "甲索", currentTension: "偏松", targetTension: "偏松", status: "待检查", dependsOn: ["幽灵索"] }
    ]
  });
  const p = await api(`/api/items/${itemId}/plans/branches/${b.data.id}/preview?target=${v4.id}`);
  assert.equal(p.data.canMerge, false);
  assert.ok(p.data.errors.some(e => e.code === "missing_line" && e.missing === "幽灵索"));

  const m = await post(`/api/items/${itemId}/plans/branches/${b.data.id}/merge`, { targetVersionId: v4.id });
  assert.equal(m.status, 409);
  assert.ok(m.data.errors.some(e => e.code === "missing_line"));
});

test("解决冲突后可重新预览并成功合并", async () => {
  // branchB（方案C）此前因并发修改被拒；把草稿改成与目标一致即可合并
  await patch(`/api/items/${itemId}/plans/branches/${branchB.id}`, {
    lines: [
      { position: "主桅升帆索", currentTension: "偏紧", targetTension: "适中", status: "调整中", dependsOn: [] },
      { position: "前桅支索", currentTension: "偏松", targetTension: "适中", status: "待检查", dependsOn: ["主桅升帆索"] }
    ]
  });
  const p = await api(`/api/items/${itemId}/plans/branches/${branchB.id}/preview?target=${v4.id}`);
  assert.equal(p.data.canMerge, true);
  const m = await post(`/api/items/${itemId}/plans/branches/${branchB.id}/merge`, { targetVersionId: v4.id });
  assert.equal(m.status, 201);
  assert.equal(m.data.version.snapshot.lines.find(l => l.position === "前桅支索").targetTension, "适中");
});

test("重启服务后数据仍在", async () => {
  await stopServer();
  await startServer();
  const versions = await api(`/api/items/${itemId}/plans/versions`);
  assert.equal(versions.status, 200);
  assert.equal(versions.data.length, 5);
  const plans = await api(`/api/items/${itemId}/plans`);
  assert.ok(plans.data.branches.length >= 5);
  assert.ok(plans.data.merges.length >= 3);
  const items = await api("/api/items");
  assert.ok(items.data.some(i => i.id === itemId));
  assert.ok(items.data.some(i => i.code === "MR-001"));
});

test("页面包含校准图谱面板，且内嵌脚本语法正确", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("校准图谱版本"));
  assert.ok(html.includes("plansPanel"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 2);
  for (let i = 0; i < scripts.length; i++) {
    const file = join(tmp, `page-script-${i}.mjs`);
    await writeFile(file, scripts[i]);
    await execFileP(process.execPath, ["--check", file]); // 语法错误会抛异常
  }
});

test("不存在的模型/版本/分支返回 404", async () => {
  assert.equal((await api("/api/items/NOPE/plans")).status, 404);
  assert.equal((await api(`/api/items/${itemId}/plans/versions/V-999`)).status, 404);
  assert.equal((await api(`/api/items/${itemId}/plans/branches/B-999`)).status, 404);
  assert.equal((await post(`/api/items/${itemId}/plans/branches/B-999/merge`, {})).status, 404);
});
