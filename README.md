# WebAutomate API examples

Runnable examples for the [WebAutomate Developer API](https://webautomate.app/documentation/api). They show how to queue project builds, follow their status, read results, receive webhooks, and run builds from your CI/CD pipeline.

## Examples

| Example | What it shows | Token scopes |
|---------|---------------|--------------|
| [authentication](./examples/authentication) | Check that an API token works by reading your account | `account.read` |
| [projects](./examples/projects) | List your projects page by page, and delete a project | `projects.read`, `projects.delete` (optional) |
| [automations](./examples/automations) | Queue a build, check its status, and read its results | `projects.run`, `results.read` |
| [webhooks](./examples/webhooks) | Receive build, project and billing events and verify their signatures | None: uses your webhook signing secret |
| [ci](./examples/ci) | Run a build from GitHub Actions, Jenkins or any other CI, and pass or fail the job on its outcome | `projects.run`, `results.read` |

Each example has its own `README.md` with the details.

## Run builds from GitHub Actions

```yaml
- uses: ezi-flows/webautomate-api/actions/run-build@v1
  with:
    api-token: ${{ secrets.WEBAUTOMATE_API_TOKEN }}
    account-id: ${{ vars.WEBAUTOMATE_ACCOUNT_ID }}
    project-id: ${{ vars.WEBAUTOMATE_PROJECT_ID }}
```

The step queues the build, waits for it to finish, and fails the job unless the build passes. The [ci](./examples/ci) example lists all inputs and outputs, and also includes a Jenkins pipeline and a runner for other CI systems.

## Before you start

- Node.js 18 or later
- An API token. In WebAutomate, open [**My Account → Developers**](https://webautomate.app/dashboard/account?account_tab=developers), choose **Generate API token**, and select the scopes the example needs. Copy the token right away, because it is shown only once.
- The ID of the account the token belongs to, and for builds, the ID of the project to run

## Run an example

```bash
cd examples/<example>
cp .env.example .env   # add your API token and IDs
npm install
npm start              # prints the example's commands, or runs it if it has only one
```

Examples that can do more than one thing take an explicit command, for example `npm run queue` or `npm run delete -- <projectId>`. Each example's README lists its commands.

## Good to know

- All requests go to `https://api.webautomate.app/developer/v1` and send the token as `Authorization: Bearer <token>`.
- Every response has a `success` field, so check it even when the HTTP status is 200. A build that can't be queued, for example because the project is already running, returns HTTP 200 with `success: false` and an `error.code`.
- Keep tokens out of your code. Store them as CI secrets or in a local `.env` file. The examples' `.gitignore` keeps `.env` files out of Git.

## Documentation

- [Developer API reference](https://webautomate.app/documentation/api)
- [WebAutomate](https://webautomate.app)
