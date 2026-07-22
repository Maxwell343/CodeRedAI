from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

# Ensure backend root directory is in sys.path
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from database import close_database_connection, init_indexes_safe
from routes.auth import router as auth_router
from routes.driver_ops import router as driver_ops_router
from routes.emergency import router as emergency_router
from routes.whatsapp import router as whatsapp_router
from services.auth_service import seed_default_admins

_logger = logging.getLogger(__name__)


def _get_cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application startup and shutdown lifecycle events."""
    _logger.info("Initializing CodeRed AI Backend services...")
    db_ready = init_indexes_safe()
    if db_ready:
        admin_count = seed_default_admins()
        _logger.info("Database initialized successfully. Seeded %d admin accounts.", admin_count)
    else:
        _logger.warning("MongoDB unavailable during startup — running in degraded mode.")
    
    yield

    _logger.info("Shutting down CodeRed AI Backend services...")
    close_database_connection()


def create_app() -> FastAPI:
    app = FastAPI(
        title="CodeRed AI API",
        description="Production-grade AI Emergency Medical Response & Autonomous Dispatch System",
        version="1.0.0",
        lifespan=lifespan,
    )

    # CORS Middleware configuration
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_get_cors_origins(),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
        allow_headers=["*"],
    )

    # Security Headers Middleware
    @app.middleware("http")
    async def add_security_headers(request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    # Route inclusion
    app.include_router(auth_router, prefix="/api", tags=["Auth"])
    app.include_router(emergency_router, prefix="/api", tags=["Emergency"])
    app.include_router(whatsapp_router, prefix="/api", tags=["WhatsApp Webhook"])
    app.include_router(driver_ops_router, prefix="/api", tags=["Driver Operations"])

    return app


app = create_app()


@app.get("/", tags=["Health"])
async def home() -> dict:
    return {
        "status": "ok",
        "service": "CodeRed AI Emergency Response API",
        "version": "1.0.0",
    }


@app.get("/health", tags=["Health"])
async def health_check() -> dict:
    return {
        "status": "healthy",
        "database": "connected",
        "timestamp": os.getenv("ENV", "production"),
    }
