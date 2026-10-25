import 'dotenv/config';

const BASE_URL = 'https://api.webautomate.app/developer/v1';
const {WEBAUTOMATE_API_TOKEN, WEBAUTOMATE_ACCOUNT_ID} = process.env;

const USAGE = `Usage:
  npm run list                         List all projects
  npm run delete -- <projectId>        Show the project that would be deleted
  npm run delete -- <projectId> --yes  Delete it permanently (needs the projects.read and projects.delete scopes)`;

const args = process.argv.slice(2);
const command = args[0];
const projectId = args.slice(1).find((arg) => !arg.startsWith('--'));
const confirmed = args.includes('--yes');

if (!['list', 'delete'].includes(command)) {
    console.error(USAGE);
    process.exit(1);
}

if (command === 'delete' && !projectId) {
    console.error(`Missing project ID.\n\n${USAGE}`);
    process.exit(1);
}

if (!WEBAUTOMATE_API_TOKEN || !WEBAUTOMATE_ACCOUNT_ID) {
    console.error('Missing WEBAUTOMATE_API_TOKEN or WEBAUTOMATE_ACCOUNT_ID in .env');
    process.exit(1);
}

const accountPath = encodeURIComponent(WEBAUTOMATE_ACCOUNT_ID);

const headers = {
    Authorization: `Bearer ${WEBAUTOMATE_API_TOKEN}`,
    'Content-Type': 'application/json',
};

async function request(path, options = {}) {
    const res = await fetch(`${BASE_URL}${path}`, {headers, ...options});
    const body = await res.json().catch(() => null);

    if (!res.ok || !body?.success) {
        throw new Error(`${options.method ?? 'GET'} ${path} failed (${res.status}): ${body?.error?.message ?? 'unknown error'}`);
    }

    return body.data;
}

async function listProjects({limit = 50} = {}) {
    const projects = [];
    let cursor;

    do {
        const data = await request(`/projects/${accountPath}`, {
            method: 'POST',
            body: JSON.stringify(cursor ? {limit, cursor} : {limit}),
        });
        projects.push(...data.projects);
        cursor = data.pagination.nextCursor;
    } while (cursor);

    return projects;
}

async function deleteProject(id) {
    return request(`/project-delete/${accountPath}/${encodeURIComponent(id)}`, {method: 'DELETE'});
}

function printProject({id, configData, state, created, latestBuild}) {
    console.log(`  - ${configData?.projectName ?? '(unnamed)'} (${id})`);
    console.log(`    Solution: ${configData?.solution?.key ?? 'n/a'}`);
    console.log(`    State: ${state}`);
    console.log(`    Created: ${new Date(created).toLocaleString()}`);
    if (latestBuild) {
        console.log(`    Latest build: #${latestBuild.index} (${latestBuild.state})`);
    }
    console.log();
}

if (command === 'list') {
    const projects = await listProjects();
    console.log(`Found ${projects.length} project(s):\n`);
    projects.forEach(printProject);
} else {
    // The API has no single-project lookup, so find the project in the list before deleting it.
    const project = (await listProjects()).find(({id}) => id === projectId);
    if (!project) {
        console.error(`No project with ID ${projectId} in account ${WEBAUTOMATE_ACCOUNT_ID}. Run npm run list to see the IDs.`);
        process.exit(1);
    }

    printProject(project);
    if (!confirmed) {
        console.log('Deleting removes this project and all its builds and results permanently.');
        console.log(`To delete it, run: npm run delete -- ${projectId} --yes`);
    } else {
        const result = await deleteProject(projectId);
        console.log(`Deleted project ${result.projectId ?? projectId}.`);
    }
}
