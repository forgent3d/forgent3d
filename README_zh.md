<p align="center">
  <img src="docs/logo.png" width="96" alt="Forgent3D logo" />
</p>

<h1 align="center">Forgent3D</h1>

<p align="center">
  <strong>用代码和 AI Agent 设计 3D 模型。</strong>
</p>

<p align="center">
  <a href="https://github.com/forgent3d/forgent3d/releases">
    <img alt="Release" src="https://img.shields.io/github/v/release/forgent3d/forgent3d?style=flat-square&logo=github" />
  </a>
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/forgent3d/forgent3d?style=flat-square&logo=github" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" />
  <img alt="AI CAD" src="https://img.shields.io/badge/AI%20CAD-local%20agent-6E56CF?style=flat-square" />
  <img alt="Parametric modeling" src="https://img.shields.io/badge/parametric-modeling-0F766E?style=flat-square" />
  <br />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-20232A?style=flat-square&logo=electron&logoColor=9FEAF9" />
  <img alt="Three.js" src="https://img.shields.io/badge/Three.js-black?style=flat-square&logo=three.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Python" src="https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white" />
  <img alt="build123d" src="https://img.shields.io/badge/build123d-CAD%20kernel-455A64?style=flat-square" />
  <img alt="MuJoCo" src="https://img.shields.io/badge/MuJoCo-simulation-8B5CF6?style=flat-square" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-agent%20tools-111827?style=flat-square" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-F69220?style=flat-square&logo=pnpm&logoColor=white" />
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="#-快速开始">快速开始</a>
  ·
  <a href="#-ai-agent-工作流">AI Agent 工作流</a>
  ·
  <a href="https://github.com/forgent3d/forgent3d/releases">下载</a>
</p>

Forgent3D 是一个本地 AI CAD 伙伴，用来把参数化模型代码转化为可检查的 3D 几何。你可以用 AI 编程 Agent 编写或生成 CAD，修改 `params.json`，重新构建，并在交互式桌面预览器里查看结果。

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

## 🚀 快速开始

下载最新版本：

<https://github.com/forgent3d/forgent3d/releases/>

或者从源码运行：

```bash
pnpm install
npm run build:runner
npm run dev
```

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

## 🛠️ 开发

```bash
pnpm install
npm run build:runner
npm run dev
```

常用脚本：

```bash
npm run build:renderer
npm run build
npm run start
```

## 📄 许可证

Forgent3D 基于 [MIT License](LICENSE) 开源。
