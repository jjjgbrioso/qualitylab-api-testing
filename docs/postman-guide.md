# Doing it by hand in Postman

A step-by-step guide to running and writing the QualityLab API tests in the Postman app. Everything here uses the same collection files that Newman runs, so what you do by hand is exactly what the automation does.

Work through it in order the first time. Each step builds on the one before.

---

## 1. Install Postman and sign in

1. Download the Postman desktop app from https://www.postman.com/downloads/ and install it.
2. Sign in, or create a free account. Postman needs an account for most features, including collections and the Collection Runner.

The free plan is enough for this guide. Postman's own documentation says manual Collection Runner runs are not limited on its current plans. Some third-party sites report a monthly limit on the free plan, though. If you ever hit a limit, run the same collections with Newman (`npm test`), which has none.

## 2. Import the collections and environments

1. In Postman, click **Import** (top left).
2. Drag in, or choose, these files from `QualityLab/api-testing/`:
   - `collections/01-authentication.postman_collection.json`
   - `collections/02-ecommerce.postman_collection.json`
   - `collections/03-banking.postman_collection.json`
   - `collections/04-travel.postman_collection.json`
   - the five files in `collections/data-driven/`
   - `environments/staging.postman_environment.json` (and `local.postman_environment.json` if you run the app on your PC)
3. Click **Import**. The collections appear on the left under **Collections**, and the environments under **Environments**.

## 3. Set your credentials safely

1. Open **Environments** → **QualityLab - STAGING**.
2. Fill in the **Current value** column, never the **Initial value**, for:
   - `testUsername` and `testPassword`: the seeded customer (Alice)
   - `adminUsername` and `adminPassword`: the seeded admin
3. Click **Save**.
4. At the top right of Postman, choose **QualityLab - STAGING** in the environment drop-down.

Why the Current value only:
- **Initial value** is shared: Postman syncs it to its cloud and includes it when you export the environment.
- **Current value** stays on your PC.

Never put real credentials in the Initial value, and never share a workspace that holds them. The files in the repository have empty values on purpose.

## 4. Optional: allow the scripts to clear one cookie

The collections sign in for you (step 6). Each sign-in also receives the app's session cookie. A later sign-in that sends that cookie ends the earlier session, because the app allows one session per browser.

The scripts cope with this on their own:
- When they sign in to another module, they forget the previous automatic sign-in's token.
- Any module token the API refuses with `401` is thrown away, so the next request signs in again.

This works whether or not Postman lets the scripts touch cookies.

To save a few extra sign-ins, you can let the scripts remove the cookie after each sign-in:

1. Click **Cookies**, on the right of the row with Params, Authorization, Headers, Body, Scripts and Settings.
2. Click **Domains Allowlist**.
3. Add `quality-lab-jb.vercel.app`: the domain only, with no `https://`. Add `localhost` too if you test a local copy.
4. Close the window.

**If you imported the collections before 15 November 2026,** some runs failed with `401` on module tokens. Re-import the collections (Import > choose the files > **Replace**) to get the self-healing scripts. Then, in each collection's **Variables** tab, clear the Current value of the `token_…` variables, or use **Reset all**.

## 5. Send your first request

1. Open **01 - QualityLab Authentication** → **Login** → **Login - E-commerce**.
2. Click **Send**.
3. Look at the response panel at the bottom:
   - **Status** shows `200 OK` and the time taken.
   - **Body** is the JSON response: `token`, `tokenType`, `expiresIn`, `module` and `user`.
   - **Headers** shows `x-request-id` and `Set-Cookie`.
   - **Test Results** lists every check with PASS or FAIL. Some come from this request's **Tests** tab, and those marked `[every response]` come from the collection.

Try a wrong password: open **Login - a wrong password is refused** and **Send**. You get `401` with a neutral message, and every check passes because a refusal is what's expected.

## 6. See how tokens work (dynamic token handling)

Each sign-in opens one module, so each module has its own token.

1. Open **03 - QualityLab Banking** → **Accounts** → **Accounts - list my accounts**.
2. Open the **Headers** tab. `Authorization` is `Bearer {{token_banking}}`, a variable, not a real token.
3. Click the collection name **03 - QualityLab Banking** → **Scripts** → **Pre-request**. This script runs before every request in the collection. It:
   - reads the request's `Authorization` header to see which module it needs (`banking` here);
   - if there's no token for that module yet, or it expires within a minute, signs in with `pm.sendRequest` using your environment's credentials;
   - saves the token as the collection variable `token_banking`, with its expiry time;
   - forgets the previous automatic sign-in's token, and tries to clear the session cookie the sign-in returned (see step 4);
   - and the collection's **Post-response** script forgets any module token the API refuses with `401`.
4. Send the request. Then open the collection's **Variables** tab: `token_banking` now has a Current value.

Every request in these collections also has **Settings → Disable cookie jar** switched on, so it authenticates with the Bearer token only.

## 7. Read a test script

Open **03 - QualityLab Banking** → **Deposit** → **Deposit - a small amount into checking**.

- **Scripts → Pre-request** picks a small random amount and a new `Idempotency-Key`:
  ```js
  pm.collectionVariables.set('amount', String(101 + Math.floor(Math.random() * 899)));
  pm.collectionVariables.set('idempotencyKey', pm.variables.replaceIn('{{$guid}}'));
  ```
- The **Body** uses them: `"amountCents": {{amount}}`. The variable has no quotes because it is a number.
- **Scripts → Post-response** (the Tests) checks the result:
  ```js
  pm.test('Status is 201 Created', () => {
    pm.response.to.have.status(201);                       // status code validation
  });

  pm.test('Response matches the BankTransaction schema', () => {
    const schemas = JSON.parse(pm.collectionVariables.get('schemas'));
    pm.response.to.have.jsonSchema(schemas.BankTransaction_one);   // JSON schema validation
  });

  const transaction = pm.response.json().data;              // response body validation
  pm.test('A DEPOSIT of the amount with a TXN- reference', () => {
    pm.expect(transaction.type).to.eql('DEPOSIT');
    pm.expect(transaction.amountCents).to.eql(Number(pm.collectionVariables.get('amount')));
  });
  ```

The next three requests show **duplicate request validation**:
1. **The same request again** reuses the same Idempotency-Key. The API replays the first answer, with the header `Idempotent-Replayed: true`.
2. **The balance moved only once** proves no second deposit happened.
3. **An identical deposit within 30 seconds** uses a new key. The API refuses it with `409 DUPLICATE_TRANSACTION`.

Send these three one after another to watch it happen.

## 8. Run a whole folder or collection

1. Right-click a collection or folder, for example **02 - QualityLab E-commerce** → **Run**. Or click **Runner** at the bottom.
2. Keep the order as it is: later requests use values saved by earlier ones, such as `createdProductId` and `orderId`.
3. Click **Run 02 - QualityLab E-commerce**.
4. The results show every request with its checks. Click one to see its request and response.

Notes:
- Run **one collection at a time**, and not while the Selenium or Playwright suites are running: they share the test customer's cart and balances.
- The Travel collection's **Known defects** folder is expected to fail. See `DEFECTS.md`.

## 9. Run a data-driven test

The `collections/data-driven/` collections run once per row of a data file.

1. Open the Runner for **Data-driven - Invalid transfers**.
2. Under **Data**, click **Select File** and choose `data/invalid-transfers.json`. Postman shows the rows and sets **Iterations** to 10.
3. Click **Run**.
4. Each iteration is one case: 5 digits, 11 digits, letters, unknown account, frozen account, and so on. The request name shows the case, for example **Transfer - a frozen account**.

Open `data/invalid-transfers.json` in VS Code to see a row:

```json
{ "case": "a frozen account", "from": "<checking id>", "to": "1000000004", "amountCents": 1000,
  "expectedStatus": 422, "expectedCode": "ACCOUNT_FROZEN", "expectedMessage": "Account 1000000004 is frozen." }
```

The request's Pre-request script turns the row into the request body (`pm.iterationData`). The Post-response script checks the row's expected status, code, field and message. To add a case, add a row; no script changes needed.

## 10. Write your own request and test

Let's add a check that the cart refuses a quantity of 150.

1. In **02 - QualityLab E-commerce** → **Cart**, right-click **Cart - quantity 100 is refused** → **Duplicate**.
2. Rename the copy **Cart - quantity 150 is refused**.
3. In **Body**, change `100` to `150`.
4. In **Scripts → Post-response**, keep the status check and make sure the message check still expects `Quantity must be at most 99.`
5. **Send** it. The cart must have the product in it, so run **Cart - add 2 of a product** first.
6. Click **Save**.

## 11. Save your changes back to the files

Postman keeps your edits in your workspace. To put them in the repository:

1. Right-click the collection → **More** → **Export** → **Collection v2.1** → **Export**.
2. Save it over the same file in `api-testing/collections/` (for example `02-ecommerce.postman_collection.json`).
3. Check the change in VS Code or with `git diff`, then commit it.

Before exporting, make sure no real password or token is in an **Initial value**. Exports include Initial values, not Current values.

If you change response schemas in the app, run `npm run schemas` afterwards. It refreshes the `schemas` variable in every collection file from the API's OpenAPI document.

## 12. Run the same thing with Newman

In a terminal in the `api-testing` folder:

```bash
npm run test:ecommerce
```

Newman runs the same collection with the same scripts and checks, then opens the summary page in Chrome. If Postman and Newman agree, your exported collection is good.

---

## Practice exercises

1. **Boundary:** in **Data-driven - Amount boundaries**, add a row for `999999` centavos (₱9,999.99, just under the limit), expecting `201`. Run it in the Runner with the data file.
   *Hint:* copy the "one centavo" row and change `case`, `amountCents` and `expectedStatus`.
2. **Authorization:** duplicate **Accounts - another customer's account is refused** and change it to read Bob's savings, `acct_bob_frz`. What status and code do you expect?
3. **Negative:** add a checkout request with the CVV `12`, and check for `400` with a field error on `payment.cvv`.
   *Hint:* copy **Checkout - an expired card** and change the body and the test.
4. **Schema:** in **Product details - a product on sale**, temporarily change `Product_one` to `Order_one` and send it. See how a schema failure is reported, then change it back.
5. **Your own data file:** create `data/my-hotel-searches.json` with two rows (a city and a star rating), and run **Data-driven - Hotel searches** with it.
