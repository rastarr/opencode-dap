# npm 发布说明

## 包名

本仓库在 [npmjs.com](https://www.npmjs.com/) 上发布为：**`@debugtalk/opencode-dap`**

`package.json` 中已设置：

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org"
}
```

## Fork 发布流程（本仓库）

本 fork 不发布到 npm；`package.json` 版本号只用于标识。发布 = 以下全部步骤：

1. 更新 `CHANGELOG.md`（Keep a Changelog 格式，顶部加新版本条目）
2. `package.json` 版本号 bump
3. 提交 + push 到 `main`
4. **打 tag**：`git tag v<version> && git push origin v<version>`
5. **建 GitHub release**：`gh release create v<version> --title "v<version>" --notes "..."`

步骤 4-5 常被遗漏（曾两次只 push 了 commit，release 页仍显示旧版本）。

## 发布前

```bash
npm run check && bun test tests/
npm pack --dry-run
```

`npm pack --dry-run` 会列出即将打包的文件，确认只包含 `src/`、`README.md`、`LICENSE`。

## 发布

```bash
npm publish --registry https://registry.npmjs.org
# 若开启 2FA：
npm publish --registry https://registry.npmjs.org --otp=XXXXXX
```

## 用户安装

通过 `opencode plugin` 命令一键安装（会自动下载插件包并写入配置）：

```bash
opencode plugin @debugtalk/opencode-dap
```

安装后**重启 OpenCode** 即可生效。`debug` 工具自动可用，无需额外配置。

### 全局安装

```bash
opencode plugin @debugtalk/opencode-dap --global
```

全局安装后，所有项目中都能使用 `debug` 工具。

### 升级

```bash
opencode plugin @debugtalk/opencode-dap --force
```

`--force` 会覆盖已缓存的旧版本，然后重启 OpenCode。

### 安装做了什么

1. 插件包下载到 `~/.cache/opencode/packages/@debugtalk/opencode-dap/`
2. 插件声明写入 `opencode.json`（项目级 `.opencode/opencode.json` 或全局 `~/.config/opencode/opencode.json`）：
   ```json
   { "plugin": ["@debugtalk/opencode-dap"] }
   ```

### 手动安装（不推荐）

如果无法使用 `opencode plugin`，也可手动操作：

```bash
npm install @debugtalk/opencode-dap --save-dev
```

然后在 `opencode.json` 中手动添加：

```json
{ "plugin": ["@debugtalk/opencode-dap"] }
```

### 验证安装

重启 OpenCode 后，查看日志确认插件是否加载成功：

```bash
grep "opencode-dap" ~/.local/share/opencode/log/opencode.log
```

- 看到 `debug tool registered` 或类似加载日志 → 加载成功
- 看到 `failed to load plugin.*opencode-dap` → 加载失败

也可以通过 OpenCode 中直接测试 `debug` 工具是否可用：

```bash
# 在 OpenCode 会话中直接使用
debug action=sessions
```

### 安装调试适配器

插件安装后，还需要安装对应语言的调试适配器：

```bash
pip install debugpy          # Python
brew install llvm            # macOS: C/C++/Rust/Swift (lldb-dap)
go install github.com/go-delve/delve/cmd/dlv@latest  # Go
npm install -g @vscode/js-debug      # JavaScript / TypeScript
```

运行以下命令检查已安装的适配器：

```bash
debug action=sessions
# 或者
debug action=launch program=test.py   # 会自动检测可用的适配器
```
