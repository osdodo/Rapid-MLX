# SPDX-License-Identifier: Apache-2.0
"""Tests for the CLI: login URL, QR rendering, and the startup banner."""

from __future__ import annotations

import sys

import pytest

from rmlx_web import cli


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


class TestQRRendering:
    def test_returns_none_when_segno_is_missing(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "segno", None)
        # ``None`` in sys.modules makes ``import segno`` raise
        # ImportError, which is the case a user without the extra hits.
        assert cli._render_qr("http://example.invalid/") is None

    def test_a_rendering_failure_does_not_propagate(self, monkeypatch):
        class _Broken:
            @staticmethod
            def make(*args, **kwargs):
                raise RuntimeError("encoder exploded")

        monkeypatch.setitem(sys.modules, "segno", _Broken)
        # A QR is decoration. It must never stop the server starting.
        assert cli._render_qr("http://example.invalid/") is None

    def test_renders_when_segno_is_available(self, monkeypatch):
        class _Fake:
            @staticmethod
            def make(content, error=None):
                class _QR:
                    @staticmethod
                    def terminal(out, border=None):
                        out.write(f"QR({content}, border={border})")

                return _QR()

        monkeypatch.setitem(sys.modules, "segno", _Fake)
        rendered = cli._render_qr("http://example.invalid/#token=x")

        assert "http://example.invalid/#token=x" in rendered
        # border=1 rather than the spec's 4: a terminal QR still scans
        # with a thinner quiet zone, and 4 blank rows above and below
        # pushes the banner off a short window.
        assert "border=1" in rendered


class TestBanner:
    def test_prints_the_url_and_token(self, capsys):
        cli._print_banner(host="127.0.0.1", port=7788, token="tok", loopback=True)
        out = capsys.readouterr().out

        assert "http://127.0.0.1:7788/" in out
        assert "tok" in out

    def test_falls_back_to_a_text_link_without_segno(self, capsys, monkeypatch):
        monkeypatch.setattr(cli, "_render_qr", lambda url: None)
        cli._print_banner(host="127.0.0.1", port=7788, token="tok", loopback=True)
        out = capsys.readouterr().out

        assert "#token=tok" in out
        # Tell the user the QR is available, but do not make it sound
        # required.
        assert "rmlx-web[qr]" in out

    def test_shows_the_qr_when_available(self, capsys, monkeypatch):
        monkeypatch.setattr(cli, "_render_qr", lambda url: "##QR##")
        cli._print_banner(host="127.0.0.1", port=7788, token="tok", loopback=True)
        out = capsys.readouterr().out

        assert "##QR##" in out
        assert "Scan" in out

    def test_warns_on_a_non_loopback_bind(self, capsys, monkeypatch):
        monkeypatch.setattr(cli, "_render_qr", lambda url: None)
        monkeypatch.setattr(cli, "_display_host", lambda host: "192.168.1.5")
        cli._print_banner(host="0.0.0.0", port=7788, token="tok", loopback=False)
        out = capsys.readouterr().out

        assert "WARNING" in out
        assert "token is the only thing protecting it" in out

    def test_no_warning_on_loopback(self, capsys, monkeypatch):
        monkeypatch.setattr(cli, "_render_qr", lambda url: None)
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

    The rule: loopback needs none, anything else always does. Getting
    this wrong in the permissive direction would put an unauthenticated
    inference endpoint on the network.
    """

    @staticmethod
    def _needs_token(*, loopback, token=None, new_token=False):
        # Mirrors the expression in main(); kept in one place so the test
        # asserts the rule rather than re-deriving it.
        return (not loopback) or bool(token) or new_token

    def test_loopback_needs_no_token(self):
        assert self._needs_token(loopback=True) is False

    def test_non_loopback_always_needs_a_token(self):
        assert self._needs_token(loopback=False) is True

    def test_an_explicit_token_opts_back_in_on_loopback(self):
        # There is still a way to have one when sharing a screen.
        assert self._needs_token(loopback=True, token="chosen") is True

    def test_rotating_opts_back_in_on_loopback(self):
        assert self._needs_token(loopback=True, new_token=True) is True

    def test_the_rule_matches_the_cli_source(self):
        # Guards against the expression in main() drifting away from the
        # rule asserted above.
        import inspect

        source = inspect.getsource(cli.main)
        assert "needs_token = (not loopback) or bool(args.token) or args.new_token" in (
            source
        )


class TestBannerWithoutToken:
    def test_says_auth_is_off_rather_than_printing_a_token(self, capsys, monkeypatch):
        monkeypatch.setattr(cli, "_render_qr", lambda url: None)
        cli._print_banner(host="127.0.0.1", port=7788, token=None, loopback=True)
        out = capsys.readouterr().out

        assert "Auth:  none" in out
        assert "Token:" not in out

    def test_the_login_url_has_no_fragment_without_a_token(self):
        assert cli._login_url("127.0.0.1", 7788, None) == "http://127.0.0.1:7788/"
        assert "#" not in cli._login_url("127.0.0.1", 7788, None)

    def test_the_qr_still_encodes_the_plain_url(self, capsys, monkeypatch):
        monkeypatch.setattr(cli, "_render_qr", lambda url: "##QR##")
        cli._print_banner(host="127.0.0.1", port=7788, token=None, loopback=True)
        out = capsys.readouterr().out

        # Still worth showing: it saves typing an IP and port on a phone.
        assert "##QR##" in out
        assert "Scan to open:" in out
