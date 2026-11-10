/**
 * What to do next, in the words of where the person is. In a terminal that is a `gcode mcp` command;
 * the desktop app does not put gcode on PATH, and it has a button for each of these in Tools & MCP.
 */
const desktop = () => process.env.GCODE_DESKTOP === '1'
export const signInAdvice = (name: string): string => desktop() ? `Use Sign in on "${name}" in Tools & MCP.` : `Run \`gcode mcp login ${name}\`.`
export const enableAdvice = (name: string): string => desktop() ? 'Then press Enable on it in Tools & MCP.' : `Then run \`gcode mcp enable ${name}\`.`
export const enableFirstAdvice = (name: string): string => desktop() ? 'Enable it first in Tools & MCP.' : `Enable it first with \`gcode mcp enable ${name}\`.`
export const disableAdvice = (name: string): string => desktop() ? 'turn it off in Tools & MCP' : `turn it off with \`gcode mcp disable ${name}\``
export const fillInAdvice = (name: string): string => desktop() ? 'Edit ~/.gcode/mcp.json, press Refresh, then Enable on it in Tools & MCP.' : `Then run \`gcode mcp enable ${name}\`.`
