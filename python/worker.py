#!/usr/bin/env python3
"""Isolated Python worker for the external-memory backends.

Two modes:

* JSONL (default): one JSON request per stdin line, one JSON response per stdout
  line. Logs and third-party progress output go to stderr so the protocol stays
  machine-readable.
* Embeddings HTTP (``--serve-embeddings``): a localhost OpenAI-compatible
  ``/v1/embeddings`` endpoint using the same FastEmbed model. A single JSON
  ready line is printed to stdout after the model has actually loaded.

The worker never fabricates embeddings. Every vector returned here comes from
FastEmbed, and every Mem0 result comes from the installed ``mem0ai`` package.

Environment is configured before importing ``mem0``/``fastembed`` so that
telemetry is disabled and model caches stay inside the benchmark work
directory.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

DEFAULT_EMBEDDING_MODEL = "intfloat/multilingual-e5-large"
DEFAULT_EMBEDDING_DIMENSIONS = 1024
DEFAULT_GATEWAY_API_KEY = "memory-bench-loopback"

_LOGGER = logging.getLogger("memory-bench.worker")


def _configure_environment(args: argparse.Namespace) -> None:
    # Read by mem0 at import time.
    os.environ["MEM0_TELEMETRY"] = "false"
    os.environ["MEM0_DIR"] = os.path.abspath(
        args.mem0_dir
        or os.path.join(tempfile.gettempdir(), "memory-bench-mem0")
    )
    if args.cache_dir:
        os.environ["FASTEMBED_CACHE_PATH"] = os.path.abspath(args.cache_dir)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TQDM_DISABLE", "1")


class EmbeddingModel:
    """Lazily loaded FastEmbed model with a process-wide lock."""

    def __init__(self, model_name: str, cache_dir: str | None) -> None:
        self.model_name = model_name
        self.cache_dir = cache_dir
        self._model = None
        self._lock = threading.Lock()

    def _load(self):
        if self._model is None:
            from fastembed import TextEmbedding

            kwargs: dict[str, Any] = {"model_name": self.model_name}
            if self.cache_dir:
                kwargs["cache_dir"] = self.cache_dir
            self._model = TextEmbedding(**kwargs)
        return self._model

    @property
    def dimensions(self) -> int:
        with self._lock:
            return int(self._load().embedding_size)

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not isinstance(texts, list) or not texts:
            raise ValueError("embed requires a non-empty 'texts' array")
        if any(not isinstance(text, str) for text in texts):
            raise ValueError("every entry in 'texts' must be a string")
        with self._lock:
            model = self._load()
            vectors = list(model.embed(texts))
        return [vector.tolist() for vector in vectors]


class Mem0Manager:
    """One isolated Mem0 store per corpus, all under the run work directory."""

    def __init__(self) -> None:
        self._instances: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _scope_id(corpus_id: str) -> str:
        import hashlib

        digest = hashlib.sha256(corpus_id.encode("utf-8")).hexdigest()[:24]
        return f"corpus_{digest}"

    @staticmethod
    def _safe_name(value: str) -> str:
        import hashlib
        import re

        cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", value).strip("_")
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]
        return f"{(cleaned or 'corpus')[:40]}_{digest}"

    def _build_config(self, params: dict[str, Any]) -> dict[str, Any]:
        work_dir = os.path.abspath(str(params["workDir"]))
        run_id = str(params["runId"])
        corpus_id = str(params["corpusId"])
        embedding_model = str(params.get("embeddingModel") or DEFAULT_EMBEDDING_MODEL)
        embedding_dimensions = int(
            params.get("embeddingDimensions") or DEFAULT_EMBEDDING_DIMENSIONS
        )

        corpus_dir = os.path.join(
            work_dir, "mem0", self._safe_name(run_id), self._safe_name(corpus_id)
        )
        qdrant_dir = os.path.join(corpus_dir, "qdrant")
        history_path = os.path.join(corpus_dir, "history.db")
        os.makedirs(qdrant_dir, exist_ok=True)

        # The gateway is loopback-only and does not require a bearer. The OpenAI
        # clients require a non-empty value, so use an explicit non-secret marker.
        api_key = str(params.get("apiKey") or DEFAULT_GATEWAY_API_KEY)

        custom_instructions = params.get("customInstructions")
        config: dict[str, Any] = {
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "path": qdrant_dir,
                    "collection_name": f"mem0_{self._safe_name(corpus_id)}",
                    "embedding_model_dims": embedding_dimensions,
                    "on_disk": True,
                },
            },
            "llm": {
                "provider": "openai",
                "config": {
                    "model": str(params["model"]),
                    "api_key": api_key,
                    "openai_base_url": str(params["openaiBaseUrl"]),
                    "temperature": float(params.get("temperature", 0.1)),
                    "max_tokens": int(params.get("maxTokens", 4096)),
                },
            },
            # Use the parent gateway's shared /embeddings endpoint (backed by the
            # FastEmbed HTTP service) instead of loading a second E5 instance.
            "embedder": {
                "provider": "openai",
                "config": {
                    "model": embedding_model,
                    "api_key": api_key,
                    "openai_base_url": str(params["openaiBaseUrl"]),
                    "embedding_dims": embedding_dimensions,
                },
            },
            "history_db_path": history_path,
            "version": "v1.1",
        }
        if custom_instructions:
            config["custom_instructions"] = str(custom_instructions)
        return config

    def _fingerprint(self, params: dict[str, Any]) -> dict[str, Any]:
        return {
            "workDir": os.path.abspath(str(params["workDir"])),
            "runId": str(params["runId"]),
            "corpusId": str(params["corpusId"]),
            "model": str(params["model"]),
            "openaiBaseUrl": str(params["openaiBaseUrl"]),
            "embeddingModel": str(
                params.get("embeddingModel") or DEFAULT_EMBEDDING_MODEL
            ),
            "embeddingDimensions": int(
                params.get("embeddingDimensions") or DEFAULT_EMBEDDING_DIMENSIONS
            ),
        }

    def _get_or_create(self, params: dict[str, Any]) -> dict[str, Any]:
        corpus_id = str(params["corpusId"])
        fingerprint = self._fingerprint(params)
        with self._lock:
            existing = self._instances.get(corpus_id)
            if existing is not None:
                if existing["fingerprint"] != fingerprint:
                    raise RuntimeError(
                        "Mem0 corpus was already initialized with different settings: "
                        f"{existing['fingerprint']!r} != {fingerprint!r}"
                    )
                return existing

            config = self._build_config(params)
            from mem0 import Memory

            started = time.perf_counter()
            memory = Memory.from_config(config)
            actual_dimensions = int(memory.embedding_model.config.embedding_dims)
            expected_dimensions = fingerprint["embeddingDimensions"]
            if actual_dimensions != expected_dimensions:
                memory.close()
                raise RuntimeError(
                    f"Embedding dimension mismatch: model reports {actual_dimensions}, "
                    f"benchmark context requires {expected_dimensions}"
                )

            instance = {
                "memory": memory,
                "fingerprint": fingerprint,
                "config": config,
                "scope_id": self._scope_id(corpus_id),
                "corpus_id": corpus_id,
                "embedding_model": fingerprint["embeddingModel"],
                "embedding_dimensions": actual_dimensions,
                "created_at": time.time(),
                "init_ms": round((time.perf_counter() - started) * 1000, 3),
                "document_ids": [document["id"] for document in params.get("restoredDocuments", [])],
                "message_count": sum(document["messageCount"] for document in params.get("restoredDocuments", [])),
                "add_events": 0,
                "retrievals": 0,
            }
            self._instances[corpus_id] = instance
            return instance

    def initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        instance = self._get_or_create(params)
        return self._describe(instance)

    def ingest(self, params: dict[str, Any]) -> dict[str, Any]:
        instance = self._get_or_create(params)
        memory = instance["memory"]
        documents = params.get("documents")
        if not isinstance(documents, list):
            raise ValueError("mem0_ingest requires a 'documents' array")

        started = time.perf_counter()
        document_results = []
        for document in documents:
            if not isinstance(document, dict):
                raise ValueError("every document must be an object")
            document_id = str(document["id"])
            raw_messages = document.get("messages") or []
            messages = []
            for message in raw_messages:
                role = str(message.get("role", "")).strip()
                content = str(message.get("content", ""))
                if role not in ("user", "assistant"):
                    raise ValueError(
                        f"unsupported role {role!r} in document {document_id!r}"
                    )
                if not content:
                    continue
                messages.append({"role": role, "content": content})
            if not messages:
                document_results.append(
                    {
                        "documentId": document_id,
                        "messageCount": 0,
                        "resultCount": 0,
                        "events": [],
                        "skipped": "no non-empty user/assistant messages",
                    }
                )
                continue

            metadata = {
                "document_id": document_id,
                "corpus_id": str(params["corpusId"]),
                "document_timestamp": str(document.get("timestamp", "")),
            }
            result = memory.add(
                messages,
                user_id=instance["scope_id"],
                metadata=metadata,
                infer=True,
            )
            events = result.get("results", []) if isinstance(result, dict) else []
            instance["document_ids"].append(document_id)
            instance["message_count"] += len(messages)
            instance["add_events"] += len(events)
            document_results.append(
                {
                    "documentId": document_id,
                    "messageCount": len(messages),
                    "resultCount": len(events),
                    "events": events,
                }
            )

        return {
            "corpusId": instance["corpus_id"],
            "scopeId": instance["scope_id"],
            "documents": document_results,
            "stats": self._stats(instance),
            "elapsedMs": round((time.perf_counter() - started) * 1000, 3),
        }

    def retrieve(self, params: dict[str, Any]) -> dict[str, Any]:
        corpus_id = str(params["corpusId"])
        with self._lock:
            instance = self._instances.get(corpus_id)
        if instance is None:
            raise RuntimeError(
                f"Mem0 corpus {corpus_id!r} has not been initialized in this worker"
            )
        query = str(params.get("query", ""))
        if not query.strip():
            raise ValueError("mem0_retrieve requires a non-empty 'query'")
        top_k = int(params.get("topK", 20))
        threshold = float(params.get("threshold", 0.1))
        memory = instance["memory"]
        profile = {"stagesMs": {}, "diagnosticStages": ["embedding"], "candidateCounts": {}, "candidateIds": []}
        originals = []

        def instrument(owner, name, label, candidates=False):
            original = getattr(owner, name)
            originals.append((owner, name, original))

            def measured(*args, **kwargs):
                stage_start = time.perf_counter()
                try:
                    value = original(*args, **kwargs)
                finally:
                    profile["stagesMs"][label] = profile["stagesMs"].get(label, 0) + (time.perf_counter() - stage_start) * 1000
                if candidates and value is not None:
                    profile["candidateCounts"][label] = len(value)
                    if label == "semantic":
                        profile["candidateIds"] = sorted(str(item.id) for item in value)
                return value

            setattr(owner, name, measured)

        if params.get("profile"):
            instrument(memory.embedding_model, "embed", "embedding")
            instrument(memory.vector_store, "search", "semantic", True)
            instrument(memory.vector_store, "keyword_search", "bm25", True)
            instrument(memory, "_compute_entity_boosts", "entity_boost", True)
        started = time.perf_counter()
        try:
            result = memory.search(
                query,
                filters={"user_id": instance["scope_id"]},
                top_k=top_k,
                threshold=threshold,
            )
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            for owner, name, original in reversed(originals):
                setattr(owner, name, original)
        profile["stagesMs"]["search_total"] = elapsed_ms
        profile["diagnosticStages"] = list(profile["stagesMs"].keys() - {"search_total"})
        results = result.get("results", []) if isinstance(result, dict) else []
        instance["retrievals"] += 1
        return {
            "corpusId": corpus_id,
            "scopeId": instance["scope_id"],
            "results": results,
            "count": len(results),
            "elapsedMs": round(elapsed_ms, 3),
            **({"profile": profile} if params.get("profile") else {}),
            "stats": self._stats(instance),
        }

    def stats(self, params: dict[str, Any]) -> dict[str, Any]:
        corpus_id = str(params["corpusId"])
        with self._lock:
            instance = self._instances.get(corpus_id)
        if instance is None:
            raise RuntimeError(
                f"Mem0 corpus {corpus_id!r} has not been initialized in this worker"
            )
        return {"corpusId": corpus_id, "stats": self._stats(instance)}

    def _stats(self, instance: dict[str, Any]) -> dict[str, Any]:
        memory = instance["memory"]
        vector_count = None
        try:
            vector_store = memory.vector_store
            vector_count = int(
                vector_store.client.count(
                    collection_name=vector_store.collection_name, exact=True
                ).count
            )
        except Exception as exc:  # stats must not hide the real retrieval result
            _LOGGER.warning("Could not read Qdrant count: %s", exc)
        history_path = instance["config"]["history_db_path"]
        history_bytes = (
            os.path.getsize(history_path) if os.path.exists(history_path) else 0
        )
        qdrant_dir = os.path.dirname(history_path)
        qdrant_bytes = 0
        for root, _dirs, files in os.walk(os.path.join(qdrant_dir, "qdrant")):
            for name in files:
                try:
                    qdrant_bytes += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass
        return {
            "vectorCount": vector_count,
            "documentCount": len(instance["document_ids"]),
            "messageCount": instance["message_count"],
            "addEvents": instance["add_events"],
            "retrievalCount": instance["retrievals"],
            "initMs": instance["init_ms"],
            "historyDbBytes": history_bytes,
            "qdrantBytes": qdrant_bytes,
            "embeddingModel": instance["embedding_model"],
            "embeddingDimensions": instance["embedding_dimensions"],
        }

    def _describe(self, instance: dict[str, Any]) -> dict[str, Any]:
        return {
            "corpusId": instance["corpus_id"],
            "scopeId": instance["scope_id"],
            "embeddingModel": instance["embedding_model"],
            "embeddingDimensions": instance["embedding_dimensions"],
            "historyDbPath": instance["config"]["history_db_path"],
            "qdrantPath": instance["config"]["vector_store"]["config"]["path"],
            "stats": self._stats(instance),
        }

    def close(self) -> list[dict[str, Any]]:
        closed = []
        with self._lock:
            instances = list(self._instances.values())
            self._instances.clear()
        for instance in instances:
            memory = instance["memory"]
            errors: list[str] = []
            try:
                memory.close()
            except Exception as exc:
                _LOGGER.warning("Error closing Mem0 SQLite handle: %s", exc)
                errors.append(f"sqlite: {type(exc).__name__}: {exc}")
            try:
                memory.vector_store.client.close()
            except Exception as exc:
                _LOGGER.warning("Error closing Qdrant client: %s", exc)
                errors.append(f"qdrant: {type(exc).__name__}: {exc}")
            closed.append(
                {
                    "corpusId": instance["corpus_id"],
                    "ok": not errors,
                    "errors": errors,
                }
            )
        return closed


def _error_payload(exc: BaseException) -> dict[str, Any]:
    return {
        "type": type(exc).__name__,
        "message": str(exc),
        "traceback": traceback.format_exc(),
    }


def _response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"id": request_id, "ok": True, "result": result}


def _error(request_id: Any, exc: BaseException) -> dict[str, Any]:
    return {"id": request_id, "ok": False, "error": _error_payload(exc)}


def run_jsonl(args: argparse.Namespace) -> int:
    embedder = EmbeddingModel(args.model, args.cache_dir)
    mem0_manager = Mem0Manager()
    _LOGGER.info("JSONL worker ready")

    def cleanup(_signum: int | None = None, _frame: Any = None) -> None:
        mem0_manager.close()

    def handle_signal(signum: int, _frame: Any) -> None:
        _LOGGER.info("Received signal %s; closing Mem0 resources", signum)
        cleanup(signum)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    try:
        return _jsonl_loop(args, embedder, mem0_manager)
    finally:
        cleanup()


def _jsonl_loop(
    args: argparse.Namespace,
    embedder: EmbeddingModel,
    mem0_manager: Mem0Manager,
) -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")
            if op == "ping":
                result = {
                    "ready": True,
                    "embeddingModel": args.model,
                    "pid": os.getpid(),
                }
            elif op == "embed":
                model_name = request.get("model") or args.model
                if model_name != args.model:
                    raise ValueError(
                        f"worker is configured for {args.model!r}, request asked for {model_name!r}"
                    )
                vectors = embedder.embed(request.get("texts") or [])
                result = {
                    "model": args.model,
                    "dimensions": len(vectors[0]) if vectors else 0,
                    "embeddings": vectors,
                }
            elif op == "mem0_init":
                result = mem0_manager.initialize(request)
            elif op == "mem0_ingest":
                result = mem0_manager.ingest(request)
            elif op == "mem0_retrieve":
                result = mem0_manager.retrieve(request)
            elif op == "mem0_stats":
                result = mem0_manager.stats(request)
            elif op == "close":
                closed = mem0_manager.close()
                sys.stdout.write(json.dumps(_response(request_id, {"closed": closed})) + "\n")
                sys.stdout.flush()
                return 0
            else:
                raise ValueError(f"unknown operation {op!r}")
            sys.stdout.write(json.dumps(_response(request_id, result)) + "\n")
            sys.stdout.flush()
        except Exception as exc:  # report the real engine error to the caller
            _LOGGER.error("Request failed: %s", exc)
            sys.stdout.write(json.dumps(_error(request_id, exc)) + "\n")
            sys.stdout.flush()
    return 0


class _EmbeddingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        embedder: EmbeddingModel,
        expected_dimensions: int | None,
    ) -> None:
        super().__init__(address, _EmbeddingHandler)
        self.embedder = embedder
        self.expected_dimensions = expected_dimensions


class _EmbeddingHandler(BaseHTTPRequestHandler):
    server: _EmbeddingHTTPServer

    def log_message(self, fmt: str, *args: Any) -> None:
        _LOGGER.info("http: " + fmt, *args)

    def _write(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if self.path.rstrip("/") in ("/health", "/v1/health"):
            self._write(
                200,
                {
                    "ok": True,
                    "model": self.server.embedder.model_name,
                    "dimensions": self.server.embedder.dimensions,
                },
            )
            return
        self._write(404, {"error": {"message": f"unknown path {self.path}"}})

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        try:
            body = self._read_body()
            path = self.path.rstrip("/")
            if path in ("/embed", "/v1/embed"):
                texts = body.get("texts", body.get("input"))
                vectors = self._embed_input(texts, body.get("model"))
                self._write(
                    200,
                    {
                        "model": self.server.embedder.model_name,
                        "dimensions": len(vectors[0]) if vectors else 0,
                        "embeddings": vectors,
                    },
                )
                return
            if path in ("/v1/embeddings", "/embeddings"):
                texts = body.get("input")
                vectors = self._embed_input(texts, body.get("model"))
                requested_dimensions = body.get("dimensions")
                if requested_dimensions is not None and int(requested_dimensions) != (
                    len(vectors[0]) if vectors else 0
                ):
                    raise ValueError(
                        f"requested dimensions {requested_dimensions} but model emits "
                        f"{len(vectors[0]) if vectors else 0}"
                    )
                self._write(
                    200,
                    {
                        "object": "list",
                        "data": [
                            {
                                "object": "embedding",
                                "index": index,
                                "embedding": vector,
                            }
                            for index, vector in enumerate(vectors)
                        ],
                        "model": self.server.embedder.model_name,
                    },
                )
                return
            if path in ("/close", "/v1/close"):
                self._write(200, {"ok": True, "closing": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            self._write(404, {"error": {"message": f"unknown path {self.path}"}})
        except BaseException as exc:
            self._write(
                400,
                {
                    "error": {
                        "type": type(exc).__name__,
                        "message": str(exc),
                        "traceback": traceback.format_exc(),
                    }
                },
            )

    def _embed_input(self, value: Any, requested_model: Any) -> list[list[float]]:
        if requested_model is not None and requested_model != self.server.embedder.model_name:
            raise ValueError(
                f"service is configured for {self.server.embedder.model_name!r}, "
                f"request asked for {requested_model!r}"
            )
        if isinstance(value, str):
            texts = [value]
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            texts = value
        else:
            raise ValueError("'input' must be a string or an array of strings")
        vectors = self.server.embedder.embed(texts)
        actual_dimensions = len(vectors[0]) if vectors else 0
        if (
            self.server.expected_dimensions is not None
            and actual_dimensions != self.server.expected_dimensions
        ):
            raise RuntimeError(
                f"model emitted {actual_dimensions} dimensions, expected "
                f"{self.server.expected_dimensions}"
            )
        return vectors


def run_embeddings_http(args: argparse.Namespace) -> int:
    embedder = EmbeddingModel(args.model, args.cache_dir)
    dimensions = embedder.dimensions  # force the model to load before ready
    if args.dimensions is not None and dimensions != args.dimensions:
        raise RuntimeError(
            f"model {args.model!r} emits {dimensions} dimensions, not {args.dimensions}"
        )
    server = _EmbeddingHTTPServer(
        (args.host, args.port), embedder, args.dimensions
    )
    host, port = server.server_address[:2]
    ready = {
        "event": "ready",
        "mode": "embeddings-http",
        "url": f"http://{host}:{port}",
        "model": args.model,
        "dimensions": dimensions,
        "pid": os.getpid(),
    }
    print(json.dumps(ready), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("BENCH_EMBEDDING_CACHE")
        or os.environ.get("FASTEMBED_CACHE_PATH"),
    )
    parser.add_argument("--mem0-dir", default=None)
    parser.add_argument("--model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--serve-embeddings", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--dimensions", type=int, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    _configure_environment(args)
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if args.serve_embeddings:
        return run_embeddings_http(args)
    return run_jsonl(args)


if __name__ == "__main__":
    raise SystemExit(main())
