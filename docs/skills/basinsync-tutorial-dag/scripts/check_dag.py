#!/usr/bin/env python3
"""Validate nested tutorial DAGs and unique tutorial slugs; Python 3.9+."""
import os
import re
import sys
from datetime import date
from pathlib import Path

DEFAULT_DIRECTORY = Path(__file__).resolve().parents[3] / "diy"
SLUG = r"[0-9]{6}-[a-z0-9]+(?:-[a-z0-9]+)*"
HEIGHT = r"0z(?:[w-z])?[g-v]+[0-9a-f]+"
TUTORIAL = rf"{HEIGHT}/{SLUG}(?:/{HEIGHT}/{SLUG})*"


def size_prefix(size):
    digits = format(size, "x")
    width = 1 << (len(digits) - 1).bit_length()
    if width > 16:
        raise ValueError("height allocation is too large")
    magnitude = "" if width == 1 else "wxyz"[width.bit_length() - 2]
    return magnitude + "".join(chr(ord("g") + int(d, 16)) for d in digits.zfill(width))


def encode_height(height):
    if type(height) is not int or height < 0:
        raise ValueError("height must be a nonnegative integer")
    digits = format(height, "x")
    return f"0z{size_prefix(len(digits) - 1)}{digits}"


def decode_height(encoded):
    if not re.fullmatch(HEIGHT, encoded):
        raise ValueError("height must be unsigned Lexidecimal")
    body = encoded[2:]
    start = 1 if body[0] in "wxyz" else 0
    width = 1 << (1 + "wxyz".index(body[0])) if start else 1
    size, digits = body[start:start + width], body[start + width:]
    if len(size) != width or not re.fullmatch(r"[g-v]+", size) or not re.fullmatch(r"[0-9a-f]+", digits):
        raise ValueError("incorrect Lexidecimal size")
    count = int("".join(format(ord(d) - ord("g"), "x") for d in size), 16)
    if count != len(digits) - 1:
        raise ValueError("incorrect Lexidecimal size")
    height = int(digits, 16)
    if encode_height(height) != encoded:
        raise ValueError("noncanonical Lexidecimal height")
    return height


def topic(slug):
    if not re.fullmatch(SLUG, slug):
        raise ValueError("expected a <YYMMDD-lowercase-slug> folder")
    stamp, name = slug[:6], slug[7:]
    try:
        date(2000 + int(stamp[:2]), int(stamp[2:4]), int(stamp[4:6]))
    except ValueError:
        raise ValueError("invalid YYMMDD introduction date") from None
    return name


def prerequisites(text):
    """Only prerequisites: [] or an unquoted block list of diy-relative paths."""
    lines = text.lstrip("\ufeff").replace("\r\n", "\n").split("\n")
    if lines[0] != "---":
        raise ValueError("missing frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise ValueError("unterminated frontmatter") from None
    fields = [line for line in lines[1:end]
              if line.strip() and not line.lstrip().startswith("#")]
    if fields == ["prerequisites: []"]:
        return []
    if not fields or fields[0] != "prerequisites:" or len(fields) == 1:
        raise ValueError("expected prerequisites: [] or prerequisites: with a block list")
    dependencies = []
    for line in fields[1:]:
        item = re.fullmatch(rf"  - ({TUTORIAL})", line)
        if not item:
            raise ValueError("prerequisites must be unquoted alternating <height>/<slug> folder paths relative to diy/")
        dependencies.append(item[1])
    return dependencies


def lint_tutorials(directory, *overlays):
    """Lint one tutorial tree plus optional overlay trees that may depend on it."""
    errors, graph, names, trees = [], {}, {}, {}
    for tree, root in enumerate((directory, *overlays)):
        collect(Path(root).resolve(), tree, errors, graph, names, trees)
    if not graph:
        errors.append("no tutorials found")
    return validate(errors, graph, trees)


def collect(directory, tree, errors, graph, names, trees):
    readmes = set()

    # Inspect supporting folders too, without following symlinks out of the bundle.
    def on_error(error):
        raise error

    for parent, folders, files in os.walk(directory, onerror=on_error):
        folders[:] = sorted(name for name in folders if name != "__pycache__")
        for slug in folders:
            folder = Path(parent) / slug
            name = folder.relative_to(directory).as_posix()
            if folder.is_symlink():
                errors.append(f"{name}: folders must not be symlinks")
                continue
        if "README.md" in files:
            readmes.add((Path(parent) / "README.md").relative_to(directory).as_posix())

    def visit(folder, height):
        name = folder.relative_to(directory).as_posix()
        if folder.is_symlink() or not folder.is_dir():
            errors.append(f"{name}: expected a tutorial folder, not a file or symlink")
            return
        try:
            slug = topic(folder.name)
        except ValueError as error:
            errors.append(f"{name}: {error}")
            slug = folder.name
        if slug in names:
            errors.append(f'{name}: duplicate tutorial slug "{slug}" (also {names[slug]})')
        else:
            names[slug] = name
        # Check the actual spelling even on case-insensitive filesystems.
        readme = next((path for path in folder.iterdir() if path.name == "README.md"), None)
        if readme is None:
            errors.append(f"{name}: missing README.md (case-sensitive)")
            return
        if readme.is_symlink() or not readme.is_file():
            errors.append(f"{name}/README.md: must be a regular file, not a symlink")
            return
        dependencies = []
        try:
            dependencies = prerequisites(readme.read_text(encoding="utf-8"))
        except (ValueError, OSError) as error:
            errors.append(f"{name}: {error}")
        if name in graph:
            errors.append(f"{name}: tutorial path exists in more than one tree")
        graph[name] = (height, dependencies)
        trees[name] = tree

    pending = [directory]
    while pending:
        parent = pending.pop()
        for folder in sorted(parent.iterdir()):
            if folder.is_symlink():
                continue
            if not folder.is_dir():
                if parent == directory and folder.suffix.lower() == ".md":
                    errors.append(f"{folder.name}: expected <unsigned-Lexidecimal-height>/<YYMMDD-lowercase-slug>/README.md")
                continue
            # Other subfolders can hold supporting material and may share names.
            if parent != directory and not re.fullmatch(r"0[zZyY][0-9A-Za-z]*", folder.name):
                continue
            height = None
            try:
                height = decode_height(folder.name)
            except ValueError as error:
                errors.append(f"{folder.relative_to(directory).as_posix()}: {error}")
            for path in sorted(folder.iterdir()):
                if path.is_symlink():
                    continue
                if path.is_dir():
                    visit(path, height)
                    pending.append(path)
                elif path.suffix.lower() == ".md":
                    errors.append(f"{path.relative_to(directory).as_posix()}: expected a tutorial folder containing README.md")
    for readme in sorted(readmes):
        if readme[:-len("/README.md")] not in graph:
            errors.append(f"{readme}: expected alternating <height>/<slug> tutorial folders")


def validate(errors, graph, trees):
    dependents = {name: [] for name in graph}
    indegree = dict.fromkeys(graph, 0)
    edges = 0
    for name, (height, dependencies) in graph.items():
        seen = set()
        for dependency in dependencies:
            if dependency in seen:
                errors.append(f"{name}: duplicate prerequisite {dependency}")
                continue
            seen.add(dependency)
            if dependency == name:
                errors.append(f"{name}: self prerequisite")
            if dependency not in graph:
                errors.append(f"{name}: missing prerequisite {dependency} (paths are case-sensitive)")
                continue
            if trees[dependency] > trees[name]:
                errors.append(f"{name}: prerequisite {dependency} is only in an overlay tree")
            edges += 1
            dependents[dependency].append(name)
            indegree[name] += 1
            target_height = graph[dependency][0]
            if height is not None and target_height is not None and height <= target_height:
                errors.append(f"{name}: height {height} must exceed {dependency}'s height {target_height}")
    # Kahn's algorithm detects cycles independently of height validation.
    ready = [name for name, count in indegree.items() if count == 0]
    for dependency in ready:
        for name in dependents[dependency]:
            indegree[name] -= 1
            if indegree[name] == 0:
                ready.append(name)
    blocked = [name for name, count in indegree.items() if count > 0]
    if blocked:
        errors.append(f"prerequisite cycle, or dependent on one: {', '.join(blocked)}")
    return {"errors": errors, "tutorials": len(graph), "edges": edges}


def main(args):
    try:
        directories = [Path(arg) for arg in args] or [DEFAULT_DIRECTORY]
        result = lint_tutorials(*directories)
        if result["errors"]:
            print("\n".join(result["errors"]), file=sys.stderr)
            return 1
        print(f"Tutorial DAG OK: {result['tutorials']} tutorials, {result['edges']} prerequisites.")
        return 0
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
