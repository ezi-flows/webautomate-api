import 'dotenv/config';

const BASE_URL = 'https://api.webautomate.app/developer/v1';
const {WEBAUTOMATE_API_TOKEN, WEBAUTOMATE_ACCOUNT_ID} = process.env;

if (!WEBAUTOMATE_API_TOKEN || !WEBAUTOMATE_ACCOUNT_ID) {
    console.error('Missing WEBAUTOMATE_API_TOKEN or WEBAUTOMATE_ACCOUNT_ID in .env');
    process.exit(1);
}

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
        const data = await request(`/projects/${WEBAUTOMATE_ACCOUNT_ID}`, {
            method: 'POST',
            body: JSON.stringify(cursor ? {limit, cursor} : {limit}),
        });
        projects.push(...data.projects);
        cursor = data.pagination.nextCursor;
    } while (cursor);

    return projects;
}

async function deleteProject(projectId) {
    return request(`/project-delete/${WEBAUTOMATE_ACCOUNT_ID}/${projectId}`, {method: 'DELETE'});
}

// List all projects
const projects = await listProjects();
console.log(`Found ${projects.length} project(s):\n`);

for (const project of projects) {
    const {configData, latestBuild} = project;

    console.log(`  - ${configData?.projectName ?? '(unnamed)'} (${project.id})`);
    console.log(`    Solution: ${configData?.solution?.key ?? 'n/a'}`);
    console.log(`    State: ${project.state}`);
    console.log(`    Created: ${new Date(project.created).toLocaleString()}`);
    if (latestBuild) {
        console.log(`    Latest build: #${latestBuild.index} (${latestBuild.state})`);
    }
    console.log();
}

// Uncomment to delete a specific project (requires the projects.delete scope):
// const result = await deleteProject('your-project-id');
// console.log('Deleted:', result);
