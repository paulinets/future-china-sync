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

// Metafield that gets written to each variant
const META_NAMESPACE    = 'shipping';
const META_KEY          = 'from_china';

// ── GraphQL helper ────────────────────────────────────────────────────────────
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

// ── Set or remove metafield on a variant ─────────────────────────────────────
async function setVariantMetafield(variantId, value) {
  await gql(`
    mutation ($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        userErrors { message field }
      }
    }
  `, {
    input: {
      id: variantId,
      metafields: [{
        namespace: META_NAMESPACE,
        key: META_KEY,
        type: 'boolean',
        value: String(value),
      }],
    },
  });
}

// ── Get inventory levels for a variant's inventory item ───────────────────────
function getLocationQty(levels, locationId) {
  return levels.find(l => l.location.id === locationId)?.quantities[0]?.quantity ?? 0;
}

// ── Sync all variants of a product ───────────────────────────────────────────
async function syncProduct(product) {
  let tagged = 0, untagged = 0, skipped = 0;

  for (const variant of product.variants.nodes) {
    const levels = variant.inventoryItem.inventoryLevels.nodes;
    const chinaQty = getLocationQty(levels, CHINA_LOCATION_ID);
    const danQty   = getLocationQty(levels, DAN_LOCATION_ID);

    // This variant ships from China only if:
    // - it has stock at Future China
    // - it has NO stock at Future Fulfilment Dan
    const shouldBeChina = chinaQty > 0 && danQty === 0;

    // Read existing metafield value
    const existing = variant.metafields?.nodes?.find(
      m => m.namespace === META_NAMESPACE && m.key === META_KEY
    );
    const currentValue = existing?.value === 'true';

    if (shouldBeChina && !currentValue) {
      await setVariantMetafield(variant.id, true);
      console.log(`  ✅ China: ${product.title} / ${variant.title} (SKU: ${variant.sku})`);
      tagged++;
    } else if (!shouldBeChina && currentValue) {
      await setVariantMetafield(variant.id, false);
      console.log(`  🔄 Not China: ${product.title} / ${variant.title} (SKU: ${variant.sku})`);
      untagged++;
    } else {
      skipped++;
    }
  }

  return { tagged, untagged, skipped };
}

// ── Fetch full product with variants + inventory ──────────────────────────────
const PRODUCT_QUERY = `
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
`;

async function getProduct(productGid) {
  const data = await gql(PRODUCT_QUERY, { id: productGid });
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
  return getProduct(productId);
}

// ── Raw body capture ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => (data += chunk));
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

// ── OAuth ─────────────────────────────────────────────────────────────────────
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

// ── Webhook verification ──────────────────────────────────────────────────────
function verifyWebhook(rawBody, hmacHeader) {
  if (!WEBHOOK_SECRET || !hmacHeader) return true;
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// ── Webhook: inventory_levels/update ─────────────────────────────────────────
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

// ── Webhook: products/update ──────────────────────────────────────────────────
app.post('/webhooks/product-update', async (req, res) => {
  if (!verifyWebhook(req.rawBody, req.headers['x-shopify-hmac-sha256'])) return res.status(401).send('Unauthorized');
  res.sendStatus(200);
  try {
    const { id } = req.body;
    if (!id) return;
    const product = await getProduct(`gid://shopify/Product/${id}`);
    if (product) await syncProduct(product);
  } catch (err) {
    console.error('Product webhook error:', err.message);
  }
});

// ── Manual full sync ──────────────────────────────────────────────────────────
app.post('/sync-all', async (req, res) => {
  if (req.headers['x-sync-secret'] !== SYNC_SECRET) return res.status(401).send('Unauthorized');
  res.send('Full sync started — check server logs');
  console.log('\n🔄 Full variant sync starting...');

  let cursor = null;
  let totalTagged = 0, totalUntagged = 0, totalSkipped = 0;

  try {
    do {
      const data = await gql(`
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
      `, { cursor });

      for (const product of data.products.nodes) {
        console.log(`\n📦 ${product.title}`);
        const result = await syncProduct(product);
        totalTagged   += result.tagged;
        totalUntagged += result.untagged;
        totalSkipped  += result.skipped;
      }

      cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (cursor);

    console.log(`\n✅ Full sync done!`);
    console.log(`   Variants set to China: ${totalTagged}`);
    console.log(`   Variants removed from China: ${totalUntagged}`);
    console.log(`   No change: ${totalSkipped}`);
  } catch (err) {
    console.error('Sync error:', err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
