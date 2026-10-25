# Automations

Queues a build for a project, checks its status, and reads the results of a finished build. Each step is its own command.

## Run

```bash
cp .env.example .env   # fill in token, account ID, and project ID
npm install
npm run queue                      # queue a build, prints its build request ID
npm run status -- <buildRequestId> # prints the state and, once the build started, its build ID
npm run results -- <buildId>       # reads every result of the finished build
```

`npm start` without a command prints this usage.

## What it does

**`queue`** queues a build:

- Calls `POST /developer/v1/project-build/:accountId/:projectId`
- Checks `success` in the response. If the project cannot be queued (not active, already queued or running, invalid configuration, or not enough Usage Credits), the API still returns HTTP 200, with `"success": false` and the reason in `error.message`. `error.code` says why, for example `BUILD_IN_PROGRESS` or `INSUFFICIENT_USAGE_CREDITS`.
- Prints the build request ID (`data.buildRequest.id`)

**`status <buildRequestId>`** checks the build request:

- Calls `GET /developer/v1/project-build-status/:accountId/:projectId/:buildRequestId`
- Prints the state (`queued`, `running`, `completed`, or `dequeued`) and, once the build has started, its build ID (`data.buildRequest.buildId`)
- The [ci](../ci) example polls this endpoint until the build finishes. The outcome also arrives as a `build.completed`, `build.failed`, `build.mixed`, or `build.cancelled` webhook; run the [webhooks](../webhooks) example to receive it.

**`results <buildId>`** reads the results:

- Takes the build ID from `status`, or from a webhook's `payload.requestData.buildId`. It is not the build request ID.
- Calls `GET /developer/v1/project-build-result/:accountId/:projectId/:buildId?limit=25` and follows `data.pagination.nextCursor`
- Prints the build's state and duration, how many results it has, and the first result

Builds queued through the API are charged like manual runs and appear with the vendor `manager`.

## Build states

`queue`, `running`, `success`, `failure`, `mixed`, `cancel`, `timeout`, `terminated`

## Required scopes

- `projects.run`: queue a build
- `results.read`: read the build's status (`status`) and results (`results`)
