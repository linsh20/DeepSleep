import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError

import crawl


def page(product, number=0, pages=1, total=1):
    return {
        "products": [product],
        "currentQuery": {"query": {"value": ":bestSeller:category:010200"}},
        "pagination": {"currentPage": number, "pageSize": 32,
                       "totalPages": pages, "totalResults": total},
        "unknown_page_field": {"keep": [0, False, None]},
    }


PRODUCT = {"code": "A", "name": "Serum", "price": {"value": 100},
           "elabIngredients": "Source ingredient text", "new_unknown_field": {
               "empty": [], "flag": False, "zero": 0, "null": None,
               "nested": [{"x": "中文"}]} }


class Tests(unittest.TestCase):
    def snapshot(self, root, payload):
        crawl.save_json(root / "raw" / "page_000.json", payload)
        crawl.save_json(root / "manifest.json", {
            "category": "010200", "page_size": 32, "pages": {},
        })

    def test_all_fields_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.snapshot(root, page(PRODUCT))
            crawl.export_snapshot(root, crawl.read_json(root / "manifest.json"))
            self.assertEqual(crawl.read_json(root / "products.json"), [PRODUCT])
            with sqlite3.connect(root / "products.db") as db:
                self.assertEqual(json.loads(db.execute("SELECT raw_json FROM products").fetchone()[0]), PRODUCT)
            self.assertEqual(crawl.read_json(root / "raw" / "page_000.json"), page(PRODUCT))

    def test_database_connection_closed_before_replace(self):
        real_connect = sqlite3.connect
        state = {"closed": False}

        class TrackedConnection:
            def __init__(self, path):
                self.connection = real_connect(path)

            def __getattr__(self, name):
                return getattr(self.connection, name)

            def close(self):
                self.connection.close()
                state["closed"] = True

        original_replace = Path.replace

        def checked_replace(path, target):
            self.assertTrue(state["closed"], "SQLite connection must be closed before rename")
            return original_replace(path, target)

        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "products.db"
            with patch("crawl.sqlite3.connect", side_effect=TrackedConnection), \
                    patch("crawl.Path.replace", new=checked_replace):
                crawl.build_database(target, [PRODUCT], {})
            self.assertTrue(target.exists())

    def test_missing_page_refuses_export(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.snapshot(root, page(PRODUCT, pages=2, total=2))
            with self.assertRaises(crawl.CrawlError):
                crawl.export_snapshot(root, {})
            self.assertFalse((root / "products.json").exists())

    def test_false_and_zero_are_nonempty(self):
        report = crawl.field_report([{"flag": False, "zero": 0, "null": None}])
        self.assertEqual(report["fields"]["flag"]["nonempty_count"], 1)
        self.assertEqual(report["fields"]["zero"]["nonempty_count"], 1)
        self.assertEqual(report["fields"]["null"]["nonempty_count"], 0)

    def test_category_annotation_does_not_drop_product(self):
        self.assertEqual(crawl.category_status(PRODUCT), "review_category_mismatch_or_missing")
        p = {**PRODUCT, "categoryNameLevels": [{"code": "010200", "name": "Face Treatment"}]}
        self.assertEqual(crawl.category_status(p), "confirmed_face_treatment")

    def test_wrong_category_refused(self):
        payload = page(PRODUCT)
        payload["currentQuery"]["query"]["value"] = ":bestSeller:category:310000"
        with self.assertRaises(crawl.CrawlError):
            crawl.validate_page(payload, 0)

    def test_access_block_stops_without_retries(self):
        error = HTTPError("https://example.invalid", 403, "Forbidden", {}, None)
        with patch("crawl.urlopen", side_effect=error) as request:
            with self.assertRaises(crawl.CrawlError):
                crawl.request_page(0, 1, 3)
        self.assertEqual(request.call_count, 1)

    def test_changed_pagination_refuses_export(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.snapshot(root, page(PRODUCT, pages=2, total=2))
            crawl.save_json(root / "raw" / "page_001.json",
                            page({**PRODUCT, "code": "B"}, number=1, pages=2, total=3))
            with self.assertRaises(crawl.CrawlError):
                crawl.export_snapshot(root, {})

    def test_duplicate_occurrences_preserved_in_raw(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.snapshot(root, page(PRODUCT, pages=2, total=2))
            crawl.save_json(root / "raw" / "page_001.json",
                            page(PRODUCT, number=1, pages=2, total=2))
            result = crawl.export_snapshot(root, {})
            self.assertEqual(result["received_records"], 2)
            self.assertEqual(result["unique_products"], 1)
            self.assertEqual(result["duplicate_occurrences"], 1)
            self.assertEqual(result["product_source_pages"]["A"], [0, 1])

    def test_offline_never_requests_network(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.snapshot(root, page(PRODUCT))
            with patch("crawl.request_page", side_effect=AssertionError("network")):
                result = crawl.run(SimpleNamespace(run_dir=root, offline=True))
            self.assertEqual(result["unique_products"], 1)

    def test_new_run_is_online_and_preserves_failed_status(self):
        with tempfile.TemporaryDirectory() as td:
            args = SimpleNamespace(run_dir=None, offline=False, output=Path(td),
                                   timeout=1, retries=1, delay=0)
            with patch("crawl.request_page", side_effect=crawl.CrawlError("blocked")) as request:
                with self.assertRaises(crawl.CrawlError):
                    crawl.run(args)
                request.assert_called_once()
            manifests = list(Path(td).glob("*/manifest.json"))
            self.assertEqual(len(manifests), 1)
            self.assertEqual(crawl.read_json(manifests[0])["status"], "failed")

    def test_partial_snapshot_resumes_without_refetching_first_page(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.snapshot(root, page(PRODUCT, pages=2, total=2))
            other = {**PRODUCT, "code": "B"}
            response = json.dumps(page(other, number=1, pages=2, total=2)).encode()
            args = SimpleNamespace(run_dir=root, offline=False, timeout=1, retries=1, delay=0)
            with patch("crawl.request_page", return_value=(response, {})) as request:
                result = crawl.run(args)
            request.assert_called_once_with(1, 1, 1)
            self.assertEqual(result["unique_products"], 2)


if __name__ == "__main__":
    unittest.main()
