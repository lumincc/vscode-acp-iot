# vscode-acp-iot 开发者指南

## 插件构建与发布

### 打包成 VSIX 安装包
当你完成了某个功能开发，或者需要将插件分发给其他环境或团队成员测试时，可以将项目打包为 VS Code 扩展安装包 (`.vsix`)。

1. **执行打包命令**：
   在项目根目录下，使用终端运行以下命令：
   ```bash
   npx vsce package
   ```
   *说明：这会自动触发 `npm run vscode:prepublish` 并调用 Webpack 进行编译和代码压缩。*

2. **获取产物**：
   打包成功后，在项目根目录下会生成名为 `acp-client-<version>.vsix` 的文件（例如 `acp-client-0.2.0.vsix`）。

3. **本地安装测试**：
   你可以通过在主 VS Code 的“扩展”面板中选择“从 VSIX 安装...”来安装此文件，或者在终端运行：
   ```bash
   code --install-extension acp-client-0.2.0.vsix
   ```
