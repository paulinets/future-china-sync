import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP              = process.env.SHOPIFY_SHOP;
const TOKEN             = process.env.SHOPIFY_ADMIN_TOKEN;
const WEBHOOK_SECRET    = process.env.SHOPIFY_WEBHOOK_SECRET;
const SYNC_SECRET       = process.env.SYNC_SECRET;
const CLIENT_ID         = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET     = process.env.SHOPIFY_CLIENT_SECRET;
const SHIPHERO_TOKEN    = process.env.SHIPHERO_TOKEN;

const CHINA_LOCATION_ID = 'gid://shopify/Location/66392490056';
const DAN_LOCATION_ID   = 'gid://shopify/Location/63623921736';
const META_NAMESPACE    = 'shipping';
const META_KEY_CHINA    = 'from_china';
const META_KEY_PREORDER = 'preorder_dandenong';

// ── Shopify GraphQL ──────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function getQty(levels, locationId) {
  return levels.find(l => l.location.id === locationId)?.quantities[0]?.quantity ?? 0;
}

// ── ShipHero GraphQL ─────────────────────────────────────────────────────────

/**
 * Query ShipHero for a SKU's on_hand quantity and whether it has an active
 * purchase order (incoming stock). Returns { onHand, hasPO }.
 */
async function getShipHeroSkuStatus(sku) {
  if (!SHIPHERO_TOKEN || !sku) return { onHand: null, hasPO: false };

  try {
    // 1. Get on-hand quantity for this SKU
    const productRes = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SHIPHERO_TOKEN}`,
      },
      body: JSON.stringify({
        query: `
          query ($sku: String) {
            product(sku: $sku) {
              data {
                sku
                on_hand
              }
            }
          }
        `,
        variables: { sku },
      }),
    });
    const productJson = await productRes.json();
    const onHand = productJson?.data?.product?.data?.on_hand ?? null;

    // 2. Check for open purchase orders containing this SKU
    const poRes = await fetch('https://public-api.shiphero.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SHIPHERO_TOKEN}`,
      },
      body: JSON.stringify({
        query: `
          query {
            purchase_orders(status: "open") {
              data {
                edges {
                  node {
                    po_number
                    line_items {
                      edges {
                        node {
                          sku
                          quantity
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
      }),
    });
    const poJson = await poRes.json();
    const orders = poJson?.data?.purchase_orders?.data?.edges ?? [];
    const hasPO = orders.some(edge =>
      edge.node.line_items?.edges?.some(li => li.node.sku === sku && li.node.quantity > 0)
    );

    return { onHand, hasPO };
  } catch (err) {
    console.error(`ShipHero error for SKU ${sku}:`, err.message);
    return { onHand: null, hasPO: false };
  }
}

/**
 * A SKU is a Dandenong preorder when:
 *   - ShipHero on_hand <= 0 (zero or negative)
 *   - AND there is an active purchase order for it in ShipHero
 */
async function isPreorderDandenong(sku) {
  const { onHand, hasPO } = await getShipHeroSkuStatus(sku);
  if (onHand === null) return false; // couldn't determine
  return onHand <= 0 && hasPO;
}

// ── Product sync ─────────────────────────────────────────────────────────────

async function syncProduct(product) {
  const toUpdate = [];

  for (const variant of product.variants.nodes) {
    const levels   = variant.inventoryItem.inventoryLevels.nodes;
    const chinaQty = getQty(levels, CHINA_LOCATION_ID);
    const danQty   = getQty(levels, DAN_LOCATION_ID);

    // ── from_china metafield ─────────────────────────────────────────────────
    const shouldBeChina   = chinaQty > 0 && danQty === 0;
    const currentChina    = variant.metafields.nodes.find(
      m => m.namespace === META_NAMESPACE && m.key === META_KEY_CHINA
    )?.value;

    // ── preorder_dandenong metafield ─────────────────────────────────────────
    // A variant is a Dandenong preorder when danQty <= 0 AND ShipHero has a PO
    const currentPreorder = variant.metafields.nodes.find(
      m => m.namespace === META_NAMESPACE && m.key === META_KEY_PREORDER
    )?.value;

    let shouldBePreorder = false;
    if (danQty <= 0 && variant.sku) {
      shouldBePreorder = await isPreorderDandenong(variant.sku);
    }

    const metafields = [];

    if (shouldBeChina && currentChina !== 'true') {
      metafields.push({ namespace: META_NAMESPACE, key: META_KEY_CHINA, type: 'boolean', value: 'true' });
      console.log(`  ✅ SET from_china: ${product.title} / ${variant.title}`);
    } else if (!shouldBeChina && currentChina === 'true') {
      metafields.push({ namespace: META_NAMESPACE, key: META_KEY_CHINA, type: 'boolean', value: 'false' });
      console.log(`  🔄 CLEAR from_china: ${product.title} / ${variant.title}`);
    }

    if (shouldBePreorder && currentPreorder !== 'true') {
      metafields.push({ namespace: META_NAMESPACE, key: META_KEY_PREORDER, type: 'boolean', value: 'true' });
      console.log(`  🛒 SET preorder_dandenong: ${product.title} / ${variant.title} (SKU: ${variant.sku})`);
    } else if (!shouldBePreorder && currentPreorder === 'true') {
      metafields.push({ namespace: META_NAMESPACE, key: META_KEY_PREORDER, type: 'boolean', value: 'false' });
      console.log(`  🔄 CLEAR preorder_dandenong: ${product.title} / ${variant.title}`);
    }

    if (metafields.length > 0) {
      toUpdate.push({ id: variant.id, metafields });
    }
  }

  if (toUpdate.length > 0) {
    await gql(`
      mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }
    `, {
      productId: product.id,
      variants: toUpdate,
    });
  }
}

const PRODUCT_QUERY = `
  query ($cursor: String) {
    products(first: 10, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title
        variants(first: 50) {
          nodes {
            id title sku
            metafields(first: 10, namespace: "shipping") {
              nodes { namespace key value }
            }
            inventoryItem {
              inventoryLevels(first: 10) {
                nodes {
                  quantities(names: ["available"]) { quantity }
                  location { id }
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function getProductById(productGid) {
  const data = await gql(`
    query ($id: ID!) {
      product(id: $id) {
        id title
        variants(first: 50) {
          nodes {
            id title sku
            metafields(first: 10, namespace: "shipping") {
              nodes { namespace key value }
            }
            inventoryItem {
              inventoryLevels(first: 10) {
                nodes {
                  quantities(names: ["available"]) { quantity }
                  location { id }
                }
              }
            }
          }
        }
      }
    }
  `, { id: productGid });
  return data?.product ?? null;
}

async function getProductForInventoryItem(inventoryItemId) {
  const data = await gql(`
    query ($id: ID!) {
      inventoryItem(id: $id) {
        variant { product { id } }
      }
    }
  `, { id: `gid://shopify/InventoryItem/${inventoryItemId}` });
  const productId = data?.inventoryItem?.variant?.product?.id;
  if (!productId) return null;
  return getProductById(productId);
}

// ── Middleware ───────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => (data += chunk));
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.send('Future China Sync — running ✅');
  if (TOKEN) return res.send('Future China Sync — running ✅');
  const scopes = 'read_products,write_products,read_inventory';
  const redirectUri = `https://future-china-sync.onrender.com/auth/callback`;
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}`);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });
    const data = await response.json();
    res.send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:50px auto;padding:20px">
        <h1>✅ App Installed!</h1>
        <p>Add this as <strong>SHOPIFY_ADMIN_TOKEN</strong> in Render:</p>
        <div style="background:#f0f0f0;padding:15px;border-radius:8px;word-break:break-all;font-family:monospace">${data.access_token}</div>
        <p style="color:red"><strong>⚠️ Copy this now — it will not be shown again!</strong></p>
      </body></html>
    `);
    console.log(`\n🔑 ACCESS TOKEN: ${data.access_token}\n`);
  } catch (err) {
    res.send(`Error: ${err.message}`);
  }
});

function verifyWebhook(rawBody, hmacHeader) {
  if (!WEBHOOK_SECRET || !hmacHeader) return true;
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

app.post('/webhooks/inventory-level-update', async (req, res) => {
  if (!verifyWebhook(req.rawBody, req.headers['x-shopify-hmac-sha256'])) return res.status(401).send('Unauthorized');
  res.sendStatus(200);
  try {
    const { inventory_item_id } = req.body;
    if (!inventory_item_id) return;
    console.log(`📦 Inventory update: ${inventory_item_id}`);
    const product = await getProductForInventoryItem(inventory_item_id);
    if (product) await syncProduct(product);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

app.post('/webhooks/product-update', async (req, res) => {
  if (!verifyWebhook(req.rawBody, req.headers['x-shopify-hmac-sha256'])) return res.status(401).send('Unauthorized');
  res.sendStatus(200);
  try {
    const { id } = req.body;
    if (!id) return;
    const product = await getProductById(`gid://shopify/Product/${id}`);
    if (product) await syncProduct(product);
  } catch (err) {
    console.error('Product webhook error:', err.message);
  }
});

app.post('/sync-all', async (req, res) => {
  if (req.headers['x-sync-secret'] !== SYNC_SECRET) return res.status(401).send('Unauthorized');
  res.send('Full sync started — check server logs');
  console.log('\n🔄 Full sync starting...');
  let cursor = null;

  try {
    do {
      const data = await gql(PRODUCT_QUERY, { cursor });
      for (const product of data.products.nodes) {
        await syncProduct(product);
      }
      cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (cursor);
    console.log(`\n✅ Full sync done!`);
  } catch (err) {
    console.error('Sync error:', err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
