import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP                = process.env.SHOPIFY_SHOP;
const TOKEN               = process.env.SHOPIFY_ADMIN_TOKEN;
const WEBHOOK_SECRET      = process.env.SHOPIFY_WEBHOOK_SECRET;
const CHINA_LOCATION_ID   = 'gid://shopify/Location/66392490056';
const DAN_LOCATION_ID     = 'gid://shopify/Location/63623921736';
const CHINA_TAG           = 'ships-from-future-china';

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

// ── Core logic ────────────────────────────────────────────────────────────────
async function getProductForInventoryItem(inventoryItemId) {
  const data = await gql(`
    query ($id: ID!) {
      inventoryItem(id: $id) {
        variant {
          product {
            id
            title
            tags
            variants(first: 50) {
              nodes {
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
    }
  `, { id: `gid://shopify/InventoryItem/${inventoryItemId}` });
  return data?.inventoryItem?.variant?.product ?? null;
}

async function getProductById(productGid) {
  const data = await gql(`
    query ($id: ID!) {
      product(id: $id) {
        id title tags
        variants(first: 50) {
          nodes {
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

function shouldBeTagged(product) {
  return product.variants.nodes.some(variant => {
    const levels = variant.inventoryItem.inventoryLevels.nodes;
    const chinaQty = levels.find(l => l.location.id === CHINA_LOCATION_ID)?.quantities[0]?.quantity ?? 0;
    const danQty   = levels.find(l => l.location.id === DAN_LOCATION_ID)?.quantities[0]?.quantity ?? 0;
    return chinaQty > 0 && danQty === 0;
  });
}

async function syncProductTag(product) {
  const isTagged = product.tags.includes(CHINA_TAG);
  const needsTag = shouldBeTagged(product);

  if (needsTag && !isTagged) {
    await gql(`mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: product.id, tags: [CHINA_TAG] });
    console.log(`✅ Tagged: ${product.title}`);
  } else if (!needsTag && isTagged) {
    await gql(`mutation ($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: product.id, tags: [CHINA_TAG] });
    console.log(`🔄 Untagged: ${product.title}`);
  } else {
    console.log(`⏭️  No change: ${product.title}`);
  }
}

// ── Webhook verification ──────────────────────────────────────────────────────
function verifyWebhook(rawBody, hmacHeader) {
  if (!WEBHOOK_SECRET) return true; // skip in dev
  const digest = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// ── Raw body capture (needed for HMAC verification) ───────────────────────────
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => (data += chunk));
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Future China Sync — running ✅'));

// ── Webhook: inventory_levels/update ─────────────────────────────────────────
// Fires whenever stock changes at any location
app.post('/webhooks/inventory-level-update', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyWebhook(req.rawBody, hmac)) {
    return res.status(401).send('Unauthorized');
  }

  res.sendStatus(200); // Shopify needs a fast 200

  try {
    const { inventory_item_id } = req.body;
    if (!inventory_item_id) return;

    console.log(`📦 Inventory update for item: ${inventory_item_id}`);
    const product = await getProductForInventoryItem(inventory_item_id);
    if (!product) return console.log('  ↳ No product found, skipping');

    await syncProductTag(product);
  } catch (err) {
    console.error('Error handling webhook:', err.message);
  }
});

// ── Webhook: products/update ──────────────────────────────────────────────────
// Catches any other product changes (e.g. variant added)
app.post('/webhooks/product-update', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyWebhook(req.rawBody, hmac)) {
    return res.status(401).send('Unauthorized');
  }

  res.sendStatus(200);

  try {
    const { id } = req.body;
    if (!id) return;

    const product = await getProductById(`gid://shopify/Product/${id}`);
    if (!product) return;

    await syncProductTag(product);
  } catch (err) {
    console.error('Error handling product webhook:', err.message);
  }
});

// ── Manual full sync endpoint ─────────────────────────────────────────────────
app.post('/sync-all', async (req, res) => {
  const auth = req.headers['x-sync-secret'];
  if (auth !== process.env.SYNC_SECRET) return res.status(401).send('Unauthorized');

  res.send('Full sync started — check server logs');

  console.log('\n🔄 Manual full sync triggered...');
  let cursor = null;
  let tagged = 0, untagged = 0, skipped = 0;

  try {
    do {
      const data = await gql(`
        query ($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title tags
              variants(first: 50) {
                nodes {
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
        const isTagged = product.tags.includes(CHINA_TAG);
        const needsTag = shouldBeTagged(product);
        if (needsTag && !isTagged) { await gql(`mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: product.id, tags: [CHINA_TAG] }); console.log(`✅ Tagged: ${product.title}`); tagged++; }
        else if (!needsTag && isTagged) { await gql(`mutation ($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: product.id, tags: [CHINA_TAG] }); console.log(`🔄 Untagged: ${product.title}`); untagged++; }
        else skipped++;
      }

      cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (cursor);

    console.log(`\n✅ Full sync done — Tagged: ${tagged}, Untagged: ${untagged}, Skipped: ${skipped}`);
  } catch (err) {
    console.error('Full sync error:', err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
