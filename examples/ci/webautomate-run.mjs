#!/usr/bin/env node
// Runs a Webautomate project build from a CI pipeline and exits with its outcome.
// Self-contained (Node.js 18+, no dependencies) so CI jobs can download this single file.

import {appendFileSync, mkdirSync, writeFileSync} from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';

export const EXIT_CODES = {
    passed: 0,
    failed: 1,
    error: 2,
    timedOut: 3,
};

const DEFAULT_API_ROOT = 'https://api.webautomate.app';
const MAX_METADATA_LENGTH = 512;
const FINAL_REQUEST_STATES = ['completed', 'dequeued'];
const FAILED_RESULT_STATES = ['failure', 'invalid'];

// A page's outcome is responseSummary.success, as in the web app. A run step
// that was aborted also fails the page.
export const isFailedResult = (result) => (
    FAILED_RESULT_STATES.includes(result.state)
    || result.responseSummary?.success === false
    || result.solutionData?.isAborted === true
);

const getResultFailureMessage = (result) => {
    const errorCode = result.responseSummary?.infoCodes?.find((infoCode) => infoCode.level === 'ERROR')?.code;
    const status = result.responseSummary?.status;
    return [errorCode, status ? `HTTP ${status}` : null, result.solutionData?.isAborted ? 'aborted' : null]
        .filter(Boolean)
        .join(', ') || result.state || 'failed';
};

export class ApiError extends Error {
    constructor(message, {status, code, body} = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

const isTruthy = (value) => ['1', 'true', 'yes'].includes(String(value ?? '').trim().toLowerCase());

const parseFlags = (argv) => Object.fromEntries(argv
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
        const [name, ...value] = arg.slice(2).split('=');
        return [name, value.length ? value.join('=') : 'true'];
    }));

/**
 * Settings come from environment variables, so CI secrets never appear on the
 * command line. Flags override the non-secret ones.
 */
export const readConfig = (env = process.env, argv = process.argv.slice(2)) => {
    const flags = parseFlags(argv);
    const get = (flag, name, fallback) => flags[flag] ?? env[name] ?? fallback;
    const config = {
        apiRoot: String(get('api-root', 'WEBAUTOMATE_API_ROOT', DEFAULT_API_ROOT)).replace(/\/+$/, ''),
        token: env.WEBAUTOMATE_API_TOKEN,
        accountId: get('account-id', 'WEBAUTOMATE_ACCOUNT_ID'),
        projectId: get('project-id', 'WEBAUTOMATE_PROJECT_ID'),
        allowMixed: isTruthy(get('allow-mixed', 'WEBAUTOMATE_ALLOW_MIXED')),
        failOnVisualChanges: isTruthy(get('fail-on-visual-changes', 'WEBAUTOMATE_FAIL_ON_VISUAL_CHANGES')),
        timeoutMinutes: Number(get('timeout-minutes', 'WEBAUTOMATE_TIMEOUT_MINUTES', 30)),
        pollSeconds: Number(get('poll-seconds', 'WEBAUTOMATE_POLL_SECONDS', 15)),
        outputDir: get('output-dir', 'WEBAUTOMATE_OUTPUT_DIR', '.'),
    };
    const problems = [
        ...['token', 'accountId', 'projectId']
            .filter((key) => !config[key])
            .map((key) => ({
                token: 'WEBAUTOMATE_API_TOKEN is required',
                accountId: 'WEBAUTOMATE_ACCOUNT_ID (or --account-id) is required',
                projectId: 'WEBAUTOMATE_PROJECT_ID (or --project-id) is required',
            })[key]),
        ...(!(config.timeoutMinutes > 0) ? ['timeout-minutes must be a positive number'] : []),
        ...(!(config.pollSeconds >= 5) ? ['poll-seconds must be at least 5'] : []),
    ];

    if (problems.length) {
        throw new Error(problems.join('\n'));
    }

    return config;
};

const compact = (metadata) => Object.fromEntries(Object.entries(metadata)
    .filter(([, value]) => typeof value === 'string' && value)
    .map(([key, value]) => [key, value.slice(0, MAX_METADATA_LENGTH)]));

/**
 * Describe the CI run, and derive an idempotency key that is stable when the
 * same run attempt calls the API again, but new for every retry of the job.
 */
export const getCiContext = (env = process.env) => {
    const override = env.WEBAUTOMATE_IDEMPOTENCY_KEY;

    if (env.GITHUB_ACTIONS === 'true') {
        return {
            provider: 'github',
            idempotencyKey: override
                || `github-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || 1}-${env.GITHUB_JOB || 'job'}`,
            metadata: compact({
                ciProvider: 'github',
                repository: env.GITHUB_REPOSITORY,
                ref: env.GITHUB_REF,
                commitSha: env.GITHUB_SHA,
                runId: env.GITHUB_RUN_ID,
                runUrl: env.GITHUB_RUN_ID
                    ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
                    : undefined,
            }),
        };
    }

    if (env.JENKINS_URL) {
        return {
            provider: 'jenkins',
            idempotencyKey: override || env.BUILD_TAG,
            metadata: compact({
                ciProvider: 'jenkins',
                repository: env.GIT_URL,
                ref: env.GIT_BRANCH,
                commitSha: env.GIT_COMMIT,
                runId: env.BUILD_TAG,
                runUrl: env.BUILD_URL,
            }),
        };
    }

    if (env.GITLAB_CI) {
        return {
            provider: 'gitlab',
            idempotencyKey: override || `gitlab-${env.CI_JOB_ID}`,
            metadata: compact({
                ciProvider: 'gitlab',
                repository: env.CI_PROJECT_PATH,
                ref: env.CI_COMMIT_REF_NAME,
                commitSha: env.CI_COMMIT_SHA,
                runId: env.CI_JOB_ID,
                runUrl: env.CI_JOB_URL,
            }),
        };
    }

    return {
        provider: 'local',
        idempotencyKey: override,
        metadata: {ciProvider: 'local'},
    };
};

const getBackoffMs = (attempt) => Math.min(30_000, 1_000 * 2 ** attempt) * (0.5 + Math.random() / 2);

export const createClient = ({
    apiRoot,
    token,
    accountId,
    requestId,
    fetchImpl = fetch,
    sleep,
    maxAttempts = 5,
}) => {
    const base = `${apiRoot}/developer/v1`;
    const account = encodeURIComponent(accountId);

    const request = async (method, pathname, {body, headers = {}} = {}) => {
        for (let attempt = 1; ; attempt += 1) {
            let response;
            try {
                response = await fetchImpl(`${base}${pathname}`, {
                    method,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        ...(requestId ? {'X-Request-Id': requestId} : {}),
                        ...(body ? {'Content-Type': 'application/json'} : {}),
                        ...headers,
                    },
                    body: body ? JSON.stringify(body) : undefined,
                });
            } catch (error) {
                if (attempt >= maxAttempts) {
                    // fetch hides the reason (DNS, TLS, refused connection) in error.cause.
                    const reason = error.cause?.code || error.cause?.message || error.message;
                    throw new ApiError(`Network error: ${reason}`, {status: 0});
                }
                await sleep(getBackoffMs(attempt));
                continue;
            }

            // Rate limits and server errors are worth retrying; requests carry an idempotency key.
            if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
                await sleep(getBackoffMs(attempt));
                continue;
            }

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
                throw new ApiError(payload?.error?.message || `HTTP ${response.status}`, {
                    status: response.status,
                    code: payload?.error?.code,
                    body: payload,
                });
            }

            return payload;
        }
    };

    const projectPath = (route, projectId, id) => (
        `/${route}/${account}/${encodeURIComponent(projectId)}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`
    );

    return {
        getUsageCredits: () => request('GET', `/usage-credits/${account}`),
        queueBuild: ({projectId, idempotencyKey, metadata}) => request('POST', projectPath('project-build', projectId), {
            body: {metadata},
            headers: idempotencyKey ? {'Idempotency-Key': idempotencyKey} : {},
        }),
        getStatus: (projectId, buildRequestId) => request('GET', projectPath('project-build-status', projectId, buildRequestId)),
        cancel: (projectId, buildRequestId) => request('POST', projectPath('project-build-cancel', projectId, buildRequestId)),
        getResults: async (projectId, buildId) => {
            const results = [];
            let cursor;
            do {
                const query = new URLSearchParams({limit: '50', ...(cursor ? {cursor} : {})});
                const page = await request('GET', `${projectPath('project-build-result', projectId, buildId)}?${query}`);
                results.push(...(page.data?.results || []));
                cursor = page.data?.pagination?.nextCursor;
            } while (cursor);
            return results;
        },
    };
};

/**
 * `success` passes. `mixed` passes only when allowed. With failOnVisualChanges,
 * rejected or changed screenshots fail the run even when the build succeeded.
 */
export const evaluateOutcome = (status, {allowMixed = false, failOnVisualChanges = false} = {}) => {
    const {buildRequest, build} = status;

    if (buildRequest.state === 'dequeued') {
        return {
            passed: false,
            outcome: 'dequeued',
            reason: `The build was removed from the queue (${buildRequest.dequeueReason || 'unknown reason'}).`,
        };
    }

    const outcome = build?.state || 'unknown';
    if (outcome !== 'success' && !(outcome === 'mixed' && allowMixed)) {
        return {passed: false, outcome, reason: `The build finished with state "${outcome}".`};
    }

    if (failOnVisualChanges) {
        const visual = build.solutionSummary?.e2eVisualTests?.additionalResults || {};
        const changes = (visual.rejected || 0) + (visual.changed || 0);
        if (changes > 0) {
            return {passed: false, outcome, reason: `${changes} visual test screenshot(s) changed or were rejected.`};
        }
    }

    return {passed: true, outcome, reason: `The build finished with state "${outcome}".`};
};

export const runBuild = async ({
    client,
    config,
    context,
    log = console.log,
    sleep,
    now = Date.now,
    onBuildRequest = () => {},
}) => {
    const {projectId} = config;

    try {
        const credits = await client.getUsageCredits();
        log(`Usage Credits available: ${credits.data?.balance?.available ?? 'unknown'}`);
    } catch (error) {
        // The token may lack billing.read; the balance is informational only.
        if (error.status !== 403) {
            log(`Could not read the Usage Credit balance: ${error.message}`);
        }
    }

    const queued = await client.queueBuild({
        projectId,
        idempotencyKey: context.idempotencyKey,
        metadata: context.metadata,
    });

    if (!queued.success) {
        const reason = queued.error?.code
            ? `${queued.error.code}: ${queued.error.message}`
            : queued.error?.message || 'unknown reason';
        return {
            exitCode: EXIT_CODES.error,
            outcome: {passed: false, outcome: 'rejected', reason: `The build was not queued (${reason}).`},
            results: [],
        };
    }

    const buildRequestId = queued.data.buildRequest.id;
    onBuildRequest(buildRequestId);
    log(queued.data.isReplay
        ? `Following build request ${buildRequestId}, which this CI run already queued.`
        : `Queued build request ${buildRequestId}.`);

    const deadline = now() + config.timeoutMinutes * 60_000;
    let status;
    let lastState;

    for (;;) {
        status = (await client.getStatus(projectId, buildRequestId)).data;
        const {state, buildId} = status.buildRequest;

        if (state !== lastState) {
            log(`Build request ${state}${buildId ? ` (build ${buildId})` : ''}.`);
            lastState = state;
        }

        if (FINAL_REQUEST_STATES.includes(state)) {
            break;
        }

        if (now() >= deadline) {
            log(`Timed out after ${config.timeoutMinutes} minutes; cancelling the build.`);
            await cancelBuildRequest({client, projectId, buildRequestId, log, sleep});
            return {
                exitCode: EXIT_CODES.timedOut,
                buildRequestId,
                status,
                outcome: {passed: false, outcome: 'timeout', reason: `No outcome within ${config.timeoutMinutes} minutes.`},
                results: [],
            };
        }

        await sleep(config.pollSeconds * 1_000 * (0.8 + Math.random() * 0.4));
    }

    const outcome = evaluateOutcome(status, config);
    const results = status.build?.id
        ? await client.getResults(projectId, status.build.id).catch((error) => {
            log(`Could not read the build results: ${error.message}`);
            return [];
        })
        : [];

    return {
        exitCode: outcome.passed ? EXIT_CODES.passed : EXIT_CODES.failed,
        buildRequestId,
        status,
        outcome,
        results,
    };
};

const escapeXml = (value) => String(value ?? '').replace(/[<>&'"]/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '\'': '&apos;',
    '"': '&quot;',
})[char]);

/**
 * One test case per result (usually one per URL), so CI shows which pages
 * failed. Builds without results get a single test case for the build itself.
 */
export const toJUnit = ({projectId, run}) => {
    const suiteName = `Webautomate project ${projectId}`;
    const className = `webautomate.${projectId}`;
    const cases = run.results.length
        ? run.results.map((result) => {
            const name = result.url || result.requestedUrl || result.id;
            if (isFailedResult(result)) {
                return `    <testcase classname="${escapeXml(className)}" name="${escapeXml(name)}"><failure message="${escapeXml(getResultFailureMessage(result))}"/></testcase>`;
            }
            if (result.state === 'ignored') {
                return `    <testcase classname="${escapeXml(className)}" name="${escapeXml(name)}"><skipped/></testcase>`;
            }
            return `    <testcase classname="${escapeXml(className)}" name="${escapeXml(name)}"/>`;
        })
        : [`    <testcase classname="${escapeXml(className)}" name="Project-Run">${run.outcome.passed
            ? ''
            : `<failure message="${escapeXml(run.outcome.reason)}"/>`}</testcase>`];
    const failures = cases.filter((testCase) => testCase.includes('<failure')).length;
    const skipped = cases.filter((testCase) => testCase.includes('<skipped')).length;

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<testsuites name="Webautomate" tests="${cases.length}" failures="${failures}">`,
        `  <testsuite name="${escapeXml(suiteName)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">`,
        ...cases,
        '  </testsuite>',
        '</testsuites>',
        '',
    ].join('\n');
};

export const toMarkdownSummary = ({projectId, run}) => {
    const build = run.status?.build;
    const duration = Number.isFinite(build?.start) && Number.isFinite(build?.end)
        ? `${Math.round((build.end - build.start) / 1000)}s`
        : '–';
    const failed = run.results.filter(isFailedResult).length;

    return [
        `### Webautomate ${run.outcome.passed ? 'passed' : 'failed'}`,
        '',
        '| | |',
        '| --- | --- |',
        `| Project | \`${projectId}\` |`,
        `| Outcome | ${run.outcome.outcome} |`,
        `| Build | ${build?.id ?? '–'} |`,
        `| Duration | ${duration} |`,
        `| Results | ${run.results.length} (${failed} failed) |`,
        ...(run.status?.resultsUrl ? [`| Details | [Open in Webautomate](${run.status.resultsUrl}) |`] : []),
        '',
        run.outcome.reason,
        '',
    ].join('\n');
};

const writeOutputs = ({config, run, env = process.env}) => {
    mkdirSync(config.outputDir, {recursive: true});
    writeFileSync(path.join(config.outputDir, 'webautomate-result.json'), `${JSON.stringify({
        projectId: config.projectId,
        buildRequestId: run.buildRequestId || null,
        exitCode: run.exitCode,
        outcome: run.outcome,
        status: run.status || null,
        results: run.results,
    }, null, 2)}\n`);
    writeFileSync(path.join(config.outputDir, 'webautomate-junit.xml'), toJUnit({projectId: config.projectId, run}));

    if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, toMarkdownSummary({projectId: config.projectId, run}));
    }
    if (env.GITHUB_OUTPUT) {
        appendFileSync(env.GITHUB_OUTPUT, [
            `build-request-id=${run.buildRequestId || ''}`,
            `build-id=${run.status?.build?.id ?? ''}`,
            `outcome=${run.outcome.outcome}`,
            `results-url=${run.status?.resultsUrl || ''}`,
            '',
        ].join('\n'));
    }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CANCEL_RETRY_MS = 3_000;
const CANCEL_MAX_ATTEMPTS = 7;

// The API answers a refused cancellation with HTTP 200 and success: false, so
// check the body as well as errors. A build that a runner just claimed cannot
// be cancelled for a few seconds (reason "buildStarting"), so retry briefly.
export const cancelBuildRequest = async ({client, projectId, buildRequestId, log, sleep: wait = sleep}) => {
    for (let attempt = 1; attempt <= CANCEL_MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await client.cancel(projectId, buildRequestId);
            if (response?.success) {
                log(`Cancellation ${response.data?.cancellationStatus || 'requested'} for build request ${buildRequestId}.`);
                return true;
            }
            if (response?.error?.reason === 'buildStarting' && attempt < CANCEL_MAX_ATTEMPTS) {
                await wait(CANCEL_RETRY_MS);
                continue;
            }
            log(`The build could not be cancelled (${response?.error?.code || 'unknown'}: ${response?.error?.reason || response?.error?.message || 'no reason'}).`);
        } catch (error) {
            log(`Cancelling failed: ${error.message}`);
        }
        return false;
    }
    return false;
};

const main = async () => {
    let config;
    try {
        config = readConfig();
    } catch (error) {
        console.error(error.message);
        return EXIT_CODES.error;
    }

    const context = getCiContext();
    const client = createClient({
        ...config,
        requestId: context.idempotencyKey,
        sleep,
    });
    let buildRequestId;
    let isFinished = false;

    // A cancelled CI job should not leave its build running.
    const stop = async (signal) => {
        if (buildRequestId && !isFinished) {
            console.log(`Received ${signal}; cancelling build request ${buildRequestId}.`);
            await cancelBuildRequest({client, projectId: config.projectId, buildRequestId, log: console.log});
        }
        process.exit(130);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));

    try {
        const run = await runBuild({
            client,
            config,
            context,
            sleep,
            onBuildRequest: (id) => {
                buildRequestId = id;
            },
        });
        isFinished = true;
        writeOutputs({config, run});
        console.log(run.outcome.reason);
        if (run.status?.resultsUrl) {
            console.log(`Results: ${run.status.resultsUrl}`);
        }
        return run.exitCode;
    } catch (error) {
        isFinished = true;
        console.error(`Webautomate request failed: ${error.message}${error.code ? ` (${error.code})` : ''}`);
        return EXIT_CODES.error;
    }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main();
}
