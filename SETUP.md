import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP                = process.env.SHOPIFY_SHOP;
const TOKEN               = process.env.SHOPIFY_ADMIN_TOKEN;
const WEBHOOK_SECRET      = process.env.SHOPIFY_WEBHOOK_SECRET;
const SYNC_SECRET         = process.env.SYNC_SECRET;
const CLIENT_ID           = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET       = process.env.SHOPIFY_CLIENT_SECRET;
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
    }
  `, { id: `gid://shopify/InventoryItem/${inventoryItemId}` });
  return data?.inventoryItem?.variant?.product ?? null;
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
    await gql(`mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: product.id, tags: [CHINA_TAG] });
    console.log(`✅ Tagged: ${product.title}`);
  } else if (!needsTag && isTagged) {
    await gql(`mutation ($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: product.id, tags: [CHINA_TAG] });
    console.log(`🔄 Untagged: ${product.title}`);
  } else {
    console.log(`⏭️  No change: ${product.title}`);
  }
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

// ── OAuth install handler ─────────────────────────────────────────────────────
// Step 1: Shopify redirects here with ?shop=... to start OAuth
app.get('/', (req, res) => {
  const shop = req.query.shop;

  // If no shop param, just show status
  if (!shop) return res.send('Future China Sync — running ✅');

  // If we already have a token configured, show running
  if (TOKEN) return res.send('Future China Sync — running ✅');

  // Otherwise start OAuth
  const scopes = 'read_products,write_products,read_inventory';
  const redirectUri = `https://future-china-sync.onrender.com/auth/callback`;
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}`;
  res.redirect(authUrl);
});

// Step 2: Shopify sends back a code — exchange it for a token
app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
      }),
    });
    const data = await response.json();
    const accessToken = data.access_token;

    // Display the token prominently
    res.send(`
      <html>
        <body style="font-family:sans-serif;max-width:600px;margin:50px auto;padding:20px">
          <h1>✅ App Installed Successfully!</h1>
          <p>Copy this Admin API access token and add it to your Render environment variables as <strong>SHOPIFY_ADMIN_TOKEN</strong>:</p>
          <div style="background:#f0f0f0;padding:15px;border-radius:8px;word-break:break-all;font-family:monospace;font-size:14px">
            ${accessToken}
          </div>
          <p style="color:red"><strong>⚠️ Copy this now — it will not be shown again!</strong></p>
          <p>After adding it to Render, your sync server will be fully operational.</p>
        </body>
      </html>
    `);

    console.log(`\n🔑 ACCESS TOKEN FOR ${shop}:\n${accessToken}\n`);
  } catch (err) {
    res.send(`Error: ${err.message}`);
  }
});

// ── Webhook verification ──────────────────────────────────────────────────────
function verifyWebhook(rawBody, hmacHeader) {
  if (!WEBHOOK_SECRET) return true;
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// ── Webhook: inventory_levels/update ─────────────────────────────────────────
app.post('/webhooks/inventory-level-update', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyWebhook(req.rawBody, hmac)) return res.status(401).send('Unauthorized');
  res.sendStatus(200);
  try {
    const { inventory_item_id } = req.body;
    if (!inventory_item_id) return;
    console.log(`📦 Inventory update for item: ${inventory_item_id}`);
    const product = await getProductForInventoryItem(inventory_item_id);
    if (!product) return;
    await syncProductTag(product);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ── Webhook: products/update ──────────────────────────────────────────────────
app.post('/webhooks/product-update', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyWebhook(req.rawBody, hmac)) return res.status(401).send('Unauthorized');
  res.sendStatus(200);
  try {
    const { id } = req.body;
    if (!id) return;
    const data = await gql(`query ($id: ID!) { product(id: $id) { id title tags variants(first: 50) { nodes { inventoryItem { inventoryLevels(first: 10) { nodes { quantities(names: ["available"]) { quantity } location { id } } } } } } } }`, { id: `gid://shopify/Product/${id}` });
    if (data?.product) await syncProductTag(data.product);
  } catch (err) {
    console.error('Product webhook error:', err.message);
  }
});

// ── Manual full sync ──────────────────────────────────────────────────────────
app.post('/sync-all', async (req, res) => {
  if (req.headers['x-sync-secret'] !== SYNC_SECRET) return res.status(401).send('Unauthorized');
  res.send('Full sync started — check server logs');
  console.log('\n🔄 Manual full sync triggered...');
  let cursor = null, tagged = 0, untagged = 0, skipped = 0;
  try {
    do {
      const data = await gql(`query ($cursor: String) { products(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id title tags variants(first: 50) { nodes { inventoryItem { inventoryLevels(first: 10) { nodes { quantities(names: ["available"]) { quantity } location { id } } } } } } } } }`, { cursor });
      for (const product of data.products.nodes) {
        const isTagged = product.tags.includes(CHINA_TAG);
        const needsTag = shouldBeTagged(product);
        if (needsTag && !isTagged) { await gql(`mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: product.id, tags: [CHINA_TAG] }); tagged++; }
        else if (!needsTag && isTagged) { await gql(`mutation ($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: product.id, tags: [CHINA_TAG] }); untagged++; }
        else skipped++;
      }
      cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (cursor);
    console.log(`✅ Done — Tagged: ${tagged}, Untagged: ${untagged}, Skipped: ${skipped}`);
  } catch (err) {
    console.error('Sync error:', err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

