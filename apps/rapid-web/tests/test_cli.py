# SPDX-License-Identifier: Apache-2.0
"""Tests for the CLI: login URL, the startup banner, and argument handling."""

from __future__ import annotations

import pytest

from rmlx_web import cli
from rmlx_web.connectors import ConnectorStore


class TestLoginURL:
    def test_the_token_rides_in_the_fragment(self):
        url = cli._login_url("127.0.0.1", 7788, "secret-token")

        # A fragment is never sent to the server, so it cannot land in an
        # access log, a proxy log, or a tunnel provider's request
        # history — all of which a query parameter would reach.
        assert "#token=secret-token" in url
        assert "?token=" not in url

    def test_the_token_is_percent_encoded(self):
        url = cli._login_url("127.0.0.1", 7788, "a+b/c=d&e")

        # `&` would otherwise start a second fragment parameter and
        # truncate the token; `/` and `+` are ambiguous in a URL.
        assert "a%2Bb%2Fc%3Dd%26e" in url
        assert "&e" not in url.split("#token=")[1]

    def test_a_generated_token_round_trips(self):
        from rmlx_web import auth

        token = auth.generate_token()
        url = cli._login_url("127.0.0.1", 7788, token)

        from urllib.parse import unquote

        assert unquote(url.split("#token=")[1]) == token



class TestBanner:
    def test_prints_the_url_and_token(self, capsys):
        cli._print_banner(host="127.0.0.1", port=7788, token="tok", loopback=True)
        out = capsys.readouterr().out

        assert "http://127.0.0.1:7788/" in out
        assert "tok" in out

    def test_prints_the_sign_in_link(self, capsys):
        # The link carries the token in its fragment, so pasting it is what
        # saves retyping 43 characters.
        cli._print_banner(host="127.0.0.1", port=7788, token="tok", loopback=True)
        out = capsys.readouterr().out

        assert "#token=tok" in out

    def test_prints_no_qr_code(self, capsys):
        # A 25-row block of blocks pushed the token off a short terminal
        # window, which is the one thing the user cannot proceed without.
        cli._print_banner(host="127.0.0.1", port=7788, token="tok", loopback=True)
        out = capsys.readouterr().out

        assert "Scan" not in out
        assert "qr" not in out.lower()
        # Whatever else changes, the banner stays short enough to read.
        assert len(out.splitlines()) < 15

    def test_warns_on_an_unprotected_non_loopback_bind(self, capsys, monkeypatch):
        monkeypatch.setattr(cli, "_display_host", lambda host: "192.168.1.5")
        cli._print_banner(host="0.0.0.0", port=7788, token=None, loopback=False)
        out = capsys.readouterr().out

        assert "WARNING" in out
        assert "--token" in out

    def test_no_warning_when_a_token_protects_the_bind(self, capsys, monkeypatch):
        monkeypatch.setattr(cli, "_display_host", lambda host: "192.168.1.5")
        cli._print_banner(host="0.0.0.0", port=7788, token="tok", loopback=False)
        assert "WARNING" not in capsys.readouterr().out

    def test_no_warning_on_loopback(self, capsys, monkeypatch):
        cli._print_banner(host="127.0.0.1", port=7788, token="tok", loopback=True)
        assert "WARNING" not in capsys.readouterr().out


class TestLoopbackDetection:
    @pytest.mark.parametrize(
        "host", ["127.0.0.1", "127.0.0.53", "localhost", "::1", "0:0:0:0:0:0:0:1"]
    )
    def test_loopback_addresses(self, host):
        # The whole 127/8 block is loopback, not just 127.0.0.1.
        assert cli._is_loopback(host) is True

    @pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.5", "::", "example.com"])
    def test_non_loopback_addresses(self, host):
        # Unparseable names must be treated as non-loopback: getting this
        # wrong in the permissive direction silently skips the exposure
        # warning.
        assert cli._is_loopback(host) is False


class TestDisplayHost:
    def test_a_wildcard_bind_is_not_echoed_back(self, monkeypatch):
        # "0.0.0.0" is not a reachable address, so printing it produces a
        # URL that does not work.
        shown = cli._display_host("0.0.0.0")
        assert shown != "0.0.0.0"

    def test_a_concrete_host_is_passed_through(self):
        assert cli._display_host("192.168.1.5") == "192.168.1.5"
        assert cli._display_host("127.0.0.1") == "127.0.0.1"


class TestTokenDecision:
    """When a bearer is created at all.

    The rule: only when asked for. Remote access always goes through a
    tunnel the user chose, and that tunnel is where access control
    belongs — a second secret only means retyping it on a phone.
    """

    @staticmethod
    def _needs_token(*, loopback, token=None, new_token=False):
        # Mirrors the expression in main(); kept in one place so the test
        # asserts the rule rather than re-deriving it.
        return bool(token) or new_token

    def test_loopback_needs_no_token(self):
        assert self._needs_token(loopback=True) is False

    def test_a_non_loopback_bind_does_not_force_one(self):
        # --host 0.0.0.0 warns instead: the tunnel or the LAN's own
        # access control is the gate, not a token this tool invents.
        assert self._needs_token(loopback=False) is False

    def test_an_explicit_token_opts_in(self):
        assert self._needs_token(loopback=True, token="chosen") is True

    def test_rotating_opts_in(self):
        assert self._needs_token(loopback=True, new_token=True) is True

    def test_the_rule_matches_the_cli_source(self):
        # Guards against the expression in main() drifting away from the
        # rule asserted above.
        import inspect

        source = inspect.getsource(cli.main)
        assert "needs_token = bool(args.token) or args.new_token" in source


class TestBannerWithoutToken:
    def test_says_auth_is_off_rather_than_printing_a_token(self, capsys, monkeypatch):
        cli._print_banner(host="127.0.0.1", port=7788, token=None, loopback=True)
        out = capsys.readouterr().out

        assert "Auth:  none" in out
        assert "Token:" not in out

    def test_the_login_url_has_no_fragment_without_a_token(self):
        assert cli._login_url("127.0.0.1", 7788, None) == "http://127.0.0.1:7788/"
        assert "#" not in cli._login_url("127.0.0.1", 7788, None)

    def test_does_not_repeat_the_url_without_a_token(self, capsys):
        # With no token the sign-in link is just the URL already printed
        # above it, so repeating it says nothing.
        cli._print_banner(host="127.0.0.1", port=7788, token=None, loopback=True)
        out = capsys.readouterr().out

        assert out.count("http://127.0.0.1:7788/") == 1
        assert "Scan" not in out


class TestOptionalModelArgument:
    """The model alias is optional; the page's picker is the other way in.

    This used to be a hard `SystemExit`, so the tests below are the thing
    stopping it from being reintroduced as an "obviously required"
    argument.
    """

    def _args(self, argv: list[str]):
        return cli.build_parser().parse_args(argv)

    def _connectors(self, tmp_path):
        # Never the real ~/.config: this constructor reads a file other tools
        # on this Mac use, and a test must not depend on what is in it.
        return ConnectorStore(
            config_path=tmp_path / "mcp.json",
            settings_path=tmp_path / "rmlx-web.json",
        )

    def test_starting_with_no_model_is_allowed(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cli, "find_rapid_mlx_binary", lambda explicit: "/bin/true")

        engine, catalog, downloads = cli._resolve_engine(
            self._args([]),
            downloads_enabled=True,
            connectors=self._connectors(tmp_path),
        )

        # A supervisor, not an attached engine — it owns the child it will
        # later spawn, which is what makes the picker able to switch.
        assert engine.can_switch is True
        assert engine.status().model is None
        # The catalog is what the picker lists, so it must exist even
        # though nothing is loaded yet.
        assert catalog is not None
        assert downloads is not None

    def test_an_alias_is_still_honoured(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cli, "find_rapid_mlx_binary", lambda explicit: "/bin/true")

        engine, catalog, _ = cli._resolve_engine(
            self._args(["some-alias"]),
            downloads_enabled=False,
            connectors=self._connectors(tmp_path),
        )

        assert engine.can_switch is True
        assert catalog is not None

    def test_attach_still_refuses_a_model(self, tmp_path):
        # --attach targets a server this process does not own, so the
        # model is not ours to choose.
        with pytest.raises(SystemExit):
            cli._resolve_engine(
                self._args(["--attach", "http://x", "alias"]),
                downloads_enabled=False,
                connectors=self._connectors(tmp_path),
            )

    def test_the_help_text_does_not_name_a_specific_model(self):
        # A concrete alias in the help reads as a default and goes stale
        # as the catalog moves.
        help_text = cli.build_parser().format_help()
        assert "qwen" not in help_text.lower()
