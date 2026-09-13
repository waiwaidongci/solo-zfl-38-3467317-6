// 真实浏览器走通：旧流程 → 固化版本 → 开分支 → 预览差异 → 成功合并 → 并发冲突被拒。
// 运行前提：npm i -D playwright && npx playwright install chromium
// 当前离线环境没有浏览器时会自动跳过（不算失败）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {
  // playwright 未安装
}

// 无 root 环境下系统共享库由 scripts/setup-browser.sh 解压到 .browser-libs/
function launchEnv() {
  const libDirs = [
    join(rootDir, ".browser-libs/usr/lib/aarch64-linux-gnu"),
    join(rootDir, ".browser-libs/usr/lib/x86_64-linux-gnu"),
    join(rootDir, ".browser-libs/lib/aarch64-linux-gnu"),
    join(rootDir, ".browser-libs/lib/x86_64-linux-gnu")
  ].filter(existsSync);
  if (!libDirs.length) return undefined;
  const prev = process.env.LD_LIBRARY_PATH;
  return { ...process.env, LD_LIBRARY_PATH: [...libDirs, prev].filter(Boolean).join(":") };
}

const tmp = await mkdtemp(join(tmpdir(), "rigging-browser-"));
const { createApp } = await import("../server.js");

test("真实浏览器走通：旧流程、分支、冲突、成功合并", async t => {
  if (!chromium) {
    return t.skip("未安装 playwright/浏览器（当前环境离线）。有网环境执行 npm i -D playwright && npx playwright install chromium 后运行 npm run test:browser");
  }
  const server = createApp({ dbPath: join(tmp, "db.json") });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ env: launchEnv() });
  try {
    const page = await browser.newPage();
    await page.goto(base);

    // ---- 旧流程：建档 + 帆索任务 + 状态 ----
    await page.fill('#createForm input[name="code"]', "MR-E2E");
    await page.fill('#createForm input[name="shipType"]', "沙船");
    await page.fill('#createForm input[name="owner"]', "林舟");
    await page.click("#createForm button");
    await page.waitForSelector('.card:has-text("MR-E2E")');

    await page.selectOption("#itemSelect", { label: "MR-E2E · 沙船" });
    await page.fill('#actionForm input[name="position"]', "首帆支索");
    await page.fill('#actionForm input[name="tension"]', "偏松");
    await page.fill('#actionForm input[name="note"]', "初装");
    await page.click("#actionForm button");
    await page.waitForSelector('.card:has-text("首帆支索")');
    const cardText = await page.textContent("#cards");
    assert.ok(cardText.includes("校准中"));

    // ---- 固化版本 v1 ----
    await page.selectOption("#planItem", { label: "MR-E2E · 沙船" });
    await page.click("#freezeBtn");
    await page.waitForSelector('#versionList .vrow:has-text("v1")');

    // ---- 开分支并修改草稿 ----
    await page.fill("#branchName", "方案-浏览器");
    await page.click('#versionList [data-branch]');
    await page.waitForSelector('#branchList .brow:has-text("方案-浏览器")');
    await page.click('#branchList [data-edit]');
    await page.waitForSelector("#draftPanel:not([hidden])");
    await page.fill('#draftBody tr:first-child input[data-f="targetTension"]', "适中");
    await page.click("#saveDraftBtn");
    await page.waitForSelector('#planMsg:has-text("草稿已保存")');

    // ---- 预览差异（无冲突）并合并 ----
    await page.click("#previewBtn");
    await page.waitForSelector('#previewOut .ok:has-text("无冲突")');
    const previewText = await page.textContent("#previewOut");
    assert.ok(previewText.includes("首帆支索"));
    assert.ok(previewText.includes("受影响记录"));
    await page.click("#mergeBtn");
    await page.waitForSelector('#mergeResult .ok:has-text("合并成功")');
    await page.waitForSelector('#versionList .vrow:has-text("v2")');

    // ---- 制造并发冲突：B1 改偏紧合并成 v3；B2 从 v2 改偏松 ----
    await page.fill("#branchName", "冲突甲");
    await page.click('#versionList .vrow:has-text("v2") [data-branch]');
    await page.waitForSelector('#branchList .brow:has-text("冲突甲")');
    await page.click('#branchList .brow:has-text("冲突甲") [data-edit]');
    await page.fill('#draftBody tr:first-child input[data-f="currentTension"]', "偏紧");
    await page.click("#saveDraftBtn");
    await page.click("#previewBtn");
    await page.waitForSelector("#mergeBtn:not([disabled])");
    await page.click("#mergeBtn");
    await page.waitForSelector('#versionList .vrow:has-text("v3")');

    await page.fill("#branchName", "冲突乙");
    await page.click('#versionList .vrow:has-text("v2") [data-branch]');
    await page.waitForSelector('#branchList .brow:has-text("冲突乙")');
    await page.click('#branchList .brow:has-text("冲突乙") [data-edit]');
    await page.fill('#draftBody tr:first-child input[data-f="currentTension"]', "过松");
    await page.click("#saveDraftBtn");
    await page.click("#previewBtn");
    await page.waitForSelector('#previewOut .conflict:has-text("首帆支索")');
    const mergeDisabled = await page.getAttribute("#mergeBtn", "disabled");
    assert.notEqual(mergeDisabled, null);

    // 旧版本可追溯：查看 v1 的溯源链
    await page.click('#versionList .vrow:has-text("v1") [data-view]');
    await page.waitForSelector('#versionDetail:has-text("溯源链")');
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
});
