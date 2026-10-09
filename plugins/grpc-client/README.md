# bb-plugin-grpc-client

A native gRPC client for bb that runs [grpcurl](https://github.com/fullstorydev/grpcurl)
underneath. It has a searchable method browser, a request form generated from
the protos (or raw JSON), and a response view with status, headers, and
trailers. Call history is shared between the UI and `bb grpc`.

## Keyboard

Outside text boxes the view takes vim-style keys, with one cursor that moves
through the method list (or call history) and the request's fields. `j`/`k`
move it, `gg`/`G` jump to the ends, and `l` goes deeper: it expands a service,
opens a method and carries the cursor into its fields, steps into a section,
or edits a field. `h` goes back out: it collapses a section or service, climbs
to the enclosing one, and from a top-level field returns to the method list.
`o` or Enter opens the row under the cursor; `i`/`I` edit the field under it
with the caret at the start and `a`/`A` with it at the end, and Escape stops
editing and puts the cursor back on that field. `dd` removes a
list item, map entry, or header, unsets a field that is set (an optional field
goes back to unset), and otherwise empties the field's box.

`/` searches (Enter opens the first match and leaves the cursor on it, Escape
clears the search, then leaves it), `f` opens the filters, `e` the endpoint
picker, `c` toggles call history, and `b` shows or hides the list. `[`/`]` and
`{`/`}` cycle the request and response tabs, `m` switches between form and
JSON, `y` copies the grpcurl command, Ctrl-d/Ctrl-u scroll the response, and
⌘↵ sends. `j`/`k` and the arrows step through the open endpoint, filter, and
actions panels. `?` (or More → Keyboard shortcuts) lists them all; arrows work
as `hjkl`.

The method search, the filter panel's API search, and the request form's,
metadata's and options' boxes opt out of the vim-mode plugin: you type, and
one Escape returns to the cursor. The JSON editor keeps vim editing, so there
the first Escape enters vim's normal mode and a second returns to the keys.

## Configuration

Four settings hold the config: `endpoints`, `sources`, and `auth` (raw JSON),
plus `grpcurl`, `buf`, `defaultSource`, and `timeoutSeconds`. The CLI edits
them:

```sh
bb grpc source add test-apis --kind protoDir --path ~/src/test-apis --scan test
bb grpc endpoint add dev --target dev.example.com:443 --source test-apis
bb grpc endpoint add prod --target prod.example.com:443 --source test-apis --protected
bb grpc endpoint add local --target localhost:14750 --transport plaintext --source test-apis \
  --var authAddress=localhost:13370 --var authFlags=--insecure
```

Option-driven auth picks a profile per method from a custom option in the
protos. With a `test.auth.v1` option whose `auth_type` field is an enum:

```sh
bb grpc profile add admin --command 'test-auth print-admin-token'
bb grpc profile add user --command 'cat ~/.test-auth/user.jwt' \
  --refresh-command 'test-auth login --address={{authAddress}} {{authFlags}}' \
  --prefix 'Bearer ' --var 'authAddress={{target}}' --var 'authFlags='
bb grpc rule add --method-option test.auth.v1.method_auth_options \
  --service-option test.auth.v1.service_auth_options --field auth_type \
  --map AUTH_TYPE_ADMIN=admin --map AUTH_TYPE_USER=user --map AUTH_TYPE_UNAUTHENTICATED=none
```

That leaves this in the `auth` setting:

```json
{
  "profiles": {
    "admin": { "command": "test-auth print-admin-token" },
    "user": {
      "command": "cat ~/.test-auth/user.jwt",
      "refreshCommand": "test-auth login --address={{authAddress}} {{authFlags}}",
      "prefix": "Bearer ",
      "vars": { "authAddress": "{{target}}", "authFlags": "" }
    }
  },
  "rules": [
    {
      "methodOption": "test.auth.v1.method_auth_options",
      "serviceOption": "test.auth.v1.service_auth_options",
      "field": "auth_type",
      "profiles": { "AUTH_TYPE_ADMIN": "admin", "AUTH_TYPE_USER": "user", "AUTH_TYPE_UNAUTHENTICATED": null }
    }
  ]
}
```

Every config command accepts `--replace`, so running it again updates the entry
instead of failing.

## Development

```sh
npm install
npm run typecheck
npm test            # node --test, against shared/fixtures/shop.protoset
bb plugin build .
bb plugin reload grpc-client
```

To regenerate the fixture after you edit `shared/fixtures/**/*.proto`:

```sh
cd shared/fixtures && grpcurl -import-path . -proto acme/shop/v1/shop.proto -protoset-out shop.protoset describe
```
