# Git 钩子（husky v9）

`npm install` 时由 `package.json` 的 `prepare: husky` 自动安装，无需手动执行。

| 钩子 | 作用 |
|---|---|
| `pre-commit` | 对**已暂存**的文件跑 `lint-staged`：`eslint --fix` + `prettier --write` |
| `commit-msg` | 用 `commitlint` 校验 Conventional Commits（`feat:` / `fix:` / `docs:` …） |

> 本仓库当前尚未 `.git init`；初始化 git 后重新执行一次 `npm install` 即可激活钩子。
> 单次绕过：`git commit --no-verify`。不要把绕过当成常态——红线靠钩子兜底。
