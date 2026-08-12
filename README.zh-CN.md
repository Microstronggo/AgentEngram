# AgentEngram

[English](README.md)

AgentEngram 是面向 Agent 系统的通用 **Context & Memory Runtime**。它可以通过 Hook、Adapter 或 MCP 增强现有 Agent；当宿主明确转移上下文所有权时，也可以托管模型看到的上下文。

Engram 指经历留下的持久记忆痕迹。AgentEngram 保存可迁移的对话与工具轨迹，并将这些事实转化为可用的短期上下文和长期记忆。

核心能力：

- 短期记忆：Tool Result Budget、History Snip、Microcompact、Context Collapse、Compact、Session Memory、Checkpoint/Resume/Fork。
- 长期记忆：factual、episodic、procedural、semantic 四类记忆，Markdown 真相源、FTS5 召回、Cell Formation、纠正、老化和 Consolidation。
- 接入：Pi 原生 Extension、Codex Hooks + MCP、通用 MCP stdio Server。
- 可靠性：Portable Transcript、Durable Job、数据校验修复、跨机器导入导出、项目和 Worktree 隔离。

## 安装

Pi：

```bash
pi install npm:@agentengram/adapter-pi
pnpm dlx @agentengram/engine setup pi
pnpm dlx @agentengram/engine doctor --adapter pi --json
```

Codex：

```bash
pnpm add @agentengram/adapter-codex
pnpm dlx @agentengram/engine setup codex
pnpm dlx @agentengram/engine doctor --adapter codex --json
```

通用 MCP：

```bash
pnpm add -g @agentengram/mcp
agentengram-mcp
```

## 上下文所有权

- Pi 默认使用 `enhance`；只有用户显式选择并通过能力检查后才启用 `managed-context`。
- Codex 当前只能使用 `enhance`，不能替换完整历史和 Compact。
- MCP 可以提供显式长期记忆工具，但单独使用 MCP 不能接管宿主上下文。

宿主继续保存自己的运行时 Transcript；AgentEngram 保存可迁移的 Portable Transcript。上下文压缩只改变模型投影视图，不删除宿主原始记录。

## 模型策略

AgentEngram 默认不配置任何付费模型：

- Pi 默认复用当前会话模型执行 Compact 和 Cell Formation。
- Codex Formation 默认关闭；用户显式配置 OpenAI-compatible Provider 后才启用。
- 配置文件只保存 API Key 的环境变量名，不保存 token。

上下文所有权和模型策略需要显式配置。数据目录包含原始对话和派生记忆；Portable Bundle 具有完整性校验但不加密，生产使用时必须保护数据目录并审查模型访问配置。项目默认不启用远程遥测。

## 开发

```bash
corepack enable
pnpm install
pnpm check
pnpm check:release
```

`pnpm check:release` 会统一执行测试、打包、当前文件与提交历史隐私检查，以及空目录安装验证。

项目当前为实验性的 `0.1.x` 预览版，采用 [Apache License 2.0](LICENSE)。
