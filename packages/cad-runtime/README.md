# @forgent3d/cad-runtime

Shared CAD runtime protocol, Python helpers, types, and pure utilities for Forgent3D cloud services.

This package is intentionally runtime-light:

- no Next.js imports
- no Cloudflare Worker bindings
- no React
- no database clients

`cad-agent` and `cf-sandbox` can both depend on this package without coupling their deploy targets together.

## Python Runtime Assets

The canonical build123d helper scripts live under:

```text
python/skill-helpers/
  aicad_attach.py
  aicad_select.py
```

Consumers copy these files into their own packaging or container build directories as generated assets.
