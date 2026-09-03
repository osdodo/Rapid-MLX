# SPDX-License-Identifier: Apache-2.0
"""``serve --help`` stays a first-run surface (issue #2354).

``rapid-mlx serve --help`` had grown to 526 lines: the flags a new user
needs (model, host, port, auth, logging, how to connect) were mixed with
experimental scheduler controls, internal module paths, project phase
labels, and issue/PR numbers.

These tests pin the contract that fixed it:

* the DEFAULT help stays small and covers the common serve journey;
* advanced/experimental flags are reachable through ``--help-all``;
* neither surface leaks internal implementation history at the user.

The flag surface itself is untouched — every option still parses. Only
rendering is tiered, so ``--help-all`` remains the exhaustive reference.

Help text is captured by subprocess (the convention in
``tests/test_kv_cache_dtype_cli.py``): importing ``vllm_mlx.cli`` in
process drags in the heavy model stack on some lanes.
"""

from __future__ import annotations

import re
import subprocess
import sys

import pytest

# Budget for the default help. The pre-fix surface was 526 lines; the
# point of the tier split is that a new flag can no longer quietly
# regrow it. Raising this number is a product decision, not a rubber
# stamp: prefer tagging the new flag advanced in ``_SERVE_ADVANCED_GROUPS``.
MAX_DEFAULT_HELP_LINES = 220


def _serve_help(*flags: str) -> str:
    proc = subprocess.run(
        [sys.executable, "-m", "vllm_mlx.cli", "serve", *flags],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


@pytest.fixture(scope="module")
def default_help() -> str:
    return _serve_help("--help")


@pytest.fixture(scope="module")
def full_help() -> str:
    return _serve_help("--help-all")


# ---------------------------------------------------------------------------
# 1. The default surface stays small and answers the first-run questions
# ---------------------------------------------------------------------------


def test_default_help_fits_the_first_run_budget(default_help):
    lines = default_help.splitlines()
    assert len(lines) <= MAX_DEFAULT_HELP_LINES, (
        f"serve --help grew to {len(lines)} lines (budget "
        f"{MAX_DEFAULT_HELP_LINES}). Tag the new flag advanced in "
        f"vllm_mlx/cli.py::_SERVE_ADVANCED_GROUPS instead of raising this."
    )


@pytest.mark.parametrize(
    "flag",
    [
        "--host",
        "--port",
        "--api-key",
        "--log-level",
        "--served-model-name",
        "--max-tokens",
        "--timeout",
    ],
)
def test_default_help_keeps_the_core_serve_journey(default_help, flag):
    """The flags a first-time user needs must not be behind --help-all."""
    assert flag in default_help


def test_default_help_documents_the_connection_contract(default_help):
    """A reader must learn where to point an OpenAI client and how to auth."""
    assert "/v1" in default_help
    assert "/v1/models" in default_help
    assert "/health" in default_help
    assert "Bearer" in default_help
    assert "RAPID_MLX_API_KEY" in default_help


def test_default_help_points_at_the_advanced_surface(default_help):
    assert "--help-all" in default_help
    assert "docs/reference/cli.md" in default_help


@pytest.mark.parametrize(
    "flag",
    [
        "--kv-cache-turboquant",
        "--speculative-config",
        "--pflash-stride-blocks",
        "--metal-cap-kv-bytes-per-token",
        "--prefix-cache-index",
        "--force-openai-harmony-streaming",
        "--listen-fd",
        "--disk-stream",
    ],
)
def test_default_help_defers_advanced_controls(default_help, flag):
    assert flag not in default_help


# ---------------------------------------------------------------------------
# 2. --help-all stays the exhaustive reference
# ---------------------------------------------------------------------------


def test_help_all_lists_every_documented_serve_option(full_help):
    """No option may be lost between the tiers.

    ``--help-all`` must render every ``serve`` flag that carries a help
    string; deliberately suppressed (deprecated) aliases stay hidden and
    are pinned by ``tests/test_cli_deprecated_noop_flags.py``.
    """
    pytest.importorskip("websockets")  # build_parser registers `share`
    import argparse

    from vllm_mlx.cli import build_parser

    serve_parser = next(
        action.choices["serve"]
        for action in build_parser()._actions
        if getattr(action, "choices", None) and "serve" in action.choices
    )
    documented = {
        opt
        for action in serve_parser._actions
        if action.help is not argparse.SUPPRESS
        for opt in action.option_strings
    }
    missing = sorted(opt for opt in documented if opt not in full_help)
    assert not missing, f"options missing from --help-all: {missing}"


def test_help_all_is_a_superset_of_default_help(default_help, full_help):
    assert len(full_help.splitlines()) > len(default_help.splitlines())
    for flag in ("--host", "--port", "--api-key", "--max-tokens"):
        assert flag in full_help


def test_advanced_groups_are_rendered_as_named_sections(full_help):
    """Advanced flags are grouped, not dumped into one wall of options."""
    for title in (
        "advanced: KV cache",
        "advanced: speculative decoding",
        "advanced: deployment",
    ):
        assert f"{title}:" in full_help


# ---------------------------------------------------------------------------
# 3. Help text speaks Rapid-MLX, not internal implementation history
# ---------------------------------------------------------------------------

# Substrings that mean "this sentence was written for a maintainer".
_INTERNAL_TOKENS = (
    "vllm_mlx.",  # internal module paths
    "D-METAL-CAP",  # internal design-doc label
    "SOP §",  # internal process reference
    "AliasProfile",  # internal class name
    "HarmonyStreamingRouter",  # internal class name
    "ExpertCache",  # internal class name
    "PortSweep",  # internal test-plan label
)

# Project phase labels (``R15-P1``, ``R15 Phase 4``) and issue/PR
# back-references (``#1853``, ``PR #649``) belong in the docs and the
# git history, not in a user's terminal.
_INTERNAL_PATTERNS = (
    re.compile(r"\bR\d+[- ](?:P\d+|Phase\b|#\d+)"),
    re.compile(r"#\d{3,}"),
)


@pytest.mark.parametrize("surface", ["--help", "--help-all"])
def test_help_text_carries_no_internal_implementation_detail(surface):
    text = _serve_help(surface)
    leaked = [token for token in _INTERNAL_TOKENS if token in text]
    assert not leaked, f"serve {surface} leaks internal detail: {leaked}"

    for pattern in _INTERNAL_PATTERNS:
        found = pattern.findall(text)
        assert not found, f"serve {surface} leaks internal references: {found}"


# ---------------------------------------------------------------------------
# 4. Tiering is a rendering concern — parsing must be untouched
# ---------------------------------------------------------------------------


def test_tiering_does_not_change_parsing():
    """Advanced flags still parse from the default (untiered) command line."""
    pytest.importorskip("websockets")
    from vllm_mlx.cli import build_parser

    args = build_parser().parse_args(
        [
            "serve",
            "some/model",
            "--listen-fd",
            "7",
            "--disk-stream",
            "--pflash",
            "always",
        ]
    )
    assert args.listen_fd == 7
    assert args.disk_stream is True
    assert args.pflash == "always"


def test_every_tiered_flag_exists_on_the_serve_parser():
    """The tier tables must not accumulate stale flag names."""
    pytest.importorskip("websockets")
    from vllm_mlx.cli import (
        _SERVE_ADVANCED_GROUPS,
        _SERVE_CORE_GROUPS,
        build_parser,
    )

    serve_parser = next(
        action.choices["serve"]
        for action in build_parser()._actions
        if getattr(action, "choices", None) and "serve" in action.choices
    )
    known = {opt for action in serve_parser._actions for opt in action.option_strings}

    tiered = [flag for _, _, flags in _SERVE_CORE_GROUPS for flag in flags]
    tiered += [flag for _, flags in _SERVE_ADVANCED_GROUPS for flag in flags]

    unknown = sorted(flag for flag in tiered if flag not in known)
    assert not unknown, f"tier table references non-existent flags: {unknown}"
    assert len(tiered) == len(set(tiered)), "a flag is listed in two tiers"
