# The AI assistant (RFC 0013)

The assistant saves typing and never acts on its own: it proposes, the user decides. It runs on Claude through the
Anthropic API, **as the user** — it is told only what the user may read, and everything it proposes goes through the
same checks as what the user would type.

Built: **search in plain language**, **summaries** of a record and **draft replies** in its chatter. Forms filled
from documents follow (RFC 0013 §6).

## Switching it on

1. Set the key on the server (from the environment or the secret manager; never in code):

   ```sh
   ANTHROPIC_API_KEY=sk-ant-...
   # KOSH_ASSISTANT_MODEL=claude-opus-5-5        # the default; claude-sonnet-5-5 costs half
   # KOSH_ASSISTANT_MONTHLY_TOKENS=2000000       # per company and month
   ```

2. Install the **assistant** module (Settings → Apps; it is in the starter's catalogue).
3. An administrator opens **Settings → AI assistant** and switches it on for the company: until then no data of the
   company leaves the server.
4. Give users the **AI assistant** access level.

## Search in plain language

Lists have **Ask** next to the search box. "customers in Dhaka with a credit limit over 100 000" becomes filters —
the model gets the fields of the list's model the user may read (and the readable fields of the records they link
to, one hop: `partner.city`), answers in a strict JSON schema, and Kosh checks every field, operator and value before
the search runs as usual (record rules apply). The filters show as one chip, removed like any other; what could not be
expressed is said under the box. A refusal says the assistant cannot help; an answer Kosh cannot use is refused with
what was wrong, and the user rephrases or filters by hand.

```http
POST /api/v1/assistant/search
{ "model": "res.partner", "text": "customers in Dhaka with a credit limit over 100 000" }

{ "where": { "and": [{ "city": { "ilike": "%Dhaka%" } }, { "creditLimit": { "gt": "100000" } }] },
  "unsupported": "" }
```

## Summaries and draft replies

A record's chatter has **Summarize** and **Draft reply** (users with the assistant and Messaging). The model reads the
record's fields the user may read and its timeline as the user sees it — messages, notes and the change log, with
field security — and writes in the user's language; the answer streams in as it is written. A summary is read and
closed. A draft can be redone with an instruction ("decline politely", "confirm Friday"); **Use this draft** puts it
in the message composer, where the user edits and sends it. The assistant never posts.

```http
POST /api/v1/assistant/summary   { "model": "purchase.order", "id": 12 }
POST /api/v1/assistant/reply     { "model": "purchase.order", "id": 12, "instruction": "confirm Friday" }

data: {"text":"The order "}
data: {"text":"waits for its approval."}
event: done
data: {"model":"claude-opus-5-5","refused":false}
```

The answers are server-sent events: a `data` line per piece of text, then `event: done` (or `event: error`).
`api.stream(path, body, onEvent)` reads them in the browser. No database transaction stays open while the model
writes: the request is prepared in the user's scope, answered outside it, and logged afterwards.

## The log and the budget

Every call is logged (`assistant.call`): who, what for, which model answered, the tokens, how long, refused or not,
why its answer was not used — never what was asked or answered. **Settings → AI assistant** shows the month's usage
against the budget and the latest calls. Past the budget, the assistant answers 429 until the next month.

## For module authors

Another search assistant can sit next to the box: `registry.registerSearchAssist('module.Name', Component)`; the
component receives the API, the model and `onDomain(where, label)`, which sets the search's custom domain (the
server checks it like any other). Controls in the chatter: `registry.registerChatterAssist('module.Name',
Component)`, with the API, the record and `onDraft(text)`, which opens the composer with the text. In tests, `createAssistant({ client: fakeClient(answer) })` answers without the API.
