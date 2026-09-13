// 并发回归测试：并行建档、并行添加帆索任务、读写混合、冷启动竞态、重启持久化
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createApp } = await import("../server.js");

const tmp = await mkdtemp(join(tmpdir(), "rigging-conc-"));

async function startServer(dbPath) {
  const server = createApp({ dbPath });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, data: await r.json() }));

test("冷启动：全新数据文件上并行首批请求全部成功", async () => {
  const dbPath = join(tmp, "fresh.json");
  const { server, base } = await startServer(dbPath);
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => fetch(base + "/api/items")));
    for (const r of results) assert.equal(r.status, 200);
    const items = await results[0].json();
    assert.ok(items.some(i => i.code === "MR-001")); // 种子数据完整
    const persisted = JSON.parse(await readFile(dbPath, "utf8"));
    assert.ok(Array.isArray(persisted.items));
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("并行建档：全部成功、编号唯一、全部落盘", async () => {
  const dbPath = join(tmp, "parallel-create.json");
  const { server, base } = await startServer(dbPath);
  try {
    const N = 30;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      post(base, "/api/items", { code: "MR-P" + i, shipType: "福船", status: "待检查" })));
    assert.ok(results.every(r => r.status === 201), "存在失败请求: " + JSON.stringify(results.filter(r => r.status !== 201).slice(0, 3)));
    const ids = results.map(r => r.data.id);
    assert.equal(new Set(ids).size, N, "建档编号重复");
    const persisted = JSON.parse(await readFile(dbPath, "utf8"));
    assert.equal(persisted.items.length, N + 1); // N 个新建 + 1 个种子
    assert.equal(new Set(persisted.items.map(i => i.id || i.code)).size, persisted.items.length);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("同一模型并行添加帆索任务：全部成功、任务编号唯一、重启后仍在", async () => {
  const dbPath = join(tmp, "parallel-task.json");
  let { server, base } = await startServer(dbPath);
  let itemId;
  try {
    const created = await post(base, "/api/items", { code: "MR-TASK", shipType: "沙船", status: "待检查" });
    assert.equal(created.status, 201);
    itemId = created.data.id;
    const N = 50;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      post(base, `/api/items/${itemId}/action`, { position: "索位-" + i, tension: "偏松", note: "并行" })));
    assert.ok(results.every(r => r.status === 201), "存在失败请求: " + JSON.stringify(results.filter(r => r.status !== 201).slice(0, 3)));
    const taskIds = results.flatMap(r => r.data.tasks.map(t => t.id));
    assert.equal(new Set(taskIds).size, N, "任务编号重复");
  } finally {
    await new Promise(r => server.close(r));
  }
  // 重启后数据仍在
  ({ server, base } = await startServer(dbPath));
  try {
    const res = await fetch(base + "/api/items");
    const item = (await res.json()).find(i => i.id === itemId);
    assert.equal(item.tasks.length, 50);
    assert.equal(new Set(item.tasks.map(t => t.id)).size, 50);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("读写混合并发：无服务端错误，读到的永远是完整 JSON", async () => {
  const dbPath = join(tmp, "mixed.json");
  const { server, base } = await startServer(dbPath);
  try {
    const writes = Array.from({ length: 20 }, (_, i) =>
      post(base, "/api/items", { code: "MR-M" + i, status: "待检查" }));
    const reads = Array.from({ length: 40 }, async () => {
      const r = await fetch(base + "/api/items");
      const data = await r.json();
      return { status: r.status, ok: Array.isArray(data) };
    });
    const results = await Promise.all([...writes, ...reads]);
    assert.ok(results.every(r => r.status < 500), "出现服务端错误");
    const readResults = await Promise.all(reads.map((_, i) => results[20 + i]));
    assert.ok(readResults.every(r => r.ok));
  } finally {
    await new Promise(r => server.close(r));
  }
});
