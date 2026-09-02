import { defineApp } from "@spec/core"
import { entity, field, crud, count, lifecycle, transition, invariant, expr, effect } from "@spec/web"
import { auth, password } from "@spec/auth"
import { postgres } from "@spec/postgres"
import { cache } from "@spec/cache"
import { redis } from "@spec/redis"
import { message, queue } from "@spec/messaging"
import { rabbitmq } from "@spec/rabbitmq"
import { kafka } from "@spec/kafka"
import { sqs } from "@spec/sqs"
import { blob } from "@spec/blob"
import { s3 } from "@spec/s3"
import { fastapi } from "@spec/fastapi"

/**
 * Media Operations Platform
 *
 * A deliberately broad production-style specification used as the
 * repeatability acceptance system. It combines relational behavior,
 * authentication, state machines, invariants, caching, three independent
 * message brokers, and multiple S3-backed object classes.
 */

const User = entity("User", {
  id: field.uuid(), email: field.email().unique(), displayName: field.string(),
  role: field.enum("operator", "editor", "viewer"),
  active: field.boolean().default(true),
})

const Organization = entity("Organization", {
  id: field.uuid(), slug: field.string().unique(), name: field.string(),
  owner: field.ref("User"),
  plan: field.enum("starter", "team", "enterprise"),
  projectLimit: field.int().default(10),
})

const Project = entity("Project", {
  id: field.uuid(), organization: field.ref("Organization"),
  key: field.string().unique(), name: field.string(),
  description: field.string().optional(),
  status: field.enum("draft", "active", "archived"),
  maxAssets: field.int().default(100),
  activatedAt: field.datetime().optional(), archivedAt: field.datetime().optional(),
})

const Dataset = entity("Dataset", {
  id: field.uuid(), project: field.ref("Project"), name: field.string(),
  schemaVersion: field.int().default(1),
  description: field.string().optional(),
  locked: field.boolean().default(false),
})

const Asset = entity("Asset", {
  id: field.uuid(), project: field.ref("Project"), dataset: field.ref("Dataset"),
  uploadedBy: field.ref("User"), filename: field.string(),
  objectKey: field.string().unique(),
  mediaType: field.string(), sizeBytes: field.int(), checksum: field.string(),
  status: field.enum("pending", "ready", "rejected", "deleted"),
  readyAt: field.datetime().optional(), deletedAt: field.datetime().optional(),
})

const ProcessingJob = entity("ProcessingJob", {
  id: field.uuid(), asset: field.ref("Asset"), requestedBy: field.ref("User"),
  kind: field.enum("transcode", "thumbnail", "metadata", "virus-scan"),
  priority: field.int().default(5), attempt: field.int().default(0),
  status: field.enum("queued", "running", "succeeded", "failed", "cancelled"),
  startedAt: field.datetime().optional(), finishedAt: field.datetime().optional(),
  errorMessage: field.string().optional(),
})

const Delivery = entity("Delivery", {
  id: field.uuid(), asset: field.ref("Asset"), requestedBy: field.ref("User"),
  destination: field.string(),
  status: field.enum("requested", "dispatching", "delivered", "failed", "cancelled"),
  attempts: field.int().default(0),
  deliveredAt: field.datetime().optional(), failureReason: field.string().optional(),
})

const AuditRecord = entity("AuditRecord", {
  id: field.uuid(), actor: field.ref("User"), project: field.ref("Project"),
  action: field.string(), subjectType: field.string(), subjectId: field.uuid(),
  occurredAt: field.datetime(),
  summary: field.string().optional(),
})

const Webhook = entity("Webhook", {
  id: field.uuid(), project: field.ref("Project"), url: field.string(),
  secretName: field.string(), eventFilter: field.string(),
  enabled: field.boolean().default(true),
  failureCount: field.int().default(0),
})

const ApiKey = entity("ApiKey", {
  id: field.uuid(), owner: field.ref("User"), label: field.string(),
  prefix: field.string().unique(), scope: field.string(),
  enabled: field.boolean().default(true),
  expiresAt: field.datetime().optional(),
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})

const Users = crud(User, { methods: ["list", "get", "update"] })
const Organizations = crud(Organization)
const Projects = crud(Project)
const Datasets = crud(Dataset)
const Assets = crud(Asset)
const Jobs = crud(ProcessingJob)
const Deliveries = crud(Delivery)
const AuditRecords = crud(AuditRecord, { methods: ["list", "get", "create"] })
const Webhooks = crud(Webhook)
const ApiKeys = crud(ApiKey)

const ProjectCount = count(Project)
const AssetCount = count(Asset)
const JobCount = count(ProcessingJob)
const DeliveryCount = count(Delivery)

const ProjectFlow = lifecycle(Project, {
  field: "status", initial: "draft",
  transitions: [
    transition("activate", {
      from: ["draft"], to: "active",
      effects: [
        effect.set("activatedAt", expr.request.time()),
        effect.emit("project.activated", ["id", "organization", "key"]),
      ],
    }),
    transition("archive", {
      from: ["active"], to: "archived",
      effects: [
        effect.set("archivedAt", expr.request.time()),
        effect.emit("project.archived", ["id", "organization", "key"]),
      ],
    }),
  ],
})

const AssetFlow = lifecycle(Asset, {
  field: "status", initial: "pending",
  transitions: [
    transition("accept", {
      from: ["pending"], to: "ready",
      effects: [
        effect.set("readyAt", expr.request.time()),
        effect.emit("asset.ready", ["id", "project", "objectKey"]),
      ],
    }),
    transition("reject", {
      from: ["pending"], to: "rejected",
      effects: [effect.emit("asset.rejected", ["id", "project", "checksum"])],
    }),
    transition("remove", {
      from: ["ready", "rejected"], to: "deleted",
      effects: [effect.set("deletedAt", expr.request.time())],
    }),
  ],
})

const JobFlow = lifecycle(ProcessingJob, {
  field: "status", initial: "queued",
  transitions: [
    transition("start", {
      from: ["queued"], to: "running",
      effects: [effect.set("startedAt", expr.request.time())],
    }),
    transition("succeed", {
      from: ["running"], to: "succeeded",
      effects: [
        effect.set("finishedAt", expr.request.time()),
        effect.emit("job.succeeded", ["id", "asset", "kind"]),
      ],
    }),
    transition("fail", {
      from: ["running"], to: "failed",
      effects: [
        effect.set("finishedAt", expr.request.time()),
        effect.emit("job.failed", ["id", "asset", "kind"]),
      ],
    }),
    transition("cancel", {
      from: ["queued", "running"], to: "cancelled",
      effects: [effect.set("finishedAt", expr.request.time())],
    }),
  ],
})

const PositiveProjectLimit = invariant("positive-project-limit", {
  on: Organization, check: expr.field("projectLimit").gt(expr.const(0)),
})
const PositiveAssetSize = invariant("positive-asset-size", {
  on: Asset, check: expr.field("sizeBytes").gt(expr.const(0)),
})
const PositiveJobPriority = invariant("positive-job-priority", {
  on: ProcessingJob, check: expr.field("priority").gt(expr.const(0)),
})
const ProjectAssetCapacity = invariant("project-asset-capacity", {
  on: Project, check: expr.countOf(Asset, { project: "self" }).lte(expr.field("maxAssets")),
})

const MainRedis = redis({
  urlEnv: "MEDIA_REDIS_URL", connectTimeoutSeconds: 2, operationTimeoutSeconds: 1,
})

const MetadataCache = cache({
  provider: MainRedis, keyPrefix: "media:metadata", ttlSeconds: 300, failureMode: "bypass",
  stampedeProtection: true,
})
const AuthorizationCache = cache({
  provider: MainRedis, keyPrefix: "media:authorization", ttlSeconds: 60,
  failureMode: "fail-closed",
})
const DeliveryCache = cache({
  provider: MainRedis, keyPrefix: "media:delivery", ttlSeconds: 30, failureMode: "bypass",
})

const AssetUploaded = message("AssetUploaded", { fields: {
  assetId: "uuid", projectId: "uuid", objectKey: "string", sizeBytes: "int",
} })
const AssetReady = message("AssetReady", { fields: {
  assetId: "uuid", projectId: "uuid", readyAt: "datetime",
} })
const JobRequested = message("JobRequested", { fields: {
  jobId: "uuid", assetId: "uuid", kind: "string", priority: "int",
} })
const JobFinished = message("JobFinished", { fields: {
  jobId: "uuid", assetId: "uuid", succeeded: "boolean", finishedAt: "datetime",
} })
const DeliveryRequested = message("DeliveryRequested", { fields: {
  deliveryId: "uuid", assetId: "uuid", destination: "string",
} })
const AuditCaptured = message("AuditCaptured", { fields: {
  auditId: "uuid", projectId: "uuid", action: "string", occurredAt: "datetime",
} })

const Rabbit = rabbitmq({ urlEnv: "MEDIA_RABBITMQ_URL", prefetch: 24, heartbeatSeconds: 30 })
const Kafka = kafka({ brokersEnv: "MEDIA_KAFKA_BROKERS", clientId: "media-operations", requestTimeoutMs: 5000 })
const SQS = sqs({ regionEnv: "AWS_REGION", endpointUrlEnv: "MEDIA_SQS_ENDPOINT_URL", visibilityTimeoutSeconds: 45 })

const ProcessingCommands = queue("ProcessingCommands", {
  provider: Rabbit, messages: [JobRequested, DeliveryRequested],
  delivery: "at-least-once", maxAttempts: 5, backoffSeconds: 2,
  deadLetter: "processing-commands-dead",
})
const AnalyticsEvents = queue("AnalyticsEvents", {
  provider: Kafka, messages: [AssetUploaded, AssetReady, JobFinished, AuditCaptured],
  delivery: "at-least-once", maxAttempts: 3, backoffSeconds: 1,
  deadLetter: "analytics-events-dead", orderingKey: "projectId",
})
const NotificationEvents = queue("NotificationEvents", {
  provider: SQS, messages: [AssetReady, JobFinished, DeliveryRequested],
  delivery: "at-least-once", maxAttempts: 4, backoffSeconds: 5,
  deadLetter: "notification-events-dead", orderingKey: "assetId",
})

const MainS3 = s3({
  regionEnv: "AWS_REGION", endpointUrlEnv: "MEDIA_S3_ENDPOINT_URL",
  forcePathStyle: true, connectTimeoutSeconds: 2, readTimeoutSeconds: 10,
})

const Originals = blob("Originals", {
  provider: MainS3, bucket: "media-originals", keyPrefix: "originals",
  maxBytes: 1073741824,
  contentTypes: ["image/jpeg", "image/png", "video/mp4", "application/pdf"],
  signedUrlTtlSeconds: 900, retentionDays: 365,
})
const Derivatives = blob("Derivatives", {
  provider: MainS3, bucket: "media-derivatives", keyPrefix: "derived",
  maxBytes: 268435456,
  contentTypes: ["image/jpeg", "image/png", "video/mp4", "application/json"],
  signedUrlTtlSeconds: 600, retentionDays: 90,
})
const Exports = blob("Exports", {
  provider: MainS3, bucket: "media-exports", keyPrefix: "exports",
  maxBytes: 2147483648,
  contentTypes: ["application/zip", "application/x-tar", "application/json"],
  signedUrlTtlSeconds: 300, retentionDays: 30,
})

const MainDB = postgres({
  entities: [User, Organization, Project, Dataset, Asset,
    ProcessingJob, Delivery, AuditRecord, Webhook, ApiKey],
})

const Server = fastapi({
  title: "Media Operations API",
  version: "1.0.0",
  prefix: "/api/v1",
  port: 8080,
  services: [
    MainAuth, Users, Organizations, Projects, Datasets, Assets, Jobs,
    Deliveries, AuditRecords, Webhooks, ApiKeys,
    ProjectCount, AssetCount, JobCount, DeliveryCount,
    ProjectFlow, AssetFlow, JobFlow,
    PositiveProjectLimit, PositiveAssetSize, PositiveJobPriority,
    ProjectAssetCapacity,
    MetadataCache, AuthorizationCache, DeliveryCache,
    ProcessingCommands, AnalyticsEvents, NotificationEvents,
    Originals, Derivatives, Exports,
  ],
  resources: [MainDB, MainRedis, Rabbit, Kafka, SQS, MainS3],
})

export default defineApp({
  name: "MediaOperationsAPI",
  entities: [User, Organization, Project, Dataset, Asset,
    ProcessingJob, Delivery, AuditRecord, Webhook, ApiKey],
  services: [
    MainAuth, Users, Organizations, Projects, Datasets, Assets, Jobs,
    Deliveries, AuditRecords, Webhooks, ApiKeys,
    ProjectCount, AssetCount, JobCount, DeliveryCount,
    ProjectFlow, AssetFlow, JobFlow,
    PositiveProjectLimit, PositiveAssetSize, PositiveJobPriority,
    ProjectAssetCapacity,
    MetadataCache, AuthorizationCache, DeliveryCache,
    ProcessingCommands, AnalyticsEvents, NotificationEvents,
    Originals, Derivatives, Exports,
    AssetUploaded, AssetReady, JobRequested, JobFinished,
    DeliveryRequested, AuditCaptured,
  ],
  resources: [MainDB, MainRedis, Rabbit, Kafka, SQS, MainS3, Server],
})
