# Competition Discovery Worker

Cloudflare Worker that monitors CompeteHub.dev for new competitions and sends Telegram notifications.

## Architecture

**PRODUCTION ONLY** - This project has no local development environment. All operations are performed directly on Cloudflare's production infrastructure.

## Deployment

```bash
npm run deploy
```

This deploys directly to production. There is no staging or local environment.

## Monitoring

View real-time logs:
```bash
wrangler tail --format pretty
```

View recent deployments:
```bash
wrangler deployments list
```

## Configuration

All configuration is in `wrangler.toml` and Cloudflare dashboard:

- **KV Namespace**: `COMPETITION_KV` (ID: 7fee0107eb3746e9b595888b802b9a9b)
- **Cron Schedule**: Every hour (`0 * * * *`)
- **Secrets** (set via Cloudflare dashboard):
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`

## How It Works

1. **Scheduled Trigger**: Runs every hour via cron
2. **Fetch**: Downloads CompeteHub competitions page
3. **Extract**: Parses React Server Components (RSC) data
4. **Filter**: Checks KV store for previously seen competitions
5. **Notify**: Sends Telegram message for new competitions
6. **Store**: Marks competitions as seen in KV (90-day TTL)

## Logs

The worker logs detailed information at each step:

- `=== Workflow started ===` - Beginning of execution
- `Fetched HTML with length: X` - HTML download complete
- `Extracted X competitions from Y iterations` - Parsing complete
- `New competitions found: X` - Filter results
- `New competition: ID - Title` - Each new competition
- `Successfully notified X competitions via Telegram` - Notification sent
- `=== Workflow completed ===` - End of execution

### Error Logs

- `CRITICAL: No RSC chunk found` - Website structure changed
- `CRITICAL: No competitions extracted` - Parsing failed
- `CRITICAL: KV binding missing` - Configuration error
- `extractJsonBlock returned null` - JSON parsing issue
- `Telegram notification error` - Notification failed

## Troubleshooting

If no notifications are received:

1. Check logs: `wrangler tail --format pretty`
2. Look for `CRITICAL` errors
3. Verify `fetched` count is > 0
4. Check `newItems` count
5. Verify Telegram credentials are set

## KV Data Structure

```
Key: seen:{competition_id}
Value: {"id": "...", "storedAt": "2025-11-12T00:00:00.000Z"}
TTL: 90 days
```

## No Local Development

This project intentionally has no local development setup:
- No `wrangler dev`
- No local KV
- No test environment
- All changes deploy directly to production

This ensures:
- No environment drift
- No local state pollution
- Single source of truth
- Simplified operations

