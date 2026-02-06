from erewhon_astro import Solution
from pydantic import BaseModel


class ImageRectangle(BaseModel):
    x: float
    y: float
    width: float
    height: float
    rotation: float
    total_exposure_time: float

class FileDescription(BaseModel):
    id: str | None = None # nanoid()
    pathname: str
    hash: str
    instrument: str = ''
    total_exposure_time: float = 0.0
    ra: float = 0.0
    dec: float = 0.0
    # gain: float = 0.0
    # target: str = ''
    stackcnt: int = 0
    exposure_time: float = 0.0
    axis1: float = 0.0
    axis2: float = 0.0
    solution: Solution | None = None


class Manifest(BaseModel):
    files: list[FileDescription] = []


class Session(BaseModel):
    start_date: str
    name: str | None = None
    description: str | None = None
    commentary: str | None = None
    manifest: Manifest | None = None
