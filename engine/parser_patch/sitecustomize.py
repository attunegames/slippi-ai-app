"""Lets slippi-ai's replay parser run on a plain Windows install.

slippi_db reads each replay out of its zip archive by running the `unzip`
program (slippi_db/utils.py, ZipFile.read). Windows has no `unzip`, so every
replay failed with "The system cannot find the file specified" and the app
reported no usable games. It only worked on PCs with Git's tools on PATH.

engine/prepare_data.py puts this folder on PYTHONPATH for the parse step, and
Python imports sitecustomize at startup in every process, including the
parser's worker processes, so they all read zips with Python's zipfile.
"""

import zipfile

from slippi_db import utils


def _read(self) -> bytes:
  with zipfile.ZipFile(self.root) as archive:
    return archive.read(self.path)


utils.ZipFile.read = _read
