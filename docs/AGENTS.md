# Agent notes: the Midplane docs

This folder is the documentation site at `https://midplane.ai/docs`, built by
Mintlify. Pages are MDX with YAML frontmatter; navigation and redirects live in
`docs.json`. It is written in the monorepo's `oss/docs` and published by the
one-way mirror to `midplaneai/midplane`, whose `/docs` folder Mintlify reads.
Edit it here only: a change made on the public repo or in Mintlify's editor is
overwritten by the next mirror run.

## Check before you push

```sh
npx --yes mint@4.2.970 validate
npx --yes mint@4.2.970 broken-links --check-anchors --check-redirects
npx --yes mint@4.2.970 dev   # preview at http://localhost:3000
```

CI runs the first two. The dashboard links to pages and headings here, so a
renamed page needs a redirect in `docs.json`, and a renamed heading breaks a
link from the app.

## Guides and reference

The site has two tabs. Put each page in one of them:

- **Guides** walk through a task: get started, prepare a database, deploy,
  troubleshoot. Start from where the reader is (what is this, what do I need),
  then number the steps to a check that it worked, with each trap inside the
  step where it bites. Keep them short, one screen per task where you can. The
  dashboard generates the config and commands, so a guide says what they set
  up and covers what the dashboard doesn't; it never copies them. Details go
  behind an `<Accordion>` or a link to the reference.
- **Reference** is complete and exact: every config key, log line, limit and
  guarantee. Long is fine there.

Prefer `<Steps>`, `<Columns>` of `<Card>`s, tables and diagrams to paragraphs.
The architecture diagram lives once, in `snippets/architecture.mdx`; import it
rather than drawing another. No dashboard screenshots while the setup flow is
still changing.

## Terms

Use these, exactly:

- **Midplane** (the product), **Midplane Cloud** (the hosted service and its
  dashboard), **the gateway** (the `midplane` npm package and its image).
- **Linked mode** (`midplane gateway`, enforcing what a project publishes) and
  **local mode** (`midplane local`, the policy in the config file).
- **Organization**, **project**, **database**, **database id** (`shop`: the
  name in Midplane and in the gateway's config, not the Postgres database's
  name), **connection string** (a DSN).
- **Policy**, published as a signed **bundle**; **table access** `deny`,
  `read`, `read_write`; **row changes** and **schema changes**, each `allow`,
  `hold` or `deny`; **masks**; **untrusted columns** and **secret tables**.
- **Agent** (an MCP client), its **grant**, **taint**; a **held write** waits
  for an **approval**.
- **Enrollment token**, the gateway's **identity**, the **mask salt**.
- **The audit log** (the file on the gateway's disk) and **the Query log**
  (what the dashboard shows).

Never use v1's terms: "the engine", "control plane", "self-host",
`MIDPLANE_POLICY_FILE`, "write classes", machine tokens (`mp_live_…`), or
"connection" for a project.

## Style

- Second person, active voice, one idea per sentence. Plain words: short
  sentences with colons and commas, no em dashes.
- Sentence case in titles and headings. A heading is a link target, so keep
  apostrophes and URLs out of it: Mintlify turns `'` into `’` and keeps it in
  the anchor. Write "Databases it cannot reach", not "can't".
- Bold for what the dashboard shows, spelled as it shows it (**Create
  enrollment token**, **Review and publish**). Code formatting for files,
  commands, config keys, ids and error codes.
- **Never put a secret's value on a command line**: no DSN, password or salt
  after `-e`, in `export`, or in `printf`. Secrets go in files the config
  names (`dsn: { file: secrets/shop.dsn }`), written with an editor or from a
  secret manager. The enrollment token is the one exception the dashboard
  makes: it works once, within a day.
- Version-gate features a released gateway doesn't have yet, inline:
  "(`0.22.0+`)".
- `/troubleshooting` has one heading per message the dashboard or the gateway
  shows, named by the sentence and its code: "Password authentication failed
  (28P01)".
- Each page ends with what tests it (`*Tested by*`) when a test does.

## Content

- Ground every statement in the code: the gateway in `oss/apps/gateway`, the
  policy in `oss/packages/protocol`, the dashboard in `cloud/app`. When the
  docs and the code disagree, the code wins; fix the page.
- Don't document what hasn't shipped. A thread that changes behaviour updates
  its pages in the same pull request.
- This folder is public and MIT licensed: no internal hostnames, design notes
  or customer names.
- Links: Mintlify paths from the site's root, no extension
  (`/gateway/configuration#the-policy`). A file outside `docs/` is linked on
  GitHub (`https://github.com/midplaneai/midplane/blob/main/SECURITY.md`).
- MDX: outside code, write `<` as `&lt;` and `{` as `\{`.
