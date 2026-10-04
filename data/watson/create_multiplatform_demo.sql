PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE product_offers (
  offer_id TEXT PRIMARY KEY,
  product_code TEXT NOT NULL REFERENCES products(code),
  sku_code TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  price REAL NOT NULL CHECK(price >= 0),
  currency TEXT NOT NULL DEFAULT 'HKD' CHECK(currency = 'HKD'),
  product_url TEXT NOT NULL,
  fact_source TEXT NOT NULL,
  fact_status TEXT NOT NULL CHECK(fact_status IN ('verified', 'unverified', 'mock')),
  fetched_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK(is_demo IN (0, 1)),
  UNIQUE(product_code, sku_code, platform_id)
);

CREATE INDEX idx_product_offers_product
ON product_offers(product_code);

CREATE INDEX idx_product_offers_platform
ON product_offers(platform_id, product_code);

INSERT INTO product_offers (
  offer_id, product_code, sku_code, platform_id, merchant_id, merchant_name,
  price, currency, product_url, fact_source, fact_status, fetched_at, is_demo
)
SELECT
  'watsons-offer-hk:' || p.code || ':' || COALESCE(
    json_extract(p.raw_json, '$.defaultVariantCode'),
    json_extract(p.raw_json, '$.ean'),
    p.code
  ),
  p.code,
  CAST(COALESCE(
    json_extract(p.raw_json, '$.defaultVariantCode'),
    json_extract(p.raw_json, '$.ean'),
    p.code
  ) AS TEXT),
  'watsons-hk',
  'watsons-hk',
  'Watsons Hong Kong',
  COALESCE(json_extract(p.raw_json, '$.price.value'), p.price),
  'HKD',
  CASE
    WHEN json_extract(p.raw_json, '$.url') LIKE 'http%'
      THEN json_extract(p.raw_json, '$.url')
    ELSE 'https://www.watsons.com.hk' || json_extract(p.raw_json, '$.url')
  END,
  'watsons-hk-api-snapshot',
  'verified',
  json_extract(s.metadata_json, '$.exported_at'),
  0
FROM products AS p
CROSS JOIN snapshot AS s;

WITH selected AS MATERIALIZED (
  SELECT
    p.code,
    p.category_name,
    o.sku_code,
    o.price,
    ROW_NUMBER() OVER (PARTITION BY p.category_name ORDER BY p.code) AS category_rank
  FROM products AS p
  JOIN product_offers AS o
    ON o.product_code = p.code AND o.platform_id = 'watsons-hk'
  WHERE p.category_status = 'confirmed_face_treatment'
    AND p.category_name IN ('Moisturizer', 'Toner')
),
limited AS (
  SELECT code, category_name, sku_code, price
  FROM selected
  WHERE category_rank <= 12
)
INSERT INTO product_offers (
  offer_id, product_code, sku_code, platform_id, merchant_id, merchant_name,
  price, currency, product_url, fact_source, fact_status, fetched_at, is_demo
)
SELECT
  platforms.offer_prefix || limited.code || ':' || limited.sku_code,
  limited.code,
  limited.sku_code,
  platforms.platform_id,
  platforms.platform_id,
  platforms.merchant_name,
  CASE platforms.platform_id
    WHEN 'sasa-hk' THEN ROUND(limited.price * 0.94, 2)
    ELSE ROUND(limited.price * 1.03, 2)
  END,
  'HKD',
  'https://example.invalid/demo/' || platforms.platform_id || '/' || limited.code,
  'mock-dataset',
  'mock',
  json_extract(s.metadata_json, '$.exported_at'),
  1
FROM limited
CROSS JOIN (
  SELECT 'sasa-hk' AS platform_id, 'SaSa Hong Kong (Demo)' AS merchant_name,
    'sasa-offer-hk:' AS offer_prefix
  UNION ALL
  SELECT 'mannings-hk', 'Mannings Hong Kong (Demo)', 'mannings-offer-hk:'
) AS platforms
CROSS JOIN snapshot AS s;

UPDATE snapshot
SET metadata_json = json_set(
  metadata_json,
  '$.demo_multiplatform',
  json_object(
    'is_demo_data', json('true'),
    'schema', 'products-plus-product_offers-v1',
    'selected_categories', json_array('Moisturizer', 'Toner'),
    'platforms', json_array('watsons-hk', 'sasa-hk', 'mannings-hk'),
    'copied_products_per_category_per_added_platform', 12,
    'added_demo_offer_rows', 48,
    'pricing_rule', 'sasa=watsons*0.94; mannings=watsons*1.03'
  )
);

COMMIT;
