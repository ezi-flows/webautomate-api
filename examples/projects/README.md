# Projects

Lists all projects in your account (following pagination), or deletes one project.

## Run

```bash
cp .env.example .env
npm install
npm run list                         # list all projects
npm run delete -- <projectId>        # show the project that would be deleted
npm run delete -- <projectId> --yes  # delete it permanently
```

`npm start` without a command prints this usage.

## What it does

**`list`** calls `POST /developer/v1/projects/:accountId` with `{limit, cursor}`, follows `data.pagination.nextCursor` until it is `null`, and prints each project's name (`configData.projectName`), ID, solution, state, creation date, and latest build.

**`delete <projectId>`** looks the project up in the list (the API has no single-project lookup), stops if the ID is not in your account, and prints the project. Only with `--yes` does it call `DELETE /developer/v1/project-delete/:accountId/:projectId`, which removes the project and all its builds and results permanently.

Project configuration (URLs, steps, schedules, notifications) is edited in Project Setup, not through the API. Through the API you can update only a project's name and description (`PUT /developer/v1/project-update/:accountId/:projectId`).

## Required scopes

- `projects.read`: list projects
- `projects.delete`: delete a project (`delete --yes`; `delete` also needs `projects.read` to look the project up)
