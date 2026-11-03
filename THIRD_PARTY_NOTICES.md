# Third-party notices

`dsh-lan-exec` is MIT licensed (see [LICENSE](LICENSE)). Parts of it are adapted
from **DeepSeek Harness**, also MIT licensed. This file records what came from
where, so the upstream copyright notice travels with the derived code.

## Upstream license

DeepSeek Harness is distributed under the MIT License:

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Adapted code

| Upstream package | What was taken | Where it lives here |
|---|---|---|
| `@deepseek-ai/dsh-tools` | The JSON Schema to TypeScript renderer (`src/ts-types.ts`: identifier quoting, integer/enum/oneOf handling, `ToolArgsMap`/`ToolOutputMap`/`declare const tools` declaration), and the `run_code` description and program-instruction prose | `lib/ptc-types.js` (renderer), `lib/sdk.js` and `lib/local-tool.js` (prose) |
| `@deepseek-ai/dsh-ptc-runtime-node` | The program wrapper (`async function __dsh_program__() { ... }` followed by type stripping), log capture, the `ToolCallError` rejection, the `{ value, logs, error }` outcome shape, and the failure kinds | `lib/ptc-program.js`, `lib/worker.mjs` |
| `@deepseek-ai/dsh-ptc-runtime` | The `resolve(request)` / `run(spec)` seam contract and its binding-namespace rules (portable identifiers, reserved globals) | `lib/ptc-program.js` |
| `@deepseek-ai/dsh-client-ui-tool` | The code-variant tool row layout: 24px header height, 13px title/summary, 2px separator dot, and the `ioCard`/`ioSection`/`ioLabel`/`ioText` output styles | `lib/client.js` (CSS strings plus the row structure) |

Each of these was **adapted**, not copied verbatim: the upstream packages do not
export these modules, and their internal paths are not part of any public
contract. The changes are noted in the file headers of the derived modules.

## Used at runtime, not copied

| Upstream package | How it is used |
|---|---|
| `@deepseek-ai/dsh-client-ui-primitives` | `require`d by the browser bundle and rendered directly: its `CodeBlock` is the same component the PTC `run_code` card uses. No source was copied. |
| `@deepseek-ai/cordis` | The plugin runtime contract (`apply`/`inject`/`ctx.effect`), consumed as a host API. |
| `@deepseek-ai/dsh-tools` | Consumed through `ctx.tools` (`register`/`schemas`/`get`/`execute`); no import. |

## Reference, not code

The two sides are named `origin` (runs the session) and `executor` (runs the
forwarded calls) after the way `dsh-tools` and `dsh-agent-loop` separate a
model-directed call from a nested sub-dispatch. No code was taken for that
convention; it is documented in `README.md`.
