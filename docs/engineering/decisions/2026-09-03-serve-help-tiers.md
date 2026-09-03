# `serve --help` is a first-run surface, not a flag dump

Date: 2026-09-03
Status: accepted
Owner: Vector (CLI), with Harbor for the docs surface
Issue: #2354

## Context

`rapid-mlx serve` accepts ~110 options. Rendering all of them produced a
526-line `--help` (540 by 0.13.4) in which the flags a first-time user needs —
model, host, port, authentication, logging, and how to connect — were
interleaved with experimental scheduler and cache controls.

The text also leaked maintainer context at users: internal module paths
(`vllm_mlx.disk_stream_patch`, `vllm_mlx.registry`,
`vllm_mlx.expert_cache.ExpertCache`), project phase labels (`R15-P1`,
`R15 Phase 4`, `D-METAL-CAP`), an internal process reference (`SOP §10`),
internal class names (`AliasProfile`, `HarmonyStreamingRouter`), and
issue/PR back-references (`PR #649`, `#1853`, `#287`).

## Decision

`serve` help is tiered:

- `rapid-mlx serve --help` renders the core tier only, in named sections
  (`model`, `server`, `authentication and access`, `generation`,
  `performance and memory`), plus an epilog carrying examples and the
  connection contract (base URL, `/v1/models`, `/health`, bearer auth).
- `rapid-mlx serve --help-all` renders every option, adding the
  `advanced: *` sections (model loading, caching, KV cache, batching,
  speculative decoding, long-prompt compression, vision, sampling defaults,
  profile overrides, embeddings, deployment).
- Help strings describe behavior and risk in Rapid-MLX terms. Implementation
  history stays in code comments, `docs/reference/cli.md`, and git.

The flag surface is unchanged. Every option still parses from any command
line; only rendering is tiered.

## Implementation

`vllm_mlx/cli.py`:

- `_SERVE_CORE_GROUPS` / `_SERVE_ADVANCED_GROUPS` are the single, reviewable
  table of which tier a flag belongs to.
- `_organize_serve_help()` runs after the last `serve` `add_argument` and
  re-homes each action into its group, tagging advanced ones with
  `action.rapid_mlx_advanced`.
- `_ServeHelpFormatter` filters tagged actions at RENDER time — from both the
  usage block and the option list. `_ServeHelpAllAction` swaps in
  `_ServeFullHelpFormatter` and prints everything.

### Why render-time filtering instead of `argparse.SUPPRESS`

Rewriting `action.help` to `SUPPRESS` would hide advanced flags from
`--help-all` too, and would break tests that introspect `action.help`
(for example `tests/test_recurrent_prefill_auto_default.py`). Filtering in the
formatter keeps one parser, one set of help strings, and two views.

### Why a post-registration move instead of `group.add_argument`

Threading a group object through ~110 `add_argument` call sites would spread
the tier decision across ~1100 lines and make review of "what is hidden?"
impossible. The table keeps that decision in one place. Only the help renderer
reads `_group_actions`; parsing walks `parser._actions`, which is untouched.

### Fail-open for new flags

A flag missing from both tables stays in the default `options` section and
remains visible. A new flag is never silently invisible; the line budget in
`tests/test_serve_help_tiers.py` is what forces the tier decision.

## Consequences

- `serve --help` is 182 lines (was 540). `--help-all` is 590.
- `rapid-mlx help serve` renders the same core tier.
- Tests that scraped `serve --help` for advanced flags now read `--help-all`,
  and additionally assert deprecated aliases are absent from *both* surfaces:
  `test_speculative_config.py`, `test_dflash_integration.py`,
  `test_ddtree_integration.py`, `test_mtp_spec_decode.py`,
  `test_mtp_cli_wiring.py`, `test_cli_deprecated_noop_flags.py`,
  `test_serve_listen_fd.py`.
- `tests/test_serve_help_tiers.py` pins the budget, the core journey, the
  connection contract, tier completeness, and the absence of internal tokens
  on both surfaces.

## Alternatives considered

- **A separate `rapid-mlx serve --advanced-help` subcommand.** More surface to
  document and complete; `--help-all` is the convention users already know
  from other CLIs.
- **Leaving help alone and only fixing the docs.** The docs were already
  correct (`docs/reference/cli.md` groups every flag). The regression was the
  terminal, which is where a first-time user actually looks.
- **Deleting advanced flags from the CLI.** Out of scope and user-hostile:
  operators depend on them.

## Reproduce

```bash
rapid-mlx serve --help      | wc -l   # 182
rapid-mlx serve --help-all  | wc -l   # 590
python -m pytest tests/test_serve_help_tiers.py
```
