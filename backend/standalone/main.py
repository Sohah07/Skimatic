import logging
import time
from pathlib import Path

from dotenv import load_dotenv  # pyright: ignore[reportMissingImports]
from fastapi import FastAPI, Request  # pyright: ignore[reportMissingImports]
from fastapi.exceptions import RequestValidationError  # pyright: ignore[reportMissingImports]
from fastapi.responses import JSONResponse  # pyright: ignore[reportMissingImports]
from starlette.exceptions import HTTPException  # pyright: ignore[reportMissingImports]

from db import article_hash, get_cached, save
from gemini_client import GeminiError, analyze_paragraphs
from models import AnalyzeRequest, AnalyzeResponse, ErrorResponse
from validator import check_request, validate

# Build the path from this file's location so .env is found no matter
# which folder uvicorn is started from.
load_dotenv(Path(__file__).parent / ".env")

# Libraries log at WARNING and up only; our own "skimatic" logger also logs INFO.
logging.basicConfig(level=logging.WARNING, format="%(levelname)s:     %(message)s")
logger = logging.getLogger("skimatic")
logger.setLevel(logging.INFO)

app = FastAPI(title="Semantic Chunk Reader")


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


# Replace FastAPI's default error bodies with our {"error": "..."} shape.
@app.exception_handler(RequestValidationError)
def bad_request_body(request: Request, exc: RequestValidationError):
    return error(422, "Request body must be JSON like {\"paragraphs\": [\"text\", ...]}.")


@app.exception_handler(HTTPException)
def http_error(request: Request, exc: HTTPException):
    return error(exc.status_code, "Not found." if exc.status_code == 404 else "Request failed.")


@app.exception_handler(Exception)
def unexpected_error(request: Request, exc: Exception):
    logger.exception("Unexpected error")  # full details go to our log only
    return error(500, "Something went wrong on our side.")


@app.get("/ping")
def ping():
    return {"status": "ok"}


@app.post(
    "/analyze",
    response_model=AnalyzeResponse,
    responses={code: {"model": ErrorResponse} for code in (400, 413, 422, 502)},
)
def analyze(request: AnalyzeRequest):
    start = time.perf_counter()
    problem = check_request(request.paragraphs)
    if problem:
        return error(*problem)

    key = article_hash(request.paragraphs)
    hit = get_cached(key)
    if hit:
        try:
            response = AnalyzeResponse(highlights=hit["highlights"], outline=hit["outline"], cached=True)
            logger.info("analyze: cache hit %s | %.2fs", key[:12], time.perf_counter() - start)
            return response
        except Exception:
            logger.warning("analyze: cached doc %s is malformed; calling Gemini instead", key[:12])

    try:
        result = analyze_paragraphs(request.paragraphs)
    except GeminiError as e:
        logger.warning("Gemini failed: %s | %.2fs", e, time.perf_counter() - start)
        return error(502, "The AI reader is unavailable right now. Please try again.")

    checked = validate(result.highlights, request.paragraphs)
    save(key, [h.model_dump() for h in checked.highlights], checked.outline)
    logger.info(
        "analyze: cache miss %s | %d paragraphs, %d chars | gemini %d, kept %d, dropped %d, "
        "core dropped %d, capped %d | %.2fs",
        key[:12], len(request.paragraphs), sum(len(p) for p in request.paragraphs),
        len(result.highlights), len(checked.highlights),
        checked.dropped_highlights, checked.dropped_core, checked.capped,
        time.perf_counter() - start,
    )
    return AnalyzeResponse(highlights=checked.highlights, outline=checked.outline, cached=False)
