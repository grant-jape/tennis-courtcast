import io
import json
import unittest
import urllib.error
from email.message import Message
from unittest import mock

from courtcast import openmeteo


def http_error(code, retry_after=None):
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("https://api.open-meteo.com", code, "err", headers, io.BytesIO(b""))


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestRateLimitRetry(unittest.TestCase):
    def test_429_waits_then_succeeds(self):
        ok = FakeResponse(json.dumps({"hourly": {}}).encode())
        with mock.patch("urllib.request.urlopen", side_effect=[http_error(429, retry_after=7), ok]) as urlopen, \
             mock.patch("time.sleep") as sleep:
            self.assertEqual(openmeteo._get({"a": 1}), {"hourly": {}})
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(7)          # follows the server's Retry-After hint

    def test_429_without_hint_backs_off_long(self):
        ok = FakeResponse(b"{}")
        with mock.patch("urllib.request.urlopen", side_effect=[http_error(429), http_error(429), ok]), \
             mock.patch("time.sleep") as sleep:
            openmeteo._get({"a": 1})
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [30, 60])

    def test_gives_up_after_retries(self):
        with mock.patch("urllib.request.urlopen", side_effect=[http_error(429, 0)] * 5), mock.patch("time.sleep"):
            with self.assertRaises(urllib.error.HTTPError):
                openmeteo._get({"a": 1})


if __name__ == "__main__":
    unittest.main()
