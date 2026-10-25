import 'dotenv/config';

const BASE_URL = 'https://api.webautomate.app/developer/v1';
const {WEBAUTOMATE_API_TOKEN, WEBAUTOMATE_ACCOUNT_ID, WEBAUTOMATE_PROJECT_ID} = process.env;

const USAGE = `Usage:
  npm run queue                      Queue a build and print its build request ID
  npm run status -- <buildRequestId> Print the build request's state and, once the build started, its build ID
  npm run results -- <buildId>       Read every result of a finished build`;

const [command, id] = process.argv.slice(2);

if (!['queue', 'status', 'results'].includes(command)) {
    console.error(USAGE);
    process.exit(1);
}

if (command !== 'queue' && !id) {
    console.error(`Missing ${command === 'status' ? 'build request ID' : 'build ID'}.\n\n${USAGE}`);
    process.exit(1);
}

if (!WEBAUTOMATE_API_TOKEN || !WEBAUTOMATE_ACCOUNT_ID || !WEBAUTOMATE_PROJECT_ID) {
    console.error('Missing required env vars. Check .env.example');
    process.exit(1);
}

// IDs come from the command line, so encode them before they become part of a URL path.
const projectPath = `${encodeURIComponent(WEBAUTOMATE_ACCOUNT_ID)}/${encodeURIComponent(WEBAUTOMATE_PROJECT_ID)}`;

const headers = {
    Authorization: `Bearer ${WEBAUTOMATE_API_TOKEN}`,
    'Content-Type': 'application/json',
};

async function queueBuild() {
    const res = await fetch(
        `${BASE_URL}/project-build/${projectPath}`,
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
        `${BASE_URL}/project-build-status/${projectPath}/${encodeURIComponent(buildRequestId)}`,
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
            `${BASE_URL}/project-build-result/${projectPath}/${encodeURIComponent(buildId)}?${query}`,
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

switch (command) {
    case 'queue': {
        console.log(`Queueing build for project ${WEBAUTOMATE_PROJECT_ID}...`);
        const buildRequest = await queueBuild();
        console.log(`Build queued. Build request ID: ${buildRequest.id}`);
        console.log(`Check it with: npm run status -- ${buildRequest.id}`);
        break;
    }

    case 'status': {
        const {buildRequest} = await getBuildStatus(id);
        console.log(`State: ${buildRequest.state}`);
        if (buildRequest.buildId) {
            console.log(`Build ID: ${buildRequest.buildId}`);
            if (buildRequest.state === 'completed') {
                console.log(`Read its results with: npm run results -- ${buildRequest.buildId}`);
            }
        } else {
            console.log('The build has not started yet, so it has no build ID. Check again shortly,');
            console.log('or wait for its build.* webhook (see ../webhooks).');
        }
        break;
    }

    case 'results': {
        console.log(`Reading results for build ${id}...`);
        const {build, results} = await getBuildResults(id);

        console.log(`\nBuild state: ${build.state}`);
        if (build.start && build.end) {
            console.log(`Duration: ${((build.end - build.start) / 1000).toFixed(1)}s`);
        }
        console.log(`Results: ${results.length} item(s)`);

        if (results.length > 0) {
            console.log('\nFirst result preview:');
            console.log(JSON.stringify(results[0], null, 2));
        }
        break;
    }
}
