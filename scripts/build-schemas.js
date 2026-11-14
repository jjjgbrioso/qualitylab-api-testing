#!/usr/bin/env node
/**
 * Builds the JSON schemas the collections validate responses against, from the API's own
 * OpenAPI document (GET /api/v1/openapi.json).
 *
 *   npm run schemas
 *
 * What it does:
 *  1. Downloads the OpenAPI document from the API base URL (API_BASE_URL, or the environment file).
 *  2. Resolves $ref links, so every schema stands alone.
 *  3. Makes every documented field required. The OpenAPI document lists fields but marks almost
 *     none as required, so without this a missing field would pass. A field the documentation
 *     promises but the API leaves out is reported as a schema failure.
 *  4. Wraps schemas in the API's response envelopes: { data }, { data: [...] } and { data, meta }.
 *  5. Writes schemas/api-schemas.json and updates the "schemas" collection variable in every
 *     collection, which the test scripts read.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

/** Which schemas the tests use, and in which envelopes. */
const USED = {
  User: ['one'],
  LoginResult: ['one'],
  Product: ['one', 'page'],
  Cart: ['one'],
  Order: ['one', 'page'],
  BankAccount: ['one', 'list'],
  BankTransaction: ['one', 'page'],
  HotelSummary: ['page'],
  HotelDetail: ['one'],
  Room: ['one'],
  Booking: ['one', 'page'],
  ErrorResponse: ['raw'],
};

/** Keywords JSON Schema validators understand; documentation-only keywords are dropped. */
const KEEP = new Set([
  'type', 'properties', 'items', 'required', 'enum', 'const', 'format', 'anyOf', 'oneOf', 'allOf',
  'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'additionalProperties',
]);

function apiBaseUrl() {
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL.replace(/\/+$/, '');
  const envName = (process.env.TEST_ENV || 'staging').toLowerCase();
  const file = path.join(ROOT, 'environments', `${envName}.postman_environment.json`);
  const values = JSON.parse(fs.readFileSync(file, 'utf8')).values;
  return values.find((value) => value.key === 'baseUrl').value.replace(/\/+$/, '');
}

function resolve(node, components, seen = []) {
  if (Array.isArray(node)) return node.map((item) => resolve(item, components, seen));
  if (!node || typeof node !== 'object') return node;
  if (node.$ref) {
    const name = node.$ref.split('/').pop();
    if (seen.includes(name)) throw new Error(`Circular schema reference: ${[...seen, name].join(' -> ')}`);
    return resolve(components[name], components, [...seen, name]);
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, resolve(schema, components, seen)]));
    } else if (KEEP.has(key)) {
      out[key] = resolve(value, components, seen);
    }
  }
  return out;
}

/**
 * Fields the API leaves out on purpose, so they stay optional. Keyed by schema name, then the
 * field's path inside that schema.
 */
const OPTIONAL = {
  // Only validation errors and some business errors list details, and a detail about the whole
  // request (such as "Provide at least one field to update.") has a message but no field.
  ErrorResponse: ['error.details', 'error.details.field'],
  // DEFECT-002 (see DEFECTS.md): the documentation says hotel details include these HotelSummary
  // fields, but GET /hotels/{id} does not return them. They stay optional here so the rest of the
  // schema is still checked; the test in the Travel collection's "Known defects" folder reports the gap.
  HotelDetail: ['fromPriceCents', 'matchingRooms'],
};

/** Every documented property becomes required, at every level, except the OPTIONAL ones. */
function strict(node, optional = [], prefix = '') {
  if (Array.isArray(node)) return node.map((item) => strict(item, optional, prefix));
  if (!node || typeof node !== 'object') return node;
  const out = { ...node };
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([name, schema]) => [name, strict(schema, optional, `${prefix}${name}.`)]),
    );
    out.required = Object.keys(out.properties).filter((name) => !optional.includes(`${prefix}${name}`));
  }
  if (out.items) out.items = strict(out.items, optional, prefix);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (out[key]) out[key] = out[key].map((item) => strict(item, optional, prefix));
  return out;
}

function envelope(kind, schema, pageMeta) {
  switch (kind) {
    case 'one':
      return { type: 'object', required: ['data'], properties: { data: schema } };
    case 'list':
      return { type: 'object', required: ['data'], properties: { data: { type: 'array', items: schema } } };
    case 'page':
      return { type: 'object', required: ['data', 'meta'], properties: { data: { type: 'array', items: schema }, meta: pageMeta } };
    default:
      return schema;
  }
}

async function main() {
  const base = apiBaseUrl();
  const response = await fetch(`${base}/openapi.json`);
  if (!response.ok) throw new Error(`GET ${base}/openapi.json returned ${response.status}`);
  const spec = await response.json();
  const components = spec.components.schemas;

  const pageMeta = strict(resolve(components.PageMeta, components));
  const schemas = {};
  for (const [name, kinds] of Object.entries(USED)) {
    if (!components[name]) throw new Error(`The OpenAPI document has no schema called ${name}.`);
    const base = strict(resolve(components[name], components), OPTIONAL[name] ?? []);
    for (const kind of kinds) schemas[kind === 'raw' ? name : `${name}_${kind}`] = envelope(kind, base, pageMeta);
  }

  const outDir = path.join(ROOT, 'schemas');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'api-schemas.json'), `${JSON.stringify(schemas, null, 2)}\n`);

  const value = JSON.stringify(schemas);
  const collections = listCollections(path.join(ROOT, 'collections'));
  let updated = 0;
  for (const file of collections) {
    const collection = JSON.parse(fs.readFileSync(file, 'utf8'));
    const variable = (collection.variable || []).find((item) => item.key === 'schemas');
    if (!variable) continue;
    variable.value = value;
    fs.writeFileSync(file, `${JSON.stringify(collection, null, '\t')}\n`);
    updated += 1;
  }

  console.log(`OpenAPI ${spec.openapi} from ${base}: ${Object.keys(schemas).length} schemas written to schemas/api-schemas.json; ${updated} collection(s) updated.`);
}

function listCollections(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listCollections(full);
    return entry.name.endsWith('.postman_collection.json') ? [full] : [];
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
