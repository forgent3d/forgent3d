## build123d Source Rules

- **File & Output**: Code lives in `models/<model_name>/parts/<part_name>/part.py`. The final build123d object must be assigned to the global `result` variable. Do not use manual `export_*()` calls. Unit: mm.
- **Parameterization**: Load only user-facing tunable variables from `params.json`. Keep defaults small: expose main dimensions and genuinely reusable knobs, compute derived values in source, and keep one-off construction constants local.
- **Viewer Materials**: Treat `__viewer` values as preview-only renderer metadata.
- **Assembly Metadata**: For parts intended for assemblies, compute local connection anchors in `part.py` from the same geometry parameters used to build the shape, then expose them through a global `metadata` dict.
- **Metadata Format**: Use `metadata = {"schema": "aicad.part.metadata.v1", "units": "mm", "anchors": {...}}`. Keep anchors in the same local coordinate frame as the exported mesh so `asm.xml` can reference them directly for body origins, sites, joints, and equality constraints.
- **Generated Metadata Files**: `metadata.json` is a rebuild artifact derived from the global `metadata` dict. Do not read, edit, or create `metadata.json` unless the user explicitly asks or you are debugging rebuild output.
- **Standard Parts**: The bundled runtime includes `bd_warehouse`. Use it when a standard mechanical catalog part is a better fit than custom source.
- **Disjoint Bodies**: For separate items such as individual hardware stacks or repeated loose parts, use separate solids or compounds instead of fusing unrelated bodies into one solid.
- **Standard Threads**: Do not model real screw threads by default unless thread geometry is the core deliverable.
