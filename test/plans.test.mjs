import test from "node:test";
import assert from "node:assert/strict";
import {
  diffSnapshots,
  threeWayMerge,
  validateSnapshot,
  snapshotFromItem,
  findCycle
} from "../lib/plans.js";

function L(position, currentTension = "", targetTension = "", status = "", dependsOn = []) {
  return { position, currentTension, targetTension, status, dependsOn };
}
function snap(status, lines) {
  return { status, lines };
}

test("diffSnapshots 识别新增、删除和逐字段修改", () => {
  const base = snap("校准中", [L("前桅支索", "偏松", "偏松", "调整中"), L("后桅支索", "适中", "适中", "待检查")]);
  const side = snap("待复核", [L("前桅支索", "偏紧", "适中", "调整中"), L("主桅升帆索", "偏松", "偏松", "待检查", ["前桅支索"])]);
  const d = diffSnapshots(base, side);
  assert.deepEqual(d.added.map(l => l.position), ["主桅升帆索"]);
  assert.deepEqual(d.removed, ["后桅支索"]);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].position, "前桅支索");
  assert.deepEqual(d.changed[0].fields.currentTension, { base: "偏松", side: "偏紧" });
  assert.deepEqual(d.changed[0].fields.targetTension, { base: "偏松", side: "适中" });
  assert.equal(d.changed[0].fields.status, undefined);
  assert.equal(d.statusChanged, true);
});

test("diffSnapshots 中 dependsOn 按集合比较，顺序不同不算变化", () => {
  const base = snap("校准中", [L("甲", "偏松", "偏松", "待检查", ["乙", "丙"])]);
  const same = snap("校准中", [L("甲", "偏松", "偏松", "待检查", ["丙", "乙"])]);
  const d = diffSnapshots(base, same);
  assert.equal(d.changed.length, 0);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
});

test("三方合并：仅分支侧修改 → 采用分支侧", () => {
  const base = snap("校准中", [L("甲", "偏松", "偏松", "待检查")]);
  const ours = snap("校准中", [L("甲", "偏松", "偏松", "待检查")]);
  const theirs = snap("待复核", [L("甲", "偏紧", "适中", "完成")]);
  const { merged, conflicts } = threeWayMerge(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.status, "待复核");
  assert.equal(merged.lines[0].currentTension, "偏紧");
  assert.equal(merged.lines[0].targetTension, "适中");
});

test("三方合并：仅目标侧修改 → 采用目标侧", () => {
  const base = snap("校准中", [L("甲", "偏松", "偏松", "待检查")]);
  const ours = snap("校准中", [L("甲", "偏紧", "偏紧", "待检查"), L("乙", "适中", "适中", "待检查")]);
  const theirs = snap("校准中", [L("甲", "偏松", "偏松", "待检查")]);
  const { merged, conflicts } = threeWayMerge(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.lines.length, 2);
  assert.equal(merged.lines.find(l => l.position === "甲").currentTension, "偏紧");
});

test("三方合并：两侧改同一索位的不同字段 → 自动合并无冲突", () => {
  const base = snap("校准中", [L("甲", "偏松", "偏松", "待检查")]);
  const ours = snap("校准中", [L("甲", "偏紧", "偏松", "待检查")]);
  const theirs = snap("校准中", [L("甲", "偏松", "适中", "完成")]);
  const { merged, conflicts } = threeWayMerge(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  const line = merged.lines.find(l => l.position === "甲");
  assert.equal(line.currentTension, "偏紧");
  assert.equal(line.targetTension, "适中");
  assert.equal(line.status, "完成");
});

test("三方合并：两侧改同一字段为不同值 → 并发修改冲突", () => {
  const base = snap("校准中", [L("甲", "偏松", "偏松", "待检查")]);
  const ours = snap("校准中", [L("甲", "偏紧", "偏松", "待检查")]);
  const theirs = snap("校准中", [L("甲", "过紧", "偏松", "待检查")]);
  const { conflicts } = threeWayMerge(base, ours, theirs);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, "field_conflict");
  assert.equal(conflicts[0].position, "甲");
  assert.deepEqual(conflicts[0].fields[0], { field: "currentTension", base: "偏松", ours: "偏紧", theirs: "过紧" });
});

test("三方合并：两侧改成一样的值 → 无冲突", () => {
  const base = snap("校准中", [L("甲", "偏松", "偏松", "待检查")]);
  const ours = snap("校准中", [L("甲", "偏紧", "偏紧", "待检查")]);
  const theirs = snap("校准中", [L("甲", "偏紧", "偏紧", "待检查")]);
  const { merged, conflicts } = threeWayMerge(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.lines[0].currentTension, "偏紧");
});

test("三方合并：一侧删除一侧修改 → delete_edit 冲突；一侧删除一侧未动 → 删除生效", () => {
  const base = snap("校准中", [L("甲", "偏松", "偏松", "待检查"), L("乙", "适中", "适中", "待检查")]);
  const ours = snap("校准中", [L("乙", "适中", "适中", "待检查")]); // 删了甲
  const theirs = snap("校准中", [L("甲", "偏紧", "偏松", "待检查"), L("乙", "适中", "适中", "待检查")]); // 改了甲
  const r1 = threeWayMerge(base, ours, theirs);
  assert.equal(r1.conflicts.length, 1);
  assert.equal(r1.conflicts[0].type, "delete_edit");
  assert.equal(r1.conflicts[0].position, "甲");

  const theirsUntouched = snap("校准中", [L("甲", "偏松", "偏松", "待检查"), L("乙", "适中", "适中", "待检查")]);
  const r2 = threeWayMerge(base, ours, theirsUntouched);
  assert.equal(r2.conflicts.length, 0);
  assert.equal(r2.merged.lines.some(l => l.position === "甲"), false);
});

test("三方合并：两侧新增同名索位但内容不同 → 冲突", () => {
  const base = snap("校准中", []);
  const ours = snap("校准中", [L("新索", "偏紧", "偏紧", "待检查")]);
  const theirs = snap("校准中", [L("新索", "偏松", "偏松", "待检查")]);
  const { conflicts } = threeWayMerge(base, ours, theirs);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].position, "新索");
});

test("三方合并：校准状态两侧改不同值 → status_conflict", () => {
  const base = snap("校准中", [L("甲", "偏松", "偏松", "待检查")]);
  const ours = snap("待复核", [L("甲", "偏松", "偏松", "待检查")]);
  const theirs = snap("已交付", [L("甲", "偏松", "偏松", "待检查")]);
  const { conflicts } = threeWayMerge(base, ours, theirs);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, "status_conflict");
});

test("validateSnapshot：缺失索位", () => {
  const errors = validateSnapshot(snap("校准中", [L("甲", "偏松", "偏松", "待检查", ["不存在的索"])]));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "missing_line");
  assert.equal(errors[0].missing, "不存在的索");
});

test("validateSnapshot：循环依赖（自环、二环、三环）", () => {
  assert.ok(findCycle([L("甲", "", "", "", ["甲"])]));
  assert.ok(findCycle([L("甲", "", "", "", ["乙"]), L("乙", "", "", "", ["甲"])]));
  const c3 = findCycle([L("甲", "", "", "", ["乙"]), L("乙", "", "", "", ["丙"]), L("丙", "", "", "", ["甲"])]);
  assert.ok(c3);
  const errors = validateSnapshot(snap("校准中", [L("甲", "", "", "", ["乙"]), L("乙", "", "", "", ["甲"])]));
  assert.equal(errors[0].code, "cyclic_dependency");
});

test("validateSnapshot：无环依赖链通过", () => {
  const errors = validateSnapshot(snap("校准中", [
    L("甲", "", "", "", ["乙"]),
    L("乙", "", "", "", ["丙"]),
    L("丙")
  ]));
  assert.equal(errors.length, 0);
});

test("validateSnapshot：重复索位与空索位", () => {
  const errors = validateSnapshot(snap("校准中", [L("甲"), L("甲"), L("")]));
  assert.ok(errors.some(e => e.code === "duplicate_position" && e.position === "甲"));
  assert.ok(errors.some(e => e.code === "empty_position"));
});

test("snapshotFromItem：从模型任务固化当前/目标松紧与状态", () => {
  const item = {
    status: "校准中",
    tasks: [
      { id: "T-1", position: "前桅支索", tension: "偏松", status: "调整中", logs: [] },
      { id: "T-2", position: "后桅升帆索", tension: "偏紧", status: "待检查", logs: [] }
    ]
  };
  const s = snapshotFromItem(item);
  assert.equal(s.status, "校准中");
  assert.equal(s.lines.length, 2);
  assert.deepEqual(s.lines[0], { position: "前桅支索", currentTension: "偏松", targetTension: "偏松", status: "调整中", dependsOn: [] });
});
