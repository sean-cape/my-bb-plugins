# bb-plugin-grpc-client

A native gRPC client for bb that runs [grpcurl](https://github.com/fullstorydev/grpcurl)
underneath. It has a searchable method browser, a request form generated from
the protos (or raw JSON), and a response view with status, headers, and
trailers. Call history is shared between the UI and `bb grpc`.

- `server.ts`: settings, page RPC, SQLite call history, and the `bb grpc` CLI.
- `host.ts`: runs on the bb machine. It builds descriptor sets (grpcurl
  `-protoset-out`, `buf build`, or merged protosets) and caches them under the
  plugin's host data dir. It also runs auth commands and invokes grpcurl. Header
  values reach grpcurl through environment variables and `-expand-headers`, so
  tokens never appear in argv.
- `shared/`: config schemas, the grpcurl `-v` output parser, and descriptor
  processing (`@bufbuild/protobuf`), including option-driven auth rules.
- `ui/`: the page. `MessageEditor.tsx` renders a form for any message,
  including oneofs, maps, repeated fields, and well-known types.

## Configuration

Four settings hold the config: `endpoints`, `sources`, and `auth` (raw JSON),
plus `grpcurl`, `buf`, `defaultSource`, and `timeoutSeconds`. The CLI edits
them:

```sh
bb grpc source add pt-apis --kind protoDir --path ~/dev/pt-apis --scan privatetech
bb grpc endpoint add dev --target dev.example.com:443 --source pt-apis
bb grpc endpoint add prod --target prod.example.com:443 --source pt-apis --protected
bb grpc endpoint add local --target localhost:14750 --transport plaintext --source pt-apis \
  --var authAddress=localhost:13370 --var 'authFlags= --insecure'
```

This is an example of option-driven auth, Cape's setup:

```json
{
  "profiles": {
    "okta": { "command": "ptctl auth okta print-bearer-token" },
    "subscriber": {
      "command": "cat ~/.pt/subscriber.jwt",
      "refreshCommand": "ptctl auth v-3 get-auth-token --address={{authAddress}}{{authFlags}}",
      "prefix": "bearer ",
      "vars": { "authAddress": "{{target}}", "authFlags": "" }
    }
  },
  "rules": [
    {
      "methodOption": "privatetech.auth.option.v1.method_auth_options",
      "serviceOption": "privatetech.auth.option.v1.service_auth_options",
      "field": "auth_type",
      "profiles": { "AUTH_TYPE_ADMIN": "okta", "AUTH_TYPE_USER": "subscriber", "AUTH_TYPE_UNAUTHENTICATED": null }
    }
  ]
}
```

## Development

```sh
npm install
npm run typecheck
npm test            # shared/ tests against shared/fixtures/shop.protoset
bb plugin build .
bb plugin reload grpc-client
```

To regenerate the fixture after you edit `shared/fixtures/**/*.proto`:

```sh
cd shared/fixtures && grpcurl -import-path . -proto acme/shop/v1/shop.proto -protoset-out shop.protoset describe
```
