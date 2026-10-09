# docs/ —— 文档索引

## 怎么在这里找东西

| 目录 | 装什么 | 什么时候看 |
|---|---|---|
| [`product/`](./product/README.md) | 需求、详细设计、任务清单、选型清单 | 动手前确认"要做什么、验收标准是什么" |
| [`architecture/`](./architecture/OVERVIEW.md) | 系统架构、代码分层、ADR 决策、迁移记录 | 想知道"为什么这样设计 / 该把代码放哪" |
| [`rules/`](./rules/DEVELOPMENT-STANDARDS.md) | **十条红线**、编码与命名规范、提交规范 | 每次提交前；新人第一天 |
| [`api/`](./api/README.md) | 接口契约：响应体、版本、鉴权、幂等、错误码 | 前后端联调 |
| [`db/`](./db/README.md) | 数据模型、Prisma 约定、迁移流程 | 改 Schema 之前 |
| [`dev/`](./dev/ENV.md) | 环境变量、错误码、开发者工具导入指引 | 本地跑不起来时 |
| [`dev/AI-OUTPUT-QUALITY-STANDARD.md`](./dev/AI-OUTPUT-QUALITY-STANDARD.md) | **AI 产出质量标准**：文案/PPT/图表三维度的产出标准与量化验收指标 | 改提示词、改 PPT 渲染或做交付验收前 |
| [`compliance/`](./compliance/OPEN_SOURCE_LICENSES.md) | 开源许可台账 | **引入任何新依赖之前** |

## 三条"唯一权威"约定（避免文档漂移）

1. **工程规范**只写在 `rules/DEVELOPMENT-STANDARDS.md`；
   `AGENTS.md` 与 `.cursor/rules/project-conventions.mdc` 只做指针，不复制内容。
2. **需求与设计**只写在 `product/青智校园_小程序详细设计文档_V2.md`；
   代码注释里引用它时用「文档 x.y.z」编号，不要抄段落。
3. **任务拆分**只写在 `product/青智校园_开发任务清单.md`；
   提交信息与 PR 用任务编号（如 `M0-05`）关联，不另建任务表。

## 文档命名规范

- 每个目录都要有一个 `README.md` 作为该层索引；
- 主题文档用大写短横线英文名：`ENV.md` / `ERROR_CODES.md` / `OVERVIEW.md` / `DECISIONS.md`；
- 产品侧中文文档保留中文文件名（与任务编号体系一致，便于口头沟通）；
- 一个文档只讲一个主题；超过约 400 行就拆分。
