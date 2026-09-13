# 古船模型帆索校准

运行：

```bash
npm start
```

访问`http://localhost:3038`。数据保存在`data/model-rigging-calibration.json`（含 `items` 与 `plans`，重启不丢）。

## 校准图谱版本（分支与合并）

- **固化版本**：每艘船可把当前帆索、目标松紧、依赖关系和校准状态固化为不可覆盖的计划版本（`v1、v2…`，带父版本溯源链）。
- **开分支**：可从任一版本开分支，在草稿中修改索位、目标松紧、依赖和校准状态。
- **合并预览**：展示两侧相对基点的差异、冲突索位和受影响记录（帆索任务）。
- **拒绝合并**：存在并发修改（同索位同字段两侧改不同值）、循环依赖、缺失索位或目标版本过期时返回 409，活动任务保持原样。
- **成功合并**：生成不可覆盖的新版本，旧版本可追溯；合并不改动线上帆索任务。

### API

```
GET  /api/items/:id/plans                          版本/分支/合并记录总览
POST /api/items/:id/plans/versions                 固化当前为版本
GET  /api/items/:id/plans/versions/:vid            版本详情 + 溯源链
POST /api/items/:id/plans/versions/:vid/branch     从该版本开分支
GET/PATCH /api/items/:id/plans/branches/:bid       分支详情 / 保存草稿
GET  /api/items/:id/plans/branches/:bid/preview?target=:vid   合并预览
POST /api/items/:id/plans/branches/:bid/merge      执行合并（409=拒绝）
```

## 测试

```bash
npm test            # 合并逻辑单测 + API 集成测试（含重启持久化、旧流程回归）+ 真实浏览器走通
npm run test:browser  # 仅真实浏览器走通（分支、冲突、成功合并、旧流程）
```

真实浏览器测试需要 Chromium：有网环境执行 `bash scripts/setup-browser.sh`
（安装 playwright、下载 chromium；无 root 时自动把系统共享库解压到 `.browser-libs/`）。
未安装浏览器时该测试自动跳过，不影响其余测试。
