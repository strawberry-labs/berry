# Skills

Berry supports the [Agent Skills](https://agentskills.io/specification) directory format and `.skill` transport packages. A skill is a folder with a required `SKILL.md` file and optional `scripts/`, `references/`, `assets/`, license files, or other resources. A `.skill` file is a ZIP archive containing exactly one such folder.

## Install a `.skill` package

Open **Settings > Skills** and choose **Import skill**. Berry opens the native file picker filtered to `.skill` files, validates the archive without extracting it, then shows its metadata, resources, size, compatibility requirements, and a warning when scripts are present. Dropping a `.skill` file onto the import dialog is also supported.

The default location is the current project:

```text
<project>/.agents/skills/<skill-name>/
```

Project installation is recommended because the skill travels with the repository and works across clients that follow the `.agents/skills` convention. Choose **Global** for a personal skill that should be available in every project:

```text
~/.agents/skills/<skill-name>/
```

If the selected scope already contains the same name, Berry requires an explicit choice: replace it, keep the existing installation, or cancel. Installation is staged beside the destination and moved into place only after the extracted files pass validation again. Failed imports leave the existing skill untouched.

Berry also discovers older `.berry/skills` locations and `~/.codex/skills` for compatibility. New skills and `.skill` imports use `.agents/skills`.

## Trust and scripts

A `.skill` file is untrusted content. Importing one never runs scripts, hooks, installers, package managers, or dependency commands. Installing a skill does not grant it extra filesystem, shell, or network access. If its instructions later ask Berry to run a bundled script, the command goes through the same permission policy as any other tool call.

Project skills stay unavailable to the model until the project is trusted. Imported skills record their own trust and enabled state; either state can be changed from **Settings > Skills**. Untrusted and disabled skills are omitted from the model catalog.

Inspect `SKILL.md` and bundled resources before trusting unfamiliar packages. Berry preserves license files and other resources without rewriting them.

## Discovery and precedence

Berry scans direct child folders containing `SKILL.md` at session start and after the Skills catalog is refreshed. Names resolve in this order:

1. Current project
2. Global user skills
3. Built-in or plugin skills

Settings shows both sides of a name collision and identifies which skill shadows the other. Removing a higher-precedence installation reveals the lower-precedence skill without requiring an app restart.

Invalid folders appear as diagnostics in Settings but are not exposed to the agent.

## Use a skill

At session start, Berry gives the model only each enabled skill's name and description. When a request matches, the model calls `activate_skill` to load the full `SKILL.md`. Referenced files are listed but loaded individually only when needed. Activated instructions remain available after conversation compaction, and repeated activation is suppressed.

To force a skill for one request, start the message with its name:

```text
$release-notes Draft notes for the current changes
```

Typing `$` in the composer opens skill autocomplete.

## Create, disable, or remove

**New skill** creates a valid template in the current project's `.agents/skills` folder. If no project is open, it creates a global skill instead. Use **View SKILL.md** or **Open folder** to edit its instructions and resources.

The enabled switch hides a skill from the agent without deleting files. Removing a managed skill requires confirmation and affects only the selected project or global scope.
