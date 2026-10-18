# Automations

Queues a build for a project, or reads the results of a finished build.

## Run

```bash
cp .env.example .env   # fill in token, account ID, and project ID
npm install
npm start
```

## What it does

**Without `WEBAUTOMATE_BUILD_ID`**, it queues a build:

- Calls `POST /developer/v1/project-build/:accountId/:projectId`
- Checks `success` in the response. If the project cannot be queued (not active, already queued or running, invalid configuration, or not enough Usage Credits), the API still returns HTTP 200, with `"success": false` and the reason in `error.message`
- The response contains `data.buildRequest.id`. The example reads `GET /developer/v1/project-build-status/:accountId/:projectId/:buildRequestId` once and prints the state (`queued`, `running`, `completed`, or `dequeued`). The [ci](../ci) example polls it until the build finishes. The outcome also arrives as a `build.completed`, `build.failed`, `build.mixed`, or `build.cancelled` webhook; run the [webhooks](../webhooks) example to receive it.
- When nothing could be queued, `error.code` says why, for example `BUILD_IN_PROGRESS` or `INSUFFICIENT_USAGE_CREDITS`.

**With `WEBAUTOMATE_BUILD_ID`** (the status endpoint's `data.buildRequest.buildId`, or the webhook's `payload.requestData.buildId`), it reads results:

- Calls `GET /developer/v1/project-build-result/:accountId/:projectId/:buildId?limit=25` and follows `data.pagination.nextCursor`
- Prints the build's state and duration, how many results it has, and the first result

Builds queued through the API are charged like manual runs and appear with the vendor `manager`.

## Build states

`queue`, `running`, `success`, `failure`, `mixed`, `cancel`, `timeout`, `terminated`

## Required scopes

- `projects.run`: queue a build
- `results.read`: read build results
