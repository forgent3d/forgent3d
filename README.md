# Forgent3D

**Code is model.**

Forgent3D is a local AI CAD companion for turning parametric model code into inspectable 3D geometry. Write or generate CAD with an AI coding agent, edit `params.json`, rebuild, and see the result in an interactive desktop previewer.

![Forgent3D: parametric model and 3D preview](docs/forgent3d-preview.gif)

## Why Forgent3D

Most AI-generated CAD workflows stop at source code. Forgent3D closes the loop: it gives agents and humans a fast way to build, preview, inspect, and iterate on real geometry.

- **Parametric CAD by default**: models are driven by `part.py` or `asm.xml` plus `params.json`, so dimensions and visual choices stay editable.
- **Live local preview**: rebuild models and inspect them in a Three.js viewer without leaving the desktop app.
- **AI-agent friendly**: built-in project skills and MCP tooling help agents generate, rebuild, screenshot, and verify CAD output.
- **Geometry-first validation**: single-body parts preview through BREP, with face and bounding-box data available for inspection.
- **Assemblies and motion**: compose multi-body systems with MJCF, reusable STL meshes, joints, constraints, and optional MuJoCo simulation.
- **Renderer materials**: use `__viewer.materials` in `params.json` to assign preview material presets and colors without mixing styling into geometry.

## Quick Start

Download the latest release:

<https://github.com/forgent3d/forgent3d/releases/>

Or run from source:

```bash
pnpm install
npm run build:runner
npm run dev
```

The app creates a project with a `models/` directory. Each model lives in its own folder with source code and parameters:

```text
models/
  bracket/
    part.py
    params.json
  linkage_demo/
    asm.xml
    params.json
```

## How It Works

```text
AI agent or editor
        |
        v
models/<name>/part.py or asm.xml
models/<name>/params.json
        |
        v
Forgent3D build runner
        |
        v
BREP part preview or MJCF assembly preview
        |
        v
Interactive viewer, screenshots, geometry info, MCP feedback
```

## AI Agent Workflow

Forgent3D is designed to sit next to AI coding tools. Launch your agent from the viewer so project-specific skills, rules, and MCP configuration are available.

A typical loop:

1. Ask the agent to create or modify a model.
2. The agent edits `part.py`, `asm.xml`, and `params.json`.
3. The agent calls the viewer rebuild tool.
4. Forgent3D updates the preview and caches geometry info.
5. The agent uses screenshots or bounding-box data to verify the result.

This keeps the workflow grounded in real geometry instead of text-only reasoning.

## Development

```bash
pnpm install
npm run build:runner
npm run dev
```

Useful scripts:

```bash
npm run build:renderer
npm run build
npm run start
```

## License

Forgent3D is open source under the [MIT License](LICENSE).
