[development]: <../docs/development.md>
[turso]: <../docs/glossary/turso.md>

# Repository development

Follow the general *development guide*[~][development]; this page covers this
repository's own build and test layout.

*Turso*[~][turso] is vendored as a git submodule at `vendor/turso`, pinned to a
tested commit after its `v0.9.0-pre.1` tag. Fetch it before building:

```sh
git submodule update --init
```

`scripts/check.sh` runs every check. Codec wire vectors, Flow ID rules, and
object-key prefixes live in `tests/vectors/`; the Rust and TypeScript tests
both read them. Dependencies build optimized in the dev profile. Set
`PROPTEST_CASES` to deepen the slowest property tests.
