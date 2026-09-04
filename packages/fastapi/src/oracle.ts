/**
 * Compiler-generated node oracles.
 *
 * One clause table, one projection: each generation node receives a frozen
 * pytest file under tests/spec_oracle/ that mechanically verifies the
 * node's oracle-verifiable clauses (import surface, route tables, column
 * metadata, pins, schema field sets, pure module behaviors, and the app's
 * OpenAPI route interface). The files are compiler-owned — materialized
 * with the seed, identical in every shot, byte-identical from round 1 to
 * round N. Deep behavioral judgment stays with the conformance suite;
 * anything not mechanically decidable here is a review-kind clause.
 *
 * Style: contract embedding. Every test file is the same three lines plus
 * a CONTRACT JSON literal; runner.py is a single generic interpreter of
 * that data (the same pattern as conformance/test_infrastructure.py).
 */
import { stableStringify } from "@spec/core"
import type { BackendBlueprint, BlueprintRoute } from "./blueprint"
import type { DagTask } from "./dag"

export const ORACLE_DIR = "tests/spec_oracle"

export function safeTaskSegment(taskId: string): string {
  return taskId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

export function oracleFileFor(taskId: string): string {
  return `${ORACLE_DIR}/test_${safeTaskSegment(taskId)}.py`
}

function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The pinned uv invocation that runs one oracle file. */
export function testCommandFor(bp: BackendBlueprint, testFile: string): string {
  const packages = Object.entries({ ...bp.stack.dependencies, ...bp.stack.dev })
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, version]) => ["--with", shellWord(`${name}==${version}`)])
  return [
    "uv", "run", "--no-project", "--python", shellWord(bp.stack.python),
    ...packages,
    "python", "-B", "-m", "pytest", "-p", "no:cacheprovider", "-q", testFile,
  ].join(" ")
}

function normalizeCaseTable(bp: BackendBlueprint): Array<[string, string]> {
  const fallback = bp.database.fallback
  const cases: Array<[string, string]> = [
    ["data.db", `sqlite:///data.db`],
    ["", fallback],
    ["sqlite:///existing.db", "sqlite:///existing.db"],
    ["postgresql+psycopg://host/db", "postgresql+psycopg://host/db"],
  ]
  return cases
}

/** The node's oracle contract: the machine-checkable slice of its clause table. */
function oracleContractFor(bp: BackendBlueprint, task: DagTask): Record<string, unknown> {
  const clauses = task.clauses.map((clause) => ({ id: clause.id, kind: clause.kind, verification: clause.verification, level: clause.level }))
  const base = { node: task.id, kind: task.kind, clauses }
  switch (task.kind) {
    case "project":
      return {
        ...base,
        pins: {
          name: bp.app.name.toLowerCase(),
          version: bp.app.version,
          requiresPython: `==${bp.stack.python}.*`,
          dependencies: Object.entries(bp.stack.dependencies).map(([name, version]) => `${name}==${version}`).sort(),
          dev: Object.entries(bp.stack.dev).map(([name, version]) => `${name}==${version}`).sort(),
        },
        files: ["app/__init__.py", ".gitignore"],
      }
    case "models": {
      const declared = (entityName: string, column: string): boolean =>
        bp.entities.find((e) => e.name === entityName)?.fields.some((f) => f.column === column) ?? false
      return {
        ...base,
        tables: [...bp.entities.map((e) => e.table), ...(bp.effects ? [bp.effects.eventsTable] : [])].sort(),
        entities: bp.entities.map((entity) => ({
          table: entity.table,
          columns: [
            ...entity.fields.map((f) => f.column),
            ...(!declared(entity.name, "id") ? ["id"] : []),
            ...(!declared(entity.name, "created_at") ? ["created_at"] : []),
            ...(bp.auth?.principal === entity.name && !declared(entity.name, bp.auth.passwordColumn) ? [bp.auth.passwordColumn] : []),
          ].sort(),
        })),
      }
    }
    case "database":
      return {
        ...base,
        exports: ["Base", "normalize_database_url", "resolve_database_url", "create_engine_from_url", "create_session_factory", "engine", "SessionLocal", "get_db", "session_dependency"],
        normalizeCases: normalizeCaseTable(bp),
      }
    case "schemas":
      return {
        ...base,
        entities: bp.entities.map((entity) => {
          const lifecycleField = bp.lifecycles.find((l) => l.entity === entity.name)?.field
          return {
            name: entity.name,
            createFields: entity.fields.filter((f) => f.name !== lifecycleField).map((f) => f.name).sort(),
            responseFields: entity.fields.map((f) => f.name).sort(),
          }
        }),
      }
    case "security":
      return { ...base, exports: ["hash_password", "verify_password", "create_access_token", "decode_access_token"] }
    case "router": {
      const routes: BlueprintRoute[] = bp.routes.filter((r) => r.owner.taskId === task.id)
      const countRoute = routes.find((r) => r.operation === "count")
      const hasIdRoute = routes.some((r) => r.path.includes("{id}"))
      return {
        ...base,
        module: task.id === "router:auth" ? "app.routers.auth" : `app.routers.${task.id.slice("router:".length).toLowerCase()}`,
        routes: routes.map((r) => [r.method, r.path, r.status]).sort(([leftMethod, leftPath], [rightMethod, rightPath]) => `${leftMethod} ${leftPath}`.localeCompare(`${rightMethod} ${rightPath}`)),
        ...(countRoute && hasIdRoute ? { countBeforeId: true, countPath: countRoute.path } : {}),
      }
    }
    case "cache":
      return { ...base, exports: ["CacheUnavailable", "CachePolicy", "CACHE_POLICIES", "InMemoryCacheBackend", "RedisCacheBackend"], policies: bp.caches.map((c) => c.name).sort(), unknownPolicy: `${bp.caches[0]?.name ?? "cache"}-unknown` }
    case "messaging":
      return { ...base, exports: ["MessageValidationError", "MESSAGE_DEFINITIONS", "QUEUE_POLICIES", "validate_payload", "build_envelope", "InMemoryMessageBroker"], definitions: bp.messages.map((m) => m.name).sort(), queues: bp.queues.map((q) => q.name).sort() }
    case "blob":
      return { ...base, exports: ["BlobValidationError", "BlobPolicy", "BLOB_POLICIES", "normalize_blob_key", "InMemoryBlobStore", "S3BlobStore"], policies: bp.blobs.map((b) => b.name).sort() }
    case "app":
      return {
        ...base,
        title: bp.app.title,
        version: bp.app.version,
        routes: bp.routes
          .filter((r) => r.entity !== undefined || r.operation === "login" || r.operation === "register" || r.operation === "me")
          .map((r) => `${r.method} ${r.path}`)
          .sort(),
      }
    default:
      return base
  }
}

function pythonString(value: string): string {
  return JSON.stringify(value)
}

/** The frozen generic runner shared by every node oracle in one module. */
function runnerSource(): string {
  return `"""Compiler-owned node oracle runner — DO NOT EDIT.

Generated by @spec/fastapi alongside the per-node CONTRACT test files.
It mechanically verifies the oracle-verifiable clauses of one node:
import surfaces, route tables, table metadata, pins, schema field sets,
pure module behaviors, and the assembled application's OpenAPI interface.
Deep behavioral judgment lives in the conformance suite, never here.
"""
import importlib
import inspect
import json
import sys
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[2]
if str(MODULE_ROOT) not in sys.path:
    sys.path.insert(0, str(MODULE_ROOT))


def check_contract(contract):
    dispatch = {
        "project": _check_project,
        "models": _check_models,
        "database": _check_database,
        "schemas": _check_schemas,
        "security": _check_security,
        "router": _check_router,
        "cache": _check_cache,
        "messaging": _check_messaging,
        "blob": _check_blob,
        "app": _check_app,
    }
    handler = dispatch.get(contract["kind"])
    assert handler is not None, f"unknown oracle kind {contract['kind']}"
    handler(contract)


def _import(name):
    return importlib.import_module(name)


def _check_project(contract):
    import tomllib

    pins = contract["pins"]
    data = tomllib.loads((MODULE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = data["project"]
    assert project["name"] == pins["name"], project["name"]
    assert project["version"] == pins["version"], project["version"]
    assert project["requires-python"] == pins["requiresPython"], project["requires-python"]
    assert sorted(project["dependencies"]) == sorted(pins["dependencies"]), project["dependencies"]
    dev = project.get("optional-dependencies", {}).get("dev", [])
    assert sorted(dev) == sorted(pins["dev"]), dev
    for relative in contract["files"]:
        assert (MODULE_ROOT / relative).exists(), relative


def _check_models(contract):
    models = _import("app.models")
    tables = set(models.Base.metadata.tables)
    expected = set(contract["tables"])
    assert tables == expected, (sorted(tables), sorted(expected))
    for entity in contract["entities"]:
        table = models.Base.metadata.tables[entity["table"]]
        columns = set(table.columns.keys())
        assert columns == set(entity["columns"]), (entity["table"], sorted(columns))


def _check_database(contract):
    database = _import("app.database")
    for name in contract["exports"]:
        assert hasattr(database, name), name
    for value, expected in contract["normalizeCases"]:
        assert database.normalize_database_url(value) == expected, (value, expected)
    engine = database.create_engine_from_url("sqlite://")
    assert engine.dialect.name == "sqlite"
    engine.dispose()


def _check_schemas(contract):
    from pydantic import BaseModel

    schemas = _import("app.schemas")
    for entity in contract["entities"]:
        for suffix in ("Create", "Update", "Out"):
            model = getattr(schemas, entity["name"] + suffix, None)
            assert model is not None, entity["name"] + suffix
            assert issubclass(model, BaseModel), entity["name"] + suffix
        create = set(getattr(schemas, entity["name"] + "Create").model_fields)
        assert create == set(entity["createFields"]), (entity["name"], sorted(create))
        update = getattr(schemas, entity["name"] + "Update")
        for info in update.model_fields.values():
            assert not info.is_required(), (entity["name"] + "Update", info)
        out = set(getattr(schemas, entity["name"] + "Out").model_fields)
        assert out == set(entity["responseFields"]), (entity["name"], sorted(out))


def _check_security(contract):
    security = _import("app.security")
    for name in contract["exports"]:
        assert hasattr(security, name), name
    assert security.verify_password("secret", None) is False
    hashed = security.hash_password("secret")
    assert hashed.startswith("$2"), hashed[:4]
    assert security.verify_password("secret", hashed) is True


def _check_router(contract):
    from fastapi import APIRouter

    module = _import(contract["module"])
    router = getattr(module, "router", None)
    assert isinstance(router, APIRouter), contract["module"]
    actual = sorted(
        (method, route.path, route.status_code)
        for route in router.routes
        if getattr(route, "methods", None)
        for method in route.methods
        if method != "HEAD"
    )
    expected = sorted(
        (method, path, status)
        for method, path, status in contract["routes"]
    )
    assert actual == expected, (actual, expected)
    if contract.get("countBeforeId"):
        paths = [route.path for route in router.routes]
        count_index = paths.index(contract["countPath"])
        id_index = next(index for index, value in enumerate(paths) if "{id}" in value)
        assert count_index < id_index, (contract["countPath"], paths)
    source = inspect.getsource(module)
    assert "DeclarativeBase" not in source, "routers must not define or import an ORM base"
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith("from app.models import"):
            imported = stripped.split("import", 1)[1]
            assert "Base" not in [part.strip() for part in imported.split(",")], stripped


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def _check_cache(contract):
    cache = _import("app.cache")
    for name in contract["exports"]:
        assert hasattr(cache, name), name
    assert set(cache.CACHE_POLICIES) == set(contract["policies"]), sorted(map(str, cache.CACHE_POLICIES))
    backend = cache.InMemoryCacheBackend()

    async def unknown_policy():
        try:
            await backend.get(contract["unknownPolicy"], "k")
            return False
        except KeyError:
            return True

    assert _run(unknown_policy()), "unknown policy must raise KeyError"


def _check_messaging(contract):
    messaging = _import("app.messaging")
    for name in contract["exports"]:
        assert hasattr(messaging, name), name
    assert set(messaging.MESSAGE_DEFINITIONS) == set(contract["definitions"])
    assert set(messaging.QUEUE_POLICIES) == set(contract["queues"])
    known = sorted(messaging.MESSAGE_DEFINITIONS)[0]
    try:
        messaging.validate_payload(known, {})
        raise AssertionError("validate_payload must reject an empty payload")
    except messaging.MessageValidationError:
        pass


def _check_blob(contract):
    blob = _import("app.blob")
    for name in contract["exports"]:
        assert hasattr(blob, name), name
    assert set(blob.BLOB_POLICIES) == set(contract["policies"]), sorted(map(str, blob.BLOB_POLICIES))
    try:
        blob.normalize_blob_key(contract["policies"][0], "/absolute")
        raise AssertionError("absolute keys must be rejected")
    except (ValueError, blob.BlobValidationError):
        pass


def _check_app(contract):
    import tempfile
    import os

    main = _import("app.main")
    assert callable(getattr(main, "create_app", None)), "create_app"
    assert getattr(main, "app", None) is not None, "module-level app"
    database_path = os.path.join(tempfile.mkdtemp(prefix="spec-oracle-"), "app.sqlite")
    application = main.create_app(database_url=f"sqlite:///{database_path}")
    schema = application.openapi()
    actual = sorted(
        f"{method.upper()} {path}"
        for path, operations in schema["paths"].items()
        for method in operations
    )
    assert actual == sorted(contract["routes"]), actual
    assert schema["info"]["title"] == contract["title"], schema["info"]["title"]
    assert schema["info"]["version"] == contract["version"], schema["info"]["version"]
`
}

function oracleTestSource(contractJson: string): string {
  return `"""Compiler-owned node oracle — DO NOT EDIT (generated from the clause table)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from runner import check_contract

CONTRACT = json.loads(${pythonString(contractJson)})


def test_node_contract():
    check_contract(CONTRACT)


def test_reviewer_judged_clauses_are_explicit():
    # These clauses are deliberately NOT machine-checked here; the read-only
    # reviewer judges them by inspection against the same clause table.
    review_only = sorted(c["id"] for c in CONTRACT["clauses"] if c["verification"] == "review")
    assert isinstance(review_only, list)
`
}

export interface NodeOracleFiles {
  /** Runner + per-node oracle test files, module-relative. */
  files: Record<string, string>
  /** The command running one node's oracle file. */
  commandFor: (taskId: string) => string
}

/** Build the compiler-owned oracle files for every task in the DAG. */
export function buildNodeOracles(bp: BackendBlueprint, tasks: DagTask[]): NodeOracleFiles {
  const files: Record<string, string> = { [`${ORACLE_DIR}/runner.py`]: runnerSource() }
  for (const task of tasks) {
    const contract = oracleContractFor(bp, task)
    const contractJson = stableStringify(contract)
    if (contractJson.includes('"""')) throw new Error(`oracle contract for ${task.id} cannot embed triple quotes`)
    files[oracleFileFor(task.id)] = oracleTestSource(contractJson)
  }
  return {
    files,
    commandFor: (taskId: string) => testCommandFor(bp, oracleFileFor(taskId)),
  }
}
