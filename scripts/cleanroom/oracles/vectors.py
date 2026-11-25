#!/usr/bin/env python3
"""Check a clean room's oracle CLI (see ../oracle-interface.md) against tests/vectors.

    vectors.py make REPO OUT    write OUT/requests.jsonl and OUT/expected.jsonl
    vectors.py check OUT        compare OUT/responses.jsonl and print a report
"""
import json
import sys
from pathlib import Path


def cases(repo):
    vectors = lambda name: json.loads((repo / "tests/vectors" / f"{name}.json").read_text())
    ok = lambda value: {"ok": value}
    error = {"error": True}

    v = vectors("lexidecimal")
    for n, wire in v["canonical"]:
        yield "lexidecimal", f"encode {n}", {"op": "lexidecimal.encode", "value": n}, ok(wire)
        yield "lexidecimal", f"decode {wire}", {"op": "lexidecimal.decode", "text": wire}, ok(n)
    for bad in v["invalid"]:
        yield "lexidecimal", f"reject {bad!r}", {"op": "lexidecimal.decode", "text": bad}, error
    for size, positive, negative in v["sizePrefixes"]:
        for sign, want in ((False, positive), (True, negative)):
            yield ("lexidecimal", f"size prefix {size}{' negative' if sign else ''}",
                   {"op": "lexidecimal.sizePrefix", "size": size, "negative": sign}, ok(want))

    v = vectors("diffuse16")
    for n, wire in v["canonical"]:
        yield "diffuse16", f"encode {n}", {"op": "diffuse16.encode", "value": n}, ok(wire)
        yield "diffuse16", f"decode {wire}", {"op": "diffuse16.decode", "text": wire}, ok(n)
    for bad in v["invalid"]:
        yield "diffuse16", f"reject {bad!r}", {"op": "diffuse16.decode", "text": bad}, error

    v = vectors("json0")
    for field in ("text", "bigint", "bytes", "wellKnownSymbol", "globalSymbol"):
        for value, wire in v[field]:
            yield "json0", f"encode {field} {value!r}", {"op": "json0.encode", field: value}, ok(wire)
            yield "json0", f"decode {wire!r}", {"op": "json0.decode", "wire": wire}, ok({field: value})
    for wire, value in v.get("decodeOnly", []):
        yield "json0", f"decode lenient {wire!r}", {"op": "json0.decode", "wire": wire}, ok(value)
    for wire in v["invalid"]:
        yield "json0", f"reject {wire!r}", {"op": "json0.decode", "wire": wire}, error
    for name in v["unsupportedWellKnownSymbols"]:
        yield "json0", f"refuse to encode #{name}", {"op": "json0.encode", "wellKnownSymbol": name}, error

    v = vectors("timeline")
    for m, key in v["keys"]:
        yield "timeline", f"key {m}", {"op": "timeline.key", "milestone": m}, ok(key)
        yield "timeline", f"milestone {key}", {"op": "timeline.milestone", "key": key}, ok(m)
    for bad in v["invalidKeys"]:
        yield "timeline", f"reject {bad}", {"op": "timeline.milestone", "key": bad}, error

    v = vectors("flexbuffer")
    for extension in v["extensions"]:
        (field, value), = ((k, x) for k, x in extension.items() if k != "wire")
        yield ("flexbuffers", f"encode {field} {value!r}",
               {"op": "flexbuffers.encodeExtension", field: value}, ok(extension["wire"]))
        yield ("flexbuffers", f"decode {field} {value!r}",
               {"op": "flexbuffers.decodeExtension", "wire": extension["wire"]}, ok({field: value}))
    for wire in v["invalid"]:
        yield "flexbuffers", f"reject {wire}", {"op": "flexbuffers.decodeExtension", "wire": wire}, error
    for wire in v.get("fixedLengthVectors", []):
        yield "flexbuffers", f"reject fixed-length {wire}", {"op": "flexbuffers.decodeExtension", "wire": wire}, error
    for wire in v.get("overlappingLayouts", []):
        yield "flexbuffers", f"reject overlapping {wire}", {"op": "flexbuffers.decodeExtension", "wire": wire}, error
    for name in v["unsupportedWellKnownSymbols"]:
        payload = list(b"#" + name.encode())
        wire = [len(payload), *payload, len(payload), 48, 1]
        yield ("flexbuffers", f"refuse to encode #{name}",
               {"op": "flexbuffers.encodeExtension", "wellKnownSymbol": name}, error)
        yield "flexbuffers", f"reject #{name}", {"op": "flexbuffers.decodeExtension", "wire": wire}, error

    v = vectors("envbuf")
    for frame in v["frames"]:
        label = f"format {frame['format']} power {frame['alignmentPower']} length {len(frame['content'])}"
        yield ("envbuf", f"encode {label}", {"op": "envbuf.encode", "format": frame["format"],
               "alignmentPower": frame["alignmentPower"], "content": frame["content"]}, ok(frame["wire"]))
        yield ("envbuf", f"decode {label}", {"op": "envbuf.decode", "wire": frame["wire"]},
               ok({"format": frame["format"], "content": frame["content"]}))
    for fmt in v["reservedFormats"]:
        yield ("envbuf", f"refuse format {fmt}",
               {"op": "envbuf.encode", "format": fmt, "alignmentPower": 3, "content": []}, error)

    v = vectors("flow-ids")
    for raw, canonical in v["normalized"]:
        yield "flow", f"normalize {raw}", {"op": "flow.normalize", "id": raw}, ok(canonical)
    longest = v["maxLength"]
    yield "flow", f"accept {longest} characters", {"op": "flow.normalize", "id": "A" * longest}, ok("a" * longest)
    yield "flow", f"reject {longest + 1} characters", {"op": "flow.normalize", "id": "a" * (longest + 1)}, error
    for bad in v["invalid"]:
        yield "flow", f"reject {bad!r}", {"op": "flow.normalize", "id": bad}, error

    yield "keys", "object-key prefixes", {"op": "keys.prefixes"}, ok(vectors("object-keys"))


def make(repo, out):
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "requests.jsonl", "w") as requests, open(out / "expected.jsonl", "w") as expected:
        for codec, label, request, want in cases(repo):
            requests.write(json.dumps(request, ensure_ascii=False) + "\n")
            expected.write(json.dumps({"codec": codec, "case": label, "expect": want}, ensure_ascii=False) + "\n")


def check(out):
    expected = [json.loads(line) for line in open(out / "expected.jsonl")]
    try:
        responses = [json.loads(line) for line in open(out / "responses.jsonl")]
    except (OSError, ValueError) as problem:
        print(f"no usable responses: {problem}")
        return 1
    tally, failures = {}, []
    for index, case in enumerate(expected):
        got = responses[index] if index < len(responses) else {"missing": True}
        want = case["expect"]
        if got.get("unsupported"):
            verdict = "unsupported"
        elif "error" in want:
            verdict = "pass" if "error" in got else "fail"
        elif case["codec"] == "keys" and "ok" in got:
            missing = {k: v for k, v in want["ok"].items() if got["ok"].get(k) != v}
            verdict = "pass" if not missing else "fail"
            if missing:
                got = {"ok": {k: got["ok"].get(k) for k in missing}}
        else:
            verdict = "pass" if got == want else "fail"
        row = tally.setdefault(case["codec"], {"pass": 0, "fail": 0, "unsupported": 0})
        row[verdict] += 1
        if verdict == "fail":
            failures.append(f"  {case['codec']}: {case['case']}: expected {json.dumps(want, ensure_ascii=False)[:120]},"
                            f" got {json.dumps(got, ensure_ascii=False)[:120]}")
    for codec, row in tally.items():
        print(f"{codec:12} {row['pass']:3} pass  {row['fail']:3} fail  {row['unsupported']:3} unsupported")
    if failures:
        print("failures:")
        print("\n".join(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["make"] and len(sys.argv) == 4:
        make(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1:2] == ["check"] and len(sys.argv) == 3:
        sys.exit(check(Path(sys.argv[2])))
    else:
        sys.exit(__doc__)
