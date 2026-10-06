# 咖啡烘焙曲线与杯测档案（gbroastlog）

面向咖啡烘焙工坊与自烘店的烘焙留档工具：把每个生豆批次的烘焙计划、关键曲线节点、发展率与 RoR、随后的杯测评分与拼配方案逐条记录，形成可复盘的烘焙档案。核心动作：**建生豆产地档案 → 配烘焙机与载量 → 录回温/脱水结束/一爆/二爆/下豆节点 → 算发展率与 RoR → 录杯测分 → 登记拼配配方**。

纯前端单页应用，**无后端 / 无数据库服务 / 无 API 接口**，所有数据保存在访问者本机浏览器的 IndexedDB 里。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先准备环境变量（.env 与 .env.example 内容一致）
cp .env.example .env

# 2. 一条命令构建并启动
docker compose up -d --build
```

启动后访问：**http://localhost:22825**

常用命令：

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `docker compose ps` |
| 查看日志 | `docker compose logs -f frontend` |
| 停止服务 | `docker compose down` |
| 改端口 / 改项目名 | 编辑 `.env` 里的 `FRONTEND_PORT`、`COMPOSE_PROJECT_NAME` 后重新 `docker compose up -d --build` |
| 校验编排文件 | `docker compose config --quiet` |

> 端口覆盖：默认宿主 `22825` → 容器 `80`。若 22825 被占用，把 `.env` 的 `FRONTEND_PORT` 改成其它端口再 `docker compose up -d --build`，访问地址随之变为 `http://localhost:<新端口>`。
>
> 顶层已写 `name: gbroastlog` 兜底，即使本项目放在中文目录下，`docker compose config --quiet` 也不会因项目名为空而报错；`docker-compose.yml` 中**不写 `version:` 字段**。

---

## 二、技术栈

| 分类 | 选型 | 版本 |
| --- | --- | --- |
| 框架 | React | ^18.3.1 |
| 语言 | TypeScript（`strict`、`noUnusedLocals`、`noUnusedParameters`） | ~5.6.3 |
| UI 组件 | Ant Design + @ant-design/icons | ^5.22.5 / ^5.5.1 |
| 构建 | Vite | ^5.4.11 |
| 状态管理 | Redux Toolkit + React Redux（`configureStore` 汇总 4 个 slice） | ^2.3.0 / ^9.1.2 |
| 路由 | React Router（`createBrowserRouter`，页面懒加载） | ^6.28.0 |
| 本地存储 | Dexie（IndexedDB 封装，含结构版本号与升级迁移） | ^4.0.10 |
| 日期 | dayjs | ^1.11.13 |
| 容器化 | 多阶段构建：`node:20-alpine` → `nginx:alpine` | — |

---

## 三、本地开发

```bash
cd frontend
npm install
npm run dev       # http://localhost:22825（vite --host --port 22825）
npm run build     # tsc --noEmit && vite build（类型检查 + 生产构建，必须 0 错误）
npm run preview   # 本地预览 dist 产物
npm run test:merge      # 合并纯逻辑冒烟测试（修订号 / RoR / 杯测总分 / 容量预检 / 余量并集）
npm run test:merge:db   # 合并端到端测试（fake-indexeddb：逐条合并 / 冲突候选 / 草稿重试 / 旧档回填）
```

要求 Node.js 20 及以上（Docker 构建阶段固定使用 `node:20-alpine`）。

---

## 四、目录结构

```
sologsb101-1025/
├── README.md                   # 本文档
├── docker-compose.yml          # 顶层 name: gbroastlog + 服务 frontend（不写 version 字段）
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT（两者内容完全一致）
├── .gitignore                  # node_modules/ dist/ .env *.log .DS_Store .idea/ .vscode/ *.tsbuildinfo
├── sologsb101-1025.md          # 提示词原文（只读）
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip + /assets/ 长缓存
    ├── .dockerignore
    ├── package.json / package-lock.json
    ├── tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：Provider(store) + ConfigProvider(zh_CN) + RouterProvider
        ├── App.tsx             # 布局、侧边导航、首屏 bootstrap（打开本地库 + 载入各表）
        ├── vite-env.d.ts
        ├── styles/main.css     # 烘焙主题全局样式
        ├── types/              # 核心数据模型（一实体一文件）
        │   ├── greenbean.ts    # GreenBean 生豆
        │   ├── roastprofile.ts # RoastProfile 烘焙记录 + MachineTemplate 载量模板
        │   ├── event.ts        # Event 曲线事件（RoastEvent 别名）
        │   ├── cupping.ts      # Cupping 杯测（权重、加权总分、分档）
        │   └── blend.ts        # Blend 拼配方案（占比校验）
        ├── stores/             # Redux Toolkit
        │   ├── beanSlice.ts    # 生豆列表 / 筛选 / 扣减库存
        │   ├── roastSlice.ts   # 烘焙记录 + 曲线事件草稿 + 载量模板 + 状态流转
        │   ├── cuppingSlice.ts # 杯测分项草稿 + 加权总分派生 + 总分排序
        │   ├── blendSlice.ts   # 拼配成分草稿 + 占比校验 + 杯测均分回显
        │   └── store.ts        # configureStore 汇总 + RootState / AppDispatch + bootstrapData
        ├── components/common/
        │   ├── ScoreTag.tsx      # 总分 / RoR / 发展率分档标签
        │   ├── FilterBar.tsx     # 关键字 + 多选下拉，同步 URL query
        │   ├── StatBadge.tsx     # 派生值徽标
        │   ├── EmptyPanel.tsx    # 空数据引导 + 新建入口
        │   ├── ConflictNotice.tsx# 业务页顶部的待裁决冲突提示条（跳转合并中心）
        │   └── MergeCenter.tsx   # 离线档案合并中心：冲突候选裁决 + 入库草稿重试
        ├── hooks/
        │   ├── useRoastCurve.ts # 关键节点 / 发展率 / 分段 RoR / 缺节点补录建议
        │   ├── useMergeCenter.ts# 待裁决冲突与入库重试草稿订阅
        │   └── useIdbTable.ts   # Dexie 表增删改查 + liveQuery 订阅
        ├── pages/
        │   ├── BeanList.tsx         # /beans
        │   ├── MachineConfig.tsx    # /machines
        │   ├── CurveEntry.tsx       # /curves
        │   ├── DevelopmentBoard.tsx # /development
        │   ├── CuppingBoard.tsx     # /cuppings
        │   └── BlendPlan.tsx        # /blends（含离线档案合并中心与逐条合并入口）
        ├── router/index.tsx    # 路由表 + ROUTE_META（导航标题）
        └── utils/
            ├── curve.ts        # 温升插值、发展率、分段 RoR、分档与缺节点检测
            ├── revision.ts     # rev 修订号回填（按烘焙日期等）与编辑推进
            ├── derived.ts      # 合并后派生值重算：分段 RoR / 杯测总分 / 已完成记录余量并集
            ├── merge.ts        # 逐条合并引擎：rev+时间比较、冲突候选、容量预检、草稿重试、冲突裁决
            ├── db.ts           # Dexie 实例、版本迁移、播种、级联、扣减、快照、冲突裁决、草稿存取
            └── export.ts       # 烘焙/杯测/拼配 JSON 导出与结构校验
```

### 路由表

| 路由 | 页面 | 消费模型 | 复用组件 |
| --- | --- | --- | --- |
| `/beans` | 生豆在库与产地档案：新建、按处理法/产地/余量筛选、到货天数与现有重量 | GreenBean、RoastProfile | FilterBar、EmptyPanel、StatBadge |
| `/machines` | 烘焙机与载量配置：机型、风门火力档、常用载量模板维护、烘焙记录状态流转与库存扣减 | RoastProfile、GreenBean、Event | FilterBar、EmptyPanel、StatBadge |
| `/curves` | 曲线关键点录入：按时间轴排回温/脱水结束/一爆/二爆/下豆并标豆温，HTML5 原生拖拽排序写回 atSec | Event、RoastProfile | FilterBar、StatBadge、EmptyPanel、ScoreTag |
| `/development` | 发展率与 RoR：按节点算发展时间占比与各段升温速率并给异常提示 | Event、RoastProfile | ScoreTag、FilterBar、StatBadge |
| `/cuppings` | 杯测评分：五维分项加权总分、分档结论、总分排序 | Cupping、RoastProfile | ScoreTag、EmptyPanel、FilterBar |
| `/blends` | 拼配方案：占比合计 100% 校验、参与批次杯测均分回显、目标风味登记、JSON 导入导出 | Blend 及全部模型 | FilterBar、StatBadge、EmptyPanel、ScoreTag |

`/` 与任何未知路径都会重定向到第一个模块路径 `/beans`。

---

## 五、IndexedDB 库名与数据存储说明

- **库名（Dexie 数据库名）**：`gbroastlog`（`src/utils/db.ts` 里的 `DB_NAME`）。
- **结构版本号**：`DB_VERSION = 3`
  - `version(1).stores({...})`：初版结构（生豆 / 烘焙记录 / 曲线事件 / 杯测 / 拼配方案分表存储）。
  - `version(2).stores({...}).upgrade(async (tx) => {...})`：补齐 `createdAt/updatedAt` 并加索引、新增 `machineTemplates` 载量模板表、按 `profileId` 分组后依时间顺序补算历史事件的 `rorPerMin`、按分项权重补算历史杯测的 `totalScore`、兜底处理法/状态/配方明细数组等字段。
  - `version(3).stores({...}).upgrade(async (tx) => {...})`：**离线档案合并**——全部业务表加 `rev` 修订号与 `conflictOf` 候选索引、新增 `mergeDrafts` 入库重试草稿表；旧数据没有修订号时按业务日期回填（生豆按到货日、烘焙记录按烘焙日、曲线事件按所属记录烘焙日、杯测按杯测日、拼配/模板按创建日）。
- **数据表**：`greenBeans`（生豆）、`roastProfiles`（烘焙记录）、`events`（曲线事件）、`cuppings`（杯测）、`blends`（拼配方案）、`machineTemplates`（载量模板）、`mergeDrafts`（整库合并的入库重试草稿）。
- **首屏自动播种**：`initDatabase()` 在 `db.greenBeans.count() === 0` 时调用 `seedDatabase()`，灌入三层互相引用的演示数据（4 批生豆 → 4 次烘焙记录 → 15 个曲线节点 / 3 笔杯测 → 3 个拼配方案 + 4 个载量模板），固定 id + `bulkPut`，幂等可重复执行。
- **业务写入规则**：
  - 删除生豆会级联删除其烘焙记录、曲线事件、杯测，并从拼配配方中摘除相关成分；删除烘焙记录同样级联删除事件、杯测并摘除配方成分。
  - 烘焙记录状态流转：记录中 → 已完成 / 作废（已完成可作废，作废可恢复记录中）。
  - **下豆扣减**：记录中状态的烘焙记录标记「已完成」（或录入下豆节点后确认）时，按 `chargeG` 自动扣减对应生豆的 `stockKg`，余量低于 2kg 给出补货提醒；余量不足会被拒绝，且不会重复扣减。
  - `/curves` 拖拽排序（HTML5 原生 `draggable`）会保留原有时间集合、按新顺序重排每个节点的 `atSec` 并 `bulkPut` 写回 Dexie。
- **导入导出 / 双店离线合并**：`/blends` 支持整库档案 JSON 导出/导入与单个方案 JSON 导入（`parseBlendJson` 校验占比必须等于 100%）；`/curves`、`/development`、`/cuppings`、`/beans` 也分别提供曲线档案、杯测档案与整库档案的导出。
  - **整库导入按条合并，不再覆盖本地库**（烘焙间与门店各存一份、离线各改，回店合并成一份）：
    - 同一条按 `id` 对齐：先比修订号 `rev`（每次编辑 +1，且不小于业务日期），`rev` 相同再比 `updatedAt`；**`rev` 与时间都相同但内容不一致（两边都动过）时两个候选都留下**（主记录 + `conflictOf` 候选行，候选 id 为 `conflict:<表>:incoming:<原id>`，确定性、重复合并幂等），绝不用后到的盖掉，在 `/blends` 顶部「离线档案合并中心」逐组裁决；
    - 只有一边有的记录直接补进来；
    - **合并前先看生豆在库余量**：对端新增的已完成烘焙所需豆量超过本端余量时，整单拒绝入库，不写业务表，快照落为 `mergeDrafts` 重试草稿（缺口随草稿保存），补货后可在合并中心「接着草稿重试」，成功后草稿自动清除，也可手动放弃；
    - **旧数据没有修订号**时先按烘焙日期等业务日期回填 `rev` 再参与合并；
    - 合并落地后统一重算派生值：曲线事件的**分段 RoR**（同记录按 `atSec` 相邻重算）、杯测分项更新后的**加权总分**、拼配方案的**参批次均分**（由合并后的杯测实时回显）、生豆余量按**已完成烘焙记录并集**（总量基线取两边较大值、扣两边已完成记录并集，作废/记录中不扣）再算一次，**不会两边各扣一遍**。
  - 合并期间待裁决候选行不进各业务列表（slice 的 list 读取会过滤 `conflictOf`），也不参与下豆扣减；生豆 / 机型 / 曲线 / 发展 / 杯测页顶部有冲突提示条，一键跳转合并中心。
- **容器无状态**：没有后端、没有数据库服务、不挂载命名卷；数据只在访问者浏览器里，换浏览器或清除站点数据即恢复到「空库 + 重新播种」状态。

---

## 六、常见问题

| 现象 | 说明与处理 |
| --- | --- |
| 端口 22825 被占用 | 修改 `.env` 的 `FRONTEND_PORT` 后 `docker compose up -d --build`，访问 `http://localhost:<新端口>` |
| 静态资源 403（favicon 等） | 已规避：`Dockerfile` 在 `COPY --from=builder /app/dist /usr/share/nginx/html` 之后紧跟 `RUN chmod -R a+rX /usr/share/nginx/html`，保证 nginx worker（uid=101）可读 |
| 刷新 `/curves` 等子路由 404 | 已规避：`nginx.conf` 使用 `try_files $uri $uri/ /index.html;` 做 SPA fallback |
| 页面数据是空的 | 首次打开会自动播种演示数据；若曾手动清空，可在 `/blends` 导入档案 JSON，或清除站点数据后刷新重新播种 |
| 数据会同步到别的电脑吗 | 不会。IndexedDB 只在本机当前浏览器中；烘焙间与门店各改各的，回店后在 `/blends` 用「导出档案 / 导入档案」逐条合并（同条先比修订号再比时间、两边都改过留两个候选、容量不足留草稿可重试），不会覆盖本地数据 |
| 导入档案提示余量不足 | 这是合并前的容量预检：对端新增的已完成烘焙超过本端在库余量，整单已存为「入库重试草稿」；先补货再到 `/blends` 合并中心点「补货后重试」即可 |
| 列表里看不到冲突的另一版本 | 冲突候选不进业务列表（避免误扣减 / 重复统计），统一在 `/blends` 合并中心裁决，或点各业务页顶部的冲突提示条跳转 |
| 图表/曲线为什么没有 canvas 图 | 本项目用时间轴卡片 + 分段 RoR 表格表达曲线，不引入图表库，避免额外依赖 |
