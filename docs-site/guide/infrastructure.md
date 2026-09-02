# Backend infrastructure

The infrastructure packages separate portable behavior from provider
configuration. A cache policy describes TTL and failure semantics; Redis
describes how that policy is implemented. Messaging and blob storage follow
the same split.

| Behavior package | Provider packages | Generated capability |
| --- | --- | --- |
| `@spec/cache` | `@spec/redis` | cache-aside storage, TTL, invalidation and stampede protection |
| `@spec/messaging` | `@spec/rabbitmq`, `@spec/kafka`, `@spec/sqs` | validated envelopes, delivery, retry, ordering and dead letters |
| `@spec/blob` | `@spec/s3` | object validation, normalized keys, retention and signed URLs |

Provider references are explicit. This permits one application to use several
brokers without relying on an ambiguous global `MessageBroker` selection.

## Cache and Redis

```ts
import { cache } from "@spec/cache"
import { redis } from "@spec/redis"

const MainRedis = redis({
  urlEnv: "MEDIA_REDIS_URL",
  connectTimeoutSeconds: 2,
  operationTimeoutSeconds: 1,
})

const MetadataCache = cache({
  provider: MainRedis,
  keyPrefix: "media:metadata",
  ttlSeconds: 300,
  failureMode: "bypass",
  stampedeProtection: true,
})
```

`failureMode` is observable behavior:

- `bypass` treats Redis failures as cache misses and lets the source loader run.
- `fail-closed` raises a typed cache-unavailable error.

The generated Python module exposes immutable policies, deterministic
in-memory behavior for tests, and a `redis.asyncio` adapter. Redis connections
are application-scoped, created during FastAPI lifespan, protected by explicit
timeouts and closed at shutdown.

## Messages, queues and providers

Messages have closed, statically validated schemas:

```ts
const AssetReady = message("AssetReady", {
  fields: {
    assetId: "uuid",
    projectId: "uuid",
    readyAt: "datetime",
  },
})
```

A queue binds messages and delivery behavior to one provider:

```ts
const Kafka = kafka({
  brokersEnv: "MEDIA_KAFKA_BROKERS",
  clientId: "media-operations",
  requestTimeoutMs: 5000,
})

const AnalyticsEvents = queue("AnalyticsEvents", {
  provider: Kafka,
  messages: [AssetReady],
  delivery: "at-least-once",
  maxAttempts: 3,
  backoffSeconds: 1,
  deadLetter: "analytics-events-dead",
  orderingKey: "projectId",
})
```

The blueprint pins the message envelope (`message`, version, id,
`occurred_at`, payload), schema validation, allowed messages per queue,
deduplication, retry limits, ordering and dead-letter destination. Provider
adapters add their own engineering rules:

- RabbitMQ uses robust `aio-pika` connections, publisher confirms, durable
  queues, QoS and acknowledgement after successful handling.
- Kafka uses an idempotent `aiokafka` producer, record keys for ordering and
  manual consumer commits.
- SQS uses bounded visibility, long polling and deletion only after success;
  blocking boto3 calls run outside the event loop.

## Blob storage and S3

```ts
const MainS3 = s3({
  regionEnv: "AWS_REGION",
  endpointUrlEnv: "MEDIA_S3_ENDPOINT_URL",
  forcePathStyle: true,
  connectTimeoutSeconds: 2,
  readTimeoutSeconds: 10,
})

const Originals = blob("Originals", {
  provider: MainS3,
  bucket: "media-originals",
  keyPrefix: "originals",
  maxBytes: 1073741824,
  contentTypes: ["image/jpeg", "image/png", "video/mp4"],
  signedUrlTtlSeconds: 900,
  retentionDays: 365,
})
```

The portable contract rejects oversized or disallowed objects before upload,
normalizes keys under the declared prefix, rejects path traversal, and pins the
signed-URL TTL. The S3 adapter adds explicit botocore timeouts, bounded retries,
multipart cleanup and lifespan-managed clients.

## Serving infrastructure

Behavior nodes are FastAPI services and providers are resources:

```ts
const Server = fastapi({
  services: [MetadataCache, AnalyticsEvents, Originals],
  resources: [MainRedis, Kafka, MainS3],
})
```

Infrastructure does not add accidental HTTP routes. It contributes dedicated
`cache`, `messaging` and `blob` tasks to the generation DAG. The compiler-owned
suite imports the generated modules and checks their behavior with deterministic
in-memory adapters, so verification never requires live Redis, brokers or S3.

See the full 324-line system at `examples/media-platform/app.spec.ts` and read
[Agentic generation](/guide/generate) for the parallel two-shot gate.
