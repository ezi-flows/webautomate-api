# Changesets

Releases of this repository are versioned with [Changesets](https://changesets.dev).

## Adding a changeset

Every pull request that changes the Action, the CI runner or an example adds a changeset:

```bash
npm install
npm run changeset
```

Pick the bump and describe the change for users. The text goes into `CHANGELOG.md` and the GitHub Release.

| Bump | When |
|------|------|
| `patch` | Fixes and wording; existing workflows behave the same |
| `minor` | New inputs, outputs or examples; existing workflows keep working |
| `major` | Removed or renamed inputs or outputs, or changed default behavior. Users must change their workflows (`@v1` → `@v2`) |

Pull requests without user-facing changes get the `skip changeset` label instead.

## Releasing

1. Merging to `main` opens or updates the **Version Packages** pull request. It raises the version in `package.json` and writes `CHANGELOG.md`.
2. Merging that pull request tags `vX.Y.Z`, creates the GitHub Release, and moves the major tag (`v1`) to it.

Users who reference `@v1` get every 1.x release automatically. `@vX.Y.Z` pins an exact version.
