import { execSync } from 'node:child_process';
import { createWriteStream, copyFileSync, chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const POSTJECT = join(ROOT, 'node_modules/.bin/postject');

const NODE_VERSION = '24.15.0';
const BLOB = 'bundle/sea.blob';

const envArg = process.argv.find(a => a.startsWith('--env='));
const ENV_NAME = envArg ? envArg.split('=')[1] : 'prod';

function buildEnvBanner(envName) {
    if (envName === 'prod') return '';
    const envFile = `.env.${envName}`;
    if (!existsSync(envFile)) {
        console.error(`Missing ${envFile} — create it with XPLANE_HOST, XPLANE_PORT, PROXY_PORT, etc.`);
        process.exit(1);
    }
    const lines = readFileSync(envFile, 'utf8').split('\n');
    const assignments = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        assignments.push(
            `process.env[${JSON.stringify(key)}] = process.env[${JSON.stringify(key)}] || ${JSON.stringify(val)};`
        );
    }
    if (!assignments.length) return '';
    return `// Baked defaults for environment: ${envName}\n${assignments.join('\n')}\n`;
}

const envBanner = buildEnvBanner(ENV_NAME);
const outputSuffix = ENV_NAME === 'prod' ? '' : `-${ENV_NAME}`;

if (ENV_NAME !== 'prod') {
    console.log(`Building for environment: ${ENV_NAME}`);
}

const PLATFORMS = [
    {
        name: 'linux-x64',
        output: `releases/xplane-proxy${outputSuffix}-linux-x64`,
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`,
        archive: join(tmpdir(), `xplane-proxy-node-${NODE_VERSION}-linux-x64.tar.gz`),
        extractBinary(archive) {
            const dir = join(tmpdir(), `xplane-proxy-node-${NODE_VERSION}-linux-x64`);
            mkdirSync(dir, { recursive: true });
            execSync(`tar -xzf "${archive}" -C "${dir}" --strip-components=2 "node-v${NODE_VERSION}-linux-x64/bin/node"`);
            return join(dir, 'node');
        },
        chmod: true,
    },
    {
        name: 'linux-arm64',
        output: `releases/xplane-proxy${outputSuffix}-linux-arm64`,
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.gz`,
        archive: join(tmpdir(), `xplane-proxy-node-${NODE_VERSION}-linux-arm64.tar.gz`),
        extractBinary(archive) {
            const dir = join(tmpdir(), `xplane-proxy-node-${NODE_VERSION}-linux-arm64`);
            mkdirSync(dir, { recursive: true });
            execSync(`tar -xzf "${archive}" -C "${dir}" --strip-components=2 "node-v${NODE_VERSION}-linux-arm64/bin/node"`);
            return join(dir, 'node');
        },
        chmod: true,
    },
    {
        name: 'win-x64',
        output: `releases/xplane-proxy${outputSuffix}-win-x64.exe`,
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
        archive: join(tmpdir(), `xplane-proxy-node-${NODE_VERSION}-win-x64.zip`),
        extractBinary(archive) {
            execSync(`unzip -o "${archive}" "node-v${NODE_VERSION}-win-x64/node.exe" -d "${tmpdir()}"`);
            return join(tmpdir(), `node-v${NODE_VERSION}-win-x64`, 'node.exe');
        },
        chmod: false,
    },
];

// nodejs.org drops connections now and then (ECONNRESET mid-download): retry with backoff
// rather than failing the whole release build on one flaky download.
async function download(url, dest, attempts = 5) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} for ${url}`);
            }
            await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
            return;
        } catch (err) {
            if (attempt >= attempts) {
                throw err;
            }
            const delayMs = 2 ** attempt * 1000;
            console.warn(`  Download failed (${err.cause?.code ?? err.code ?? err.message}), retry ${attempt}/${attempts - 1} in ${delayMs / 1000}s...`);
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}

mkdirSync('bundle', { recursive: true });
mkdirSync('releases', { recursive: true });

console.log('Bundling with esbuild...');
buildSync({
    entryPoints: ['src/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: 'bundle/main.cjs',
    keepNames: true,
    ...(envBanner ? { banner: { js: envBanner } } : {}),
});

console.log('Generating SEA blob...');
writeFileSync('sea-config.json', JSON.stringify({
    main: 'bundle/main.cjs',
    output: BLOB,
    disableExperimentalSEAWarning: true,
}, null, 2));
execSync('node --experimental-sea-config=sea-config.json', { stdio: 'inherit' });

for (const plat of PLATFORMS) {
    console.log(`\nBuilding ${plat.name}...`);

    console.log('  Downloading Node binary...');
    await download(plat.url, plat.archive);

    console.log('  Extracting...');
    const nodeBin = plat.extractBinary(plat.archive);

    copyFileSync(nodeBin, plat.output);
    if (plat.chmod) chmodSync(plat.output, 0o755);

    console.log('  Injecting SEA blob...');
    execSync(
        `"${POSTJECT}" "${plat.output}" NODE_SEA_BLOB "${BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
        { stdio: 'inherit' },
    );

    console.log(`  ✓ ${plat.output}`);
}

console.log('\nAll SEA binaries built successfully.');
