import 'dotenv/config';

const BASE_URL = 'https://api.webautomate.app/developer/v1';
const {WEBAUTOMATE_API_TOKEN, WEBAUTOMATE_ACCOUNT_ID} = process.env;

if (!WEBAUTOMATE_API_TOKEN || !WEBAUTOMATE_ACCOUNT_ID) {
    console.error('Missing WEBAUTOMATE_API_TOKEN or WEBAUTOMATE_ACCOUNT_ID in .env');
    process.exit(1);
}

async function verifyToken() {
    const res = await fetch(`${BASE_URL}/account/${WEBAUTOMATE_ACCOUNT_ID}`, {
        headers: {
            Authorization: `Bearer ${WEBAUTOMATE_API_TOKEN}`,
        },
    });

    const body = await res.json().catch(() => null);

    if (!res.ok || !body?.success) {
        // Error codes: API.BEARER_TOKEN_REQUIRED, API.INVALID_OR_EXPIRED_TOKEN,
        // API.TOKEN_DOES_NOT_MATCH_ACCOUNT, API.TOKEN_NOT_FOUND_OR_REVOKED, API.INSUFFICIENT_SCOPE, ...
        throw new Error(`Token check failed (${res.status}): ${body?.error?.message ?? 'unknown error'}`);
    }

    return body.data.account;
}

const account = await verifyToken();
console.log('Token is valid.');
console.log('Account:', JSON.stringify(account, null, 2));
