# Future China Sync Server — Setup Guide

This server runs 24/7 and auto-tags products whenever inventory changes at Future China.

---

## Step 1 — Deploy to Render (free, 5 mins)

1. Go to https://render.com and sign up (free)
2. Click **New → Web Service**
3. Connect your GitHub account and push this folder as a repo, OR choose **"Deploy from existing repo"**
   - Alternatively: click **New → Web Service → Deploy manually** and upload the files
4. Set these environment variables in Render's dashboard:

| Key | Value |
|---|---|
| `SHOPIFY_SHOP` | `your-store.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | Your Admin API token (see below) |
| `SHOPIFY_WEBHOOK_SECRET` | Get this in Step 3 |
| `SYNC_SECRET` | Any random string you choose (e.g. `mysecret123`) |

5. Click **Deploy** — Render will give you a URL like `https://future-china-sync.onrender.com`

---

## Step 2 — Get your Shopify Admin Token

1. Shopify Admin → **Settings → Apps and sales channels**
2. Click **Develop apps** → **Create an app** (name it "Future China Sync")
3. Go to **Configuration** → enable these API scopes:
   - `read_products`
   - `write_products`
   - `read_inventory`
4. Click **Install app** → copy the **Admin API access token**

---

## Step 3 — Register Shopify Webhooks

In Shopify Admin → **Settings → Notifications → Webhooks**, add two webhooks:

| Event | URL |
|---|---|
| Inventory levels / Update | `https://your-render-url.onrender.com/webhooks/inventory-level-update` |
| Products / Update | `https://your-render-url.onrender.com/webhooks/product-update` |

Copy the **webhook signing secret** shown and add it as `SHOPIFY_WEBHOOK_SECRET` in Render.

---

## Step 4 — Run initial full sync

Once deployed, trigger a one-time sync of all existing products:

```bash
curl -X POST https://your-render-url.onrender.com/sync-all \
  -H "x-sync-secret: your-SYNC_SECRET-value"
```

---

## How it works

From this point on, everything is automatic:

1. Stock arrives at Future China → Shopify fires `inventory_levels/update` webhook
2. Server checks: does this product have China stock AND no Dan stock?
3. If yes → adds tag `ships-from-future-china`
4. If no longer qualifies → removes the tag
5. Checkout UI Extension reads the tag → shows the shipping notice

---

## Checkout UI Extension

Add this to your Shopify app (requires Shopify Plus + Shopify CLI):

**shopify.extension.toml**
```toml
api_version = "2025-10"

[[extensions]]
name = "international-shipping-notice"
handle = "international-shipping-notice"
type = "ui_extension"

[[extensions.targeting]]
target = "purchase.checkout.cart-line-item.render-after"
module = "./src/Checkout.jsx"
```

**src/Checkout.jsx**
```jsx
import '@shopify/ui-extensions/preact';
import { render } from 'preact';

export default function () {
  render(<Extension />, document.body);
}

function Extension() {
  const line = shopify.target.value;
  const tags = line?.merchandise?.product?.tags ?? [];

  if (!tags.includes('ships-from-future-china')) return null;

  return (
    <s-banner tone="info">
      🌏 This item will be shipped from our international warehouse.
      Shipping time: 5–7 business days.
    </s-banner>
  );
}
```
