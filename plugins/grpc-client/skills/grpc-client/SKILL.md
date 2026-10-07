---
name: grpc-client
description: Call gRPC APIs with `bb grpc` (grpcurl underneath), using named endpoints such as local, dev, staging, and prod, plus proto sources and auth profiles that refresh tokens automatically. Use when the user wants to call, inspect, or describe a gRPC method, list a server's services, configure gRPC endpoints, proto sources, or auth, or debug a failing gRPC call.
---

# gRPC plugin

`bb grpc` and the **gRPC** page in the bb sidebar share one
configuration and one call history. The page has a request form generated
from the protos. The CLI is the scriptable version, so prefer it when you
call methods for the user.

## Calling methods

```sh
bb grpc list                                         # endpoints, sources, auth profiles
bb grpc methods dev --filter healthservice           # find methods; [auth=okta] shows the profile used
bb grpc describe dev HealthServiceAdminAPI/ListLatestFeatureStates   # request fields, enums, comments
bb grpc call dev pkg.v1.FooAPI/GetFoo --data '{"id": "123"}'
bb grpc call dev GetFoo --data-stdin < request.json  # unique method names work too
bb grpc call dev pkg.v1.FooAPI/GetFoo --json         # status, headers, trailers, every response
bb grpc command dev pkg.v1.FooAPI/GetFoo --data '{}' # copyable grpcurl command
bb grpc history
```

- Request JSON uses proto3 JSON mapping. Fields are lowerCamelCase or proto
  names, 64-bit integers are strings, enums are value names, and
  Timestamp/Duration are strings such as `"2024-01-01T00:00:00Z"` and `"1.5s"`.
  Run `describe` first rather than guessing field names.
- For client-streaming methods, pass a JSON array to send one message per element.
- `-H 'name: value'` adds metadata. It overrides auth and endpoint headers with
  the same name.
- Exit code 1 means failure. stderr carries `Code: message` and any status
  details.
- **Protected endpoints** (typically prod) refuse calls without `--yes`. Ask
  the user before every call to a protected endpoint, and especially before a
  mutating method (Create/Update/Delete/Set…). Read-only calls on dev and local
  need no confirmation.

## Auth

The plugin chooses an auth profile for each method:

1. If the endpoint sets `auth`, that profile is used for every method.
   `"none"` disables auth.
2. Otherwise, `rules` match a custom method option, or the service option as a
   fallback, and map its value to a profile. For example, Cape's
   `privatetech.auth.option.v1` `auth_type` maps `AUTH_TYPE_ADMIN` to `okta`
   and `AUTH_TYPE_USER` to `subscriber`.

A profile runs `command` and sends the trimmed stdout, with `prefix`
prepended, as `header`. If the command fails or prints an expired JWT,
`refreshCommand` runs and then `command` runs again. Values are cached until
the JWT expires, or for 5 minutes when the value is not a JWT. Commands can
use `{{target}}`, `{{host}}`, `{{port}}`, `{{endpoint}}`, and any `vars`.
Endpoint vars override the profile's defaults.

`bb grpc auth reset` clears cached tokens. Run it after you log in again or
switch accounts.

## Configuring

```sh
bb grpc source add protos --kind protoDir --path ~/src/protos --scan api
bb grpc source add mod --kind buf --path ~/src/protos            # buf build, resolves BSR deps
bb grpc endpoint add local --target localhost:50051 --transport plaintext
bb grpc endpoint add prod --target api.example.com:443 --source protos --protected
bb grpc profile add okta --command 'mytool print-token' --prefix 'Bearer '
```

Auth rules exist only in the raw `auth` JSON setting:
`bb plugin config grpc-client set auth '<json>'`. The JSON shape is
`{profiles: {...}, rules: [{methodOption, serviceOption, field, profiles: {VALUE: profile|null}}]}`.

Descriptors are cached per source, and per endpoint for `reflection`. The
cache rebuilds by itself when a proto file changes. Use `--reload`, or
**Reload protos** in the UI, after a server's reflection output changes.

## Troubleshooting

- `PermissionDenied` or `Unauthenticated`: run `bb grpc describe` to see which
  profile the method uses, then `bb grpc auth reset` and call again.
- `Failed to dial target host`: the endpoint is down, or the transport is
  wrong (`plaintext` vs `tls`).
- `has no known field named …`: the request JSON does not match. Check
  `describe`.
- Never print header values or tokens. Results mask auth and endpoint header
  values, and history masks sensitive metadata.
