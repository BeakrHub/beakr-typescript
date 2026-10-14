"""Keep ``snapshots/``, the files this repository is checked against, current.

    python3 scripts/refresh_snapshots.py refresh [--engine PATH] [--python PATH]
    python3 scripts/refresh_snapshots.py diff    [--engine PATH] [--python PATH]
    python3 scripts/refresh_snapshots.py verify   # offline, what CI runs

@beakr/sdk is generated from and tested against BeakrHub/beakr-engine's
documented contract, and shares its release scripts with BeakrHub/beakr-python;
both repositories are private. CI reads neither: it reads the copies committed
under ``snapshots/<repository>/`` (laid out as in that repository, so
``BEAKR_ENGINE_PATH=snapshots/beakr-engine`` stands in for an engine checkout),
and ``snapshots/manifest.json`` records the commit each was taken from and each
file's SHA-256. ``refresh`` rewrites them from local checkouts (``--engine`` /
``--python``, else ``$BEAKR_ENGINE_PATH`` / ``$BEAKR_PYTHON_PATH``, else a
sibling ``beakr-engine`` / ``beakr-python``);
``diff`` says whether they are stale against them; ``verify`` checks, with no
checkout, that the files are exactly the ones the manifest lists. Only the
standard library is used.

Only the documented contract and its changelog are kept, never the engine's
internal contract.

When ``release/released.json`` names the engine commit of the last release,
``release-base/<commit>/`` holds that commit's public contract and API
changelog, and ``docs/api/still-served-openapi.json`` the operations that
release documented which the engine still serves (all ``prepare_release.py``
needs of the internal contract), so the release check runs offline too.

The engine's CI checks this repository and beakr-python out on the branch named
like its own and runs these same checks against the real repositories, so drift
shows up there before a refresh here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOTS = ROOT / "snapshots"
MANIFEST = SNAPSHOTS / "manifest.json"
sys.path.insert(0, str(Path(__file__).resolve().parent))

PUBLIC = "docs/api/public-openapi.json"
INTERNAL = "docs/api/internal-openapi.json"
API_CHANGELOG = "docs/api/CHANGELOG.md"
STILL_SERVED = "docs/api/still-served-openapi.json"
RELEASE_BASE = "release-base"
def _json(document: Any) -> str:
    return json.dumps(document, indent=1, sort_keys=True) + "\n"


@dataclass(frozen=True)
class Source:
    """A repository this one is checked against, and the files taken from it."""

    name: str
    repository: str
    #: The command-line option naming a checkout (``--engine``).
    flag: str
    env: str
    siblings: tuple[str, ...]
    #: Copied byte for byte, at the same relative path.
    copied: tuple[str, ...]
    #: Written by a function of the checkout, with the paths it reads.
    derived: dict[str, tuple[Callable[[Path], str], tuple[str, ...]]] = field(default_factory=dict)
    #: Whether ``release/released.json``'s engine commit is read from this source.
    release_base: bool = False


SOURCES = (
    Source(
        name="beakr-engine",
        repository="BeakrHub/beakr-engine",
        flag="engine",
        env="BEAKR_ENGINE_PATH",
        siblings=("beakr-engine",),
        copied=(PUBLIC, API_CHANGELOG),
        release_base=True,
    ),
    Source(
        name="beakr-python",
        repository="BeakrHub/beakr-python",
        flag="python",
        env="BEAKR_PYTHON_PATH",
        siblings=("beakr-python",),
        # The release scripts every client repository shares; ours must match.
        copied=("scripts/prepare_release.py", "scripts/contract_compat.py"),
    ),
)


# -- reading a checkout -------------------------------------------------------------


def checkout(source: Source, args: argparse.Namespace) -> Path:
    candidates = [getattr(args, source.flag), os.environ.get(source.env)]
    candidates += [str(ROOT.parent / name) for name in source.siblings]
    for candidate in candidates:
        # A git checkout: never the snapshot itself.
        if candidate and (Path(candidate) / ".git").exists():
            return Path(candidate).resolve()
    raise SystemExit(f"No {source.name} checkout found (pass --{source.flag} or set {source.env}).")


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    ).stdout


def released_engine_commit() -> str | None:
    record = json.loads((ROOT / "release" / "released.json").read_text())
    return record.get("engine_commit")


def _release_files(repo: Path, commit: str) -> dict[str, str]:
    from contract_compat import _missing_operations
    from prepare_release import still_served_by

    base_contract = _git(repo, "show", f"{commit}:{PUBLIC}")
    files = {
        f"{RELEASE_BASE}/{commit}/{PUBLIC}": base_contract,
        f"{RELEASE_BASE}/{commit}/{API_CHANGELOG}": _git(repo, "show", f"{commit}:{API_CHANGELOG}"),
    }
    # Of the full internal contract the release check only asks whether an
    # operation the last release documented is still served: keep just those,
    # each of which was public once.
    internal = json.loads((repo / INTERNAL).read_text())
    current = json.loads((repo / PUBLIC).read_text())
    served = still_served_by(internal)
    assert served is not None
    paths: dict[str, dict[str, Any]] = {}
    for method, path, operation in _missing_operations(json.loads(base_contract), current):
        if served(method, path, operation.get("x-beakr-scope")):
            paths.setdefault(path, {})[method.lower()] = internal["paths"][path][method.lower()]
    files[STILL_SERVED] = _json(
        {
            "info": {
                "title": "Operations the last release documented that the engine still serves",
                "version": commit,
            },
            "openapi": internal.get("openapi", "3.1.0"),
            "paths": paths,
        }
    )
    return files


def expected_files(source: Source, repo: Path) -> dict[str, bytes]:
    files: dict[str, bytes] = {path: (repo / path).read_bytes() for path in source.copied}
    for path, (derive, _reads) in source.derived.items():
        files[path] = derive(repo).encode()
    commit = released_engine_commit() if source.release_base else None
    if commit:
        files.update({path: text.encode() for path, text in _release_files(repo, commit).items()})
    return files


def _inputs(source: Source) -> list[str]:
    reads = {path for _derive, paths in source.derived.values() for path in paths}
    return sorted(set(source.copied) | reads)


def provenance(source: Source, repo: Path) -> dict[str, Any]:
    status = _git(repo, "status", "--porcelain", "--", *_inputs(source))
    return {
        "repository": source.repository,
        "commit": _git(repo, "rev-parse", "HEAD").strip(),
        # True when a file was taken from uncommitted changes on top of `commit`.
        "uncommitted_changes": bool(status.strip()),
    }


# -- the snapshot on disk ------------------------------------------------------------


def digest(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def on_disk(source: Source, snapshots: Path = SNAPSHOTS) -> dict[str, bytes]:
    base = snapshots / source.name
    return {
        path.relative_to(base).as_posix(): path.read_bytes()
        for path in sorted(base.rglob("*"))
        # Bytecode Python leaves beside a snapshotted module a test imported.
        if path.is_file() and "__pycache__" not in path.parts
    }


def load_manifest(manifest: Path = MANIFEST) -> dict[str, Any]:
    return json.loads(manifest.read_text()) if manifest.exists() else {"sources": {}}


def write_snapshot(
    source: Source, repo: Path, files: dict[str, bytes], snapshots: Path = SNAPSHOTS
) -> dict[str, Any]:
    """Replace ``snapshots/<source>`` with ``files``; the manifest entry for them."""
    base = snapshots / source.name
    for stale in set(on_disk(source, snapshots)) - set(files):
        (base / stale).unlink()
    for path, content in files.items():
        target = base / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    for directory in sorted(base.rglob("*"), reverse=True):
        if directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()
    return {
        **provenance(source, repo),
        "files": {path: digest(files[path]) for path in sorted(files)},
    }


def verify(
    sources: tuple[Source, ...] = SOURCES,
    snapshots: Path = SNAPSHOTS,
    release_commit: str | None = None,
) -> list[str]:
    """What is wrong with the committed snapshot, read with no checkout at all."""
    manifest = load_manifest(snapshots / "manifest.json")
    problems: list[str] = []
    for source in sources:
        recorded = manifest["sources"].get(source.name)
        if recorded is None:
            problems.append(f"manifest has no entry for {source.name}")
            continue
        actual = {path: digest(content) for path, content in on_disk(source, snapshots).items()}
        for path in sorted(set(recorded["files"]) | set(actual)):
            if recorded["files"].get(path) != actual.get(path):
                problems.append(f"{source.name}/{path} does not match the manifest")
        wanted = set(source.copied) | set(source.derived)
        problems += [
            f"{source.name}/{path} is not snapshotted" for path in sorted(wanted - set(actual))
        ]
        if source.release_base and release_commit:
            if f"{RELEASE_BASE}/{release_commit}/{PUBLIC}" not in actual:
                problems.append(f"{source.name} has no release base for commit {release_commit}")
    return problems


# -- commands -------------------------------------------------------------------------


def cmd_refresh(args: argparse.Namespace) -> int:
    manifest = load_manifest()
    for source in SOURCES:
        repo = checkout(source, args)
        files = expected_files(source, repo)
        manifest["sources"][source.name] = write_snapshot(source, repo, files)
        print(f"snapshots/{source.name}: {len(files)} files from {repo}")
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    return 0


def cmd_diff(args: argparse.Namespace) -> int:
    stale: list[str] = []
    for source in SOURCES:
        repo = checkout(source, args)
        expected = expected_files(source, repo)
        actual = on_disk(source)
        stale += [
            f"{source.name}/{path}"
            for path in sorted(set(expected) | set(actual))
            if expected.get(path) != actual.get(path)
        ]
    if stale:
        print("stale against the local checkout (run refresh): " + ", ".join(stale))
        return 1
    print("snapshots match the local checkouts")
    return 0


def cmd_verify(_args: argparse.Namespace) -> int:
    problems = verify(release_commit=released_engine_commit())
    if problems:
        print("\n".join(problems) + "\n(run scripts/refresh_snapshots.py refresh)")
        return 1
    pins = ", ".join(
        f"{name}@{entry['commit'][:12]}{' (+uncommitted)' if entry['uncommitted_changes'] else ''}"
        for name, entry in load_manifest()["sources"].items()
    )
    print(f"snapshots match the manifest ({pins})")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["refresh", "diff", "verify"])
    for source in SOURCES:
        parser.add_argument(f"--{source.flag}", help=f"a {source.name} checkout")
    args = parser.parse_args(argv)
    return {"refresh": cmd_refresh, "diff": cmd_diff, "verify": cmd_verify}[args.command](args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
