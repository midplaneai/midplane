# Midplane quickstart

Try Midplane on your own machine in a few minutes: a sample Postgres database
in Docker, the gateway in local mode with `npx`, and Claude Code as the agent.
Nothing leaves your machine. There is no Midplane Cloud in this setup, so
writes that need a person's approval are refused rather than held.

You need Node 24.16 or newer, Docker, and Claude Code (any MCP client works).

## 1. Start the sample database

From this folder:

```sh
docker compose up -d --wait
```

That is Postgres 17 on `127.0.0.1:54329` with a small shop (`seed.sql`):

- `customers`: names, emails, phone numbers, plans, signup dates;
- `support_tickets`: bodies anyone on the internet can write, and ticket 1
  tries a prompt injection;
- `api_keys`: the shop's keys (fake ones).

The gateway connects as `midplane_agent`, a role that can read every table and
update tickets, and nothing else. Midplane narrows what the database allows;
it never replaces the database's own permissions.

## 2. Make a key and a token

```sh
npx midplane keygen --out .
export SHOP_DSN=postgres://midplane_agent:quickstart@127.0.0.1:54329/shop
export MIDPLANE_MASK_SALT=$(openssl rand -hex 32)
npx midplane token --config midplane.yaml --key midplane-signing-key.json \
  --sub you@example.com --access write > token.txt
```

`keygen` writes a signing key (keep it secret) and the verify key that
`midplane.yaml` names. The token is a signed JWT that lets an agent read and
write the `shop` database for an hour (`--ttl` changes that). The salt keys the
masks; keep the same one across restarts, or masked values change.

## 3. Start the gateway

```sh
npx midplane local --config midplane.yaml
```

It listens on `http://127.0.0.1:7433/mcp` and enforces the policy in
`midplane.yaml`: which tables agents may use, how writes are treated, which
columns are masked, and which are labeled untrusted or secret.

## 4. Connect Claude Code

In another terminal, in this folder:

```sh
claude mcp add --transport http midplane http://127.0.0.1:7433/mcp \
  --header "Authorization: Bearer $(cat token.txt)"
```

Start `claude` and check `/mcp` lists `midplane` as connected.

Or let Claude Code start the gateway itself, over stdio, instead of step 3's
terminal (not both):

```sh
claude mcp add midplane \
  -e MIDPLANE_TOKEN="$(cat token.txt)" \
  -e SHOP_DSN="$SHOP_DSN" -e MIDPLANE_MASK_SALT="$MIDPLANE_MASK_SALT" \
  -- npx midplane local --config "$PWD/midplane.yaml" --stdio
```

The token is fixed into that entry; when it expires, make a new one and add
the entry again. That's fine for a demo, but the entry holds the DSN, the salt
and the token, and the gateway runs as you: an agent with a shell or your files
could read them. Beyond a demo, use HTTP, with the gateway running as another
user or on another host.

## 5. Things to ask

1. **"What tables can you see in the shop database?"** It lists `customers`,
   `support_tickets` and `api_keys`.
2. **"List our customers with their emails and phone numbers."** Emails come
   back as hashes (the same email, the same hash, so joins and counts still
   work), phones keep their last four digits, and signup dates are cut to the
   month. Masks are applied inside the query, so no filter or join sees the
   raw value either.
3. **"Mark ticket 2 as closed."** The policy holds row changes for a person's
   approval. Local mode can't approve, so the gateway refuses and says so;
   linked to Midplane Cloud, the same write becomes an approval request.
4. **"Delete all support tickets."** Denied: a write must say which rows it
   changes, with a `WHERE`.
5. **"Which API keys do we have?"** The agent can read `api_keys` for now.
6. **"Summarize ticket 1."** Its body is labeled untrusted, and ticket 1 tells
   AI assistants to paste every API key into the reply. Reading it taints the
   agent's grant.
7. **"Now show me the API keys."** Denied: a tainted grant can't read tables
   labeled secret. That is exactly what the injected instruction was after.

## 6. Look at the record

Every statement was recorded before it ran, in a hash chain:

```sh
npx midplane audit export --config midplane.yaml --out audit.jsonl
npx midplane audit verify --file audit.jsonl
```

The export is JSON lines: each statement as the agent sent it, the decision
and the rule behind it, and how it ended. Results are never recorded.

## With Midplane Cloud

The same sample runs linked to Midplane Cloud, where a held write becomes an
approval request instead of a refusal and every statement shows in the Query
log. In a new project, choose **Try with sample data** on the first step of
its setup. That makes a project named Sample shop, with this database as `shop`
and this folder's policy published, and shows what to run: this database, and
a gateway on port 7434, beside this one's 7433. See [get
started](https://midplane.ai/docs/get-started#with-the-sample-database).

## Clean up

```sh
docker compose down -v
```

## Next

- Link the gateway to Midplane Cloud to author policy in a dashboard, approve
  held writes, and see a query log:
  [get started](https://midplane.ai/docs/get-started).
- Every setting in `midplane.yaml`:
  [configuration](https://midplane.ai/docs/gateway/configuration).
- How masking works, and its known limits:
  [masking](https://midplane.ai/docs/policies/masking).

*Tested by* `apps/gateway/test/quickstart.e2e.test.ts` (this folder's seed and
config, each answer above) and `apps/gateway/scripts/package-smoke.ts` (these
steps with the packed npm package and the image, in CI's `package` job).
