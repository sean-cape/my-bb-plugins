import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { endpointSchema, profileSchema, renderTemplate, type AuthRule } from "./config.ts";
import { createRegistry, findMethod, listServices, parseDescriptorSets, typeClosure } from "./descriptors.ts";
import { invokeArgs, parseErrorStatus, parseVerboseOutput, splitJsonArray } from "./grpcurl.ts";
import { matchMethods } from "./schema.ts";

const registry = createRegistry(parseDescriptorSets([readFileSync(new URL("./fixtures/shop.protoset", import.meta.url))]));
const endpoint = endpointSchema.parse({ name: "dev", target: "api.example.com:443" });
const rules: AuthRule[] = [
  {
    methodOption: "acme.auth.v1.method_auth_options",
    serviceOption: "acme.auth.v1.service_auth_options",
    field: "auth_type",
    profiles: { AUTH_TYPE_ADMIN: "okta", AUTH_TYPE_USER: "subscriber", AUTH_TYPE_UNAUTHENTICATED: null },
  },
];

test("auth rules prefer the method option, then fall back to the service option", () => {
  const services = listServices(registry, rules, endpoint);
  const orders = services.find((service) => service.typeName === "acme.shop.v1.OrderAPI")!;
  const [get, list, cancel] = orders.methods;
  assert.deepEqual([cancel?.auth, cancel?.authReason], ["subscriber", "AUTH_TYPE_USER (service option)"]);
  assert.deepEqual([get?.auth, get?.authReason], ["subscriber", "AUTH_TYPE_USER (service option)"]);
  assert.deepEqual([list?.auth, list?.authReason], ["okta", "AUTH_TYPE_ADMIN (method option)"]);
  assert.equal(list?.authValue, "AUTH_TYPE_ADMIN");
  assert.equal(list?.kind, "server_streaming");
  assert.equal(get?.comment, "Gets one order.");
  assert.equal(orders.comment, "Manages orders.");
  const ping = services.find((service) => service.typeName === "acme.shop.v1.PingAPI")!.methods[0];
  assert.deepEqual([ping?.auth, ping?.authReason], [null, null]);
});

test("an endpoint auth override wins over rules", () => {
  const forced = endpointSchema.parse({ name: "x", target: "a:1", auth: "okta" });
  const none = endpointSchema.parse({ name: "x", target: "a:1", auth: "none" });
  const method = listServices(registry, rules, forced).find((service) => service.typeName === "acme.shop.v1.OrderAPI")!.methods[0];
  assert.equal(method?.auth, "okta");
  const disabled = listServices(registry, rules, none).find((service) => service.typeName === "acme.shop.v1.OrderAPI")!.methods[0];
  assert.equal(disabled?.auth, null);
});

test("type closure covers nested messages, enums, maps, oneofs and recursion", () => {
  const closure = typeClosure(registry, "acme.shop.v1.Order");
  assert.deepEqual(Object.keys(closure.messages).sort(), [
    "acme.shop.v1.LineItem",
    "acme.shop.v1.Order",
    "google.protobuf.Timestamp",
  ]);
  assert.deepEqual(Object.keys(closure.enums), ["acme.shop.v1.Order.Status"]);
  const order = closure.messages["acme.shop.v1.Order"]!;
  const byName = Object.fromEntries(order.fields.map((field) => [field.name, field]));
  assert.equal(byName.items?.cardinality, "list");
  assert.equal(byName.labels?.cardinality, "map");
  assert.equal(byName.labels?.mapKey, "string");
  assert.equal(byName.card?.oneof, "payment");
  assert.equal(byName.credit_cents?.scalar, "int64");
  assert.equal(byName.created_at?.jsonName, "createdAt");
  assert.deepEqual(order.oneofs, ["payment"]);
  const request = typeClosure(registry, "acme.shop.v1.ListOrdersRequest").messages["acme.shop.v1.ListOrdersRequest"]!;
  assert.deepEqual(
    request.fields.map((field) => [field.name, field.optional]),
    [
      ["page_size", false],
      ["cursor", true],
    ],
  );
  assert.equal(typeClosure(registry, "acme.shop.v1.GetOrderRequest").messages["acme.shop.v1.GetOrderRequest"]?.fields[0]?.comment, "The order id.");
});

test("findMethod accepts slash and dot forms", () => {
  assert.equal(findMethod(registry, "acme.shop.v1.OrderAPI/GetOrder")?.name, "GetOrder");
  assert.equal(findMethod(registry, "acme.shop.v1.OrderAPI.ListOrders")?.name, "ListOrders");
  assert.equal(findMethod(registry, "acme.shop.v1.OrderAPI/Nope"), undefined);
});

test("templates expand built-ins and endpoint vars over profile defaults", () => {
  const profile = profileSchema.parse({
    command: "ptctl get --address={{authAddress}}{{flags}}",
    vars: { authAddress: "{{target}}", flags: "" },
  });
  assert.equal(renderTemplate(profile.command, endpoint, profile), "ptctl get --address=api.example.com:443");
  const local = endpointSchema.parse({ name: "local", target: "localhost:1", vars: { authAddress: "localhost:13370", flags: " --insecure" } });
  assert.equal(renderTemplate(profile.command, local, profile), "ptctl get --address=localhost:13370 --insecure");
  assert.throws(() => renderTemplate("{{missing}}", endpoint, profile), /Unknown placeholder \{\{missing\}\}/);
  assert.equal(renderTemplate("{{host}}/{{port}}/{{endpoint}}", endpoint, profile), "api.example.com/443/dev");
});

const VERBOSE = `
Resolved method descriptor:
// Gets one order.
rpc GetOrder ( .acme.shop.v1.GetOrderRequest ) returns ( .acme.shop.v1.Order );

Request metadata to send:
authorization: Bearer secret
x-team: core

Response headers received:
content-type: application/grpc
server: envoy

Response contents:
{
  "id": "1"
}

Response contents:
{
  "id": "2"
}

Response trailers received:
(empty)
Sent 1 request and received 2 responses
`;

test("verbose output parses metadata, every response and the summary", () => {
  const parsed = parseVerboseOutput(VERBOSE);
  assert.deepEqual(parsed.requestMetadata, [
    ["authorization", "Bearer secret"],
    ["x-team", "core"],
  ]);
  assert.deepEqual(parsed.headers, [
    ["content-type", "application/grpc"],
    ["server", "envoy"],
  ]);
  assert.deepEqual(parsed.responses, [{ id: "1" }, { id: "2" }]);
  assert.deepEqual(parsed.trailers, []);
  assert.equal(parsed.summary, "Sent 1 request and received 2 responses");
});

test("error status comes from the exit code and the JSON on stderr", () => {
  const stderr = '{\n  "code": 16,\n  "message": "missing token",\n  "details": []\n}\n';
  assert.deepEqual(parseErrorStatus(stderr, 64 + 16), { code: 16, name: "Unauthenticated", message: "missing token", details: [] });
  assert.equal(parseErrorStatus("Failed to dial target host", 1), null);
  assert.deepEqual(parseErrorStatus("ERROR: weird", 64 + 14), { code: 14, name: "Unavailable", message: "ERROR: weird", details: [] });
});

test("invoke args reference header values through the environment", () => {
  const args = invokeArgs({
    protoset: "/cache/x.binpb",
    connection: ["-plaintext"],
    headerNames: ["authorization"],
    timeoutSeconds: 30,
    target: "localhost:1",
    method: "a.B/C",
  });
  assert.ok(args.includes("authorization: ${BB_GRPC_HEADER_0}"));
  assert.deepEqual(args.slice(-5), ["30", "-d", "@", "localhost:1", "a.B/C"]);
});

test("splitJsonArray keeps each element's source text, so big integers survive", () => {
  assert.deepEqual(splitJsonArray('[{"id": 9007199254740993}, {"s": "a,]}"} ,{}]'), ['{"id": 9007199254740993}', '{"s": "a,]}"}', "{}"]);
  assert.deepEqual(splitJsonArray("[]"), []);
  assert.deepEqual(splitJsonArray('[ "x\\"" , 1 ]'), ['"x\\""', "1"]);
});

test("matchMethods only matches on name segment boundaries", () => {
  const methods = ["a.v1.OrderAPI/GetOrder", "a.v1.OrderAPI/BatchGetOrder", "a.v1.MyOrderAPI/GetOrder", "a.v1.OrderAPI/CancelOrder"].map((fullName) => ({ fullName }));
  const names = (name: string) => matchMethods(methods, name).map((method) => method.fullName);
  assert.deepEqual(names("Order"), []);
  assert.deepEqual(names("BatchGetOrder"), ["a.v1.OrderAPI/BatchGetOrder"]);
  assert.deepEqual(names("GetOrder"), ["a.v1.OrderAPI/GetOrder", "a.v1.MyOrderAPI/GetOrder"]);
  assert.deepEqual(names("OrderAPI.GetOrder"), ["a.v1.OrderAPI/GetOrder"]);
  assert.deepEqual(names("OrderAPI/GetOrder"), ["a.v1.OrderAPI/GetOrder"]);
  assert.deepEqual(names("a.v1.OrderAPI.GetOrder"), ["a.v1.OrderAPI/GetOrder"]);
});
