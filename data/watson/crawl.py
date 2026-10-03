"""Watsons HK Face Treatment: snapshot every API field without normalization.

Python 3.10+, standard library only. Default is a fresh online crawl.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import time
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
API = "https://api.watsons.com.hk/api/v2/wtchk/products/search"
CATEGORY = "010200"
PAGE_SIZE = 32


class CrawlError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(message: str) -> None:
    print(message, flush=True)


def save_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_bytes(data)
    temp.replace(path)


def save_json(path: Path, data: Any) -> None:
    save_bytes(path, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))


def read_json(path: Path) -> Any:
    return json.loads(path.read_bytes())


def page_url(page: int) -> str:
    return API + "?" + urlencode({
        "fields": "FULL", "query": f":bestSeller:category:{CATEGORY}",
        "currentPage": page, "pageSize": PAGE_SIZE,
        "lang": "en_HK", "curr": "HKD",
    })


def validate_page(payload: Any, page: int) -> None:
    if not isinstance(payload, dict) or not isinstance(payload.get("products"), list):
        raise CrawlError(f"Page {page + 1}: response is not a product JSON page")
    pagination = payload.get("pagination") or {}
    if pagination.get("currentPage") != page or pagination.get("pageSize") != PAGE_SIZE:
        raise CrawlError(f"Page {page + 1}: unexpected pagination: {pagination}")
    query = ((payload.get("currentQuery") or {}).get("query") or {}).get("value", "")
    if f":category:{CATEGORY}" not in query:
        raise CrawlError(f"Page {page + 1}: response is not the requested category")
    if not isinstance(pagination.get("totalPages"), int) or pagination["totalPages"] < 1:
        raise CrawlError("Missing or invalid totalPages; refusing an incomplete export")
    if not isinstance(pagination.get("totalResults"), int) or pagination["totalResults"] < 1:
        raise CrawlError("Empty category or invalid totalResults; previous data stays intact")
    if not all(isinstance(p, dict) and p.get("code") for p in payload["products"]):
        raise CrawlError(f"Page {page + 1}: product object is invalid or lacks code")


def request_page(page: int, timeout: float, retries: int) -> tuple[bytes, dict]:
    for attempt in range(retries):
        try:
            request = Request(page_url(page), headers={
                "Accept": "application/json",
                "Accept-Language": "en-HK,en;q=0.9",
                "User-Agent": "WatsonsHackathonDataCollector/1.0",
            })
            with urlopen(request, timeout=timeout) as response:
                data = response.read()
                response_meta = {
                    "status": response.status,
                    "content_type": response.headers.get("Content-Type"),
                    "etag": response.headers.get("ETag"),
                    "last_modified": response.headers.get("Last-Modified"),
                    "final_url": response.geturl(),
                    "fetched_at": now(),
                }
            validate_page(json.loads(data), page)
            return data, response_meta
        except HTTPError as exc:
            # Explicit access restrictions / rate limits are stop conditions.
            if exc.code in (401, 403, 429):
                raise CrawlError(
                    f"HTTP {exc.code}: access blocked or rate limited. Stop; "
                    "do not bypass the restriction. Completed pages are retained."
                ) from exc
            if exc.code < 500 or attempt + 1 == retries:
                raise CrawlError(f"Page {page + 1}: HTTP {exc.code}") from exc
            error = exc
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            if attempt + 1 == retries:
                raise CrawlError(f"Page {page + 1}: request failed: {exc}") from exc
            error = exc
        delay = min(2 ** attempt, 8)
        log(f"  Retry {attempt + 2}/{retries} in {delay}s: {error}")
        time.sleep(delay)
    raise CrawlError("Unreachable retry state")


def category_status(product: dict) -> str:
    """Annotate, never delete, records whose breadcrumb disagrees with the feed."""
    rows = product.get("categoryNameLevels") or []
    codes = {str(row.get("code", "")) for row in rows if isinstance(row, dict)}
    names = [row.get("name") for row in rows if isinstance(row, dict)]
    if CATEGORY in codes or "Face Treatment" in names:
        return "confirmed_face_treatment"
    if names[:2] == ["Skin Care", "Skin Care"]:
        return "generic_skincare_in_face_treatment_feed"
    return "review_category_mismatch_or_missing"


def field_report(products: list[dict]) -> dict:
    stats: dict[str, dict] = {}
    for product in products:
        for key, value in product.items():
            row = stats.setdefault(key, {"present_count": 0, "nonempty_count": 0, "types": Counter()})
            row["present_count"] += 1
            # False and 0 are valid values, not missing data.
            if value is not None and value != "" and value != [] and value != {}:
                row["nonempty_count"] += 1
            row["types"][type(value).__name__] += 1
    return {
        "product_count": len(products), "top_level_field_count": len(stats),
        "note": "All nested objects/arrays are preserved. Nonempty is not evidence of a complete INCI list or verified efficacy.",
        "fields": {
            key: {**row, "types": dict(row["types"]),
                  "present_percent": round(100 * row["present_count"] / len(products), 2),
                  "nonempty_percent": round(100 * row["nonempty_count"] / len(products), 2)}
            for key, row in sorted(stats.items())
        },
    }


def build_database(path: Path, products: list[dict], manifest: dict) -> None:
    temp = path.with_name(path.name + ".tmp")
    # sqlite3.Connection's context manager commits/rolls back but does NOT
    # close the connection. Windows forbids renaming an open database file,
    # so close it explicitly before the atomic replace below.
    db = sqlite3.connect(temp)
    try:
        db.execute("DROP TABLE IF EXISTS products")
        db.execute("DROP TABLE IF EXISTS snapshot")
        db.execute("""CREATE TABLE products (
            code TEXT PRIMARY KEY, name TEXT, brand TEXT, price REAL,
            ingredients TEXT, category_status TEXT NOT NULL,
            raw_json TEXT NOT NULL
        )""")
        db.execute("CREATE INDEX idx_products_price ON products(price)")
        db.execute("CREATE TABLE snapshot (metadata_json TEXT NOT NULL)")
        for product in products:
            brand = product.get("masterBrand") or {}
            price = product.get("price") or {}
            db.execute("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?)", (
                str(product["code"]), product.get("name"), brand.get("name"),
                price.get("value"), product.get("elabIngredients"),
                category_status(product), json.dumps(product, ensure_ascii=False),
            ))
        db.execute("INSERT INTO snapshot VALUES (?)", (json.dumps(manifest, ensure_ascii=False),))
        # Round-trip verification checks all nested fields, not just row counts.
        restored = {code: json.loads(raw) for code, raw in db.execute("SELECT code, raw_json FROM products")}
        if restored != {str(p["code"]): p for p in products}:
            raise CrawlError("SQLite round-trip verification failed")
        db.commit()
    finally:
        db.close()
    try:
        temp.replace(path)
    except PermissionError as exc:
        raise CrawlError(
            f"Cannot replace {path.name}: close DB Browser, VS Code database "
            "preview, Excel, antivirus scan, or any program using the file, "
            "then resume the same --run-dir"
        ) from exc


def export_snapshot(run_dir: Path, manifest: dict) -> dict:
    first = read_json(run_dir / "raw" / "page_000.json")
    validate_page(first, 0)
    expected = first["pagination"]
    products_by_code: dict[str, dict] = {}
    source_pages = defaultdict(list)
    duplicate_occurrences = 0
    records = 0
    for page in range(expected["totalPages"]):
        path = run_dir / "raw" / f"page_{page:03d}.json"
        if not path.exists():
            raise CrawlError(f"Missing page {page + 1}; cannot export a complete snapshot")
        raw = path.read_bytes()
        payload = json.loads(raw)
        validate_page(payload, page)
        if (payload["pagination"]["totalResults"], payload["pagination"]["totalPages"]) != (
            expected["totalResults"], expected["totalPages"]
        ):
            raise CrawlError("Pagination totals changed during crawl; start a fresh run")
        page_meta = manifest.get("pages", {}).get(str(page), {})
        if page_meta.get("sha256") and page_meta["sha256"] != hashlib.sha256(raw).hexdigest():
            raise CrawlError(f"Page {page + 1}: saved response checksum mismatch")
        for product in payload["products"]:
            records += 1
            code = str(product["code"])
            if code in products_by_code:
                duplicate_occurrences += 1
            products_by_code[code] = product
            source_pages[code].append(page)
    if records != expected["totalResults"]:
        raise CrawlError(f"Received {records} records but API reports {expected['totalResults']}; incomplete snapshot")
    products = list(products_by_code.values())
    # The full feed remains the canonical output. Optional strict view is separate.
    confirmed = [p for p in products if category_status(p) == "confirmed_face_treatment"]
    review = [{"code": p["code"], "name": p.get("name"),
               "category_path": p.get("categoryNameLevels"),
               "status": category_status(p)} for p in products
              if category_status(p) != "confirmed_face_treatment"]
    report = field_report(products)
    export_meta = {
        **manifest, "status": "complete", "exported_at": now(),
        "reported_total": expected["totalResults"], "received_records": records,
        "unique_products": len(products), "duplicate_occurrences": duplicate_occurrences,
        "confirmed_category_products": len(confirmed),
        "category_status_counts": dict(Counter(category_status(p) for p in products)),
        "top_level_field_count": report["top_level_field_count"],
        "product_source_pages": dict(source_pages),
        "note": "All products returned by category 010200 are kept. No fixed 351 count. Duplicate occurrences remain in raw page responses.",
    }
    save_json(run_dir / "products.json", products)
    save_json(run_dir / "products_confirmed_category.json", confirmed)
    save_json(run_dir / "category_review.json", review)
    save_json(run_dir / "fields.json", report)
    build_database(run_dir / "products.db", products, export_meta)
    save_json(run_dir / "manifest.json", export_meta)
    log(f"DONE: {len(products)} unique records; {report['top_level_field_count']} top-level fields")
    log(f"Category-confirmed: {len(confirmed)}; remaining records annotated, not deleted")
    log(f"Output: {run_dir}")
    return export_meta


def run(args: argparse.Namespace) -> dict:
    if args.run_dir:
        run_dir = args.run_dir.resolve()
        if not run_dir.is_dir() or not (run_dir / "manifest.json").exists():
            raise CrawlError("--run-dir must point to an existing snapshot with manifest.json")
        manifest = read_json(run_dir / "manifest.json")
        if manifest.get("category") != CATEGORY or manifest.get("page_size") != PAGE_SIZE:
            raise CrawlError("Snapshot configuration does not match this crawler")
    else:
        if args.offline:
            raise CrawlError("--offline requires --run-dir; online failure never silently uses old data")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        run_dir = args.output.resolve() / f"{stamp}_{uuid.uuid4().hex[:8]}"
        run_dir.mkdir(parents=True, exist_ok=False)
        manifest = {
            "category": CATEGORY, "category_name": "Face Treatment",
            "page_size": PAGE_SIZE, "language": "en_HK", "currency": "HKD",
            "source_api": API, "started_at": now(), "status": "in_progress", "pages": {},
        }
        save_json(run_dir / "manifest.json", manifest)
    log(f"Mode: {'OFFLINE (no network)' if args.offline else 'ONLINE'}")
    log(f"Snapshot: {run_dir}")
    if args.offline:
        return export_snapshot(run_dir, manifest)
    manifest["status"] = "in_progress"
    manifest.pop("error", None)
    save_json(run_dir / "manifest.json", manifest)
    try:
        page, total_pages = 0, 1
        while page < total_pages:
            path = run_dir / "raw" / f"page_{page:03d}.json"
            if path.exists():
                log(f"Page {page + 1}: resume saved response")
                payload = read_json(path)
                validate_page(payload, page)
                meta = manifest.get("pages", {}).get(str(page), {})
                if meta.get("sha256") and meta["sha256"] != hashlib.sha256(path.read_bytes()).hexdigest():
                    raise CrawlError(f"Page {page + 1}: checksum mismatch")
            else:
                log(f"Page {page + 1}/{total_pages}: downloading (timeout {args.timeout}s)...")
                raw, meta = request_page(page, args.timeout, args.retries)
                payload = json.loads(raw)
                save_bytes(path, raw)
                manifest.setdefault("pages", {})[str(page)] = {
                    **meta, "url": page_url(page),
                    "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                }
                save_json(run_dir / "manifest.json", manifest)
                log(f"Page {page + 1}: saved {len(payload['products'])} records")
                if args.delay:
                    time.sleep(args.delay)
            if page == 0:
                total_pages = payload["pagination"]["totalPages"]
                log(f"API reports {payload['pagination']['totalResults']} records / {total_pages} pages")
            page += 1
        return export_snapshot(run_dir, manifest)
    except (Exception, KeyboardInterrupt) as exc:
        manifest.update(status="failed", error=f"{type(exc).__name__}: {exc}", failed_at=now())
        save_json(run_dir / "manifest.json", manifest)
        log(f"Stopped; completed raw pages preserved. Resume with --run-dir \"{run_dir}\"")
        raise


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", type=Path, default=ROOT / "data", help="parent folder for new snapshots")
    p.add_argument("--run-dir", type=Path, help="resume or export an existing snapshot")
    p.add_argument("--offline", action="store_true", help="export saved raw pages only; never use network")
    p.add_argument("--timeout", type=float, default=30, help="network socket timeout in seconds")
    p.add_argument("--retries", type=int, default=3, help="maximum attempts per page")
    p.add_argument("--delay", type=float, default=1, help="delay after each successful download")
    return p


if __name__ == "__main__":
    args = parser().parse_args()
    if args.timeout <= 0 or args.retries < 1 or args.delay < 0:
        raise SystemExit("timeout > 0, retries >= 1 and delay >= 0 are required")
    try:
        run(args)
    except (Exception, KeyboardInterrupt) as exc:
        log(f"ERROR: {type(exc).__name__}: {exc}")
        sys.exit(1)
