import { Type } from "typebox";

/**
 * Manual TUI evidence spike. Install this throwaway extension and invoke
 * `spike_confirm` from a tool-capable Pi session. The result records whether a dialog
 * created inside tool execution was answered before its five-second timeout.
 */
export default function spikeConfirm(pi) {
  pi.registerTool({
    name: "spike_confirm",
    description: "Manual confirmation-dialog spike; not part of Kanban.",
    parameters: Type.Object({}),
    async execute(_id, _input, signal, _onUpdate, ctx) {
      const confirmed = await ctx.ui.confirm(
        "Kanban confirm spike",
        "Did this confirmation dialog open from tool execution?",
        { signal, timeout: 5_000 },
      );
      return {
        content: [
          {
            type: "text",
            text: `SPIKE-CONFIRM ${confirmed ? "accepted" : "refused-or-timed-out"}`,
          },
        ],
      };
    },
  });
}
