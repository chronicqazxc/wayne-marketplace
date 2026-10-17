import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPost, deletePost, getMe, getPost, listPosts, readContentFile, summarize, updatePost } from "./api.js";
import { getSite } from "./config.js";
import { applyEdits, markdownToHtml, writeScratch, type Edit } from "./convert.js";

const server = new McpServer({ name: "wordpress", version: "0.2.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

const status = z.enum(["draft", "publish", "private", "pending", "future"]);
const content = {
  content: z.string().optional().describe("Post body inline (HTML by default, see content_format)"),
  content_file: z.string().optional().describe("Absolute path to a local file with the body; alternative to content"),
  content_format: z.enum(["html", "markdown"]).default("html").describe(
    "Format of content/content_file. markdown is converted to HTML (GFM) before sending",
  ),
};

async function resolveContent(a: {
  content?: string;
  content_file?: string;
  content_format?: "html" | "markdown";
}): Promise<string | undefined> {
  if (a.content !== undefined && a.content_file !== undefined) throw new Error("Pass either content or content_file, not both.");
  const raw = a.content_file !== undefined ? await readContentFile(a.content_file) : a.content;
  return raw !== undefined && a.content_format === "markdown" ? markdownToHtml(raw) : raw;
}

const LIVE = "WARNING: this post is LIVE (status=publish); the change is already visible on the public site.";

server.registerTool(
  "wp_create_post",
  {
    description:
      "Create a WordPress.com post. Write the body as markdown (content_format=\"markdown\", converted to HTML by the server) or raw HTML. Status defaults to draft; the user normally publishes in wp-admin. " +
      "Setting status=publish requires confirm_live=true and explicit user approval. Returns ID, status and URL.",
    inputSchema: {
      title: z.string().min(1),
      ...content,
      status: status.default("draft"),
      categories: z.array(z.string()).optional().describe("Category names"),
      tags: z.array(z.string()).optional().describe("Tag names"),
      confirm_live: z.boolean().optional().describe("Must be true to create with status=publish"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (a) => {
    try {
      if (a.status === "publish" && a.confirm_live !== true)
        throw new Error("Refusing to publish: set confirm_live=true after the user explicitly approves going live.");
      const p = await createPost({ ...a, content: await resolveContent(a) });
      return json({ ...summarize(p), ...(p.status === "publish" ? { warning: LIVE } : {}) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "wp_update_post",
  {
    description:
      "Update a WordPress.com post (only provided fields change). To change part of the body, pass `edits` " +
      "([{find, replace}] exact-string patches applied to the stored HTML, each find must be unique): the server " +
      "fetches the HTML and patches it, so send only the changed fragments; grep the wp-<id>.html file written by " +
      "wp_get_post to copy exact find strings. Full replacement: content/content_file (html or markdown). Do not " +
      "round-trip an existing HTML post through markdown, that is lossy. Editing a post that is already published, " +
      "or setting status=publish, changes the live page immediately and requires confirm_live=true plus explicit " +
      "user approval. Returns ID, status and URL.",
    inputSchema: {
      id: z.number().int().positive(),
      title: z.string().optional(),
      ...content,
      edits: z
        .array(z.object({ find: z.string(), replace: z.string(), replace_all: z.boolean().optional() }))
        .optional()
        .describe("Partial body edits on the stored HTML; mutually exclusive with content/content_file"),
      status: status.optional(),
      categories: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      confirm_live: z.boolean().optional().describe("Required when the post is currently published or status=publish"),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ id, confirm_live, edits, ...fields }) => {
    try {
      if (edits && (fields.content !== undefined || fields.content_file !== undefined))
        throw new Error("Pass either edits or content/content_file, not both.");
      const current = await getPost(id, true);
      if ((current.status === "publish" || fields.status === "publish") && confirm_live !== true)
        throw new Error(
          `Refusing: post ${id} is ${current.status === "publish" ? "already LIVE" : "being published"}. ` +
            "Set confirm_live=true after the user explicitly approves editing the live page.",
        );
      const body = edits ? applyEdits(current.content ?? "", edits as Edit[]) : await resolveContent(fields);
      const p = await updatePost(id, { ...fields, content: body });
      return json({
        ...summarize(p),
        ...(edits ? { edits_applied: edits.length } : {}),
        ...(p.status === "publish" ? { warning: LIVE } : {}),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "wp_get_post",
  {
    description:
      "Get a WordPress.com post. The body is NOT returned inline (it can be huge): it is written to local files " +
      "wp-<id>.md (readable markdown) and wp-<id>.html (exact stored HTML) in the scratch dir and their paths and " +
      "sizes are returned along with ID, status, URL, title, modified. Read/grep those files as needed. Set " +
      "include_markdown=true to also get the markdown inline (small posts only).",
    inputSchema: { id: z.number().int().positive(), include_markdown: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  },
  async ({ id, include_markdown }) => {
    try {
      const p = await getPost(id, true);
      const { markdown, ...files } = await writeScratch(id, p.content ?? "");
      return json({
        ...summarize(p),
        ...files,
        ...(include_markdown ? { markdown } : {}),
        ...(p.status === "publish" ? { warning: LIVE } : {}),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "wp_list_posts",
  {
    description: "List posts (newest first) with ID, status, URL and title.",
    inputSchema: {
      status: z.enum(["draft", "publish", "private", "pending", "future", "trash", "any"]).optional(),
      number: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ status: s, number }) => {
    try {
      const r = await listPosts(s, number);
      return json({ found: r.found, posts: (r.posts ?? []).map((p: any) => summarize(p)) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "wp_delete_post",
  {
    description:
      "Delete a post: a first call moves it to trash; deleting an already-trashed post is permanent. " +
      "Requires confirm_live=true if the post is published. Ask the user first.",
    inputSchema: { id: z.number().int().positive(), confirm_live: z.boolean().optional() },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ id, confirm_live }) => {
    try {
      const current = await getPost(id);
      if (current.status === "publish" && confirm_live !== true)
        throw new Error(`Refusing: post ${id} is LIVE. Set confirm_live=true after explicit user approval.`);
      return json(summarize(await deletePost(id)));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "wp_auth_status",
  {
    description: "Check that the configured token is valid and which site is targeted.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const me = await getMe();
      return text(`Token valid for ${me.display_name ?? me.username} (user ${me.ID}); site: ${getSite()}`);
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
