import json
import os
import sys
import unittest
from unittest import mock

import requests

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "doiLookupV2"))

import doiLookup as h  # noqa: E402


def _event(query_params=None, headers=None, method="GET"):
    return {
        "headers": headers or {},
        "queryStringParameters": query_params,
        "requestContext": {"http": {"method": method}},
    }


def _mock_response(json_data=None, status_code=200, raise_exc=None):
    resp = mock.MagicMock()
    resp.status_code = status_code
    if raise_exc is not None:
        resp.raise_for_status.side_effect = raise_exc
    else:
        resp.raise_for_status.return_value = None
    resp.json.return_value = json_data
    return resp


class TestOptions(unittest.TestCase):
    def test_options_returns_200_with_cors_and_no_body(self):
        res = h.lambda_handler(_event(method="OPTIONS"))
        self.assertEqual(res["statusCode"], 200)
        self.assertNotIn("body", res)
        self.assertEqual(res["headers"]["Access-Control-Allow-Methods"], "GET,OPTIONS")
        self.assertEqual(res["headers"]["Access-Control-Allow-Origin"], "http://localhost:3000")

    def test_options_reflects_allowed_origin(self):
        res = h.lambda_handler(_event(headers={"origin": "https://groov.bio"}, method="OPTIONS"))
        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(res["headers"]["Access-Control-Allow-Origin"], "https://groov.bio")

    def test_disallowed_origin_falls_back_to_localhost(self):
        res = h.lambda_handler(_event(headers={"origin": "https://evil.example"}, method="OPTIONS"))
        self.assertEqual(res["headers"]["Access-Control-Allow-Origin"], "http://localhost:3000")


class TestMissingDoi(unittest.TestCase):
    def test_missing_query_params_returns_400(self):
        res = h.lambda_handler(_event(query_params=None))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertEqual(body["message"], "Missing required query parameter: doi")

    def test_missing_doi_key_returns_400(self):
        res = h.lambda_handler(_event(query_params={}))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertEqual(body["message"], "Missing required query parameter: doi")

    def test_empty_string_doi_returns_400(self):
        res = h.lambda_handler(_event(query_params={"doi": ""}))
        self.assertEqual(res["statusCode"], 400)

    def test_whitespace_only_doi_returns_400(self):
        res = h.lambda_handler(_event(query_params={"doi": "   "}))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertEqual(body["message"], "Missing required query parameter: doi")


class TestHappyPath(unittest.TestCase):
    def test_full_metadata_with_short_journal(self):
        csl = {
            "title": "A Great Paper",
            "author": [
                {"family": "Smith", "given": "Jane"},
                {"family": "Doe", "given": "John"},
            ],
            "issued": {"date-parts": [[2021, 5, 1]]},
            "container-title-short": "J. Great",
            "container-title": "Journal of Great Papers",
            "DOI": "10.1234/example",
            "URL": "https://doi.org/10.1234/example",
        }
        with mock.patch.object(h, "_fetch_csl", return_value=csl):
            res = h.lambda_handler(_event(query_params={"doi": "  10.1234/example  "}))

        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(res["headers"]["Content-Type"], "application/json")
        body = json.loads(res["body"])
        reference = body["reference"]
        self.assertEqual(reference["title"], "A Great Paper")
        self.assertEqual(
            reference["authors"],
            [
                {"last_name": "Smith", "first_name": "Jane"},
                {"last_name": "Doe", "first_name": "John"},
            ],
        )
        self.assertEqual(reference["year"], "2021")
        self.assertEqual(reference["journal"], "J. Great")
        self.assertEqual(reference["doi"], "10.1234/example")
        self.assertEqual(reference["url"], "https://doi.org/10.1234/example")

    def test_strips_whitespace_from_doi_before_lookup(self):
        csl = {"title": "T", "author": []}
        with mock.patch.object(h, "_fetch_csl", return_value=csl) as fetch_mock:
            h.lambda_handler(_event(query_params={"doi": "  10.1/xyz\t"}))
        fetch_mock.assert_called_once_with("10.1/xyz")

    def test_container_title_fallback_when_short_absent(self):
        csl = {
            "title": "Another Paper",
            "author": [{"family": "Lee", "given": "Amy"}],
            "container-title": "Journal of Fallbacks",
            "DOI": "10.5555/fallback",
        }
        with mock.patch.object(h, "_fetch_csl", return_value=csl):
            res = h.lambda_handler(_event(query_params={"doi": "10.5555/fallback"}))

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["reference"]["journal"], "Journal of Fallbacks")

    def test_accepts_csl_array_response(self):
        csl_array = [
            {
                "title": "Array Paper",
                "author": [{"family": "Kim", "given": "Sam"}],
                "issued": {"date-parts": [[2019]]},
                "container-title": "Array Journal",
                "DOI": "10.9/array",
                "URL": "https://doi.org/10.9/array",
            }
        ]
        with mock.patch.object(h, "_fetch_csl", return_value=csl_array):
            res = h.lambda_handler(_event(query_params={"doi": "10.9/array"}))

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["reference"]["title"], "Array Paper")
        self.assertEqual(body["reference"]["year"], "2019")

    def test_missing_author_given_family_map_to_none(self):
        csl = {
            "title": "Partial Author Info",
            "author": [{"family": "OnlyLast"}, {"given": "OnlyFirst"}],
        }
        with mock.patch.object(h, "_fetch_csl", return_value=csl):
            res = h.lambda_handler(_event(query_params={"doi": "10.1/partial"}))

        body = json.loads(res["body"])
        self.assertEqual(
            body["reference"]["authors"],
            [
                {"last_name": "OnlyLast", "first_name": None},
                {"last_name": None, "first_name": "OnlyFirst"},
            ],
        )

    def test_falls_back_to_requested_doi_when_no_resolved_doi(self):
        csl = {"title": "No DOI field", "author": []}
        with mock.patch.object(h, "_fetch_csl", return_value=csl):
            res = h.lambda_handler(_event(query_params={"doi": "10.1/requested"}))

        body = json.loads(res["body"])
        self.assertEqual(body["reference"]["doi"], "10.1/requested")
        self.assertIsNone(body["reference"]["url"])
        self.assertIsNone(body["reference"]["year"])


class TestUnresolvableDoi(unittest.TestCase):
    # _fetch_csl now goes through the retry-configured h._doi_session (which
    # transparently retries 429/5xx before surfacing a final response), so these
    # patch the session's .get rather than the bare requests module.
    def test_request_exception_returns_404(self):
        with mock.patch.object(h, "_doi_session") as session_mock:
            session_mock.get.side_effect = requests.RequestException("boom")
            res = h.lambda_handler(_event(query_params={"doi": "10.0/bad"}))

        self.assertEqual(res["statusCode"], 404)
        body = json.loads(res["body"])
        self.assertEqual(body["message"], "Could not resolve DOI: 10.0/bad")

    def test_non_200_raises_for_status_returns_404(self):
        with mock.patch.object(h, "_doi_session") as session_mock:
            session_mock.get.return_value = _mock_response(
                raise_exc=requests.HTTPError("404 Client Error")
            )
            res = h.lambda_handler(_event(query_params={"doi": "10.0/missing"}))

        self.assertEqual(res["statusCode"], 404)
        body = json.loads(res["body"])
        self.assertEqual(body["message"], "Could not resolve DOI: 10.0/missing")

    def test_unparsable_json_body_returns_404(self):
        with mock.patch.object(h, "_doi_session") as session_mock:
            resp = _mock_response()
            resp.json.side_effect = ValueError("no json")
            session_mock.get.return_value = resp
            res = h.lambda_handler(_event(query_params={"doi": "10.0/badjson"}))

        self.assertEqual(res["statusCode"], 404)


class TestEmptyMetadata(unittest.TestCase):
    def test_no_title_and_no_authors_returns_404(self):
        csl = {"issued": {"date-parts": [[2020]]}}
        with mock.patch.object(h, "_fetch_csl", return_value=csl):
            res = h.lambda_handler(_event(query_params={"doi": "10.1/empty"}))

        self.assertEqual(res["statusCode"], 404)
        body = json.loads(res["body"])
        self.assertEqual(body["message"], "No metadata found for DOI: 10.1/empty")

    def test_empty_dict_response_returns_404(self):
        with mock.patch.object(h, "_fetch_csl", return_value={}):
            res = h.lambda_handler(_event(query_params={"doi": "10.1/blank"}))

        self.assertEqual(res["statusCode"], 404)

    def test_authors_present_but_no_title_is_success(self):
        csl = {"author": [{"family": "Solo", "given": "Han"}]}
        with mock.patch.object(h, "_fetch_csl", return_value=csl):
            res = h.lambda_handler(_event(query_params={"doi": "10.1/authoronly"}))

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertIsNone(body["reference"]["title"])
        self.assertEqual(len(body["reference"]["authors"]), 1)


class TestFetchCsl(unittest.TestCase):
    def test_fetch_csl_calls_doi_org_with_negotiation_header(self):
        with mock.patch.object(h, "_doi_session") as session_mock:
            session_mock.get.return_value = _mock_response(json_data={"title": "X"})
            result = h._fetch_csl("10.1/xyz")

        session_mock.get.assert_called_once_with(
            "https://doi.org/10.1/xyz",
            headers={"Accept": "application/vnd.citationstyles.csl+json"},
            timeout=15,
            allow_redirects=True,
        )
        self.assertEqual(result, {"title": "X"})


if __name__ == "__main__":
    unittest.main()
