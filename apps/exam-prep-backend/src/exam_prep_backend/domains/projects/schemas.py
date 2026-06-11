from __future__ import annotations

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1)
    description: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None


class ProjectRead(BaseModel):
    id: str
    name: str
    description: str
    created_at: str
    updated_at: str


class ProjectList(BaseModel):
    items: list[ProjectRead]
