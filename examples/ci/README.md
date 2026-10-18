# CI/CD

Runs a WebAutomate project build from a pipeline, waits for its outcome, and fails the job unless it passes. The runner `webautomate-run.mjs` is a single file without dependencies (Node.js 18+). The GitHub Action and the Jenkins example both use it.

## GitHub Actions

```yaml
- uses: ezi-flows/webautomate-api/actions/run-build@v1
  with:
    api-token: ${{ secrets.WEBAUTOMATE_API_TOKEN }}
    account-id: ${{ vars.WEBAUTOMATE_ACCOUNT_ID }}
    project-id: ${{ vars.WEBAUTOMATE_PROJECT_ID }}
```

A complete workflow that also keeps the reports is in [`github-actions/webautomate.yml`](./github-actions/webautomate.yml).

| Input | Default | Description |
|-------|---------|-------------|
| `api-token` | – | API token with `projects.run` and `results.read`. Pass it from a secret. |
| `account-id` | – | Account the token belongs to |
| `project-id` | – | Project to run |
| `api-root` | `https://api.webautomate.app` | API origin |
| `timeout-minutes` | `30` | Cancel the build and fail when it has no outcome after this time |
| `allow-mixed` | `false` | Pass when the build finishes `mixed` (some pages failed) |
| `fail-on-visual-changes` | `false` | Fail when visual test screenshots changed or were rejected |
| `output-dir` | `.` | Where the reports are written |

Outputs: `build-request-id`, `build-id`, `outcome`, `results-url`. The job summary shows the outcome and a link to the build.

GitHub-hosted runners include Node.js. On self-hosted runners, add `actions/setup-node` first.

## Jenkins

[`jenkins/Jenkinsfile`](./jenkins/Jenkinsfile) downloads the runner pinned to a release tag, runs it with the token from a **Secret text** credential, and publishes `webautomate-junit.xml` as test results. A failed build marks the run **unstable**; a build that could not be queued or timed out fails it.

## Other CI systems or local runs

```bash
cp .env.example .env   # fill in token, account ID, and project ID
node --env-file=.env webautomate-run.mjs   # Node.js 20.6+; otherwise export the variables
```

Against a local WebAutomate stack with a self-signed or mkcert certificate, let Node.js trust it: `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node --env-file=.env webautomate-run.mjs`. Without it the runner stops with `Network error: UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

Settings are environment variables (`WEBAUTOMATE_API_TOKEN`, `WEBAUTOMATE_ACCOUNT_ID`, `WEBAUTOMATE_PROJECT_ID`, and the optional ones in [`.env.example`](./.env.example)). Flags override the non-secret ones, for example `--project-id=…`, `--allow-mixed`, `--timeout-minutes=45`.

## What it does

1. Shows the Usage Credit balance when the token has `billing.read`.
2. Queues the build with `POST /developer/v1/project-build/:accountId/:projectId`, sending the CI run as `metadata` (provider, repository, ref, commit, run ID and URL) and an `Idempotency-Key` for the run attempt. A retried request follows the build it already queued instead of queueing another.
3. Polls `GET /developer/v1/project-build-status/:accountId/:projectId/:buildRequestId` every 15 seconds (with jitter, retrying on `429` and `5xx`) until the request is `completed` or `dequeued`.
4. Reads the results with `GET /developer/v1/project-build-result/…` and writes `webautomate-result.json` and `webautomate-junit.xml` (one test case per result).
5. Exits with the outcome. When the job is cancelled (SIGINT or SIGTERM) or the timeout is reached, it cancels the build with `POST /developer/v1/project-build-cancel/…` first.

| Exit code | Meaning |
|-----------|---------|
| `0` | The build passed: `success`, or `mixed` with `allow-mixed` |
| `1` | The build failed: `failure`, `timeout`, `cancel`, `terminated`, `mixed`, or removed from the queue; or visual changes with `fail-on-visual-changes` |
| `2` | Not queued (the reason's `error.code`, for example `BUILD_IN_PROGRESS` or `INSUFFICIENT_USAGE_CREDITS`), invalid settings, or an API error |
| `3` | No outcome within the timeout; the build was cancelled |

## Best practices

- **One token per pipeline**, with only `projects.run` and `results.read`, stored as a CI secret. Choose a 30- or 90-day lifetime and rotate it: create the new token, update the secret, then delete the old token (deleting blocks it immediately).
- **A project dedicated to the pipeline, without a schedule.** Scheduled or manual runs of the same project make the CI request fail with `BUILD_IN_PROGRESS`.
- **Set the job timeout above `timeout-minutes`**, so the runner can cancel the build before the CI system kills the job.
- **Decide what passes.** Keep `allow-mixed` off unless partial results are acceptable, and turn on `fail-on-visual-changes` for visual regression checks.
- **Shared runners share the rate limit** of 300 requests per minute per IP address. The 15-second poll interval keeps one run far below it.
- **Prefer webhooks for long builds** if you have an endpoint: the `build.*` webhooks carry the same `metadata`, see [webhooks](../webhooks).

## Required scopes

- `projects.run`: queue and cancel the build
- `results.read`: read its status and results
- `billing.read` (optional): show the Usage Credit balance

## Test

```bash
npm test
```
