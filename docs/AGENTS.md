[SKILL]: <skills/basinsync-tutorial-dag/SKILL.md>
[envbuf]: <glossary/envbuf.md>
[heap]: <glossary/heap.md>
[kernelspace]: <glossary/kernelspace.md>
[lexidecimal]: <glossary/lexidecimal.md>
[margin]: <glossary/margin.md>
[object-keys]: <object-keys.md>
[userspace]: <glossary/userspace.md>

# Prompt-to-documentation

Document the user's prompt and subsequent clarifications, preserving every stated
requirement while freely rewording, reordering, and splitting material across
concise tutorials, reference pages, and glossary entries. Assume a seasoned
developer: leave routine implementation details and engineering implications
implicit, and err on the side of documenting too little. Add detail beyond the
prompt only when a concrete implementation problem exposes underspecification;
record the smallest clarification that resolves it, without turning incidental
implementation choices into requirements.

Keep milestone scope, temporary limitations, and deferred work in the relevant
`diy/` tutorial; shared references and glossary entries should describe enduring
concepts and interfaces. Keep benchmark reports and measurements in the corresponding
tutorial's `benchmark/` folder.

Use `Datashed` for the tenancy domain and `Basin` for the data-state `Reservoir`.
Use *UserSpace*[~][userspace] for client-driven `Flow` state and *KernelSpace*[~][kernelspace]
for server-driven `Basin`/`Jet` state; *Heap*[~][heap] is their common node-storage concept.
Use basin node/edge for stored DAG elements, distinguishing trie nodes and other
logical structures; avoid heap node/edge, which can suggest a priority queue.
Call concatenated *EnvBufs*[~][envbuf] a feed and their enclosed
bytes a message (`message_length`), distinguishing that count from S3 `Content-Length`.
Call skippable format `110` envelopes *margins*[~][margin]; reserve padding for alignment filler inside envelopes.

# Tutorial dependencies

Tutorial paths alternate canonical unsigned *Lexidecimal*[~][lexidecimal] height
folders and named folders, ending in `README.md`; nesting may continue as
`diy/<height>/<YYMMDD-unique>/<height>/<YYMMDD-distinct>/README.md`.
Prefix slugs with the introduction date (`YYMMDD-`), preserving it through renames;
use `jj` history to date existing tutorials. Topics after the date must be unique
throughout `diy/`; supporting folder names and filenames may repeat.
Frontmatter lists prerequisite folders relative to `diy/`, each at a strictly
smaller height. For tutorial graph edits or audits, use the *tutorial DAG
skill*[~][SKILL] and its bundled Python linter.

# Documentation links

Use `*multi-word phrase*[~][reference-name]` links throughout `docs/`. Wrap
the entire keyphrase, whether one word or multiple words, in single asterisks
for italic text and link only the adjacent `~` marker. Keep the keyphrase itself
copyable without link navigation; do not use `[keyphrase][reference-name]`. List
every link definition at the top of its file, after any frontmatter and before the document body, using descriptive,
stable labels (in sorted order), and angle-bracket destinations. This makes each document's
relationships easy to inspect without searching its prose.

Include possessives and attached compound suffixes inside the emphasized phrase
(e.g. `*Viewpoint's*[~][viewpoint]`); audit both boundaries for stranded word fragments.

Link introduced domain terms wherever they occur in prose, including lowercase,
plural, and synonymous forms, using the corresponding glossary entry. During
audits, check for missing term links as well as broken links; omit self-links in
the defining entry and links inside code.

For tutorial links, use the full tutorial folder path from `docs/` as the
reference label (including every nested height/name pair), targeting its `README.md`. Otherwise, name local labels after the destination
filename without its extension, preserving case (e.g. `[server]: <../server.md>`).
Verify this correspondence during audits; external references may use descriptive names.

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

Keep object-key layouts in the *object-key reference*[~][object-keys]; link there
rather than duplicating patterns across pages.

Tutorial and command requirements belong in these docs. Implementations should
follow them.
During link audits, verify that copying `docs/` alone
preserves every local reference and the information needed to follow a tutorial.
