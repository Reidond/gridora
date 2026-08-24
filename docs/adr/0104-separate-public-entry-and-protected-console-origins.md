# ADR 0104: Separate public entry and protected console origins

- Status: Accepted
- Date: 2026-08-25
- Extends: ADR 0073 and ADR 0074

## Situation

Production browser QA loaded `https://gridora.coasts.red/sign-in` and
`/sign-up`, but `https://gridora.coasts.red/` failed with `Unexpected token
'<'`. The deployed web bundle had empty Nuxt public runtime values. It called
`/v1/auth/bootstrap` on the web Worker, which returned the SPA HTML instead of
the API JSON contract.

Gridora has two browser trust boundaries. `gridora.coasts.red` is the public
entry application for sign-in, sign-up, legal, and invitation routes.
`console.gridora.coasts.red` is the Cloudflare Access protected console. The API
is `api.gridora.coasts.red` and shares the protected Access application with the
console.

## Task

Bind every deployed web Worker to its exact environment origins. Keep public
entry routes outside Access. Send all other public-host routes through sign-in,
then complete authentication on the protected console origin.

## Execution

Define non-secret web runtime bindings for the API base, API data mode, Access
completion URL, and public application origin. Make the Cloudflare environment
renderer derive all four values from its already validated environment
hostnames. Use `https://console.<environment>/auth/complete` as the Access entry
URL. The completion page then posts opaque state to the API after Access has
issued the shared console/API browser cookie.

Classify public routes in one browser utility. When a protected console route
is requested on the public hostname, redirect to `/sign-in` with only a bounded
same-origin return path. Do not call a protected API from the unauthenticated
public origin.

## Consequences

The public Worker no longer guesses a relative API. Staging and production
cannot render each other's hostnames. The public hostname cannot display the
authenticated console or trigger its bootstrap request. The console and API
remain within their shared Cloudflare Access application, while the public
authentication-intent path retains its narrow bypass and CORS contract.

A missing or placeholder runtime value fails environment rendering. The same
web build can be promoted because the Worker injects the reviewed environment
values into the Nuxt response at request time.

## Verification

Require environment-render tests for staging and production, unit tests for
public-route classification and bounded return paths, Nuxt build, a local
rendered Worker response containing all four runtime values, complete CI and
Security, production deployment, and browser verification on
`gridora.coasts.red` and `console.gridora.coasts.red`.
