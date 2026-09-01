import { describe, expect, it } from "vitest";

import { renderPublication } from "./index.js";

describe("typed publication renderer", () => {
  it("escapes document text, attributes, code, and link content", () => {
    const html = renderPublication(
      {
        schemaVersion: "1.0",
        title: '<script>alert("title")</script>',
        description: '" onload="alert(1)',
        blocks: [
          {
            type: "paragraph",
            content: [
              {
                text: "<img src=x onerror=alert(1)>",
                marks: ["bold"],
                href: "https://example.test/?q=%22%3E%3Cscript%3E",
              },
            ],
          },
          { type: "code", code: "</code><script>alert(1)</script>" },
        ],
      },
      { mediaUrl: (digest) => `/media/${digest}` },
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;/code&gt;&lt;script&gt;");
  });

  it("rejects raw HTML blocks, script links, and undeclared shapes", () => {
    expect(() =>
      renderPublication(
        {
          schemaVersion: "1.0",
          title: "Unsafe",
          blocks: [{ type: "html", html: "<script>alert(1)</script>" }],
        },
        { mediaUrl: (digest) => `/media/${digest}` },
      ),
    ).toThrow();
    expect(() =>
      renderPublication(
        {
          schemaVersion: "1.0",
          title: "Unsafe",
          blocks: [
            {
              type: "paragraph",
              content: [
                { text: "bad", marks: [], href: "javascript:alert(1)" },
              ],
            },
          ],
        },
        { mediaUrl: (digest) => `/media/${digest}` },
      ),
    ).toThrow();
  });
});
