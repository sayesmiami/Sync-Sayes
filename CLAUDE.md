# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Starting the Application
- `npm run dev` - Start server in development mode with nodemon (auto-restart on changes)
- `npm start` - Start server in production mode
- `npm install` - Install dependencies

### Testing
- No test framework configured - tests need to be set up
- Manual testing available via curl commands (see README.md)
- Health check endpoints: `/health`, `/test-bridallive`, `/test-shopify`

## Architecture Overview

This is a Node.js Express webhook server that synchronizes customer data between BridalLive and Shopify. The system consists of 5 main modules:

### Core Files
- **index.js** - Main Express server with webhook endpoint (`/webhook`), health checks, and CORS configuration
- **utils.js** - Data processing and validation using Zod schemas for BridalLive webhook payloads
- **config.js** - Environment configuration for Shopify credentials and server settings
- **bridallive-service.js** - Service class for BridalLive API integration with authentication and category management
- **shopify-service.js** - Service class for Shopify Admin API integration with customer CRUD operations

### Data Flow
1. BridalLive webhook received at `/webhook` endpoint
2. Raw webhook data processed and validated in utils.js
3. Category information fetched from BridalLive API
4. Customer looked up in Shopify by email
5. Customer created/updated with BridalLive data including phone fallback handling

### Key Features
- **Authentication**: BridalLive API uses token-based auth with automatic renewal
- **Error Handling**: Phone validation fallback - if Shopify rejects phone, retries without phone and adds to notes
- **Data Validation**: Comprehensive Zod schemas for webhook payload validation
- **Customer Sync**: Bidirectional sync with email as primary key, includes tags and notes

### Configuration
Environment variables loaded via .env file:
- `SHOPIFY_SHOP_DOMAIN` - Shopify store domain
- `SHOPIFY_ACCESS_TOKEN` - Shopify Admin API token
- `PORT` - Server port (default 3000)

### API Endpoints
- `POST /webhook` - Main BridalLive webhook receiver
- `GET /health`, `/test-bridallive`, `/test-shopify` - Health and connectivity checks
- `GET /` - API documentation endpoint

### Dependencies
- express - Web framework
- axios - HTTP client for API calls
- zod - Runtime schema validation
- @shopify/admin-api-client - Shopify API client