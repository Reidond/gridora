# End-to-end tests

The local acceptance suite calls the exported API Worker through Hono. It uses an
in-memory SQLite adapter for the D1 methods that the application uses. The suite
applies the real SQL migrations before each test. It covers tenant selection,
inventory and audit isolation, invitation acceptance, and final-Owner protection.
It also proves that gated lifecycle requests do not create operations.

Run the local suite with this command:

```sh
pnpm exec vitest run tests/e2e
```

These tests do not claim browser, deployed Worker, D1, Durable Object, R2, email,
or provider acceptance. The API Worker exports an HTTP test seam. The web
application does not export a browser fixture that can bind this in-memory D1
adapter. A staging suite must cover the scenarios in `PRODUCT.md` section 32.7.
It must use dedicated test organizations and disposable provider resources.

Paid tests require all of these values:

- `live_test=true`;
- an expiry time of 60 minutes or less;
- a cleanup owner;
- restricted provider credentials;
- an `always` cleanup and reconciliation step.
