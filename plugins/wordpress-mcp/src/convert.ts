import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marked } from "marked";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export type Format = "html" | "markdown";

export const SCRATCH_DIR = process.env.WORDPRESS_MCP_SCRATCH ?? join(tmpdir(), "wordpress-mcp");

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.use(gfm);

export const markdownToHtml = (md: string): string => marked.parse(md, { async: false, gfm: true }) as string;
export const htmlToMarkdown = (html: string): string => turndown.turndown(html);

export interface Edit {
  find: string;
  replace: string;
  replace_all?: boolean;
}

// Exact-string patching on raw HTML: lossless, and the agent only sends the changed fragments.
export function applyEdits(html: string, edits: Edit[]): string {
  let out = html;
  edits.forEach((e, i) => {
    if (!e.find) throw new Error(`edits[${i}].find is empty`);
    const n = out.split(e.find).length - 1;
    if (n === 0) throw new Error(`edits[${i}].find not found in the post HTML: ${JSON.stringify(e.find.slice(0, 80))}`);
    if (n > 1 && !e.replace_all)
      throw new Error(`edits[${i}].find matches ${n} times; make it unique or set replace_all=true`);
    out = out.split(e.find).join(e.replace);
  });
  return out;
}

export async function writeScratch(id: number, html: string) {
  await mkdir(SCRATCH_DIR, { recursive: true });
  const base = join(SCRATCH_DIR, `wp-${id}`);
  const md = htmlToMarkdown(html);
  await Promise.all([writeFile(`${base}.html`, html), writeFile(`${base}.md`, md)]);
  return { html_file: `${base}.html`, markdown_file: `${base}.md`, html_chars: html.length, markdown_chars: md.length, markdown: md };
}
