import 'dotenv/config';

const BASE_URL = 'https://api.webautomate.app/developer/v1';
const {WEBAUTOMATE_API_TOKEN, WEBAUTOMATE_ACCOUNT_ID, WEBAUTOMATE_PROJECT_ID, WEBAUTOMATE_BUILD_ID} = process.env;

if (!WEBAUTOMATE_API_TOKEN || !WEBAUTOMATE_ACCOUNT_ID || !WEBAUTOMATE_PROJECT_ID) {
    console.error('Missing required env vars. Check .env.example');
    process.exit(1);
}

const headers = {
    Authorization: `Bearer ${WEBAUTOMATE_API_TOKEN}`,
    'Content-Type': 'application/json',
};

async function queueBuild() {
    const res = await fetch(
        `${BASE_URL}/project-build/${WEBAUTOMATE_ACCOUNT_ID}/${WEBAUTOMATE_PROJECT_ID}`,
        {method: 'POST', headers},
    );
    const body = await res.json().catch(() => null);

    if (!res.ok) {
        throw new Error(`Failed to queue build (${res.status}): ${body?.error?.message ?? 'unknown error'}`);
    }

    // A build that cannot be queued right now still returns HTTP 200, with success: false.
    if (!body?.success) {
        throw new Error(`Build not queued: ${body?.error?.code ?? ''} ${body?.error?.message ?? 'unknown reason'}`.trim());
    }

    return body.data.buildRequest;
}

async function getBuildStatus(buildRequestId) {
    const res = await fetch(
        `${BASE_URL}/project-build-status/${WEBAUTOMATE_ACCOUNT_ID}/${WEBAUTOMATE_PROJECT_ID}/${buildRequestId}`,
        {headers},
    );
    const body = await res.json().catch(() => null);

    if (!res.ok || !body?.success) {
        throw new Error(`Failed to read build status (${res.status}): ${body?.error?.message ?? 'unknown error'}`);
    }

    return body.data;
}

async function getBuildResults(buildId, {limit = 25} = {}) {
    const results = [];
    let build;
    let cursor;

    do {
        const query = new URLSearchParams({limit: String(limit), ...(cursor ? {cursor} : {})});
        const res = await fetch(
            `${BASE_URL}/project-build-result/${WEBAUTOMATE_ACCOUNT_ID}/${WEBAUTOMATE_PROJECT_ID}/${buildId}?${query}`,
            {headers},
        );
        const body = await res.json().catch(() => null);

        if (!res.ok || !body?.success) {
            throw new Error(`Failed to fetch build results (${res.status}): ${body?.error?.message ?? 'unknown error'}`);
        }

        build = body.data.build;
        results.push(...body.data.results);
        cursor = body.data.pagination.nextCursor;
    } while (cursor);

    return {build, results};
}

if (!WEBAUTOMATE_BUILD_ID) {
    console.log(`Queueing build for project ${WEBAUTOMATE_PROJECT_ID}...`);
    const buildRequest = await queueBuild();
    console.log(`Build queued as build request ${buildRequest.id}.`);

    const status = await getBuildStatus(buildRequest.id);
    console.log(`Current state: ${status.buildRequest.state}`);
    console.log('Follow it with GET /project-build-status/... until the state is "completed" (see ../ci),');
    console.log('or wait for its build.* webhook (see ../webhooks).');
    console.log('Then set WEBAUTOMATE_BUILD_ID to the build ID and run again to read the results.');
} else {
    console.log(`Reading results for build ${WEBAUTOMATE_BUILD_ID}...`);
    const {build, results} = await getBuildResults(WEBAUTOMATE_BUILD_ID);

    console.log(`\nBuild state: ${build.state}`);
    if (build.start && build.end) {
        console.log(`Duration: ${((build.end - build.start) / 1000).toFixed(1)}s`);
    }
    console.log(`Results: ${results.length} item(s)`);

    if (results.length > 0) {
        console.log('\nFirst result preview:');
        console.log(JSON.stringify(results[0], null, 2));
    }
}
