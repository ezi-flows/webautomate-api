# Projects

Lists all projects in your account (following pagination) and shows how to delete one.

## Run

```bash
cp .env.example .env
npm install
npm start
```

## What it does

- Calls `POST /developer/v1/projects/:accountId` with `{limit, cursor}` and follows `data.pagination.nextCursor` until it is `null`
- Prints each project's name (`configData.projectName`), ID, solution, state, creation date, and latest build
- Includes a commented-out `deleteProject()` call (`DELETE /developer/v1/project-delete/:accountId/:projectId`) you can enable

Project configuration (URLs, steps, schedules, notifications) is edited in Project Setup, not through the API. Through the API you can update only a project's name and description (`PUT /developer/v1/project-update/:accountId/:projectId`).

## Required scopes

- `projects.read`: list projects
- `projects.delete`: delete a project (only if you uncomment the delete call)
