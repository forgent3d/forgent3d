<p align="center">
  <img src="docs/logo.png" width="96" alt="Forgent3D logo" />
</p>

<h1 align="center">Forgent3D</h1>

<p align="center">
  <strong>一个本地 AI CAD 伙伴，用来和编程 Agent 一起生成、预览并迭代参数化 3D 模型。</strong>
</p>

<p align="center">
  <a href="https://github.com/forgent3d/forgent3d/releases">
    <img alt="Release" src="https://img.shields.io/github/v/release/forgent3d/forgent3d?style=flat-square&logo=github" />
  </a>
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/forgent3d/forgent3d?style=flat-square&logo=github" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" />
  <img alt="AI CAD" src="https://img.shields.io/badge/AI%20CAD-local%20agent-6E56CF?style=flat-square" />
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="#-下载">下载</a>
  ·
  <a href="#-ai-agent-工作流">AI Agent 工作流</a>
  ·
  <a href="#-从源码开发">从源码开发</a>
  ·
  <a href="https://github.com/forgent3d/forgent3d/releases">发布版</a>
</p>

Forgent3D 是一个独立项目，探索当编程 Agent 能在本地生成、重建、检查并修改真实几何时，CAD 工作流会变成什么样。

可以直接从 Releases 下载桌面应用。发布包内置 CAD 运行时，不需要手动配置 Python 或 build123d 就能开始使用。

<p align="center">
  <a href="https://github.com/forgent3d/forgent3d/releases"><strong>下载 Forgent3D</strong></a>
</p>

### 四旋翼无人机

![Forgent3D 参数化四旋翼无人机预览](docs/forgent3d-preview.gif)

### 涡扇发动机

![Forgent3D 涡扇发动机预览](docs/forgent3d-preview2.gif)

## ✨ 为什么选择 Forgent3D

大多数 AI 生成 CAD 的流程停留在源码阶段。Forgent3D 补上了闭环：它让 Agent 和人都能快速构建、预览、检查并迭代真实几何。

- **默认参数化 CAD**：模型由 `part.py` 或 `asm.xml` 搭配 `params.json` 驱动，尺寸和视觉选项都保持可编辑。
- **本地实时预览**：无需离开桌面应用，即可重建模型并在 Three.js 查看器中检查。
- **适合 AI Agent**：内置项目技能和 MCP 工具，帮助 Agent 生成、重建、截图并验证 CAD 输出。
- **几何优先验证**：模型包通过 MJCF 预览，并提供截图和包围盒数据用于检查。
- **装配与运动**：使用 MJCF、可复用 STL 网格、关节、约束和可选 MuJoCo 仿真来组合多体系统。
- **渲染材质**：通过 `params.json` 中的 `__viewer.materials` 指定预览材质预设和颜色，不需要把样式混入几何代码。

## 🚀 下载

下载最新版本：

<https://github.com/forgent3d/forgent3d/releases/>

推荐先从发布版应用开始体验 Forgent3D。它已经打包了本地 CAD 运行时和查看器，你可以直接创建并检查模型，不需要先搭建一套 CAD 开发环境。

应用会在 `models/` 下创建自包含的模型包。每个模型都有根级 `asm.xml` 和 `params.json`，可编辑的本地零件放在其下：

```text
models/
  reference_mount/
    asm.xml
    params.json
    parts/
      mounting_plate/
        part.py
        params.json
      fastener_stack/
        part.py
        params.json
```

## 🧩 工作方式

```text
AI Agent 或编辑器
        |
        v
models/<name>/asm.xml + params.json
models/<name>/parts/<part>/part.py + params.json
        |
        v
Forgent3D 构建运行器
        |
        v
MJCF 模型包预览
        |
        v
交互式查看器、截图、几何信息、MCP 反馈
```

## 🤖 AI Agent 工作流

Forgent3D 被设计成可以和 AI 编程工具一起使用。你可以从查看器启动 Agent，让项目专属技能、规则和 MCP 配置自动可用。

典型循环：

1. 让 Agent 创建或修改模型。
2. Agent 编辑 `part.py`、`asm.xml` 和 `params.json`。
3. Agent 调用查看器重建工具。
4. Forgent3D 更新预览并缓存几何信息。
5. Agent 使用截图或包围盒数据验证结果。

这样能让工作流建立在真实几何之上，而不是只依赖纯文本推理。

## 🛠️ 从源码开发

大多数用户可以直接使用发布版应用。如果你想参与 Forgent3D 本身的开发，可以用 pnpm 从源码运行：

```bash
pnpm install
pnpm run build:electron
pnpm run build:runner
pnpm run dev
```

构建内置 CAD runner 目前需要 Python 3.13。如果你想指定 Python 可执行文件，可以设置 `AICAD_PYTHON_BIN`。

常用脚本：

```bash
pnpm run build:renderer
pnpm run build
pnpm run start
```

## 🔗 生态与参考

Forgent3D 属于正在兴起的 AI 辅助 CAD 探索之一。许多项目都在尝试让语言模型、代码和 CAD 几何更好地协同工作。

- [CADAM](https://github.com/Adam-CAD/CADAM) 探索基于浏览器的 text-to-CAD，支持自然语言或图像输入、参数化控制、浏览器预览和常见导出格式。
- [text-to-cad](https://github.com/earthtojake/text-to-cad) 探索面向 Codex、Claude Code 等编程 Agent 的 CAD 技能和工作流。它是和 Forgent3D 在精神上最接近的项目之一。
- [ForgeCAD](https://github.com/KoStard/ForgeCAD) 探索使用 JavaScript/TypeScript 进行 code-first 参数化 CAD，提供浏览器工作台、本地 CLI 和 agent-ready 工作流。

Forgent3D 专注于围绕 Agent 生成 CAD 的桌面工作流：把 CAD 运行时、查看器、Agent 桥接、重建循环和几何反馈打包到一个可安装的应用中。

## 📄 许可证

本仓库中的源代码基于 [MIT License](LICENSE) 提供。
