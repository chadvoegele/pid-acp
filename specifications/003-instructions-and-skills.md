+++
status = "draft"
created = 2026-10-22
last_update = 2026-10-22
+++

# Instructions and skills

## Purpose

Give pid-acp sessions reusable instructions and discoverable skills without adding
an execution engine or loading Pi application configuration. This builds on the
native tools in milestone 002.

## Goals

- Include global and project instructions in model context.
- Advertise skill metadata; let the model load bodies through native `read`.
- Provide explicit launch-environment overrides for global resource paths.

## Non-goals

Pi settings, packages, executable extensions, resource hot reload, skill slash
commands, automatic descendant instruction loading, and tool permissions derived
from skill metadata are excluded.

## Specification

The default global instruction file must be `~/.agents/AGENTS.md`; the default
global skill directory must be `~/.agents/skills`. `PID_ACP_INSTRUCTIONS` and
`PID_ACP_SKILLS_DIR` must independently replace these paths. Nonempty overrides
must be absolute; an empty override must disable that global resource. These
variables belong to the trusted server launch environment, not ACP requests.
Missing resources are optional, including missing override targets.

At `session/new`, pid-acp must snapshot instruction text and skill metadata.
Project discovery must use the canonical session cwd and ascend through the
nearest `.git` marker (directory or worktree file), or the filesystem root if no
marker exists, stopping before the user's home directory. Home resources must
only come from the global configuration. Global instructions must precede
project `AGENTS.md` files in root-to-cwd order, with source paths attached and
canonical file duplicates omitted. The prompt must explain that more specific
project instructions take precedence within their scope. Descendant files are
not preloaded; models with loaded instructions are told to read additional
`AGENTS.md` files before working below the cwd.

Skills must be discovered in the global directory and each project ancestor's
`.agents/skills` directory. Discovery must recursively find `SKILL.md`, stopping
at skill roots and ignoring hidden directories and `node_modules`. Directory
symlinks may be followed; canonical visited-directory tracking must prevent
cycles. Broken directory links must be skipped.

Skill YAML front matter must contain a lowercase hyphen-separated name of at most
64 characters and a nonempty string description of at most 1024 characters.
Later, more local directories must override earlier names; duplicate names
within one discovery root must fail session creation. A local skill with
`disable-model-invocation: true` must hide any inherited skill of the same name.
Other front-matter fields must not grant permissions or register tools.

A Durable extension prompt section must advertise only visible skill names,
descriptions, and absolute paths, sorted by name. It must instruct the model to
read matching skill files and resolve supporting relative paths from the skill's
directory. Bodies must not be injected upfront; ordinary native `read` calls load
current bodies and produce normal ACP tool updates. Instruction text must use
Durable's conversation `instructions` field. No custom skill execution tool is
needed.

Malformed metadata and resource I/O errors other than absence must fail session
creation without exposing file contents or parser diagnostics. Failure must
leave the session slot available for retry after repair. Snapshot changes require
a new server process/session; skill bodies remain ordinary live filesystem reads.

All resources are trusted prompt input, not a sandbox or approval boundary.
Selecting a cwd trusts its discovered instruction and skill files, including
symlink targets outside that cwd. `.pi` resources must not be discovered implicitly;
users may select their text resources through the explicit overrides.

## Verification

- Unit tests must cover defaults, independent overrides, disablement, invalid
  paths, ordering, repository boundaries, local precedence, YAML metadata,
  disabled skills, symlinks/cycles, absence, and sanitized failures.
- Production ACP tests must use isolated home/workspace directories to verify
  both canonical defaults and custom paths, initial instruction/catalog delivery,
  lazy native reads, unchanged instruction snapshots, and retry after a malformed
  skill is repaired.
- Existing lifecycle, native-tool, and provider suites must continue to pass.
