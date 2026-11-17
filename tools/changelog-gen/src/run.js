// @ts-check
import path from "node:path";
import { CLI_VERSION, HELP, parseArgs, UsageError } from "./args.js";
import { classify } from "./classify.js";
import { GitError, isGitRepo, latestTag, readCommits, resolveRef } from "./git.js";
import { group, renderMarkdown } from "./render.js";
import { writeSection } from "./write.js";

/**
 * @param {string[]} argv
 * @param {{ cwd: string, stdout: (s: string) => void, stderr: (s: string) => void, now?: () => Date }} io
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`changelog-gen: ${e.message}\nRun changelog-gen --help for usage.\n`);
      return 2;
    }
    throw e;
  }
  if (opts.help) {
    io.stdout(HELP);
    return 0;
  }
  if (opts.cliVersion) {
    io.stdout(`${CLI_VERSION}\n`);
    return 0;
  }

  try {
    if (!(await isGitRepo(io.cwd))) {
      io.stderr("changelog-gen: not a git repository\n");
      return 2;
    }

    const toRef = opts.to || "HEAD";
    const toHash = await resolveRef(toRef, io.cwd);
    if (!toHash) {
      if (!opts.to) {
        io.stderr("changelog-gen: no commits in range (the repository has no commits yet)\n");
        return 1;
      }
      io.stderr(`changelog-gen: unknown ref for --to: ${opts.to}\n`);
      return 2;
    }

    /** @type {string | null} */
    let from = null;
    /** @type {string | null} */
    let tag = null;
    if (opts.from) {
      if (!(await resolveRef(opts.from, io.cwd))) {
        io.stderr(`changelog-gen: unknown ref for --from: ${opts.from}\n`);
        return 2;
      }
      from = opts.from;
    } else {
      tag = await latestTag(opts.tagPrefix, toRef, io.cwd);
      from = tag;
    }

    const commits = await readCommits({
      cwd: io.cwd,
      from,
      to: toRef,
      path: opts.path,
      includeMerges: opts.includeMerges,
    });

    /** @type {string[]} */
    const names = [];
    if (opts.path) names.push(path.basename(path.resolve(io.cwd, opts.path)));
    if (opts.scope) names.push(opts.scope);
    const all = commits.map((c) => classify(c, { names }));
    const visible = opts.all ? all : all.filter((e) => !e.hidden);

    const rangeText = from ? `${from}..${toRef}` : `start..${toRef}`;
    if (commits.length === 0) {
      io.stderr(`changelog-gen: no commits in range ${rangeText}\n`);
      return 1;
    }
    if (visible.length === 0) {
      io.stderr(
        `changelog-gen: no changelog entries in range ${rangeText} (${commits.length} hidden commits, use --all to include them)\n`,
      );
      return 1;
    }

    const date = opts.date || (io.now ? io.now() : new Date()).toISOString().slice(0, 10);
    const markdown = renderMarkdown({ label: opts.versionLabel, date, entries: visible, hash: opts.hash });

    /** @type {string | null} */
    let action = null;
    if (opts.write) {
      action = writeSection(path.resolve(io.cwd, opts.write), markdown, opts.versionLabel);
    }

    if (opts.json) {
      const { sections, breaking } = group(visible);
      /** @param {import("./classify.js").Entry} e */
      const item = (e) => ({
        subject: e.subject,
        hash: e.hash,
        short: e.short,
        type: e.type,
        breaking: e.breaking,
        breakingNote: e.breakingNote,
      });
      /** @type {Record<string, unknown>} */
      const outSections = {};
      for (const [k, v] of Object.entries(sections)) if (v.length) outSections[k] = v.map(item);
      if (breaking.length) outSections.Breaking = breaking.map(item);
      io.stdout(
        JSON.stringify(
          {
            version: opts.versionLabel,
            date,
            range: { from, to: toRef, tag },
            commits: commits.length,
            entries: visible.length,
            sections: outSections,
            markdown,
            written: opts.write ? { file: opts.write, action } : null,
          },
          null,
          2,
        ) + "\n",
      );
    } else if (opts.write) {
      io.stdout(`${action} section "${opts.versionLabel}" in ${opts.write} (${visible.length} entries)\n`);
    } else {
      io.stdout(markdown + "\n");
    }
    return 0;
  } catch (e) {
    if (e instanceof GitError) {
      io.stderr(`changelog-gen: ${e.message}\n`);
      return 2;
    }
    io.stderr(`changelog-gen: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}
