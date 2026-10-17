import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPost, deletePost, editPost, getUserInfo } from "./api.js";
import { loadToken } from "./token-store.js";

const server = new McpServer({ name: "linkedin", version: "0.1.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

server.registerTool(
  "linkedin_get_profile",
  {
    description: "Get the authenticated member's basic LinkedIn profile (name, email, picture, locale).",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      return text(JSON.stringify(await getUserInfo(), null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "linkedin_auth_status",
  {
    description: "Check whether a valid LinkedIn token exists and when it expires.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const t = await loadToken();
      return text(`Authenticated as ${t.name ?? t.sub}; expires ${new Date(t.expiresAt).toISOString()}; scopes: ${t.scope}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "linkedin_create_post",
  {
    description:
      "Publish a post on the authenticated member's LinkedIn feed. This is publicly visible and immediately live: " +
      "always show the user the exact text and get their explicit approval before calling.",
    inputSchema: {
      text: z.string().min(1).max(3000).describe("Post body (max 3000 chars)"),
      visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
      articleUrl: z.string().url().optional().describe("Optional link to attach as an article card"),
      articleTitle: z.string().optional(),
      articleDescription: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (a) => {
    try {
      const urn = await createPost({
        text: a.text,
        visibility: a.visibility,
        article: a.articleUrl
          ? { url: a.articleUrl, title: a.articleTitle, description: a.articleDescription }
          : undefined,
      });
      return text(`Posted. URN: ${urn}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "linkedin_edit_post",
  {
    description:
      "Replace the text of one of the member's own live posts (media, link card and visibility cannot change). " +
      "LinkedIn marks the post as edited and the old text is not kept: always show the user the exact new text " +
      "and get explicit approval before calling.",
    inputSchema: {
      urn: z.string().regex(/^urn:li:(share|ugcPost):\d+$/),
      text: z.string().min(1).max(3000).describe("Full replacement text (max 3000 chars)"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ urn, text: newText }) => {
    try {
      await editPost(urn, newText);
      return text(`Edited ${urn}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "linkedin_delete_post",
  {
    description: "Delete one of the member's own posts by URN (e.g. urn:li:share:123 or urn:li:ugcPost:123).",
    inputSchema: { urn: z.string().regex(/^urn:li:(share|ugcPost):\d+$/) },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ urn }) => {
    try {
      await deletePost(urn);
      return text(`Deleted ${urn}`);
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
