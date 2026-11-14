# Application defects found by the API tests

Genuine defects in the QualityLab API, found while building and running these collections against the deployed site. They are kept separate from test failures caused by the tests themselves, which were fixed in the tests.

Each defect has a test in the Travel collection's **Known defects** folder. Those tests are expected to fail until the application is fixed. The application itself was not changed.

| ID | Title | Severity | Status |
| --- | --- | --- | --- |
| [DEFECT-001](#defect-001) | Room availability ignores the number of guests | Medium | Open |
| [DEFECT-002](#defect-002) | Hotel details leave out fields the API documentation promises | Low | Open |

---

## DEFECT-001

**Room availability ignores the number of guests**

| | |
| --- | --- |
| Endpoint | `GET /api/v1/rooms/{id}?checkIn=…&checkOut=…&guests=…` |
| Severity | Medium: a client that trusts `available` offers a booking that will then be refused |
| Found | 14 November 2026, staging (https://quality-lab-jb.vercel.app) |
| Test | Travel › Known defects › `[DEFECT-001] Room availability ignores the number of guests` |

**Steps**

1. `GET /api/v1/rooms/room_0002_std?checkIn=2028-03-01&checkOut=2028-03-03&guests=9` (no sign-in needed). The room sleeps 2 (`maxGuests: 2`).
2. `POST /api/v1/bookings` for the same room, dates and `"guests": 9` (Travel token).

**Expected**

Step 1 says the room cannot be booked for 9 guests, either with `available: false` or with a validation error on `guests`, matching step 2.

**Actual**

- Step 1 returns `200 OK` with `"available": true` and `"availableRooms": 5`.
- Step 2 is refused with `422 GUEST_LIMIT_EXCEEDED`, "This room sleeps at most 2 guests."

The endpoint accepts and validates `guests` but does not use it when it works out availability.

**Likely cause**

`getRoom()` in `web-app/src/lib/services/hotels.ts` passes the stay to `roomsLeft()`, which only counts overlapping bookings. `guests` is never compared with `room.maxGuests`. The booking service does compare them, so the two endpoints disagree.

---

## DEFECT-002

**Hotel details leave out fields the API documentation promises**

| | |
| --- | --- |
| Endpoint | `GET /api/v1/hotels/{id}` |
| Severity | Low: a documentation and contract mismatch; clients generated from the OpenAPI document expect two fields that never arrive |
| Found | 14 November 2026, staging |
| Test | Travel › Known defects › `[DEFECT-002] Hotel details leave out fields the API documentation promises` |

**Steps**

1. `GET /api/v1/openapi.json`. `components.schemas.HotelDetail` is `allOf: [HotelSummary, { rooms }]`, so it includes every HotelSummary field, among them `fromPriceCents` and `matchingRooms`.
2. `GET /api/v1/hotels/hotel_0002`.

**Expected**

The response has every field the documentation lists for HotelDetail, including `fromPriceCents` and `matchingRooms`. Alternatively, the documentation lists only the fields the endpoint really returns.

**Actual**

The response has `id, name, city, country, address, description, starRating, amenities, imageUrl, rooms`. `fromPriceCents` and `matchingRooms` are missing.

**Note for the tests**

The normal HotelDetail schema check treats those two fields as optional (see `OPTIONAL` in `scripts/build-schemas.js`), so every other field is still checked, and only the Known defects test reports the gap.

---

## How to report a new defect here

1. Confirm that the failure is in the application, not in the test: repeat the request by hand in Postman, and compare it with the app's validation rules and the OpenAPI document.
2. Add a section like the ones above: endpoint, severity, steps, expected, actual, and the likely cause if known.
3. Add a request to the **Known defects** folder of the relevant collection, named `[DEFECT-00n] …`, that asserts the expected behaviour.
4. If a schema check is affected, list the field in `OPTIONAL` in `scripts/build-schemas.js` with a comment naming the defect.
