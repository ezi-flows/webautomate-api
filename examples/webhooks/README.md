# Webhooks

A minimal webhook receiver for WebAutomate build, project, and billing events. It verifies signatures and drops duplicate deliveries.

## Run

```bash
cp .env.example .env
npm install
npm start
```

Then expose it publicly so WebAutomate can reach it:

```bash
npx ngrok http 3000
```

Register the resulting URL (`https://<id>.ngrok.io/webhook`) under **My Account → Settings → Notifications** (Project Notification Defaults) or in a project's notification settings. Set the same **Signing Secret** there as `WEBHOOK_SIGNING_SECRET` in `.env`, then click **Send Test Webhook** to receive a `notification.test` event.

## What it does

- Starts an HTTP server on `POST /webhook`
- When `WEBHOOK_SIGNING_SECRET` is set, verifies `X-WebAutomate-Signature-V2` (`t=<sentAt>,sha256=<hex HMAC-SHA256 of "<sentAt>." + raw body>`) against the raw request body, and rejects timestamps more than 5 minutes old
- Deduplicates on `eventId`, because delivery is at least once and retries keep the same `eventId`
- Replies `200` right away, since WebAutomate expects a 2xx within 10 seconds
- Handles `build.completed`, `build.failed`, `build.mixed`, `build.cancelled`, and `notification.test`, and logs every other event type

## Envelope

```json
{
  "accountId": "acc_123456",
  "eventId": "notification_event_abc",
  "eventType": "build.completed",
  "payload": {},
  "schemaVersion": 1,
  "sentAt": 1790674567000
}
```

For `build.*` events, `payload` contains `projectConfig` (credentials masked as `[REDACTED]`), `requestData` (the build record: `projectId`, `buildId`, `state`, `start`, `end`, ...), `buildEvents`, and `buildResults`. To read the full paginated results, pass `requestData.buildId` to the [automations](../automations) example as `WEBAUTOMATE_BUILD_ID`.

Other events: `build.retryExhausted`, `build.blocked`, `build.dequeued`, `project.invalid`, `project.paused`, and `billing.*`.
