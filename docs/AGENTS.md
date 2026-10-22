# Prompt-to-documentation

Document the user's prompt and subsequent clarifications, preserving every stated
requirement while freely rewording, reordering, and splitting material across
concise tutorials, reference pages, and glossary entries. Assume a seasoned
developer: leave routine implementation details and engineering implications
implicit, and err on the side of documenting too little. Add detail beyond the
prompt only when a concrete implementation problem exposes underspecification;
record the smallest clarification that resolves it, without turning incidental
implementation choices into requirements.

# Documentation links

Use `*multi-word phrase*[^][reference-name]` links throughout `docs/`. Wrap
the entire keyphrase, whether one word or multiple words, in single asterisks
for italic text and link only the adjacent `^` marker. Keep the keyphrase itself
copyable without link navigation; do not use `[keyphrase][reference-name]`. List
every link definition at the top of its file, before the document body, using descriptive,
stable labels and angle-bracket destinations. This makes each document's
relationships easy to inspect without searching its prose.

Name local reference labels after the destination filename without its extension,
preserving case (e.g. `[server]: <../server.md>`), and verify this correspondence
during audits. Filenames under `docs/` should be unique; external references may use descriptive names.

Avoid inline links and bare/autolink URLs in prose, including tables and lists.
Keep literal links inside code examples unchanged. Check that reference labels
resolve and local paths match the target filename's casing when editing links.

Keep all documentation standalone within `docs/`. Local links and embedded assets
must resolve inside this directory. External links may use only HTTP(S) URLs to
genuinely independent resources; do not replace a repository-code link with a
hosted URL to the same implementation. Use small code blocks when needed to convey
prompted requirements or established clarifications. Self-contained means a
seasoned developer can fill in the gaps without project source, not that every
implementation step or test must be documented.

Tutorial and command requirements belong in these docs. Implementations should
follow them.
During link audits, verify that copying `docs/` alone
preserves every local reference and the information needed to follow a tutorial.
