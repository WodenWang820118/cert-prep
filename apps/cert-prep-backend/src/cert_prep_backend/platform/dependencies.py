"""FastAPI providers of the platform's resources, which create_app puts on app.state."""

from __future__ import annotations

from fastapi import Request

from cert_prep_backend.platform.change_notifications import DatabaseChangeNotifier
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_database(request: Request) -> Database:
    return request.app.state.database


def get_database_change_notifier(request: Request) -> DatabaseChangeNotifier:
    return request.app.state.database_change_notifier
