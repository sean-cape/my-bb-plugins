A gRPC client inside bb, built on grpcurl.

## What you get

- A **gRPC** page with endpoint and proto source pickers, a searchable
  method list, a request form generated from your protos (or raw JSON), and a
  response view with status, timing, headers, and trailers.
- A **gRPC** action in a thread's side panel that opens the same view.
- Vim-style **keyboard navigation**: `j`/`k` and `h`/`l` through the method
  tree, call history and the request's fields, `i` to edit a field, `/` to
  search, `?` for the full list.
- `bb grpc` for agents and scripts. It can list, describe, and call methods,
  print the equivalent grpcurl command, and show call history.

## How it works

Endpoints are named targets (`local`, `dev`, `prod`, …). Proto sources are
server reflection, a proto directory, proto files, protosets, or a buf module.
Auth profiles are commands that print a token. The plugin picks a profile per
method, either per endpoint or from a custom proto option, and caches the
token until it expires. Endpoints marked protected ask before every call.
