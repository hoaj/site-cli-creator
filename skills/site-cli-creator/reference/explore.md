# Explore first: one Capture, then pick the Tasks

Replaces the Task loop's steps 1 and 2 ([add-task.md](add-task.md)) when the user cannot name the Tasks yet, or wants several read Tasks from one site without one Chrome round, and one sign-in, per Task. The user walks through the site once; you propose Tasks from what that Capture recorded; the user picks; each chosen Task gets its own Capture, split from the explore Capture.

Not for a `feature` issue (the Task is known: run add-task as usual), and never for a write Task: an explore Capture aborts every write, so a write Task always gets its own `capture.ts --task <slug> --write`.

Done when every chosen Task has its own `captures/<slug>/` and its card is accepted; then go on at add-task step 5.

## 1. Explore Capture

```sh
bun <gen>/tools/capture.ts --skill-dir <skill> --explore --url <start page>
```

It takes the read Task's flags (`--origin`, `--login-host`, `--allow-read`, `--script`, `--profile`, `--headless`) but no `--task`, `--write` or `--write-op`, and it stops and runs in the background as in [add-task.md](add-task.md) step 2. Tell the user, before Chrome opens:

- sign in if asked;
- open every page an agent should be able to read, and for a list, one of its detail pages too (one bill, one order);
- let each page's data show before moving on: a response still loading when the page is left is lost;
- to show a write an agent should be able to make (add a note, change a setting), fill in the form and submit it once: every write is aborted before it leaves Chrome, so nothing changes on the site (the page may show an error), but the Capture records the write as a candidate;
- then close the window, or press Enter in the terminal.

The Capture lands in `<skill>/captures/explore/`, shapes only, like any other; capturing `--explore` again replaces it. The output's `pages` lists each page in the order it was visited, as a path with ids and seen values redacted (`/bills/:id`; `host/path` on another host), with the calls it made. Page loads, sign-in steps, server actions and RSC streams are left out of `pages`; they stay in `index.json`, where every Operation also has its own `pages`.

Read the REST paths in `index.json` and the page paths in `pages` once, as for any Capture (add-task step 2): a segment that is still a name, a place or a word the user typed is a value; rename it to `:id`.

## 2. Candidate Tasks

From `pages` and the shape files, propose candidate Tasks:

- a page that shows the user's data is usually one Task: a list page becomes `<noun> list`, a detail page `<noun> show` taking an id;
- a call made on every page (the customer, feature flags) is a chain link or page chrome, not a Task of its own;
- one Task may need calls from two pages (a list and the detail it links to).

For each candidate, filter its Operations as in add-task step 3 (kept and dropped, one-line reason each) and draft its card as in step 4. Show all the cards at once, numbered, and ask which become commands (a multi-select question when your tools have one, else ask for the numbers), and whether to rename a command or change an output. An aborted write on a page is a possible write Task (one the page fired on its own while loading, such as a quote, usually is not): list it under the cards, saying it needs its own `--write` Capture. Ask too whether the user wants a write the walk did not record. Write nothing before the user has chosen.

## 3. Split

For each chosen read Task, copy the Operations its card keeps (its own and the chain that supplies their variables) into its own Capture:

```sh
bun <gen>/tools/split-capture.ts --skill-dir <skill> --task <slug> --op <operation> [--op <operation>]... [--start-path <path>]
```

- `--op` is the Operation's name in `captures/explore/index.json`; when the same name was recorded on two hosts, pass its shape file instead (the error names both).
- The Task's start page (`startPath` in its `index.json`, which `fix` re-captures from) is the page that called the most of them. Pass `--start-path` with a path from `pages` when the Task starts elsewhere.
- It refuses sign-in steps (they go in `site.ts`), page loads, calls the explore Capture aborted (capture that Task on its own: `--write` for a write, `--allow-read` for a POST that only reads), and a slug that already has a Capture.

Then go on at add-task step 5 for each chosen Task: the cards are accepted. Commit `captures/explore/` with the rest. `draft-contract` never merges it into a draft, and `fix` re-captures a Task into its own folder, so an old explore Capture never brings old shapes back. A later add-task may split another Task from it while the site has not changed since; otherwise capture that Task.
