import type { Tool } from "@earendil-works/pi-mcp";

export const fixtureTool = (name: string): Tool => ({
	name,
	inputSchema: { type: "object", properties: {} },
});
