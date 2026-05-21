/** MCP tools exposed by the Forgent3D desktop preview app. */
export const PREVIEW_MCP_TOOL_NAMES = [
  'list_models',
  'screenshot_model',
  'rebuild_model'
] as const;

export type PreviewMcpToolName = (typeof PREVIEW_MCP_TOOL_NAMES)[number];

export function isPreviewMcpToolName(name: unknown): name is PreviewMcpToolName {
  return typeof name === 'string' && (PREVIEW_MCP_TOOL_NAMES as readonly string[]).includes(name);
}
