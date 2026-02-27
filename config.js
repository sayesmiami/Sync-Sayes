module.exports = {
  shopify: {
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || 'atelier-docon.myshopify.com',
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
    apiVersion: '2025-01'
  },
  server: {
    port: process.env.PORT || 3000
  }
};
