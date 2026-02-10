import { t as ObservationRepository } from "../observations-RiHueE9T.mjs";

//#region src/hooks/handler.d.ts
/**
 * Processes a PostToolUse or PostToolUseFailure event through the full
 * filter pipeline: extract -> privacy -> admission -> store.
 *
 * Exported for unit testing of the pipeline logic.
 */
declare function processPostToolUseFiltered(input: Record<string, unknown>, obsRepo: ObservationRepository): void;
//#endregion
export { processPostToolUseFiltered };
//# sourceMappingURL=handler.d.ts.map