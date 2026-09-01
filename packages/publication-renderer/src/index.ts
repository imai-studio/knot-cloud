import {
  publicationDocumentSchema,
  type PublicationDocument,
} from "@imai/knot-cloud-contract";

export interface PublicationRenderOptions {
  mediaUrl(digest: string): string;
  canonicalUrl?: string;
}

export function renderPublication(
  input: unknown,
  options: PublicationRenderOptions,
): string {
  const document = publicationDocumentSchema.parse(input);
  const title = escapeHtml(document.title);
  const description = document.description
    ? `<meta name="description" content="${escapeAttribute(document.description)}">`
    : "";
  const canonical = options.canonicalUrl
    ? `<link rel="canonical" href="${escapeAttribute(options.canonicalUrl)}">`
    : "";
  const body = document.blocks
    .map((block) => renderBlock(block, options))
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${description}${canonical}<style>${stylesheet}</style></head><body><main><header><h1>${title}</h1>${document.description ? `<p class="description">${escapeHtml(document.description)}</p>` : ""}</header>${body}</main></body></html>`;
}

function renderBlock(
  block: PublicationDocument["blocks"][number],
  options: PublicationRenderOptions,
): string {
  switch (block.type) {
    case "heading":
      return `<h${block.level}>${renderSpans(block.content)}</h${block.level}>`;
    case "paragraph":
      return `<p>${renderSpans(block.content)}</p>`;
    case "quote":
      return `<blockquote>${renderSpans(block.content)}</blockquote>`;
    case "code": {
      const language = block.language
        ? ` data-language="${escapeAttribute(block.language)}"`
        : "";
      return `<pre${language}><code>${escapeHtml(block.code)}</code></pre>`;
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      return `<${tag}>${block.items.map((item) => `<li>${renderSpans(item)}</li>`).join("")}</${tag}>`;
    }
    case "image": {
      const source = escapeAttribute(options.mediaUrl(block.assetDigest));
      const alt = escapeAttribute(block.alt ?? "");
      const caption = block.caption
        ? `<figcaption>${renderSpans(block.caption)}</figcaption>`
        : "";
      return `<figure><img src="${source}" alt="${alt}" loading="lazy" decoding="async">${caption}</figure>`;
    }
    case "file": {
      const source = escapeAttribute(options.mediaUrl(block.assetDigest));
      const label = escapeHtml(block.alt ?? "Download file");
      const caption = block.caption
        ? `<span>${renderSpans(block.caption)}</span>`
        : "";
      return `<p class="file"><a href="${source}" download>${label}</a>${caption}</p>`;
    }
    case "table":
      return `<div class="table-scroll"><table><tbody>${block.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${renderSpans(cell)}</td>`).join("")}</tr>`,
        )
        .join("")}</tbody></table></div>`;
  }
}

function renderSpans(
  spans: PublicationDocument["blocks"][number] extends never
    ? never
    : Array<{ text: string; marks: string[]; href?: string }>,
): string {
  return spans
    .map((span) => {
      let value = escapeHtml(span.text);
      for (const mark of span.marks) {
        const tag = markTags[mark];
        if (tag) value = `<${tag}>${value}</${tag}>`;
      }
      return span.href
        ? `<a href="${escapeAttribute(span.href)}" rel="noreferrer noopener">${value}</a>`
        : value;
    })
    .join("");
}

const markTags: Record<string, string> = {
  bold: "strong",
  code: "code",
  italic: "em",
  strikethrough: "s",
  underline: "u",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => escapes[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/gu, "&#96;");
}

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const stylesheet = `:root{color-scheme:light;font-family:ui-serif,Georgia,Cambria,"Times New Roman",serif;background:#fff;color:#17131d}*{box-sizing:border-box}body{margin:0}main{width:min(48rem,calc(100% - 2rem));margin:0 auto;padding:4rem 0 8rem;line-height:1.65}header{margin-bottom:3rem}h1,h2,h3,h4,h5,h6{line-height:1.15;letter-spacing:-.02em}header h1{font-size:clamp(2.5rem,8vw,5rem);margin:0}.description{color:#61586b;font-size:1.2rem}a{color:#6540a4;text-underline-offset:.18em}blockquote{border-left:.2rem solid #9b7bc5;margin-left:0;padding-left:1.25rem;color:#4e4656}pre{overflow:auto;padding:1rem;border:1px solid #e8e1ee;border-radius:.5rem;background:#f8f5fa}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.9em}figure{margin:2rem 0}img{display:block;max-width:100%;height:auto}figcaption,.file span{display:block;color:#61586b;font-size:.9rem;margin-top:.5rem}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}td{border:1px solid #e8e1ee;padding:.6rem;vertical-align:top}`;
