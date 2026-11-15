# API contract (backend ⇄ extension)

This is the **one file everyone agrees on**. If you change a field name, update
this file in the same commit and tell the team. Everything else can change freely.

Base URL: `http://localhost:8000` while developing, the Render/Railway URL once deployed.

## Roles

Each highlight has exactly one role. These four strings are fixed:

| role         | meaning                                  |
|--------------|------------------------------------------|
| `main`       | the main point / claim                   |
| `evidence`   | data, examples, quotes that support it   |
| `background` | context the reader needs                 |
| `counter`    | the other side, caveats, objections      |

## `GET /health`

```json
{ "status": "ok", "mock": false }
```

`mock: true` means the server has no API key and returns fake results (useful
for frontend/extension work without spending API credits).

## `POST /analyze`

Request: the paragraphs the extension pulled out with Readability.

```json
{
  "paragraphs": [
    { "id": 0, "text": "Full text of paragraph 0..." },
    { "id": 1, "text": "Full text of paragraph 1..." }
  ]
}
```

Response: sentences to highlight. **`text` must be copied word-for-word from the
paragraph**, otherwise the extension cannot find it on the page.

```json
{
  "highlights": [
    { "paragraph_id": 0, "text": "Exact sentence from paragraph 0.", "role": "main" },
    { "paragraph_id": 1, "text": "Another exact sentence.", "role": "evidence" }
  ]
}
```

## `POST /simplify`

Request: one highlighted sentence the reader clicked.

```json
{ "sentence": "The committee, after months of debate, approved the bill on Tuesday." }
```

Response: the "backbone" (who did what to what) as exact substrings, in order.
The extension bolds these and fades everything else.

```json
{ "core": ["The committee", "approved", "the bill"] }
```
