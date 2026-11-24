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
        sleep.assert_called_once_with(15)         # a short hint still waits at least 15 s

    def test_429_long_hint_is_followed(self):
        ok = FakeResponse(b"{}")
        with mock.patch("urllib.request.urlopen", side_effect=[http_error(429, retry_after=90), ok]),              mock.patch("time.sleep") as sleep:
            openmeteo._get({"a": 1})
        sleep.assert_called_once_with(90)

    def test_429_zero_hint_never_retries_instantly(self):
        ok = FakeResponse(b"{}")
        with mock.patch("urllib.request.urlopen", side_effect=[http_error(429, retry_after=0), http_error(429, retry_after=0), ok]),              mock.patch("time.sleep") as sleep:
            openmeteo._get({"a": 1})
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [15, 30])

    def test_429_without_hint_backs_off_long(self):
        ok = FakeResponse(b"{}")
        with mock.patch("urllib.request.urlopen", side_effect=[http_error(429), http_error(429), ok]), \
             mock.patch("time.sleep") as sleep:
            openmeteo._get({"a": 1})
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [30, 60])

    def test_gives_up_after_retries(self):
        with mock.patch("urllib.request.urlopen", side_effect=[http_error(429, 0)] * 6), mock.patch("time.sleep"):   # 6 attempts, then give up
            with self.assertRaises(urllib.error.HTTPError):
                openmeteo._get({"a": 1})


if __name__ == "__main__":
    unittest.main()


class KeySwitchTest(unittest.TestCase):
    def test_free_endpoint_without_key(self):
        with mock.patch.dict("os.environ", {"OPEN_METEO_API_KEY": ""}):
            base, params = openmeteo.endpoint({"latitude": 34})
        self.assertEqual(base, "https://api.open-meteo.com/v1/forecast")
        self.assertNotIn("apikey", params)

    def test_paid_endpoint_with_key(self):
        with mock.patch.dict("os.environ", {"OPEN_METEO_API_KEY": " abc123 "}):
            base, params = openmeteo.endpoint({"latitude": 34})
        self.assertEqual(base, "https://customer-api.open-meteo.com/v1/forecast")
        self.assertEqual(params, {"latitude": 34, "apikey": "abc123"})

    def test_request_goes_to_paid_host_with_key(self):
        ok = mock.MagicMock()
        ok.__enter__.return_value.read.return_value = b"{}"
        with mock.patch.dict("os.environ", {"OPEN_METEO_API_KEY": "abc123"}), \
             mock.patch("urllib.request.urlopen", return_value=ok) as urlopen:
            openmeteo._get({"latitude": 34})
        url = urlopen.call_args[0][0].full_url
        self.assertTrue(url.startswith("https://customer-api.open-meteo.com/v1/forecast?"))
        self.assertIn("apikey=abc123", url)
