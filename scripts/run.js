#!/usr/bin/env node
/**
 * Runs the Postman collections with Newman.
 *
 *   node scripts/run.js                      all collections (npm test)
 *   node scripts/run.js banking travel       only these (auth, ecommerce, banking, travel)
 *   node scripts/run.js --env local          against http://localhost:3100 (TEST_ENV=local works too)
 *   node scripts/run.js --open-report        only open the latest summary page
 *
 * Each collection is followed by its data-driven collections, run once per row of their data file.
 * Reports: reports/index.html (summary of the run, opens in Chrome), reports/html/*.html (one
 * htmlextra report per run), reports/junit/*.xml.
 *
 * Credentials come from environment variables or the git-ignored .env file and are passed to
 * Newman at run time, so they are never written into the collection or environment files.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, exec } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const REPORTS = path.join(ROOT, 'reports');
const INDEX = path.join(REPORTS, 'index.html');

/** What each name runs: the main collection, then data-driven collections with their data files. */
const PLAN = {
  auth: [
    { collection: 'collections/01-authentication.postman_collection.json' },
    { collection: 'collections/data-driven/invalid-logins.postman_collection.json', data: 'data/invalid-logins.json' },
    { collection: 'collections/data-driven/invalid-registrations.postman_collection.json', data: 'data/invalid-registrations.json' },
  ],
  ecommerce: [{ collection: 'collections/02-ecommerce.postman_collection.json' }],
  banking: [
    { collection: 'collections/03-banking.postman_collection.json' },
    { collection: 'collections/data-driven/amount-boundaries.postman_collection.json', data: 'data/amount-boundaries.json' },
    { collection: 'collections/data-driven/invalid-transfers.postman_collection.json', data: 'data/invalid-transfers.json' },
  ],
  travel: [
    { collection: 'collections/04-travel.postman_collection.json' },
    { collection: 'collections/data-driven/hotel-searches.postman_collection.json', data: 'data/hotel-searches.json' },
  ],
};

function parseArgs(argv) {
  const options = { names: [], env: (process.env.TEST_ENV || 'staging').toLowerCase(), openOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env') options.env = (argv[++i] || '').toLowerCase();
    else if (arg.startsWith('--env=')) options.env = arg.slice(6).toLowerCase();
    else if (arg === '--open-report') options.openOnly = true;
    else if (PLAN[arg]) options.names.push(arg);
    else throw new Error(`Unknown argument "${arg}". Use: ${Object.keys(PLAN).join(', ')}, --env local|staging, --open-report.`);
  }
  if (!['local', 'staging'].includes(options.env)) throw new Error('--env must be local or staging.');
  if (options.names.length === 0) options.names = Object.keys(PLAN);
  return options;
}

function credentials() {
  const names = ['TEST_USERNAME', 'TEST_PASSWORD', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'];
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`${missing.join(', ')} not set. Copy .env.example to .env and fill it in, or set them as environment variables.`);
  }
  return {
    testUsername: process.env.TEST_USERNAME.trim(),
    testPassword: process.env.TEST_PASSWORD.trim(),
    adminUsername: process.env.ADMIN_USERNAME.trim(),
    adminPassword: process.env.ADMIN_PASSWORD.trim(),
  };
}

/**
 * Names of requests whose body may hold a password (in the body itself, or built by their
 * pre-request script), so the HTML report hides their bodies.
 */
function requestsWithPasswords(collection) {
  const names = [];
  const walk = (items) => {
    for (const item of items || []) {
      if (item.item) {
        walk(item.item);
        continue;
      }
      const script = (item.event || []).map((event) => (event.script?.exec || []).join('\n')).join('\n');
      if (/password/i.test(item.request?.body?.raw || '') || /password/i.test(script)) names.push(item.name);
    }
  };
  walk(collection.item);
  return names;
}

function slug(file) {
  return path.basename(file).replace('.postman_collection.json', '');
}

function runNewman(newman, step, environment, creds, stamp) {
  const collectionPath = path.join(ROOT, step.collection);
  const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  const name = slug(step.collection);
  const htmlFile = path.join(REPORTS, 'html', `${name}.html`);
  const junitFile = path.join(REPORTS, 'junit', `${name}.xml`);
  const envVar = Object.entries(creds).map(([key, value]) => ({ key, value }));
  if (process.env.API_BASE_URL) envVar.push({ key: 'baseUrl', value: process.env.API_BASE_URL.replace(/\/+$/, '') });

  return new Promise((resolve, reject) => {
    newman.run(
      {
        collection,
        environment: path.join(ROOT, 'environments', `${environment}.postman_environment.json`),
        envVar,
        iterationData: step.data ? path.join(ROOT, step.data) : undefined,
        timeoutRequest: 30_000,
        reporters: ['cli', 'htmlextra', 'junit'],
        reporter: {
          htmlextra: {
            export: htmlFile,
            title: `QualityLab API tests - ${collection.info.name}`,
            browserTitle: `${collection.info.name} - Newman`,
            timezone: 'Asia/Manila',
            skipHeaders: ['Authorization', 'Cookie', 'Set-Cookie'],
            skipEnvironmentVars: Object.keys(creds),
            hideRequestBody: requestsWithPasswords(collection),
            showFolderDescription: true,
            testPaging: false,
          },
          junit: { export: junitFile },
        },
      },
      (error, summary) => {
        if (error) return reject(error);
        const stats = summary.run.stats;
        resolve({
          name: collection.info.name,
          file: step.collection.replace(/\\/g, '/'),
          data: step.data,
          iterations: stats.iterations.total,
          requests: { total: stats.requests.total, failed: stats.requests.failed },
          assertions: { total: stats.assertions.total, failed: stats.assertions.failed },
          failures: summary.run.failures.map((failure) => ({
            request: failure.source?.name || 'collection',
            test: failure.error?.test || failure.error?.name || 'error',
            message: failure.error?.message || String(failure.error),
            iteration: failure.cursor?.iteration,
          })),
          durationMs: (summary.run.timings.completed || Date.now()) - (summary.run.timings.started || stamp),
          html: path.relative(REPORTS, htmlFile).replace(/\\/g, '/'),
        });
      },
    );
  });
}

/** Belt and braces: hide passwords and session tokens if any reached a report. */
function redact(file, secrets) {
  if (!fs.existsSync(file)) return;
  let text = fs.readFileSync(file, 'utf8');
  for (const secret of secrets) if (secret && secret.length >= 6) text = text.split(secret).join('[hidden]');
  text = text.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[hidden-token]');
  fs.writeFileSync(file, text);
}

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Tests named "[DEFECT-nnn] …" (Travel › Known defects) fail on purpose until the app is fixed; see DEFECTS.md. */
const isKnownDefect = (failure) => /^\[DEFECT-\d+\]/.test(failure.request);

function writeIndex(results, environment, startedAt) {
  const totals = results.reduce(
    (sum, run) => ({
      requests: sum.requests + run.requests.total,
      assertions: sum.assertions + run.assertions.total,
      failed: sum.failed + run.assertions.failed,
      failedRequests: sum.failedRequests + run.requests.failed,
    }),
    { requests: 0, assertions: 0, failed: 0, failedRequests: 0 },
  );
  const passed = totals.assertions - totals.failed;
  const rate = totals.assertions ? Math.round((passed / totals.assertions) * 1000) / 10 : 0;
  // A run passes when its only failures are the known defects; any other failure fails it.
  const known = results.flatMap((run) => run.failures).filter(isKnownDefect).length;
  const status = totals.failed === known && totals.failedRequests === 0 ? 'passed' : 'failed';
  const duration = Math.round((Date.now() - startedAt) / 1000);
  const baseUrl = process.env.API_BASE_URL || JSON.parse(fs.readFileSync(path.join(ROOT, 'environments', `${environment}.postman_environment.json`), 'utf8')).values.find((v) => v.key === 'baseUrl').value;

  const rows = results
    .map((run) => {
      const ok = run.assertions.failed === 0 && run.requests.failed === 0;
      return `<tr><td><a href="${escape(run.html)}">${escape(run.name)}</a><span class="sub">${escape(run.file)}${run.data ? ` &middot; data: ${escape(run.data)} (${run.iterations} rows)` : ''}</span></td>
        <td class="num">${run.requests.total}</td><td class="num">${run.assertions.total}</td>
        <td class="num">${run.assertions.total - run.assertions.failed}</td><td class="num ${run.assertions.failed ? 'bad' : ''}">${run.assertions.failed}</td>
        <td><span class="pill ${ok ? 'passed' : 'failed'}">${ok ? 'Passed' : 'Failed'}</span></td></tr>`;
    })
    .join('');

  const failures = results.flatMap((run) => run.failures.map((failure) => ({ ...failure, collection: run.name })));
  const failureList = failures.length
    ? `<h2>Failures <span class="muted">${failures.length}</span></h2><table><thead><tr><th>Collection</th><th>Request</th><th>Check</th><th>Message</th></tr></thead><tbody>${failures
        .map((f) => `<tr><td>${escape(f.collection)}</td><td>${escape(f.request)}${f.iteration !== undefined ? ` <span class="sub">row ${f.iteration + 1}</span>` : ''}</td><td>${escape(f.test)}</td><td class="msg">${escape(f.message)}</td></tr>`)
        .join('')}</tbody></table>`
    : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QualityLab API test run</title><style>
:root{--ink:#16202a;--muted:#5d6b78;--line:#dde3e9;--bg:#f6f8fa;--card:#fff;--pass:#137a4b;--pass-bg:#e3f5ec;--fail:#b42318;--fail-bg:#fdeceb;--accent:#0f6e6e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI",system-ui,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 16px 48px}h1{margin:0 0 4px;font-size:24px}h2{font-size:17px;margin:24px 0 10px}
.meta,.muted,.sub{color:var(--muted);font-size:13px}.sub{display:block;font-size:12px}
.status{display:inline-block;margin-top:6px;padding:2px 10px;border-radius:999px;font-weight:600;font-size:12px;text-transform:uppercase}
.status.passed,.pill.passed{background:var(--pass-bg);color:var(--pass)}.status.failed,.pill.failed{background:var(--fail-bg);color:var(--fail)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:20px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.tile .v{font-size:24px;font-weight:700}.tile .l{color:var(--muted);font-size:12px;text-transform:uppercase}
.tile.bad .v{color:var(--fail)}.tile.good .v{color:var(--pass)}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#eef2f5;font-size:12px;text-transform:uppercase;color:var(--muted)}
td.num{text-align:right;font-variant-numeric:tabular-nums}td.bad{color:var(--fail);font-weight:600}td.msg{font-family:Consolas,monospace;font-size:12px;word-break:break-word}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}a{color:var(--accent)}
footer{margin-top:24px;color:var(--muted);font-size:12px}
</style></head><body><main>
<h1>QualityLab API test run</h1>
<div class="meta"><b>${escape(new Date(startedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }))}</b> &middot; ${escape(environment.toUpperCase())} &middot; ${escape(baseUrl)} &middot; Newman &middot; ${duration}s</div>
<span class="status ${status}">Run ${status}${known ? ` &middot; ${known} known defect${known === 1 ? '' : 's'}` : ''}</span>
<div class="tiles">
<div class="tile"><div class="v">${results.length}</div><div class="l">Collection runs</div></div>
<div class="tile"><div class="v">${totals.requests}</div><div class="l">Requests</div></div>
<div class="tile"><div class="v">${totals.assertions}</div><div class="l">Checks</div></div>
<div class="tile good"><div class="v">${passed}</div><div class="l">Passed</div></div>
<div class="tile ${totals.failed ? 'bad' : ''}"><div class="v">${totals.failed}</div><div class="l">Failed</div></div>
<div class="tile"><div class="v">${rate}%</div><div class="l">Pass rate</div></div>
</div>
<h2>Collections</h2><div class="wrap"><table><thead><tr><th>Collection (click for the full Newman report)</th><th>Requests</th><th>Checks</th><th>Passed</th><th>Failed</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>
${failureList ? `<div class="wrap">${failureList}</div>` : ''}
<footer>Known application defects are listed in DEFECTS.md. Generated by scripts/run.js.</footer>
</main></body></html>`;
  fs.writeFileSync(INDEX, html);
  fs.writeFileSync(path.join(REPORTS, 'summary.json'), `${JSON.stringify({ environment, baseUrl, startedAt: new Date(startedAt).toISOString(), totals, results }, null, 2)}\n`);
  return status;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform !== 'win32') return undefined;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  return roots.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((file) => fs.existsSync(file));
}

function openReport() {
  if (!fs.existsSync(INDEX)) {
    console.error('No report yet. Run the tests first: npm test');
    return;
  }
  const chrome = findChrome();
  const url = pathToFileURL(INDEX).href;
  if (process.platform === 'win32') {
    if (chrome) spawn(chrome, [url], { detached: true, stdio: 'ignore' }).unref();
    else exec(`start "" "${INDEX}"`);
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', chrome || 'Google Chrome', INDEX], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(chrome || 'google-chrome', [url], { detached: true, stdio: 'ignore' }).on('error', () => exec(`xdg-open "${INDEX}"`)).unref();
  }
  console.log(`Opening ${path.relative(process.cwd(), INDEX)} in ${chrome ? 'Google Chrome' : 'the default browser'}`);
}

function shouldOpen(status) {
  if (process.env.CI) return false;
  const mode = (process.env.OPEN_REPORT || 'always').toLowerCase();
  if (mode === 'never' || mode === 'false') return false;
  if (mode === 'on-failure') return status !== 'passed';
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.openOnly) return openReport();

  const creds = credentials();
  const newman = require('newman');
  fs.rmSync(REPORTS, { recursive: true, force: true });
  fs.mkdirSync(path.join(REPORTS, 'html'), { recursive: true });
  fs.mkdirSync(path.join(REPORTS, 'junit'), { recursive: true });

  const startedAt = Date.now();
  const results = [];
  for (const name of options.names) {
    for (const step of PLAN[name]) {
      console.log(`\n=== ${step.collection}${step.data ? ` with ${step.data}` : ''}`);
      results.push(await runNewman(newman, step, options.env, creds, startedAt));
    }
  }

  const secrets = [creds.testPassword, creds.adminPassword];
  for (const file of fs.readdirSync(path.join(REPORTS, 'html'))) redact(path.join(REPORTS, 'html', file), secrets);
  const status = writeIndex(results, options.env, startedAt);

  const failed = results.reduce((sum, run) => sum + run.assertions.failed, 0);
  const checks = results.reduce((sum, run) => sum + run.assertions.total, 0);
  const known = results.flatMap((run) => run.failures).filter(isKnownDefect).length;
  console.log(`\nRun ${status}: ${checks - failed} of ${checks} checks passed in ${results.length} collection runs${known ? ` (${known === failed ? `the ${known} failed checks are` : `${known} of the failed checks are`} known defects, see DEFECTS.md)` : ''}. Summary: ${path.relative(process.cwd(), INDEX)}`);
  if (shouldOpen(status)) openReport();
  process.exitCode = status === 'passed' ? 0 : 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
