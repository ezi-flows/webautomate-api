# Authentication

Checks that your API token is valid by calling the account endpoint.

## Run

```bash
cp .env.example .env   # fill in your token and account ID
npm install
npm start
```

## What it does

- Sends `GET /developer/v1/account/:accountId` with your Bearer token
- Prints your account data on success
- On failure, prints the API error code (for example `API.INVALID_OR_EXPIRED_TOKEN`, `API.TOKEN_DOES_NOT_MATCH_ACCOUNT`, or `API.INSUFFICIENT_SCOPE`)

## Get a token

Go to **My Account → Developers** in your WebAutomate dashboard, click **Generate API token**, and select at least the `account.read` scope. Copy the token right away, because it is shown only once. The account ID in your `.env` must be the account the token belongs to.
