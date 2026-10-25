import 'dotenv/config';
import crypto from 'crypto';
import http from 'http';

const PORT = process.env.PORT || 3000;
const SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET;
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
// Skipping verification is opt-in (npm run start:unverified) and meant for local tests only.
const SKIP_SIGNATURE_VERIFICATION = process.argv.includes('--skip-signature-verification');

if (!SIGNING_SECRET && !SKIP_SIGNATURE_VERIFICATION) {
    console.error('Missing WEBHOOK_SIGNING_SECRET in .env. Set it to the Signing Secret from your WebAutomate webhook settings.');
    console.error('For a local test without signature checks, run: npm run start:unverified');
    process.exit(1);
}

// Delivery is at least once; remember recent eventIds to drop duplicates.
// Use a persistent store in production.
const seenEventIds = new Set();

// Verifies X-WebAutomate-Signature-V2: "t=<sentAt>,sha256=<hex HMAC-SHA256 of "<sentAt>." + raw body>"
function isValidSignatureV2(rawBody, header, secret) {
    const {t, sha256} = Object.fromEntries((header || '').split(',').map((part) => part.split('=')));
    if (!t || !sha256 || Math.abs(Date.now() - Number(t)) > SIGNATURE_TOLERANCE_MS) {
        return false;
    }
    const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
    return expected.length === sha256.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sha256));
}

// Minimal HTTP server — no framework dependency.
const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
        res.writeHead(404).end();
        return;
    }

    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
        // Verify against the exact raw bytes, before JSON parsing.
        const rawBody = Buffer.concat(chunks);

        if (!SKIP_SIGNATURE_VERIFICATION && !isValidSignatureV2(rawBody, req.headers['x-webautomate-signature-v2'], SIGNING_SECRET)) {
            console.warn('Rejected webhook: invalid or expired signature');
            res.writeHead(401).end();
            return;
        }

        let event;
        try {
            event = JSON.parse(rawBody.toString('utf8'));
        } catch {
            res.writeHead(400).end('Invalid JSON');
            return;
        }

        // Acknowledge quickly; WebAutomate expects a 2xx within 10 seconds.
        res.writeHead(200).end('ok');

        if (seenEventIds.has(event.eventId)) {
            console.log(`Duplicate delivery of ${event.eventId}, ignored`);
            return;
        }
        seenEventIds.add(event.eventId);

        handleEvent(event);
    });
});

function handleEvent({eventId, eventType, payload, sentAt}) {
    console.log(`\n[${new Date(sentAt).toISOString()}] ${eventType} (${eventId})`);

    switch (eventType) {
        case 'build.completed':
        case 'build.failed':
        case 'build.mixed':
        case 'build.cancelled': {
            const {requestData: build, projectConfig, buildResults} = payload;
            console.log(`  Project: ${projectConfig?.projectName ?? build?.projectId} (${build?.projectId})`);
            console.log(`  Build: ${build?.buildId}, state: ${build?.state}`);
            if (build?.start && build?.end) {
                console.log(`  Duration: ${((build.end - build.start) / 1000).toFixed(1)}s`);
            }
            console.log(`  Results in payload: ${buildResults?.length ?? 0} item(s)`);
            break;
        }

        case 'notification.test':
            console.log(`  Test webhook from ${payload.triggeredByEmail}: ${payload.message}`);
            break;

        default:
            console.log(`  Unhandled event type: ${eventType}`);
            console.log('  Payload:', JSON.stringify(payload, null, 2));
    }
}

server.listen(PORT, () => {
    console.log(`Webhook listener running on http://localhost:${PORT}/webhook`);
    console.log('Expose it publicly with: npx ngrok http ' + PORT);
    if (SKIP_SIGNATURE_VERIFICATION) {
        console.warn('Signature verification is OFF: any request to /webhook is accepted. Use this for local tests only.');
    }
});
