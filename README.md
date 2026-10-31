# hillview_common

Web UI code shared by the **hillview frontend** and the **recon workbench**, included in both as
a git submodule. The design is in the recon notes (`recon/docs/3d-world-service.md`, *The three
repos*). The workbench may track a working branch of this repo and experiment; hillview moves its
submodule pointer only to commits on `main` that have been reviewed.

| dir | what | alias in the apps |
|---|---|---|
| `world/` | the 3D world's pure parts: geodesy (WGS84 ↔ ECEF ↔ a local tangent frame), relief (exaggeration and refraction: the vertex shader chunk and its CPU mirror), names (projection, the depth-buffer verdict and its probe, layout, paint), the heading tape, click-to-pick | `$world` |
| `terrain/` | the terrain overlay's parts: peak labels and their layout, the sky-pill painter, the depth-panorama viewer, the overlay fit | `$terrain` |
| `zoomview/` | the photo zoom view's parts: tile sources, label layout and paint, annotation targets, viewer init | `$zoomview` |

Next to arrive (the design's phase 3): the lean scene viewer, cut out of the workbench's
`ReconCloudViewer`, with its tile layers.

## Rules

- **No app imports.** Nothing from `$app/*`, `$lib/*`, an API base URL or an app's stores. What a
  module needs from its app (a base URL, a fetch scheduler, the ground height under a point)
  comes in as a parameter. Inside this repo, import relatively; `$terrain/…` inside
  `terrain/TerrainViewer.svelte` is the one exception, inherited, and resolves in both apps.
- **Dependencies are peers.** `svelte` and `three` (optional: only `world/` uses it, and mostly as
  types) come from the app. Dev dependencies follow the apps' 14-day cooloff (`bunfig.toml`).
  They are the only bare imports outside tests: each app dedupes them to its own copy (vite
  `resolve.dedupe`). Any other bare import would resolve from this repo's own `node_modules` in
  development and fail in an app's Docker build, which copies these directories without it.
- **Tested here.** `bun install && bun run test` (vitest) and `bun run check` (tsc, svelte-check)
  must pass on every commit, without either app.
- **Mirrors are pinned.** Where a module mirrors code in another language or another place, a test
  here pins it: `world/geodesy-cases.json` is generated from the Python `geodesy.py` and checked
  by both sides; `world/relief.ts` holds the shader chunk next to its CPU mirror.

## In an app

```sh
git submodule add <url> hillview_common
```

Then point the aliases at it (`$world`, `$terrain`, `$zoomview` → `hillview_common/…`) in the
app's vite config, its test runner's config, and its Dockerfile (which copies the directory
into the build). Each app's own tests keep running against its copy of the submodule.
