import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
    cancelBuildRequest,
    createClient,
    evaluateOutcome,
    EXIT_CODES,
    getCiContext,
    readConfig,
    runBuild,
    toJUnit,
} from './webautomate-run.mjs';

const config = {
    projectId: 'project-1',
    allowMixed: false,
    failOnVisualChanges: false,
    timeoutMinutes: 30,
    pollSeconds: 15,
};
const context = {idempotencyKey: 'github-1-1-test', metadata: {ciProvider: 'github'}};
const noSleep = async () => {};
const silent = () => {};

const createFakeClient = ({statuses, queued, results = []}) => {
    const calls = {cancel: 0, status: 0};
    return {
        calls,
        getUsageCredits: async () => ({data: {balance: {available: 100}}}),
        queueBuild: async () => queued ?? {
            success: true,
            data: {buildRequest: {id: 'build_request_1', state: 'queued'}},
        },
        getStatus: async () => ({data: statuses[Math.min(calls.status++, statuses.length - 1)]}),
        cancel: async () => {
            calls.cancel += 1;
            return {success: true};
        },
        getResults: async () => results,
    };
};

const completed = (state, extra = {}) => ({
    buildRequest: {id: 'build_request_1', state: 'completed', buildId: 7},
    build: {id: 7, state, start: 0, end: 1000, ...extra},
    resultsUrl: 'https://webautomate.app/dashboard/project-list/project-1/7',
});

describe('evaluateOutcome', () => {
    it('passes a successful build', () => {
        assert.equal(evaluateOutcome(completed('success')).passed, true);
    });

    it('fails a mixed build unless mixed results are allowed', () => {
        assert.equal(evaluateOutcome(completed('mixed')).passed, false);
        assert.equal(evaluateOutcome(completed('mixed'), {allowMixed: true}).passed, true);
    });

    it('fails failed, timed-out, cancelled and terminated builds', () => {
        for (const state of ['failure', 'timeout', 'cancel', 'terminated']) {
            assert.equal(evaluateOutcome(completed(state)).passed, false, state);
        }
    });

    it('fails a dequeued build with its reason', () => {
        const outcome = evaluateOutcome({buildRequest: {state: 'dequeued', dequeueReason: 'billingProblem'}, build: null});

        assert.equal(outcome.passed, false);
        assert.match(outcome.reason, /billingProblem/);
    });

    it('fails on changed screenshots only when asked to', () => {
        const status = completed('success', {
            solutionSummary: {e2eVisualTests: {additionalResults: {new: 1, accepted: 3, rejected: 0, changed: 2}}},
        });

        assert.equal(evaluateOutcome(status).passed, true);
        assert.equal(evaluateOutcome(status, {failOnVisualChanges: true}).passed, false);
    });
});

describe('runBuild', () => {
    it('waits for the build and exits 0 when it succeeds', async () => {
        const client = createFakeClient({
            statuses: [
                {buildRequest: {state: 'queued'}, build: null},
                {buildRequest: {state: 'running', buildId: 7}, build: {id: 7, state: 'running'}},
                completed('success'),
            ],
            results: [{id: 'r1', url: 'https://example.com/', state: 'success'}],
        });

        const run = await runBuild({client, config, context, log: silent, sleep: noSleep});

        assert.equal(run.exitCode, EXIT_CODES.passed);
        assert.equal(run.buildRequestId, 'build_request_1');
        assert.equal(run.results.length, 1);
        assert.equal(client.calls.status, 3);
    });

    it('exits 1 when the build fails', async () => {
        const client = createFakeClient({statuses: [completed('failure')]});

        const run = await runBuild({client, config, context, log: silent, sleep: noSleep});

        assert.equal(run.exitCode, EXIT_CODES.failed);
    });

    it('exits 2 with the error code when nothing was queued', async () => {
        const client = createFakeClient({
            statuses: [],
            queued: {success: false, error: {code: 'BUILD_IN_PROGRESS', message: 'Already queued'}},
        });

        const run = await runBuild({client, config, context, log: silent, sleep: noSleep});

        assert.equal(run.exitCode, EXIT_CODES.error);
        assert.match(run.outcome.reason, /BUILD_IN_PROGRESS/);
    });

    it('cancels the build and exits 3 after the timeout', async () => {
        let time = 0;
        const client = createFakeClient({statuses: [{buildRequest: {state: 'running', buildId: 7}, build: null}]});

        const run = await runBuild({
            client,
            config: {...config, timeoutMinutes: 1},
            context,
            log: silent,
            sleep: async () => {
                time += 30_000;
            },
            now: () => time,
        });

        assert.equal(run.exitCode, EXIT_CODES.timedOut);
        assert.equal(client.calls.cancel, 1);
    });

    it('reports the build request as soon as it is queued', async () => {
        const client = createFakeClient({statuses: [completed('success')]});
        let reported;

        await runBuild({
            client,
            config,
            context,
            log: silent,
            sleep: noSleep,
            onBuildRequest: (id) => {
                reported = id;
            },
        });

        assert.equal(reported, 'build_request_1');
    });
});

describe('cancelBuildRequest', () => {
    it('retries while the build is still starting', async () => {
        const responses = [
            {success: false, error: {code: 'BUILD_NOT_CANCELLABLE', reason: 'buildStarting'}},
            {success: false, error: {code: 'BUILD_NOT_CANCELLABLE', reason: 'buildStarting'}},
            {success: true, data: {cancellationStatus: 'accepted'}},
        ];
        const lines = [];

        const cancelled = await cancelBuildRequest({
            client: {cancel: async () => responses.shift()},
            projectId: 'project-1',
            buildRequestId: 'build_request_1',
            log: (line) => lines.push(line),
            sleep: noSleep,
        });

        assert.equal(cancelled, true);
        assert.equal(responses.length, 0);
        assert.match(lines.at(-1), /Cancellation accepted/);
    });

    it('reports a cancellation the API refused', async () => {
        const lines = [];
        const cancelled = await cancelBuildRequest({
            client: {
                cancel: async () => ({
                    success: false,
                    error: {code: 'BUILD_NOT_CANCELLABLE', reason: 'identityChanged'},
                }),
            },
            projectId: 'project-1',
            buildRequestId: 'build_request_1',
            log: (line) => lines.push(line),
        });

        assert.equal(cancelled, false);
        assert.match(lines[0], /BUILD_NOT_CANCELLABLE: identityChanged/);
    });
});

describe('createClient', () => {
    it('retries rate-limited requests and sends the idempotency key', async () => {
        const requests = [];
        const responses = [
            {ok: false, status: 429, json: async () => ({})},
            {ok: true, status: 200, json: async () => ({success: true, data: {buildRequest: {id: 'b1'}}})},
        ];
        const client = createClient({
            apiRoot: 'https://api.example.test',
            token: 'token',
            accountId: 'account-1',
            requestId: 'run-1',
            sleep: noSleep,
            fetchImpl: async (url, init) => {
                requests.push({url, init});
                return responses.shift();
            },
        });

        const response = await client.queueBuild({projectId: 'project-1', idempotencyKey: 'key-1', metadata: {}});

        assert.equal(response.data.buildRequest.id, 'b1');
        assert.equal(requests.length, 2);
        assert.equal(requests[1].url, 'https://api.example.test/developer/v1/project-build/account-1/project-1');
        assert.equal(requests[1].init.headers['Idempotency-Key'], 'key-1');
        assert.equal(requests[1].init.headers['X-Request-Id'], 'run-1');
    });

    it('throws the API error for client errors without retrying', async () => {
        let calls = 0;
        const client = createClient({
            apiRoot: 'https://api.example.test',
            token: 'token',
            accountId: 'account-1',
            sleep: noSleep,
            fetchImpl: async () => {
                calls += 1;
                return {ok: false, status: 403, json: async () => ({error: {message: 'API.INSUFFICIENT_SCOPE'}})};
            },
        });

        await assert.rejects(client.getUsageCredits(), {status: 403, message: 'API.INSUFFICIENT_SCOPE'});
        assert.equal(calls, 1);
    });
});

describe('getCiContext', () => {
    it('derives a per-attempt idempotency key and metadata on GitHub Actions', () => {
        const ciContext = getCiContext({
            GITHUB_ACTIONS: 'true',
            GITHUB_RUN_ID: '42',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_JOB: 'qa',
            GITHUB_REPOSITORY: 'acme/shop',
            GITHUB_SHA: 'abc',
            GITHUB_SERVER_URL: 'https://github.com',
        });

        assert.equal(ciContext.idempotencyKey, 'github-42-2-qa');
        assert.deepEqual(ciContext.metadata, {
            ciProvider: 'github',
            repository: 'acme/shop',
            commitSha: 'abc',
            runId: '42',
            runUrl: 'https://github.com/acme/shop/actions/runs/42',
        });
    });

    it('uses BUILD_TAG on Jenkins', () => {
        const ciContext = getCiContext({JENKINS_URL: 'https://ci', BUILD_TAG: 'jenkins-shop-17', GIT_COMMIT: 'abc'});

        assert.equal(ciContext.idempotencyKey, 'jenkins-shop-17');
        assert.equal(ciContext.metadata.commitSha, 'abc');
    });
});

describe('readConfig', () => {
    it('reads environment variables and lets flags override them', () => {
        const parsed = readConfig({
            WEBAUTOMATE_API_TOKEN: 'token',
            WEBAUTOMATE_ACCOUNT_ID: 'account-1',
            WEBAUTOMATE_PROJECT_ID: 'project-1',
            WEBAUTOMATE_ALLOW_MIXED: 'true',
        }, ['--project-id=project-2', '--fail-on-visual-changes']);

        assert.equal(parsed.projectId, 'project-2');
        assert.equal(parsed.allowMixed, true);
        assert.equal(parsed.failOnVisualChanges, true);
        assert.equal(parsed.apiRoot, 'https://api.webautomate.app');
    });

    it('lists every missing setting', () => {
        assert.throws(() => readConfig({}, []), /WEBAUTOMATE_API_TOKEN[\s\S]*WEBAUTOMATE_ACCOUNT_ID[\s\S]*WEBAUTOMATE_PROJECT_ID/);
    });
});

describe('toJUnit', () => {
    it('writes one test case per result', () => {
        const xml = toJUnit({
            projectId: 'project-1',
            run: {
                outcome: {passed: false, reason: 'mixed'},
                results: [
                    {url: 'https://example.com/a', state: 'success'},
                    {url: 'https://example.com/b?x=1&y=2', state: 'failure'},
                    {url: 'https://example.com/c', state: 'ignored'},
                ],
            },
        });

        assert.match(xml, /tests="3" failures="1" skipped="1"/);
        assert.match(xml, /https:\/\/example\.com\/b\?x=1&amp;y=2/);
    });

    it('fails pages whose response did not succeed, as the API reports them', () => {
        const xml = toJUnit({
            projectId: 'project-1',
            run: {
                outcome: {passed: false, reason: 'mixed'},
                results: [
                    {url: 'https://shop.example/a', responseSummary: {success: true, status: 200}},
                    {
                        url: 'https://shop.example/b',
                        responseSummary: {success: false, status: 403, infoCodes: [{code: 'CLIENT_ERROR', level: 'ERROR'}]},
                        solutionData: null,
                    },
                    {url: 'https://shop.example/c', responseSummary: {success: true}, solutionData: {isAborted: true}},
                ],
            },
        });

        assert.match(xml, /tests="3" failures="2" skipped="0"/);
        assert.match(xml, /<failure message="CLIENT_ERROR, HTTP 403"\/>/);
        assert.match(xml, /<failure message="aborted"\/>/);
    });

    it('writes a single test case when the build has no results', () => {
        const xml = toJUnit({projectId: 'project-1', run: {outcome: {passed: false, reason: 'dequeued'}, results: []}});

        assert.match(xml, /name="Project-Run"><failure message="dequeued"\/>/);
    });
});
