# Developer Tip: Token-Efficient Context Bundling for AI Coding Assistants

When working with AI coding assistants (like Claude, Gemini, or ChatGPT), sending raw, bloated directories wastes budget, blows through context windows, and degrades model reasoning. 

Here is a 3-step zero-waste context preparation workflow using tools from **Toolshed**.

---

## 1. Estimate & Audit Before Sending

Before packaging entire folders, estimate the token footprint of your files:

```bash
# Estimate token count across your source directory
node tools/token-count/src/cli.js src/

# Or check specific large files
node tools/token-count/src/cli.js src/large-module.js
```

**Rule of thumb:** Keep targeted prompt contexts under 15,000-25,000 tokens for optimal reasoning speed and response quality.

---

## 2. Bundle Only Relevant Context with a Hard Token Budget

Use `repo-pack` to bundle your entry points, types, and relevant files into a structured Markdown or XML prompt file, enforcing an upper token ceiling:

```bash
# Package only source files, excluding tests and lockfiles, capped at 20,000 tokens:
node tools/repo-pack/src/cli.js \
  --include "src/**/*.js" \
  --exclude "test/**" \
  --max-tokens 20000 \
  --output context.md
```

`repo-pack` formats each file with clear headers and relative paths so the AI immediately understands your project structure without parsing clutter.

---

## 3. Strip Test Noise on Failure

When asking an assistant to fix broken tests, don't paste thousands of lines of passing test logs. Use `dev-context-mcp`'s `test-report` module or pipe only failed assertions:

- Filter to only failing test names, line numbers, and trimmed error traces.
- This saves 80-90% of tokens in test-debugging loops and prevents the assistant from hallucinating fixes for passing tests.

---

## Quick Reference Workflow

```
[ Codebase ] ───▶ [ token-count ] ───(Check size)
                          │
                          ▼
                    [ repo-pack ] ───(Bundle within token ceiling)
                          │
                          ▼
                 [ AI Assistant Prompt ] ───(Lean, accurate, fast response)
```
