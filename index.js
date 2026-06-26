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
const CHINA_LOCATION_ID = 'gid://shopify/Location/66392490056';
const DAN_LOCATION_ID   = 'gid://shopify/Location/63623921736';
const META_NAMESPACE    = 'shipping';
const META_KEY          = 'from_china';

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

async function syncProduct(product) {
  const toUpdate = [];

  for (const variant of product.variants.nodes) {
    const levels = variant.inventoryItem.inventoryLevels.nodes;
    const chinaQty = getQty(levels, CHINA_LOCATION_ID);
    const danQty   = getQty(levels, DAN_LOCATION_ID);
    const shouldBeChina = chinaQty > 0 && danQty === 0;
    const currentValue = variant.metafields.nodes.find(
      m => m.namespace === META_NAMESPACE && m.key === META_KEY
    )?.value;

    if (shouldBeChina && currentValue !== 'true') {
      toUpdate.push({ id: variant.id, value: 'true' });
      console.log(`  ✅ SET: ${product.title} / ${variant.title}`);
    } else if (!shouldBeChina && currentValue === 'true') {
      toUpdate.push({ id: variant.id, value: 'false' });
      console.log(`  🔄 CLEAR: ${product.title} / ${variant.title}`);
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
      variants: toUpdate.map(v => ({
        id: v.id,
        metafields: [{ namespace: META_NAMESPACE, key: META_KEY, type: 'boolean', value: v.value }]
      }))
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

app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => (data += chunk));
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

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
  let totalSet = 0, totalCleared = 0;

  try {
    do {
      const data = await gql(PRODUCT_QUERY, { cursor });
      for (const product of data.products.nodes) {
        const before = { set: totalSet, cleared: totalCleared };
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

