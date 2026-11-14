# QualityLab: API testing with Postman and Newman

Postman collections for the QualityLab REST API (`/api/v1`), run from the command line with Newman, with HTML reports. They test the deployed site by default, or a copy on your PC.

The project is independent of the web application and of the Selenium and Playwright frameworks. It only calls the public REST API.

| Part | Tool |
| --- | --- |
| Collections and environments | Postman (Collection v2.1 format) |
| Command-line runs | Newman 6.2 |
| HTML reports | newman-reporter-htmlextra, plus a summary page from `scripts/run.js` |
| Scripts | JavaScript (Postman sandbox; Node.js for the runner) |
| Data | JSON data files and JSON schemas |

To learn to do it by hand in the Postman app, follow **[docs/postman-guide.md](docs/postman-guide.md)**.

## What is tested

### Endpoint coverage

**35 of the API's 60 operations** (method + path), which is every endpoint in the Phase 4 scope:

| Area | Operations |
| --- | --- |
| Authentication | `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` |
| Products | `GET /products`, `GET /products/{id}`, `GET /products/categories` |
| Admin products and inventory | `GET /admin/products`, `POST /admin/products`, `GET /admin/products/{id}`, `PATCH /admin/products/{id}`, `DELETE /admin/products/{id}`, `POST /admin/products/{id}/inventory` |
| Cart | `GET /cart`, `DELETE /cart`, `POST /cart/items`, `PATCH /cart/items/{productId}`, `DELETE /cart/items/{productId}` |
| Checkout and orders | `POST /orders`, `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/cancel` |
| Banking | `GET /bank/accounts`, `GET /bank/accounts/{id}`, `GET /bank/accounts/{id}/transactions`, `POST /bank/deposits`, `POST /bank/withdrawals`, `POST /bank/transfers` |
| Travel | `GET /hotels`, `GET /hotels/{id}`, `GET /rooms/{id}`, `POST /bookings`, `GET /bookings`, `GET /bookings/{id}`, `POST /bookings/{id}/cancel` |

Not covered, because they are outside this phase: loans (8), cruises, ships and cruise bookings (6), online account opening with OTP (3), admin orders, stats and users (4), flash sale, bank products and health.

### Collections

| Collection | Requests | What it covers |
| --- | --- | --- |
| `01-authentication` | 27 | Registration (8-character password, duplicate email), login per module, wrong password, unauthorized access, module and role authorization, token validation, logout revocation, tampered token |
| `02-ecommerce` | 71 | Listing, search, filters, sorting, paging limits, invalid queries, product details, admin create/update/delete on a throwaway product, inventory, cart, checkout (approved, declined, invalid card, expired, missing details, empty cart, duplicate), orders |
| `03-banking` | 26 | Accounts, balance consistency, deposits, idempotency replay, 30-second duplicate rule, the ₱10,000.00 limit, withdrawals, insufficient funds, transfers, frozen accounts, other customers' accounts, history |
| `04-travel` | 43 | Hotel listing and search, details, room availability and stay rules, bookings (sold-out room, guest limit, 30-night maximum), details, cancellation, **Known defects** |
| `data-driven/invalid-logins` | 1 x 11 rows | Wrong password, unknown email, disabled account, missing or unknown module, bad email, missing password |
| `data-driven/invalid-registrations` | 1 x 11 rows | Password rules at 7 and 73 characters and each character rule, required fields, length limits |
| `data-driven/amount-boundaries` | 2 x 8 rows | Zero, negative, fractions, text, null, one centavo, one centavo over the limit |
| `data-driven/invalid-transfers` | 2 x 10 rows | Account number length and format, unknown, same, frozen, zero, over the limit, another customer's account |
| `data-driven/hotel-searches` | 1 x 13 rows | Destinations, stars and amenities, star limits, sort, invalid dates |

### Test design

Every request checks its **status code**, its **response body** values and, where there is a body, its **JSON schema**.

The collection-level script adds checks to **every** response:
- no 5xx error;
- answered within 20 seconds;
- an `x-request-id` header;
- a JSON body;
- for errors, the shared `ErrorResponse` schema.

| Coverage type | Where |
| --- | --- |
| Positive | Every happy path: register, login, list, create, update, buy, deposit, transfer, book, cancel |
| Negative | Wrong credentials, unknown ids, invalid input, refused business rules |
| Boundary | Password 7/8/72/73 characters, page size 0/1/100/101, quantity 0/99/100, amounts 0/1 centavo and ₱10,000.00 / ₱10,000.01, stars 0/1/5/6/7, stay 30/31 nights, guests 2/3, stock to exactly 0 / one below |
| Authentication | Missing token, malformed token, tampered signature, token after logout |
| Authorization | Token for the wrong module (`403 MODULE_NOT_ALLOWED`), customer on admin endpoints, another customer's account, order or booking (`403 FORBIDDEN`) |
| JSON schema | Built from the API's own OpenAPI document, with every documented field required (see below) |
| Required fields | Product create with only a name, empty shipping details, missing lead guest, missing destination, data-driven rows |
| Duplicate requests | Same email, same SKU, Idempotency-Key replay, identical deposit within 30 seconds, second checkout, cancelling twice, booking a sold-out room |

**Schemas.** `npm run schemas` downloads `/api/v1/openapi.json`, resolves its references, and makes **every documented field required**. The document lists fields but marks almost none as required, so without this a missing field would pass. The result is saved to `schemas/api-schemas.json` and to the `schemas` variable of each collection, which the tests read. Fields that are optional by design, or affected by a known defect, are listed with a reason in `OPTIONAL` in `scripts/build-schemas.js`.

## Results

Latest full run against the deployed site (14 November 2026, after the self-healing token fix): **9 collection runs, 255 requests, 1,602 checks: 1,600 passed, 2 failed.**

The 2 failures are the two **genuine application defects** in [DEFECTS.md](DEFECTS.md). Their tests are in the Travel collection's **Known defects** folder and will keep failing until the app is fixed:

- **DEFECT-001:** room availability ignores the number of guests.
- **DEFECT-002:** hotel details leave out two fields the API documentation promises.

Problems in the tests themselves were fixed while building them. For example, the session cookie set at sign-in was being sent with later requests and silently authenticating them; the cookie jar is now disabled.

## Installation

Requirements: Node.js 20.12 or newer (`node -v`). The Postman app is optional; you only need it to view or edit the collections.

In the `api-testing` folder, install Newman and the HTML reporter (exact versions from `package-lock.json`, about 70 MB, no browsers):

```bash
npm ci
```

## Configuration

Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored. Real environment variables win over `.env`.

| Variable | Meaning |
| --- | --- |
| `TEST_ENV` | `staging` (default, the deployed site) or `local` (`http://localhost:3100`) |
| `API_BASE_URL` | Optional: another API address, such as `https://…/api/v1` |
| `TEST_USERNAME`, `TEST_PASSWORD` | The seeded banking customer (Alice). Required. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | The seeded admin. Required for the admin product tests. |
| `OPEN_REPORT` | Open the summary in Chrome after a run: `always` (default), `on-failure` or `never`. Never on CI. |
| `CHROME_PATH` | Only if Chrome is installed somewhere unusual |

**Credentials never go into the repository:**
- `scripts/run.js` passes them to Newman as environment variables at run time.
- The environment files in `environments/` contain the API address and empty credential fields only.
- The HTML reports hide the `Authorization` header, the bodies of requests that contain passwords, and any token or password text.

The data-driven files use placeholders such as `<test user>` instead of real values.

## Running the tests

Run these in the `api-testing` folder (PowerShell, Command Prompt or a terminal):

| Goal | Command |
| --- | --- |
| Everything | `npm test` |
| One area | `npm run test:auth`, `npm run test:ecommerce`, `npm run test:banking`, `npm run test:travel` |
| Several areas | `node scripts/run.js banking travel` |
| Against a local copy | `npm run test:local` |
| Reopen the last summary | `npm run report` |
| Refresh the schemas from the API | `npm run schemas` |

Each area runs its main collection, then its data-driven collections with their data files.

Run one collection directly with Newman (credentials as `--env-var`):

```bash
npx newman run collections/03-banking.postman_collection.json -e environments/staging.postman_environment.json --env-var "testUsername=..." --env-var "testPassword=..." -r cli,htmlextra --reporter-htmlextra-export reports/html/banking.html
```

A data-driven collection with its data file:

```bash
npx newman run collections/data-driven/invalid-transfers.postman_collection.json -e environments/staging.postman_environment.json -d data/invalid-transfers.json --env-var "testUsername=..." --env-var "testPassword=..."
```

In those direct commands, type your own values instead of `...`. `npm test` is easier, because it reads `.env`.

Things to know:
- **Run one suite at a time.** Newman, Selenium and Playwright all use the same test customer's cart and balances.
- **On the live site each run leaves:**
  - one new user (registration can't be undone);
  - one deactivated product;
  - a few small banking transactions.

  Orders and bookings are cancelled, and the cart is emptied.

## Reports

After a run, `reports/` holds:

| File | Contents |
| --- | --- |
| `reports/index.html` | **Summary of the whole run**, opened in Chrome after the run: totals, one row per collection run with a link to its full report, and every failure |
| `reports/html/<collection>.html` | Full htmlextra report for each collection run: every request, response, header and check, with filters for failed tests |
| `reports/junit/<collection>.xml` | JUnit XML for CI tools |
| `reports/summary.json` | The run's totals and failures as JSON |

## Project structure

```text
api-testing/
├── collections/                   Postman collections (import these into Postman)
│   ├── 01-authentication.postman_collection.json
│   ├── 02-ecommerce.postman_collection.json
│   ├── 03-banking.postman_collection.json
│   ├── 04-travel.postman_collection.json
│   └── data-driven/               Collections run once per data row
├── environments/                  STAGING and LOCAL (API address only, empty credentials)
├── data/                          Data rows for the data-driven collections
├── schemas/api-schemas.json       JSON schemas built from the API's OpenAPI document
├── scripts/
│   ├── run.js                     Newman runner: data files, reports, summary, opens Chrome
│   └── build-schemas.js           npm run schemas
├── docs/postman-guide.md          Step-by-step guide for Postman
├── DEFECTS.md                     Genuine application defects found
├── .env.example                   Settings template (copy to .env)
└── package.json                   Newman and htmlextra, pinned
```

### How the collections work

- **Dynamic token handling.** Each collection's Pre-request script runs before every request. If the request's `Authorization` header is `Bearer {{token_<module>}}`, the script makes sure there is a valid token for that module, signing in with `pm.sendRequest` when needed, and caches it until a minute before it expires.
- **No cookies, self-healing tokens.** Every request has **Disable cookie jar** on, so it authenticates with its Bearer token only. `pm.sendRequest` still uses the cookie jar, and the app ends a session when a later sign-in sends its cookie. So the scripts:
  - forget the previous automatic sign-in's token whenever they sign in to another module;
  - forget any module token the API refuses with `401`;
  - try to clear the cookie after each sign-in. In the Postman app that last part needs the domain on the cookie allowlist, but the tests pass without it.
- **Variables:**
  - *Environment variables:* the base URL and credentials.
  - *Collection variables:* tokens, the schemas, and values saved by one request for the next (`createdProductId`, `orderId`, `bookingId`, balances).
  - *Local variables:* request bodies built from data rows.
- **Clean-up.** The admin tests create and then deactivate their own product, so real stock is never changed. Test orders and bookings are cancelled. The ₱10,000.00 limit test deposits and then withdraws the same amount.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `TEST_USERNAME, … not set` | Create `.env` from `.env.example`, or set the variables in your shell. |
| `Automatic sign-in to … failed: 401` | Wrong credentials, or not the seeded customer or admin. |
| Many `401` errors in the Postman app | Re-import the collections (**Replace**) and reset the `token_…` collection variables; see the guide, step 4. Collections imported before 15 November 2026 did not renew refused tokens. |
| Balance or cart checks fail unexpectedly | Another suite (Selenium, Playwright, or a second Newman run) is using the same customer at the same time. Run one at a time. |
| `409 DUPLICATE_TRANSACTION` on "one centavo" | Two runs within 30 seconds sent the same amount. Run again. |
| Schema failures after an app change | Run `npm run schemas` to rebuild the schemas from the API's current OpenAPI document. |
