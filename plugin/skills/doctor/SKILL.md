---
name: doctor
description: Diagnose and fix Laminark plugin health — dependency checks, native addon verification, global/local conflict detection, and dist file integrity
---

Run the Laminark doctor script to check plugin health. Use the `--fix` flag to auto-repair issues.

## Steps

1. Ask the user if they want a dry-run (report only) or auto-fix:
   - Dry-run: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh"`
   - Auto-fix: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh" --fix`

2. Run the chosen command via Bash and show the output to the user.

3. If issues remain after `--fix`, explain what failed and suggest manual steps.
