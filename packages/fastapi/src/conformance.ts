/**
 * Conformance suite derivation (the golden-rule oracle).
 *
 * The COMPILER — never the agent — generates a pytest suite from the
 * blueprint and drops it into every generated workspace. Whatever the
 * agent writes must pass this suite:
 *
 *   - exact route set (strict OpenAPI paths/methods equality),
 *   - exact success status codes and path params,
 *   - exact response key sets and echoed values,
 *   - exact error bodies (401/404/409) and validation statuses (422),
 *   - exact auth flow (register → login → me → protected routes),
 *   - list ordering, defaults, refs-as-id-strings.
 *
 * Same spec ⇒ same suite ⇒ all generations behave identically.
 */
import { stableStringify } from "@spec/core"
import type {
  BackendBlueprint,
  BlueprintEntity,
  BlueprintField,
  BlueprintLifecycle,
  BlueprintRoute,
} from "./blueprint"

export interface ConformanceFiles {
  /** path (relative to workspace) → file content */
  files: Record<string, string>
}

/** Sample request value for a field, as a Python literal/expression. */
/** A deterministic in-bounds int for a bounded field (clamps 42). */
function intInBounds(field: BlueprintField, preferred: number): number {
  if (field.min !== undefined && preferred < field.min) return field.min
  if (field.max !== undefined && preferred > field.max) return field.max
  return preferred
}

function sampleValue(field: BlueprintField): string {
  switch (field.type) {
    case "string": {
      // Unique string fields need per-call values or repeated creates 409.
      // Declared maxLength caps the emitted sample (uuid hex stays unique).
      if (field.maxLength !== undefined) {
        const cap = field.maxLength
        return field.unique
          ? `f"{uuid.uuid4().hex[:${cap}]}"`
          : JSON.stringify(`sample-${field.name}`.slice(0, cap))
      }
      return field.unique
        ? `f"{uuid.uuid4()}-sample-${field.name}"`
        : JSON.stringify(`sample-${field.name}`)
    }
    case "email":
      return `f"{uuid.uuid4()}@example.com"`
    case "int":
      return String(intInBounds(field, 42))
    case "boolean":
      return "True"
    case "uuid":
      return "str(uuid.uuid4())"
    case "datetime":
      return JSON.stringify("2026-01-01T12:00:00")
    case "ref":
      return JSON.stringify(`REF:${field.target ?? ""}`)
    case "enum":
      return JSON.stringify((field.states ?? [])[0] ?? "state")
  }
}

/** A second, distinct sample value for update assertions (assignable). */
function updateSample(field: BlueprintField): string {
  switch (field.type) {
    case "string":
      if (field.maxLength !== undefined) {
        const cap = field.maxLength
        return field.unique
          ? `f"{uuid.uuid4().hex[:${cap}]}"`
          : JSON.stringify(`updated-${field.name}`.slice(0, cap))
      }
      return field.unique
        ? `f"{uuid.uuid4()}-updated-${field.name}"`
        : JSON.stringify(`updated-${field.name}`)
    case "email":
      return `f"{uuid.uuid4()}@example.com"`
    case "int": {
      // Distinct in-bounds second value when the declared range allows one.
      const first = intInBounds(field, 42)
      const second = intInBounds(field, 7)
      return String(second !== first ? second : first)
    }
    case "boolean":
      return "False"
    case "uuid":
      return "str(uuid.uuid4())"
    case "datetime":
      return JSON.stringify("2026-02-02T12:00:00")
    case "ref":
      return "str(uuid.uuid4())"
    case "enum":
      return JSON.stringify((field.states ?? ["state"])[Math.min(1, (field.states ?? []).length - 1)])
  }
}

/** Render a JSON-ish value as a Python literal. */
function pythonLiteral(value: unknown): string {
  if (value === true) return "True"
  if (value === false) return "False"
  if (value === null || value === undefined) return "None"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return JSON.stringify(value)
  return JSON.stringify(value)
}

function createRoutesByEntity(bp: BackendBlueprint): Map<string, BlueprintRoute> {
  const map = new Map<string, BlueprintRoute>()
  for (const route of bp.routes) {
    if (route.operation === "create" && route.entity) map.set(route.entity, route)
  }
  return map
}

/** Entities whose lifecycle is testable (create route + resolvable refs). */
function lifecyclableEntities(bp: BackendBlueprint): BlueprintEntity[] {
  const createRoutes = createRoutesByEntity(bp)
  // Rows can be created via a create route, or via register for the
  // auth principal when no create route is exposed.
  const canCreate = (name: string): boolean =>
    createRoutes.has(name) || (bp.auth !== undefined && bp.auth.principal === name)
  const resolvable = (entity: BlueprintEntity, seen: Set<string>): boolean =>
    entity.fields
      .filter((f) => f.type === "ref" && f.target)
      .every((f) => {
        const target = f.target!
        if (seen.has(target)) return false
        const targetEntity = bp.entities.find((e) => e.name === target)
        if (!targetEntity || !canCreate(target)) return false
        return resolvable(targetEntity, new Set([...seen, target]))
      })
  return bp.entities.filter((e) => canCreate(e.name) && resolvable(e, new Set([e.name])))
}

/** Shortest event chain from `initial` to any of `targets`; null if unreachable. */
function pathToState(
  lifecycle: BlueprintLifecycle,
  targets: string[],
): string[] | null {
  if (targets.includes(lifecycle.initial)) return []
  const queue: Array<{ state: string; path: string[] }> = [{ state: lifecycle.initial, path: [] }]
  const seen = new Set([lifecycle.initial])
  while (queue.length > 0) {
    const { state, path } = queue.shift()!
    for (const t of lifecycle.transitions) {
      if (!t.from.includes(state)) continue
      if (seen.has(t.to)) continue
      const next = { state: t.to, path: [...path, t.event] }
      if (targets.includes(t.to)) return next.path
      seen.add(t.to)
      queue.push(next)
    }
  }
  return null
}

/** If a guard compares a datetime field against request.time(), return
 * the field plus far-future/far-past values that pass/fail the guard. */
function requestTimeGuard(
  guard: unknown,
): { field: string; passValue: string; failValue: string } | undefined {
  const visit = (node: unknown): { field: string; passValue: string; failValue: string } | undefined => {
    if (!node || typeof node !== "object") return undefined
    const n = node as Record<string, unknown>
    if (n.__expr === "cmp") {
      const left = n.left as Record<string, unknown> | undefined
      const right = n.right as Record<string, unknown> | undefined
      const op = String(n.op)
      const fieldOnLeft = left?.__expr === "field" && right?.__expr === "requestTime"
      const fieldOnRight = right?.__expr === "field" && left?.__expr === "requestTime"
      if (fieldOnLeft || fieldOnRight) {
        const fieldName = String((fieldOnLeft ? left : right)!.name)
        // normalize: "field OP requestTime"; mirror when reversed
        const mirror: Record<string, string> = { lt: "gt", lte: "gte", gt: "lt", gte: "lte", eq: "eq", neq: "neq" }
        const effOp = fieldOnLeft ? op : mirror[op]
        const futurePasses = effOp === "gt" || effOp === "gte"
        return {
          field: fieldName,
          passValue: futurePasses ? "2100-01-01T00:00:00" : "2000-01-01T00:00:00",
          failValue: futurePasses ? "2000-01-01T00:00:00" : "2100-01-01T00:00:00",
        }
      }
      return visit(left) ?? visit(right)
    }
    if (n.__expr === "and") {
      return visit(n.left) ?? visit(n.right)
    }
    return undefined
  }
  return visit(guard)
}

/** First comparison in a check tree (DFS), if any. */
function findFirstCmp(check: unknown): Record<string, unknown> | undefined {
  if (!check || typeof check !== "object") return undefined
  const node = check as Record<string, unknown>
  if (node.__expr === "cmp") return node
  if (node.__expr === "and") {
    return findFirstCmp(node.left) ?? findFirstCmp(node.right)
  }
  return undefined
}

/** The field compared against a const in a cmp node ("left" or "right"). */
function cmpFieldName(cmp: Record<string, unknown>): string | undefined {
  const left = cmp.left as Record<string, unknown> | undefined
  const right = cmp.right as Record<string, unknown> | undefined
  if (left?.__expr === "field" && right?.__expr === "const") return String(left.name)
  if (right?.__expr === "field" && left?.__expr === "const") return String(right.name)
  return undefined
}

/** A Python literal/expression that VIOLATES the comparison, or undefined. */
function violatingValue(
  entity: BlueprintEntity,
  fieldName: string | undefined,
  cmp: Record<string, unknown>,
): string | undefined {
  if (!fieldName) return undefined
  const field = entity.fields.find((f) => f.name === fieldName)
  if (!field) return undefined
  const left = cmp.left as Record<string, unknown> | undefined
  const right = cmp.right as Record<string, unknown> | undefined
  const op = String(cmp.op)
  // normalize so `bound` is the const and the field side is known
  let bound: unknown
  if (right?.__expr === "const") bound = right.value
  else if (left?.__expr === "const") bound = left.value
  else return undefined
  const flip = left?.__expr === "const" // field on the right → mirror the op
  const mirror: Record<string, string> = { lt: "gt", lte: "gte", gt: "lt", gte: "lte", eq: "eq", neq: "neq" }
  const effOp = flip ? mirror[op] : op

  if (typeof bound === "number" && field.type === "int") {
    const v =
      effOp === "neq" ? bound :
      effOp === "eq" ? bound + 1 :
      effOp === "lt" || effOp === "lte" ? bound + 1 :
      bound - 1
    return String(v)
  }
  if (typeof bound === "string" && (field.type === "string" || field.type === "enum")) {
    if (field.type === "enum") {
      const others = (field.states ?? []).filter((s) => s !== bound)
      if (effOp === "neq") return JSON.stringify(bound)
      if (others.length > 0) return JSON.stringify(others[0])
      return undefined
    }
    if (effOp === "neq") return JSON.stringify(bound)
    if (effOp === "eq") return JSON.stringify(bound + "-different")
    return undefined
  }
  if (typeof bound === "boolean" && field.type === "boolean") {
    if (effOp === "eq") return bound ? "False" : "True"
    if (effOp === "neq") return bound ? "True" : "False"
    return undefined
  }
  return undefined
}

/** Python expression for a route path with {id} filled from a variable. */
function pathExpr(route: BlueprintRoute, idVar: string): string {
  if (route.path.includes("{id}")) {
    return `${JSON.stringify(route.path)}.replace("{id}", ${idVar})`
  }
  return JSON.stringify(route.path)
}

function infrastructureTests(bp: BackendBlueprint): string {
  const infrastructure = {
    caches: bp.caches,
    messages: bp.messages,
    queues: bp.queues,
    blobs: bp.blobs,
    moduleAbis: bp.moduleAbis,
  }
  return `"""Compiler-generated infrastructure conformance — DO NOT EDIT."""

import asyncio
from datetime import datetime
import json
import uuid

import pytest

CONTRACT = json.loads(${JSON.stringify(stableStringify(infrastructure))})


def _sample_payload(message):
    values = {
        "string": "sample",
        "int": 7,
        "boolean": True,
        "uuid": "00000000-0000-4000-8000-000000000001",
        "datetime": "2026-01-01T00:00:00",
    }
    return {name: values[kind] for name, kind in message["fields"].items()}


def test_cache_contract():
    if not CONTRACT["caches"]:
        return
    from app.cache import CACHE_POLICIES, InMemoryCacheBackend

    assert sorted(CACHE_POLICIES) == sorted(item["name"] for item in CONTRACT["caches"])

    async def probe():
        backend = InMemoryCacheBackend()
        for policy in CONTRACT["caches"]:
            name = policy["name"]
            assert await backend.get(name, "asset:1") is None
            original = {"nested": [1, 2]}
            await backend.set(name, "asset:1", original)
            original["nested"].append(3)
            first = await backend.get(name, "asset:1")
            assert first == {"nested": [1, 2]}
            first["nested"].append(4)
            assert await backend.get(name, "asset:1") == {"nested": [1, 2]}
            await backend.delete(name, "asset:1")
            assert await backend.get(name, "asset:1") is None
            calls = 0
            async def loader():
                nonlocal calls
                calls += 1
                return {"loaded": True}
            assert await backend.get_or_set(name, "asset:2", loader) == {"loaded": True}
            assert await backend.get_or_set(name, "asset:2", loader) == {"loaded": True}
            assert calls == 1
        with pytest.raises((KeyError, ValueError)):
            await backend.get("__unknown__", "key")

    asyncio.run(probe())

    import app.cache as module

    class FakeRedisClient:
        def __init__(self, *, fail=False):
            self.fail = fail
            self.values = {}
            self.calls = []

        def _check(self):
            if self.fail:
                raise OSError("provider unavailable")

        async def get(self, key):
            self.calls.append(("get", key))
            self._check()
            value = self.values.get(key)
            return value.encode("utf-8") if value is not None else None

        async def set(self, key, value, *, ex):
            self.calls.append(("set", key, value, ex))
            self._check()
            self.values[key] = value
            return True

        async def delete(self, key):
            self.calls.append(("delete", key))
            self._check()
            return 1 if self.values.pop(key, None) is not None else 0

    async def probe_redis():
        for policy in CONTRACT["caches"]:
            name = policy["name"]
            full_key = f'{policy["keyPrefix"]}:provider'
            client = FakeRedisClient()
            backend = module.RedisCacheBackend(client)
            value = {"nested": [1, 2]}
            await backend.set(name, "provider", value)
            assert client.calls[-1][0:2] == ("set", full_key)
            assert client.calls[-1][3] == policy["ttlSeconds"]
            assert json.loads(client.calls[-1][2]) == value
            assert await backend.get(name, "provider") == value
            await backend.delete(name, "provider")
            assert client.calls[-1] == ("delete", full_key)

        bypass = next((item for item in CONTRACT["caches"] if item["failureMode"] == "bypass"), None)
        if bypass is not None:
            bypass_backend = module.RedisCacheBackend(FakeRedisClient(fail=True))
            assert await bypass_backend.get(bypass["name"], "provider") is None
            await bypass_backend.set(bypass["name"], "provider", {"ok": True})
            await bypass_backend.delete(bypass["name"], "provider")

        closed = next((item for item in CONTRACT["caches"] if item["failureMode"] == "fail-closed"), None)
        if closed is not None:
            closed_backend = module.RedisCacheBackend(FakeRedisClient(fail=True))
            with pytest.raises(module.CacheUnavailable) as raised:
                await closed_backend.get(closed["name"], "provider")
            assert isinstance(raised.value.__cause__, OSError)

    asyncio.run(probe_redis())


def test_messaging_contract():
    if not CONTRACT["queues"]:
        return
    from app.messaging import (
        MESSAGE_DEFINITIONS,
        QUEUE_POLICIES,
        InMemoryMessageBroker,
        MessageValidationError,
        build_envelope,
        validate_payload,
    )

    assert sorted(MESSAGE_DEFINITIONS) == sorted(item["name"] for item in CONTRACT["messages"])
    assert sorted(QUEUE_POLICIES) == sorted(item["name"] for item in CONTRACT["queues"])

    async def probe():
        broker = InMemoryMessageBroker()
        by_name = {item["name"]: item for item in CONTRACT["messages"]}
        for queue in CONTRACT["queues"]:
            message = by_name[queue["messages"][0]]
            payload = _sample_payload(message)
            validate_payload(message["name"], payload)
            with pytest.raises(MessageValidationError):
                validate_payload(message["name"], {})
            envelope = build_envelope(
                message["name"], payload,
                message_id="00000000-0000-4000-8000-000000000010",
                occurred_at=datetime(2026, 1, 1, 0, 0, 0),
            )
            assert envelope.message == message["name"]
            assert envelope.version == 1
            await broker.publish(queue["name"], envelope)
            await broker.publish(queue["name"], envelope)
            drained = await broker.drain(queue["name"])
            expected = 1 if queue["delivery"] == "at-least-once" else 2
            assert len(drained) == expected
            assert [item.id for item in drained] == [envelope.id] * expected

    asyncio.run(probe())

    import app.messaging as module

    class FakeKafkaClient:
        def __init__(self):
            self.calls = []

        async def send_and_wait(self, *args, **kwargs):
            self.calls.append((args, kwargs))

    class FakeRabbitClient:
        def __init__(self):
            self.calls = []

        async def publish(self, *args, **kwargs):
            self.calls.append((args, kwargs))

    class FakeSQSClient:
        def __init__(self):
            self.calls = []

        def send_message(self, **kwargs):
            self.calls.append(kwargs)
            return {"MessageId": "provider-message-id"}

    async def probe_providers():
        clients = {
            "kafka": FakeKafkaClient(),
            "rabbitmq": FakeRabbitClient(),
            "sqs": FakeSQSClient(),
        }
        class_names = {
            "kafka": "KafkaBroker",
            "rabbitmq": "RabbitMQBroker",
            "sqs": "SQSBroker",
        }
        messages = {item["name"]: item for item in CONTRACT["messages"]}
        for queue in CONTRACT["queues"]:
            kind = queue["provider"]["kind"]
            client = clients[kind]
            # Only the brokers for DECLARED providers are exported; resolve
            # by name so a partial provider set never AttributeErrors.
            broker = getattr(module, class_names[kind], None)
            assert broker is not None, class_names[kind]
            broker = broker(client)
            message = messages[queue["messages"][0]]
            payload = _sample_payload(message)
            envelope = module.build_envelope(
                message["name"], payload,
                message_id="00000000-0000-4000-8000-000000000020",
                occurred_at=datetime(2026, 1, 1, 0, 0, 0),
            )
            expected_object = {
                "message": message["name"],
                "version": 1,
                "id": "00000000-0000-4000-8000-000000000020",
                "occurred_at": "2026-01-01T00:00:00",
                "payload": payload,
            }
            expected_text = json.dumps(expected_object, sort_keys=True, separators=(",", ":"))
            ordering = str(payload[queue["orderingKey"]]) if queue.get("orderingKey") else envelope.id
            await broker.publish(queue["name"], envelope)
            if kind == "kafka":
                args, kwargs = client.calls[-1]
                assert args == (queue["name"], expected_text.encode("utf-8"))
                assert kwargs == {"key": ordering.encode("utf-8")}
            elif kind == "rabbitmq":
                args, kwargs = client.calls[-1]
                assert args == (queue["name"], expected_text.encode("utf-8"))
                assert kwargs == {"message_id": envelope.id}
            else:
                assert client.calls[-1] == {
                    "QueueUrl": queue["name"],
                    "MessageBody": expected_text,
                    "MessageDeduplicationId": envelope.id,
                    "MessageGroupId": ordering,
                }

            disallowed = next(
                (item for item in CONTRACT["messages"] if item["name"] not in queue["messages"]),
                None,
            )
            if disallowed is not None:
                bad = module.build_envelope(
                    disallowed["name"], _sample_payload(disallowed),
                    message_id="00000000-0000-4000-8000-000000000021",
                    occurred_at=datetime(2026, 1, 1, 0, 0, 0),
                )
                before = len(client.calls)
                with pytest.raises(module.MessageValidationError):
                    await broker.publish(queue["name"], bad)
                assert len(client.calls) == before

    asyncio.run(probe_providers())


def test_blob_contract():
    if not CONTRACT["blobs"]:
        return
    from app.blob import BLOB_POLICIES, BlobValidationError, InMemoryBlobStore, normalize_blob_key

    assert CONTRACT["moduleAbis"]["blob"]["selector"] == {
        "name": "policy_name", "type": "declared-name-string", "unknown": "KeyError"
    }

    assert sorted(BLOB_POLICIES) == sorted(item["name"] for item in CONTRACT["blobs"])

    async def probe():
        store = InMemoryBlobStore()
        for policy in CONTRACT["blobs"]:
            name = policy["name"]
            key = "tenant/object.bin"
            normalized = normalize_blob_key(name, key)
            prefix = policy["keyPrefix"].strip("/")
            assert normalized == f"{prefix + '/' if prefix else ''}{key}"
            content_type = policy["contentTypes"][0]
            await store.put(name, key, b"payload", content_type)
            assert await store.get(name, key) == b"payload"
            assert await store.signed_url(name, key) == f"memory://{policy['bucket']}/{normalized}?expires={policy['signedUrlTtlSeconds']}"
            await store.delete(name, key)
            with pytest.raises(KeyError):
                await store.get(name, key)
            with pytest.raises(BlobValidationError):
                await store.put(name, key, b"x" * (policy["maxBytes"] + 1), content_type)
            with pytest.raises(BlobValidationError):
                await store.put(name, key, b"x", "application/x-not-allowed")
            with pytest.raises(BlobValidationError):
                normalize_blob_key(name, "../secret")

    asyncio.run(probe())

    import app.blob as module
    if any(item["provider"]["kind"] == "s3" for item in CONTRACT["blobs"]):
        assert hasattr(module, "S3BlobStore")

        class FakeBody:
            def __init__(self, value):
                self.value = value

            def read(self):
                return self.value

        class FakeS3Client:
            def __init__(self):
                self.objects = {}
                self.calls = []

            def put_object(self, **kwargs):
                self.calls.append(("put", kwargs))
                self.objects[(kwargs["Bucket"], kwargs["Key"])] = bytes(kwargs["Body"])

            def get_object(self, **kwargs):
                self.calls.append(("get", kwargs))
                return {"Body": FakeBody(self.objects[(kwargs["Bucket"], kwargs["Key"])])}

            def delete_object(self, **kwargs):
                self.calls.append(("delete", kwargs))
                self.objects.pop((kwargs["Bucket"], kwargs["Key"]), None)

            def generate_presigned_url(self, operation, **kwargs):
                self.calls.append(("presign", operation, kwargs))
                return "https://signed.invalid/object"

        async def probe_s3():
            policy = CONTRACT["blobs"][0]
            name = policy["name"]
            key = "tenant/provider.bin"
            normalized = f'{policy["keyPrefix"].strip("/")}/{key}'
            content_type = policy["contentTypes"][0]
            client = FakeS3Client()
            store = module.S3BlobStore(client)
            await store.put(name, key, b"provider-payload", content_type)
            assert client.calls[-1] == ("put", {
                "Bucket": policy["bucket"], "Key": normalized,
                "Body": b"provider-payload", "ContentType": content_type,
            })
            assert await store.get(name, key) == b"provider-payload"
            assert await store.signed_url(name, key) == "https://signed.invalid/object"
            assert client.calls[-1] == ("presign", "get_object", {
                "Params": {"Bucket": policy["bucket"], "Key": normalized},
                "ExpiresIn": policy["signedUrlTtlSeconds"],
            })
            await store.delete(name, key)
            assert client.calls[-1] == ("delete", {
                "Bucket": policy["bucket"], "Key": normalized,
            })
            before = list(client.calls)
            with pytest.raises(BlobValidationError):
                await store.put(name, key, b"x", "application/x-not-allowed")
            assert client.calls == before

        asyncio.run(probe_s3())
`
}

function behaviorSnapshot(bp: BackendBlueprint): string {
  const infrastructure = {
    caches: bp.caches,
    messages: bp.messages,
    queues: bp.queues,
    blobs: bp.blobs,
  }
  return `"""Deterministic cross-shot behavior probe — compiler owned."""

import asyncio
from datetime import datetime
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app

CONTRACT = json.loads(${JSON.stringify(stableStringify(infrastructure))})


def sample_payload(message):
    values = {"string": "sample", "int": 7, "boolean": True, "uuid": "00000000-0000-4000-8000-000000000001", "datetime": "2026-01-01T00:00:00"}
    return {name: values[kind] for name, kind in message["fields"].items()}


async def infrastructure_snapshot():
    result = {"cache": {}, "messaging": {}, "blob": {}}
    if CONTRACT["caches"]:
        from app.cache import InMemoryCacheBackend
        backend = InMemoryCacheBackend()
        for policy in CONTRACT["caches"]:
            await backend.set(policy["name"], "probe", {"ok": True})
            result["cache"][policy["name"]] = await backend.get(policy["name"], "probe")
    if CONTRACT["queues"]:
        from app.messaging import InMemoryMessageBroker, build_envelope
        broker = InMemoryMessageBroker()
        messages = {item["name"]: item for item in CONTRACT["messages"]}
        for queue in CONTRACT["queues"]:
            message = messages[queue["messages"][0]]
            envelope = build_envelope(message["name"], sample_payload(message), message_id="00000000-0000-4000-8000-000000000010", occurred_at=datetime(2026, 1, 1))
            await broker.publish(queue["name"], envelope)
            await broker.publish(queue["name"], envelope)
            result["messaging"][queue["name"]] = len(await broker.drain(queue["name"]))
    if CONTRACT["blobs"]:
        from app.blob import InMemoryBlobStore
        store = InMemoryBlobStore()
        for policy in CONTRACT["blobs"]:
            await store.put(policy["name"], "probe.bin", b"payload", policy["contentTypes"][0])
            result["blob"][policy["name"]] = {
                "bytes": len(await store.get(policy["name"], "probe.bin")),
                "url": await store.signed_url(policy["name"], "probe.bin"),
            }
    return result


openapi = app.openapi()
interface = sorted(
    f"{method.upper()} {path}"
    for path, operations in openapi.get("paths", {}).items()
    for method in operations
    if method in {"get", "post", "put", "patch", "delete"}
)
print(json.dumps({"interface": interface, "infrastructure": asyncio.run(infrastructure_snapshot())}, sort_keys=True))
`
}

export function buildConformanceSuite(bp: BackendBlueprint): ConformanceFiles {
  const createRoutes = createRoutesByEntity(bp)
  const lifecycles = lifecyclableEntities(bp)
  const hasAuth = bp.auth !== undefined

  /* ================= conftest.py ================= */
  const conf: string[] = []
  conf.push('"""Compiler-generated conformance harness — DO NOT EDIT."""')
  conf.push("")
  conf.push("import pytest")
  conf.push("from fastapi.testclient import TestClient")
  conf.push("")
  conf.push("from app.main import create_app")
  conf.push("")
  conf.push("")
  conf.push("@pytest.fixture()")
  conf.push("def client(tmp_path):")
  conf.push('    """Fresh app + isolated SQLite database per test."""')
  conf.push('    db_path = str(tmp_path / "test.db")')
  conf.push('    application = create_app(database_url=f"sqlite:///{db_path}")')
  conf.push("    with TestClient(application) as test_client:")
  conf.push("        test_client.db_path = db_path")
  conf.push("        yield test_client")
  const conftest = conf.join("\n") + "\n"

  /* ================= helpers.py ================= */
  const c: string[] = []
  c.push('"""Compiler-generated conformance helpers — DO NOT EDIT."""')
  c.push("")
  c.push("import uuid")
  c.push("")
  c.push("")
  c.push("def make_body(client, entity, overrides=None, token=None):")
  c.push('    """Build a valid create body for entity (seeding ref targets).')
  c.push("")
  c.push("    Does NOT create the row itself — used by invariant tests that")
  c.push("    need a body for a create that must FAIL.")
  c.push('"""')
  for (const entity of lifecycles) {
    const create = createRoutes.get(entity.name)
    if (!create) continue // principal-without-create has no dict form
    c.push(`    if entity == ${JSON.stringify(entity.name)}:`)
    const seeds: string[] = []
    for (const field of entity.fields) {
      if (field.type === "ref" && field.target) {
        const varName = `_${field.target.toLowerCase()}`
        c.push(
          `        ${varName} = create_row(client, ${JSON.stringify(field.target)}, token=token)`,
        )
        seeds.push(`${JSON.stringify(field.name)}: ${varName}["id"]`)
      }
    }
    const parts: string[] = [...seeds]
    for (const field of entity.fields) {
      // id is server-generated; refs are seeded; optional and defaulted
      // fields are omittable (the pinned default/None must apply).
      if (field.name === "id" || field.type === "ref" || field.optional || field.default !== undefined) {
        continue
      }
      parts.push(`${JSON.stringify(field.name)}: ${sampleValue(field)}`)
    }
    c.push(`        base = {${parts.join(", ")}}`)
    c.push("        if overrides:")
    c.push("            base.update(overrides)")
    c.push("        return base")
  }
  c.push(`    raise AssertionError(f"no body builder for {entity}")`)
  c.push("")
  c.push("")
  c.push("def body_for(client, entity, overrides=None, token=None):")
  c.push('    """Make a body and CREATE the row; returns (sent_body, stored_json)."""')
  for (const entity of lifecycles) {
    const create = createRoutes.get(entity.name)
    c.push(`    if entity == ${JSON.stringify(entity.name)}:`)
    if (!create) {
      // Principal without an exposed create route: seed via register.
      const reg = bp.auth!.routes.find((r) => r.operation === "register")!
      const identity = bp.auth!.identityField
      const parts: string[] = []
      for (const field of entity.fields) {
        if (field.name === "id" || field.name === identity) continue
        if (field.type === "ref" || field.optional || field.default !== undefined) continue
        parts.push(`${JSON.stringify(field.name)}: ${sampleValue(field)}`)
      }
      c.push(`        identity = f"{uuid.uuid4()}@example.com"`)
      c.push(
        `        body = {${JSON.stringify(identity)}: identity, ${parts.join(", ")}, "password": "secret123"}`,
      )
      c.push(`        r = client.post(${JSON.stringify(reg.path)}, json=body)`)
      c.push("        assert r.status_code == 201, r.text")
      c.push("        return body, r.json()")
      continue
    }
    const hdrs = hasAuth && create.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
    c.push(`        base = make_body(client, entity, overrides=overrides, token=token)`)
    c.push(`        r = client.post(${JSON.stringify(create.path)}, json=base${hdrs})`)
    c.push("        assert r.status_code == 201, r.text")
    c.push("        return base, r.json()")
  }
  c.push(`    raise AssertionError(f"no body builder for {entity}")`)
  c.push("")
  c.push("")
  c.push("def create_row(client, entity, overrides=None, token=None):")
  c.push('    """Create one row of entity; returns the stored json."""')
  c.push("    _, stored = body_for(client, entity, overrides=overrides, token=token)")
  c.push("    return stored")
  if (hasAuth) {
    const principal = bp.entities.find((e) => e.name === bp.auth!.principal)!
    const identity = bp.auth!.identityField
    const register = bp.auth!.routes.find((r) => r.operation === "register")!
    const login = bp.auth!.routes.find((r) => r.operation === "login")!
    const regParts: string[] = [`${JSON.stringify(identity)}: identity`]
    for (const field of principal.fields) {
      if (field.name === "id" || field.name === identity) continue
      if (field.type === "ref" || field.optional || field.default !== undefined) continue
      regParts.push(`${JSON.stringify(field.name)}: ${sampleValue(field)}`)
    }
    regParts.push(`"password": password`)
    c.push("")
    c.push("")
    c.push("def auth_user(client, identity=None, password='secret123'):")
    c.push('    """Register + login a principal; returns (identity, token)."""')
    c.push(`    identity = identity or f"{uuid.uuid4()}@example.com"`)
    c.push(
      `    r = client.post(${JSON.stringify(register.path)}, json={${regParts.join(", ")}})`,
    )
    c.push("    assert r.status_code == 201, r.text")
    c.push(
      `    r = client.post(${JSON.stringify(login.path)}, json={${JSON.stringify(identity)}: identity, "password": password})`,
    )
    c.push("    assert r.status_code == 200, r.text")
    c.push('    assert r.json()["token_type"] == "bearer"')
    c.push('    return identity, r.json()["access_token"]')
    c.push("")
    c.push("")
    c.push("def auth_token(client):")
    c.push("    return auth_user(client)[1]")
  }
  const helpers = c.join("\n") + "\n"

  /* ================= test_contract.py ================= */
  const t: string[] = []
  t.push('"""Compiler-generated conformance suite — DO NOT EDIT.')
  t.push("")
  t.push("Derived from the specification. Every generated implementation of")
  t.push("this specification must pass this suite with identical behavior.")
  t.push('"""')
  t.push("import uuid")
  t.push("")
  t.push(
    "from helpers import body_for, create_row, make_body" +
      (hasAuth ? ", auth_user, auth_token" : ""),
  )
  t.push("")
  t.push("")

  // ---- interface (strict OpenAPI equality) ----
  const expected: Record<string, { statuses: string[]; pathParams: string[] }> = {}
  for (const route of bp.routes) {
    expected[route.id] = {
      statuses: [String(route.status)],
      pathParams: route.path.includes("{id}") ? ["id"] : [],
    }
  }
  t.push("# The exact interface the specification defines (strict equality).")
  t.push(`EXPECTED_INTERFACE = ${pythonInterfaceLiteral(expected)}`)
  t.push("")
  t.push("")
  t.push("def _normalize(spec):")
  t.push('    """Paths/methods/statuses/path-params of an OpenAPI document."""')
  t.push("    out = {}")
  t.push('    for path, ops in spec.get("paths", {}).items():')
  t.push("        for method, op in ops.items():")
  t.push('            if method not in ("get", "post", "put", "patch", "delete"):')
  t.push("                continue")
  t.push('            statuses = sorted(op.get("responses", {}).keys())')
  t.push(
    '            params = sorted(p["name"] for p in op.get("parameters", []) if p.get("in") == "path")',
  )
  t.push('            out[f"{method.upper()} {path}"] = {"statuses": statuses, "pathParams": params}')
  t.push("    return out")
  t.push("")
  t.push("")
  t.push("def test_interface_matches_specification(client):")
  t.push('    r = client.get("/openapi.json")')
  t.push("    assert r.status_code == 200, r.text")
  t.push("    actual = _normalize(r.json())")
  t.push("    expected_keys = set(EXPECTED_INTERFACE.keys())")
  t.push("    assert set(actual.keys()) == expected_keys, (")
  t.push("        sorted(set(actual.keys()) - expected_keys),")
  t.push("        sorted(expected_keys - set(actual.keys())),")
  t.push("    )")
  t.push("    for route_id, exp in EXPECTED_INTERFACE.items():")
  t.push('        assert actual[route_id]["pathParams"] == exp["pathParams"], route_id')
  t.push('        assert exp["statuses"][0] in actual[route_id]["statuses"], route_id')
  t.push("")

  // ---- auth flow ----
  if (hasAuth) {
    const auth = bp.auth!
    const principal = bp.entities.find((e) => e.name === auth.principal)!
    const identity = auth.identityField
    const principalKeys = principal.fields.map((f) => f.name)
    const login = auth.routes.find((r) => r.operation === "login")!
    const register = auth.routes.find((r) => r.operation === "register")!
    const me = auth.routes.find((r) => r.operation === "me")!
    const regParts: string[] = [`${JSON.stringify(identity)}: identity`]
    for (const field of principal.fields) {
      if (field.name === "id" || field.name === identity) continue
      if (field.type === "ref" || field.optional || field.default !== undefined) continue
      regParts.push(`${JSON.stringify(field.name)}: ${sampleValue(field)}`)
    }

    t.push("")
    t.push("# ------------------------------------------------------------------")
    t.push("# Auth flow")
    t.push("# ------------------------------------------------------------------")
    t.push("def test_register_login_me(client):")
    t.push("    identity, token = auth_user(client)")
    t.push(
      `    r = client.get(${JSON.stringify(me.path)}, headers={"Authorization": f"Bearer {token}"})`,
    )
    t.push("    assert r.status_code == 200, r.text")
    t.push(`    assert set(r.json().keys()) == ${pythonSetLiteral(principalKeys)}`)
    t.push(`    assert r.json()[${JSON.stringify(identity)}] == identity`)
    t.push(`    assert ${JSON.stringify(auth.passwordColumn)} not in r.json()`)
    t.push("")
    t.push("def test_login_wrong_password(client):")
    t.push(`    identity, _ = auth_user(client, password="correct-horse")`)
    t.push(
      `    r = client.post(${JSON.stringify(login.path)}, json={${JSON.stringify(identity)}: identity, "password": "wrong"})`,
    )
    t.push("    assert r.status_code == 401, r.text")
    t.push('    assert r.json() == {"detail": "Invalid credentials"}')
    t.push("")
    t.push("def test_login_unknown_identity(client):")
    t.push(
      `    r = client.post(${JSON.stringify(login.path)}, json={${JSON.stringify(identity)}: f"{uuid.uuid4()}@example.com", "password": "x"})`,
    )
    t.push("    assert r.status_code == 401, r.text")
    t.push('    assert r.json() == {"detail": "Invalid credentials"}')
    t.push("")
    t.push("def test_register_duplicate_identity(client):")
    t.push("    identity, _ = auth_user(client)")
    t.push(
      `    r = client.post(${JSON.stringify(register.path)}, json={${regParts.join(", ")}, "password": "another-secret"})`,
    )
    t.push("    assert r.status_code == 409, r.text")
    t.push('    assert r.json() == {"detail": "Already exists"}')
    t.push("")
    t.push("def test_me_without_token(client):")
    t.push(`    r = client.get(${JSON.stringify(me.path)})`)
    t.push("    assert r.status_code == 401, r.text")
    t.push('    assert r.json() == {"detail": "Not authenticated"}')
    t.push("")

    const protectedRoutes = bp.routes.filter((r) => r.auth && r.operation !== "me")
    if (protectedRoutes.length > 0) {
      t.push("def test_protected_routes_require_token(client):")
      for (const route of protectedRoutes) {
        t.push(`    r = ${requestExpr(route, "str(uuid.uuid4())")}`)
        t.push(`    assert r.status_code == 401, ${JSON.stringify(route.id)}`)
        t.push('    assert r.json() == {"detail": "Not authenticated"}')
      }
    }
  }

  // ---- entity lifecycles ----
  for (const entity of lifecycles) {
    const create = createRoutes.get(entity.name)
    const withAuth = hasAuth && create !== undefined && create.auth
    const tokenArg = withAuth ? ", token=token" : ""
    const keys = entity.fields.map((f) => f.name)
    const lower = entity.name.toLowerCase()
    const routes = bp.routes.filter((r) => r.entity === entity.name)

    t.push("")
    t.push("# ------------------------------------------------------------------")
    t.push(`# ${entity.name}`)
    t.push("# ------------------------------------------------------------------")

    if (routes.some((r) => r.operation === "create")) {
      t.push(`def test_${lower}_create(client):`)
      if (withAuth) t.push("    token = auth_token(client)")
      t.push(`    body, stored = body_for(client, ${JSON.stringify(entity.name)}${tokenArg})`)
      t.push(`    assert set(stored.keys()) == ${pythonSetLiteral(keys)}`)
      if (keys.includes("id")) {
        t.push('    assert isinstance(stored["id"], str) and stored["id"]')
      }
      const lifecycle = bp.lifecycles.find((l) => l.entity === entity.name)
      for (const field of entity.fields) {
        if (field.name === "id") continue
        if (lifecycle && field.name === lifecycle.field) {
          t.push(`    assert stored[${JSON.stringify(field.name)}] == ${JSON.stringify(lifecycle.initial)}`)
          continue
        }
        if (field.type === "ref") {
          t.push(`    assert stored[${JSON.stringify(field.name)}] == body[${JSON.stringify(field.name)}]`)
          continue
        }
        if (field.default !== undefined) {
          t.push(`    assert stored[${JSON.stringify(field.name)}] == ${pythonLiteral(field.default)}`)
          continue
        }
        if (field.optional) {
          t.push(`    assert stored[${JSON.stringify(field.name)}] is None`)
          continue
        }
        t.push(`    assert stored[${JSON.stringify(field.name)}] == body[${JSON.stringify(field.name)}]`)
      }
    }

    for (const route of routes) {
      const suffix = hasAuth && route.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
      const needsToken = hasAuth && route.auth
      switch (route.operation) {
        case "get":
          t.push("")
          t.push("")
          t.push(`def test_${lower}_get(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          t.push(`    stored = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
          t.push(`    r = client.get(${pathExpr(route, 'stored["id"]')}${suffix})`)
          t.push("    assert r.status_code == 200, r.text")
          t.push(`    assert set(r.json().keys()) == ${pythonSetLiteral(keys)}`)
          t.push('    assert r.json()["id"] == stored["id"]')
          t.push(`    r = client.get(${pathExpr(route, "str(uuid.uuid4())")}${suffix})`)
          t.push("    assert r.status_code == 404, r.text")
          t.push('    assert r.json() == {"detail": "Not found"}')
          break
        case "list":
          t.push("")
          t.push("")
          t.push(`def test_${lower}_list(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          // listScope: "allRows" — when the listed entity IS the auth
          // principal, the token's own row is part of the list (created
          // first, so it leads the createdAt ordering).
          if (needsToken && hasAuth && bp.auth!.principal === entity.name) {
            t.push(`    me = client.get(${JSON.stringify(mePath(bp))}, headers={"Authorization": f"Bearer {token}"})`)
            t.push("    assert me.status_code == 200, me.text")
            t.push(`    first = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(`    second = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(`    r = client.get(${JSON.stringify(route.path)}${suffix})`)
            t.push("    assert r.status_code == 200, r.text")
            t.push("    rows = r.json()")
            t.push("    assert isinstance(rows, list)")
            t.push('    assert sorted(row["id"] for row in rows) == sorted([me.json()["id"], first["id"], second["id"]])')
          } else {
            t.push(`    first = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(`    second = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(`    r = client.get(${JSON.stringify(route.path)}${suffix})`)
            t.push("    assert r.status_code == 200, r.text")
            t.push("    rows = r.json()")
            t.push("    assert isinstance(rows, list)")
            t.push('    assert [row["id"] for row in rows] == [first["id"], second["id"]]')
          }
          t.push(`    assert set(rows[0].keys()) == ${pythonSetLiteral(keys)}`)
          break
        case "update": {
          const patchField = entity.fields.find(
            (f) => f.name !== "id" && f.type !== "ref" && !f.optional,
          )
          t.push("")
          t.push("")
          t.push(`def test_${lower}_update(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          t.push(`    stored = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
          if (patchField) {
            t.push(`    new_value = ${updateSample(patchField)}`)
            t.push(
              `    r = client.patch(${pathExpr(route, 'stored["id"]')}, json={${JSON.stringify(patchField.name)}: new_value}${suffix})`,
            )
            t.push("    assert r.status_code == 200, r.text")
            t.push(`    assert r.json()[${JSON.stringify(patchField.name)}] == new_value`)
          } else {
            t.push(`    r = client.patch(${pathExpr(route, 'stored["id"]')}, json={}${suffix})`)
            t.push("    assert r.status_code == 200, r.text")
          }
          t.push('    assert r.json()["id"] == stored["id"]')
          t.push(`    r = client.patch(${pathExpr(route, "str(uuid.uuid4())")}, json={}${suffix})`)
          t.push("    assert r.status_code == 404, r.text")
          t.push('    assert r.json() == {"detail": "Not found"}')
          break
        }
        case "delete":
          t.push("")
          t.push("")
          t.push(`def test_${lower}_delete(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          t.push(`    stored = create_row(client, ${JSON.stringify(entity.name)}${tokenArg})`)
          t.push(`    r = client.delete(${pathExpr(route, 'stored["id"]')}${suffix})`)
          t.push("    assert r.status_code == 204, r.text")
          t.push('    assert r.content == b""')
          t.push(`    r = client.delete(${pathExpr(route, 'stored["id"]')}${suffix})`)
          t.push("    assert r.status_code == 404, r.text")
          break
        case "create":
          // validation / uniqueness / dangling ref
          t.push("")
          t.push("")
          t.push(`def test_${lower}_create_validation(client):`)
          if (needsToken) t.push("    token = auth_token(client)")
          t.push(`    body, _ = body_for(client, ${JSON.stringify(entity.name)}${tokenArg})`)
          const badField = entity.fields.find((f) => f.type === "int" && !f.optional)
          if (badField) {
            t.push(`    bad = {**body, ${JSON.stringify(badField.name)}: "not-an-int"}`)
            t.push(`    r = client.post(${JSON.stringify(route.path)}, json=bad${suffix})`)
            t.push("    assert r.status_code == 422, r.text")
            t.push('    assert isinstance(r.json()["detail"], list)')
          }
          // Declared bounds are validation: one out-of-range probe per bound
          // (inclusive edges), answered by the default 422 — never the 409
          // invariant body.
          for (const boundField of entity.fields.filter(
            (f) => f.min !== undefined || f.max !== undefined || f.maxLength !== undefined,
          )) {
            if (boundField.min !== undefined) {
              t.push(`    body_b = {**body, ${JSON.stringify(boundField.name)}: ${boundField.min - 1}}`)
              t.push(`    r = client.post(${JSON.stringify(route.path)}, json=body_b${suffix})`)
              t.push("    assert r.status_code == 422, r.text")
            }
            if (boundField.max !== undefined) {
              t.push(`    body_b = {**body, ${JSON.stringify(boundField.name)}: ${boundField.max + 1}}`)
              t.push(`    r = client.post(${JSON.stringify(route.path)}, json=body_b${suffix})`)
              t.push("    assert r.status_code == 422, r.text")
            }
            if (boundField.maxLength !== undefined) {
              t.push(`    body_b = {**body, ${JSON.stringify(boundField.name)}: "x" * ${boundField.maxLength + 1}}`)
              t.push(`    r = client.post(${JSON.stringify(route.path)}, json=body_b${suffix})`)
              t.push("    assert r.status_code == 422, r.text")
            }
            // The inclusive edge itself is valid — the probe pair pins which
            // side of the boundary 422s. Uses the DISTINCT in-bounds sample
            // (updateSample) so unique fields do not 409 against the row
            // body_for already created; when no distinct value exists
            // (min == max), every other create in this suite already uses
            // the edge value, so the valid side is covered.
            const edgeValue = updateSample(boundField)
            if (edgeValue !== sampleValue(boundField)) {
              t.push(`    body_b = {**body, ${JSON.stringify(boundField.name)}: ${edgeValue}}`)
              t.push(`    r = client.post(${JSON.stringify(route.path)}, json=body_b${suffix})`)
              t.push("    assert r.status_code == 201, r.text")
            }
          }
          const uniqueField = entity.fields.find((f) => f.unique && f.type !== "ref" && !f.optional)
          if (uniqueField && (!hasAuth || entity.name !== bp.auth!.principal)) {
            t.push(`    body2, _ = body_for(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(
              `    dup = {**body2, ${JSON.stringify(uniqueField.name)}: body[${JSON.stringify(uniqueField.name)}]}`,
            )
            t.push(`    r = client.post(${JSON.stringify(route.path)}, json=dup${suffix})`)
            t.push("    assert r.status_code == 409, r.text")
            t.push('    assert r.json() == {"detail": "Already exists"}')
          }
          const refField = entity.fields.find((f) => f.type === "ref")
          if (refField) {
            t.push(`    body3, _ = body_for(client, ${JSON.stringify(entity.name)}${tokenArg})`)
            t.push(
              `    dangling = {**body3, ${JSON.stringify(refField.name)}: str(uuid.uuid4())}`,
            )
            t.push(`    r = client.post(${JSON.stringify(route.path)}, json=dangling${suffix})`)
            t.push("    assert r.status_code == 404, r.text")
            t.push('    assert r.json() == {"detail": "Not found"}')
          }
          break
      }
    }
  }

  // ---- lifecycle transitions (behavior Phase 1) ----
  for (const lifecycle of bp.lifecycles) {
    const entity = bp.entities.find((e) => e.name === lifecycle.entity)
    if (!entity || !lifecycles.includes(entity)) continue
    const lower = lifecycle.entity.toLowerCase()
    const withAuth = hasAuth
    const tokenLine = withAuth ? '    token = auth_token(client)' : ""
    const headers = withAuth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
    const tokenArg = withAuth ? ", token=token" : ""

    for (const route of bp.routes.filter(
      (r) => r.operation === "transition" && r.entity === lifecycle.entity && r.transition?.event,
    )) {
      const event = route.transition!.event
      const chain = pathToState(lifecycle, route.transition!.from)
      const guardInfo = requestTimeGuard(route.transition!.guard)
      if (chain !== null) {
        t.push("")
        t.push("")
        t.push(`def test_transition_${event}(client):`)
        if (withAuth) t.push(tokenLine)
        t.push(
          `    row = create_row(client, ${JSON.stringify(lifecycle.entity)}${tokenArg}` +
            (guardInfo
              ? `, overrides={${JSON.stringify(guardInfo.field)}: ${JSON.stringify(guardInfo.passValue)}}`
              : "") +
            ")",
        )
        // pre-apply the chain that brings the row into a from-state
        for (const step of chain) {
          const stepRoute = bp.routes.find(
            (r) => r.operation === "transition" && r.entity === lifecycle.entity && r.transition?.event === step,
          )
          if (stepRoute) {
            t.push(`    client.post(${pathExpr(stepRoute, 'row["id"]')}${headers})`)
          }
        }
        t.push(`    r = client.post(${pathExpr(route, 'row["id"]')}${headers})`)
        t.push("    assert r.status_code == 200, r.text")
        t.push(`    assert r.json()[${JSON.stringify(lifecycle.field)}] == ${JSON.stringify(route.transition!.to)}`)
        t.push('    assert r.json()["id"] == row["id"]')
        t.push(`    assert set(r.json().keys()) == ${pythonSetLiteral(entity.fields.map((f) => f.name))}`)

        // set effects: constants are exact; request.time() is non-null
        for (const eff of route.transition!.effects ?? []) {
          const e = eff as Record<string, unknown>
          if (e.__effect === "set") {
            const value = e.value as Record<string, unknown> | undefined
            if (value?.__expr === "const") {
              t.push(`    assert r.json()[${JSON.stringify(String(e.field))}] == ${pythonLiteral(value.value)}`)
            } else {
              t.push(`    assert r.json()[${JSON.stringify(String(e.field))}] is not None`)
            }
          }
        }

        // emit effects: an outbox row with the pinned payload shape
        for (const eff of route.transition!.effects ?? []) {
          const e = eff as Record<string, unknown>
          if (e.__effect !== "emit") continue
          const fields = Array.isArray(e.fields) ? (e.fields as string[]) : []
          const eventName = String(e.event)
          t.push("    import json as _json, sqlite3")
          t.push("    conn = sqlite3.connect(client.db_path)")
          t.push('    rows = conn.execute("SELECT event, payload FROM events").fetchall()')
          t.push("    conn.close()")
          t.push(`    matching = [rw for rw in rows if rw[0] == ${JSON.stringify(eventName)}]`)
          t.push("    assert len(matching) >= 1, rows")
          t.push("    payload = _json.loads(matching[-1][1])")
          t.push(`    assert set(payload.keys()) == ${pythonSetLiteral(fields)}`)
          for (const pf of fields) {
            t.push(`    assert payload[${JSON.stringify(pf)}] == row[${JSON.stringify(pf)}]`)
          }
        }

        // guard fail-direction: the mirrored datetime value must 409
        if (guardInfo) {
          t.push(
            `    bad = create_row(client, ${JSON.stringify(lifecycle.entity)}${tokenArg}, overrides={${JSON.stringify(guardInfo.field)}: ${JSON.stringify(guardInfo.failValue)}})`,
          )
          t.push(`    r = client.post(${pathExpr(route, 'bad["id"]')}${headers})`)
          t.push("    assert r.status_code == 409, r.text")
          t.push('    assert r.json() == {"detail": "Invalid state"}')
        }

        // applying again from the to-state is illegal (unless self-loop)
        if (!route.transition!.from.includes(route.transition!.to)) {
          t.push(`    r = client.post(${pathExpr(route, 'row["id"]')}${headers})`)
          t.push("    assert r.status_code == 409, r.text")
          t.push('    assert r.json() == {"detail": "Invalid state"}')
        }
        t.push(`    r = client.post(${pathExpr(route, "str(uuid.uuid4())")}${headers})`)
        t.push("    assert r.status_code == 404, r.text")
        t.push('    assert r.json() == {"detail": "Not found"}')
      }
    }

    // create assigns the initial state; update ignores the state field
    const updateRoute = bp.routes.find((r) => r.operation === "update" && r.entity === lifecycle.entity)
    if (updateRoute) {
      t.push("")
      t.push("")
      t.push(`def test_${lower}_update_ignores_${lifecycle.field}(client):`)
      if (withAuth) t.push(tokenLine)
      t.push(`    row = create_row(client, ${JSON.stringify(lifecycle.entity)}${tokenArg})`)
      const otherState = (entity.fields.find((f) => f.name === lifecycle.field)?.states ?? [])
        .filter((s) => s !== lifecycle.initial)
      const probeState = otherState[0] ?? lifecycle.initial
      t.push(`    r = client.patch(${pathExpr(updateRoute, 'row["id"]')}, json={${JSON.stringify(lifecycle.field)}: ${JSON.stringify(probeState)}}${headers})`)
      t.push("    assert r.status_code == 200, r.text")
      t.push(`    assert r.json()[${JSON.stringify(lifecycle.field)}] == row[${JSON.stringify(lifecycle.field)}]`)
    }
  }

  // ---- invariants (behavior Phase 2): minimally violating worlds ----
  for (const inv of bp.invariants) {
    const onEntity = bp.entities.find((e) => e.name === inv.entity)
    const withAuth = hasAuth

    if (inv.shape === "rowCheck" && onEntity) {
      // Find the first comparison with a const bound and compute a value
      // that violates it.
      const firstCmp = findFirstCmp(inv.check)
      const field = firstCmp ? cmpFieldName(firstCmp) : undefined
      const value = firstCmp ? violatingValue(onEntity, field, firstCmp) : undefined
      const create = createRoutes.get(inv.entity)
      if (firstCmp && field && value !== undefined && create && lifecycles.includes(onEntity)) {
        const suffix = withAuth && create.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
        const tokenArg = withAuth && create.auth ? ", token=token" : ""
        t.push("")
        t.push("")
        t.push(`def test_invariant_${inv.name.replace(/[^a-zA-Z0-9_]/g, "_")}(client):`)
        if (withAuth && create.auth) t.push("    token = auth_token(client)")
        t.push(`    good = make_body(client, ${JSON.stringify(inv.entity)}${tokenArg})`)
        t.push(`    bad = {**good, ${JSON.stringify(field)}: ${value}}`)
        t.push(`    r = client.post(${JSON.stringify(create.path)}, json=bad${suffix})`)
        t.push("    assert r.status_code == 409, r.text")
        t.push('    assert r.json() == {"detail": "Invariant violated"}')
        const countRoute = bp.routes.find(
          (r) => r.operation === "count" && r.entity === inv.entity && (!withAuth || r.auth === (create.auth ?? false)),
        )
        if (countRoute) {
          const cSuffix = withAuth && countRoute.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
          t.push(`    r = client.get(${JSON.stringify(countRoute.path)}${cSuffix})`)
          t.push("    assert r.status_code == 200, r.text")
          t.push(`    assert r.json() == {"count": 0}`)
        }
      }
    }

    if (inv.shape === "crossRowCount" && onEntity) {
      const c = inv.count!
      const countedCreate = createRoutes.get(c.entity)
      const onCreate = createRoutes.get(inv.entity)
      const onUpdate = bp.routes.find((r) => r.operation === "update" && r.entity === inv.entity)
      const countedEntity = bp.entities.find((e) => e.name === c.entity)
      const boundIsField = c.bound.kind === "field"
      if (
        countedCreate &&
        countedEntity &&
        lifecycles.includes(countedEntity) &&
        onEntity &&
        (boundIsField ? onCreate && onUpdate : true)
      ) {
        const cSuffix = withAuth && countedCreate.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
        const cTokenArg = withAuth && countedCreate.auth ? ", token=token" : ""
        const boundField = c.bound.kind === "field" ? c.bound.name : undefined
        const boundConst = c.bound.kind === "const" ? c.bound.value : undefined
        t.push("")
        t.push("")
        t.push(`def test_invariant_${inv.name.replace(/[^a-zA-Z0-9_]/g, "_")}(client):`)
        if (withAuth && countedCreate.auth) t.push("    token = auth_token(client)")
        if (boundIsField && onCreate && boundField) {
          const onSuffix = withAuth && onCreate.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
          const uSuffix = withAuth && onUpdate?.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
          // The minimally violating world must respect declared bounds: a
          // zero bound is impossible when the field's min is higher, so the
          // base is the smallest legal bound value (mirrors the node-oracle
          // derivation) and the parent is FILLED to that bound first.
          const boundFieldDef = countedEntity.fields.find((f) => f.name === boundField)
          const parentDef = bp.entities.find((e) => e.name === inv.entity)
          const parentField = parentDef?.fields.find((f) => f.name === boundField)
          const minV = parentField?.min
          const maxV = parentField?.max
          const base = Math.max(minV ?? 0, 0)
          const relax = maxV === undefined || base + 1 <= maxV
          t.push(`    tight = create_row(client, ${JSON.stringify(inv.entity)}${onCreate.auth && withAuth ? ", token=token" : ""}, overrides={${JSON.stringify(boundField)}: ${base}})`)
          t.push(`    for _i in range(${base}):`)
          t.push(`        body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
          t.push(`        body[${JSON.stringify(c.refField)}] = tight["id"]`)
          t.push(`        r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
          t.push("        assert r.status_code == 201, r.text")
          // 1) the parent is at its bound: the next create must fail
          t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
          t.push(`    body[${JSON.stringify(c.refField)}] = tight["id"]`)
          t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
          t.push("    assert r.status_code == 409, r.text")
          t.push('    assert r.json() == {"detail": "Invariant violated"}')
          // 2) relax the bound by one (skipped when the max bound would
          // 422 first): one more create succeeds, the next fails;
          // 3) tightening back below the live count also fails.
          if (onUpdate && relax) {
            t.push(`    r = client.patch(${pathExpr(onUpdate, 'tight["id"]')}, json={${JSON.stringify(boundField)}: ${base + 1}}${uSuffix})`)
            t.push("    assert r.status_code == 200, r.text")
            t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
            t.push(`    body[${JSON.stringify(c.refField)}] = tight["id"]`)
            t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
            t.push("    assert r.status_code == 201, r.text")
            t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
            t.push(`    body[${JSON.stringify(c.refField)}] = tight["id"]`)
            t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
            t.push("    assert r.status_code == 409, r.text")
            t.push('    assert r.json() == {"detail": "Invariant violated"}')
            t.push(`    r = client.patch(${pathExpr(onUpdate, 'tight["id"]')}, json={${JSON.stringify(boundField)}: ${base}}${uSuffix})`)
            t.push("    assert r.status_code == 409, r.text")
            t.push('    assert r.json() == {"detail": "Invariant violated"}')
          }
          void onSuffix
        } else if (boundConst !== undefined) {
          // const bound N: the first N creates succeed, the (N+1)-th fails
          const N = Math.max(0, Math.min(boundConst, 3))
          t.push(`    holder = create_row(client, ${JSON.stringify(inv.entity)}${onCreate && hasAuth && onCreate.auth ? ", token=token" : ""})`)
          for (let i = 0; i < N; i++) {
            t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
            t.push(`    body[${JSON.stringify(c.refField)}] = holder["id"]`)
            t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
            t.push("    assert r.status_code == 201, r.text")
          }
          t.push(`    body = make_body(client, ${JSON.stringify(c.entity)}${cTokenArg})`)
          t.push(`    body[${JSON.stringify(c.refField)}] = holder["id"]`)
          t.push(`    r = client.post(${JSON.stringify(countedCreate.path)}, json=body${cSuffix})`)
          t.push("    assert r.status_code == 409, r.text")
          t.push('    assert r.json() == {"detail": "Invariant violated"}')
        }
      }
    }
  }

  // ---- count endpoints ----
  for (const route of bp.routes.filter((r) => r.operation === "count")) {
    const entityName = route.entity!
    const create = createRoutes.get(entityName)
    const needsToken = hasAuth && route.auth
    const suffix = needsToken ? ', headers={"Authorization": f"Bearer {token}"}' : ""
    const tokenArg = needsToken ? ", token=token" : ""
    // The token itself is created via register: when counting the
    // principal entity, that row is already present (listScope allRows).
    const principalOffset =
      needsToken && hasAuth && bp.auth!.principal === entityName ? 1 : 0
    t.push("")
    t.push("")
    t.push(`def test_count_${entityName.toLowerCase()}(client):`)
    if (needsToken) t.push("    token = auth_token(client)")
    t.push(`    r = client.get(${JSON.stringify(route.path)}${suffix})`)
    t.push("    assert r.status_code == 200, r.text")
    t.push(`    assert r.json() == {"count": ${principalOffset}}`)
    if (create) {
      t.push(`    create_row(client, ${JSON.stringify(entityName)}${tokenArg})`)
      t.push(`    r = client.get(${JSON.stringify(route.path)}${suffix})`)
      t.push("    assert r.status_code == 200, r.text")
      t.push(`    assert r.json() == {"count": ${principalOffset + 1}}`)
    }
  }

  return {
    files: {
      "conformance/conftest.py": conftest,
      "conformance/helpers.py": helpers,
      "conformance/test_contract.py": t.join("\n") + "\n",
      "conformance/test_infrastructure.py": infrastructureTests(bp),
      "conformance/behavior_snapshot.py": behaviorSnapshot(bp),
      "conformance/contract.json": stableStringify(bp) + "\n",
      ...(bp.examples.length > 0 ? { "conformance/test_examples.py": examplesTests(bp) } : {}),
    },
  }
}

/** conformance/test_examples.py — author-declared input→output examples.
 *
 * One test per @spec/test example: build the declared fixture world via
 * the API, send the literal input exactly as written, assert the pinned
 * status and the body subset. No sampling, no synthesis — the author's
 * literals are the contract. */
function examplesTests(bp: BackendBlueprint): string {
  const hasAuth = !!bp.auth
  const createRoutes = createRoutesByEntity(bp)
  const tableOf = (entity: string): string => bp.entities.find((e) => e.name === entity)?.table ?? entity
  const usesCounts = bp.examples.some((e) => (e.expect.state?.counts ?? []).length > 0)
  const lines: string[] = [
    '"""Compiler-generated author examples — DO NOT EDIT.',
    "",
    "One test per @spec/test example declaration: create the fixture world,",
    "send the literal request body, assert the pinned status, body subset or",
    "exact key set, and the declared world effects (outbox rows, row deltas).",
    '"""',
    "",
    `from helpers import create_row${hasAuth ? ", auth_token" : ""}`,
    ...(usesCounts
      ? [
          "",
          "",
          "def _table_count(client, table):",
          "    import sqlite3",
          "    conn = sqlite3.connect(client.db_path)",
          "    n = conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]",
          "    conn.close()",
          "    return n",
        ]
      : []),
    "",
  ]
  for (const example of bp.examples) {
    const route = bp.routes.find((r) => r.id === example.routeId)!
    const needsToken =
      hasAuth && (route.auth || example.given.some((f) => createRoutes.get(f.entity)?.auth === true))
    const headers = needsToken && route.auth ? ', headers={"Authorization": f"Bearer {token}"}' : ""
    const safeName = example.name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()
    lines.push("", "", `def test_example_${safeName}(client):`)
    if (needsToken) lines.push("    token = auth_token(client)")
    for (const fixture of example.given) {
      const overrides = Object.entries(fixture.fields ?? {}).map(([key, value]) =>
        `${JSON.stringify(key)}: ${typeof value === "string" && value.startsWith("$") ? `_${value.slice(1)}["id"]` : pythonLiteral(value)}`,
      )
      lines.push(
        `    _${fixture.as} = create_row(client, ${JSON.stringify(fixture.entity)}` +
          (needsToken ? ", token=token" : "") +
          (overrides.length > 0 ? `, overrides={${overrides.join(", ")}}` : "") +
          ")",
      )
    }
    for (const count of example.expect.state?.counts ?? []) {
      lines.push(`    _before_${tableOf(count.entity)} = _table_count(client, ${JSON.stringify(tableOf(count.entity))})`)
    }
    const path = pathExpr(route, example.subjectAs !== undefined ? `_${example.subjectAs}["id"]` : '""')
    const inputParts =
      example.input !== undefined
        ? Object.entries(example.input).map(([key, value]) =>
            `${JSON.stringify(key)}: ${typeof value === "string" && value.startsWith("$") ? `_${value.slice(1)}["id"]` : pythonLiteral(value)}`,
          )
        : undefined
    const method =
      route.method === "GET" ? "client.get" : route.method === "PATCH" ? "client.patch" : route.method === "PUT" ? "client.put" : route.method === "DELETE" ? "client.delete" : "client.post"
    lines.push(
      `    r = ${method}(${path}${inputParts !== undefined ? `, json={${inputParts.join(", ")}}` : ""}${headers})`,
    )
    lines.push(`    assert r.status_code == ${example.expect.status}, r.text`)
    if (example.expect.match === "exact" && route.entity !== undefined) {
      const entity = bp.entities.find((e) => e.name === route.entity)
      const keys = (entity?.fields ?? []).map((f) => JSON.stringify(f.name)).sort((a, b) => a.localeCompare(b))
      lines.push(`    assert set(r.json().keys()) == {${keys.join(", ")}}`)
    }
    for (const [key, value] of Object.entries(example.expect.body ?? {})) {
      if (typeof value === "object" && value !== null) {
        const marker = (value as Record<string, unknown>).__expect
        if (marker === "notNull") {
          lines.push(`    assert r.json()[${JSON.stringify(key)}] is not None`)
          continue
        }
        if (marker === "any") {
          lines.push(`    assert ${JSON.stringify(key)} in r.json()`)
          continue
        }
      }
      if (typeof value === "string" && value.startsWith("$")) {
        lines.push(`    assert r.json()[${JSON.stringify(key)}] == _${value.slice(1)}["id"]`)
        continue
      }
      lines.push(`    assert r.json()[${JSON.stringify(key)}] == ${pythonLiteral(value)}`)
    }
    for (const row of example.expect.state?.outbox ?? []) {
      const fields = row.fields.map((f) => JSON.stringify(f)).join(", ")
      lines.push("    import json as _json, sqlite3")
      lines.push("    conn = sqlite3.connect(client.db_path)")
      lines.push('    rows = conn.execute("SELECT event, payload FROM events").fetchall()')
      lines.push("    conn.close()")
      lines.push(`    matching = [rw for rw in rows if rw[0] == ${JSON.stringify(row.event)}]`)
      lines.push("    assert len(matching) >= 1, rows")
      lines.push("    payload = _json.loads(matching[-1][1])")
      lines.push(`    assert set(payload.keys()) == {${fields}}`)
      for (const field of row.fields) {
        lines.push(`    assert payload[${JSON.stringify(field)}] == _${row.fromAs}[${JSON.stringify(field)}]`)
      }
    }
    for (const count of example.expect.state?.counts ?? []) {
      const delta =
        count.delta === 0 ? "" : count.delta > 0 ? ` + ${count.delta}` : ` - ${Math.abs(count.delta)}`
      lines.push(
        `    assert _table_count(client, ${JSON.stringify(tableOf(count.entity))}) == _before_${tableOf(count.entity)}${delta}`,
      )
    }
  }
  return lines.join("\n") + "\n"
}

/** Bare request expression used by the no-token protection tests. */
function requestExpr(route: BlueprintRoute, idExpr: string): string {
  const path = pathExpr(route, idExpr)
  switch (route.method) {
    case "GET":
      return `client.get(${path})`
    case "POST":
      return `client.post(${path}, json={})`
    case "PATCH":
      return `client.patch(${path}, json={})`
    case "PUT":
      return `client.put(${path}, json={})`
    case "DELETE":
      return `client.delete(${path})`
  }
}

function pythonInterfaceLiteral(
  value: Record<string, { statuses: string[]; pathParams: string[] }>,
): string {
  const entries = Object.entries(value).map(([key, val]) => {
    const statuses = `[${val.statuses.map((s) => `"${s}"`).join(", ")}]`
    const params = `[${val.pathParams.map((p) => `"${p}"`).join(", ")}]`
    return `    ${JSON.stringify(key)}: {"statuses": ${statuses}, "pathParams": ${params}}`
  })
  // A route-less contract still has to compile: an empty dict literal is
  // "{}", never a dangling comma.
  if (entries.length === 0) return "{}"
  return "{\n" + entries.join(",\n") + ",\n}"
}

function pythonSetLiteral(values: string[]): string {
  return `{${values.map((v) => JSON.stringify(v)).join(", ")}}`
}

/** Path of the GET /auth/me route (asserted to exist when auth is active). */
function mePath(bp: BackendBlueprint): string {
  return bp.auth!.routes.find((r) => r.operation === "me")!.path
}
